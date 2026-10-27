// Core logic: duplicate the selection next to itself, then detach every
// component instance inside the copy until none are left.

const GAP = 80

// Progress goes to the UI every 50 instances or every 200 ms, whichever comes
// first. Each report also pauses briefly so Figma can redraw.
const PROGRESS_EVERY_COUNT = 50
const PROGRESS_EVERY_MS = 200

export interface SkippedLayer {
  name: string
  reason: string
}

export interface SelectionSummary {
  names: string[]
  layerCount: number
  skipped: SkippedLayer[]
}

export interface InstanceCount {
  instanceCount: number
  depth: number
}

export interface FreezeResult {
  copies: SceneNode[]
  total: number
  detached: number
  depth: number
  remaining: number
  flattened: number
  skipped: SkippedLayer[]
}

export type ProgressCallback = (done: number, total: number, depth: number) => void

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** Splits the selection into layers we can freeze and layers we skip (with a reason). */
export function partitionSelection(selection: readonly SceneNode[]) {
  const selectedIds = new Set(selection.map((node) => node.id))
  const accepted: SceneNode[] = []
  const skipped: SkippedLayer[] = []

  for (const node of selection) {
    // Cloning a main component creates a brand new component, not a snapshot.
    if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
      skipped.push({ name: node.name, reason: 'main component, not an instance' })
      continue
    }
    // A child of another selected layer is already included in that layer's copy.
    if (hasSelectedAncestor(node, selectedIds)) {
      skipped.push({ name: node.name, reason: 'inside another selected layer' })
      continue
    }
    accepted.push(node)
  }

  return { accepted, skipped }
}

/** Names only. Runs on every selection change, so it must not search the layer tree. */
export function describeSelection(selection: readonly SceneNode[]): SelectionSummary {
  const { accepted, skipped } = partitionSelection(selection)
  return { names: accepted.map((node) => node.name), layerCount: accepted.length, skipped }
}

/** Counts instances in the selection, nested ones included. Only runs when the COUNT key is pressed. */
export function countSelection(selection: readonly SceneNode[]): InstanceCount {
  const { accepted } = partitionSelection(selection)
  const rootIds = new Set(accepted.map((node) => node.id))

  // Number of instances on the path from the selected layer down to `node`,
  // `node` included. Cached by id, so layers shared by many instances (a card
  // grid with hundreds of cards) are only walked once.
  const levelById = new Map<string, number>()
  function levelOf(node: BaseNode): number {
    const cached = levelById.get(node.id)
    if (cached !== undefined) return cached
    const own = node.type === 'INSTANCE' ? 1 : 0
    const level = rootIds.has(node.id) || !node.parent ? own : levelOf(node.parent) + own
    levelById.set(node.id, level)
    return level
  }

  let instanceCount = 0
  let depth = 0
  for (const root of accepted) {
    for (const instance of instancesIn(root)) {
      instanceCount++
      depth = Math.max(depth, levelOf(instance))
    }
  }
  return { instanceCount, depth }
}

// ---------------------------------------------------------------------------
// Duplicating
// ---------------------------------------------------------------------------

/**
 * Clones each node and places the copies to the right of the selection,
 * keeping their positions relative to each other.
 */
export function cloneBeside(nodes: SceneNode[], rename: boolean): SceneNode[] {
  const page = figma.currentPage
  const bounds = unionRect(nodes.map(rectOf))
  const offsetX = findFreeOffset(page, bounds)
  const stamp = timestamp(new Date())

  return nodes.map((node) => {
    // clone() always parents the copy directly under the current page, even
    // when the original sits inside a frame or section.
    const copy = node.clone()

    // absoluteTransform is the node's position and rotation on the page. Since
    // the copy is now a top level layer, its relativeTransform is the same
    // thing, so we can copy it across and shift it to the right.
    const [[a, b, tx], [c, d, ty]] = node.absoluteTransform
    copy.relativeTransform = [
      [a, b, tx + offsetX],
      [c, d, ty],
    ]

    if (rename) copy.name = `${node.name} / frozen ${stamp}`
    return copy
  })
}

/** Moves right from the selection until the copy would not overlap any top level layer. */
function findFreeOffset(page: PageNode, bounds: Rect): number {
  let offsetX = bounds.width + GAP

  for (;;) {
    const target = { ...bounds, x: bounds.x + offsetX }
    const blocker = page.children.find((child) => intersects(rectOf(child), target))
    if (!blocker) return offsetX

    const blockerRect = rectOf(blocker)
    offsetX = blockerRect.x + blockerRect.width + GAP - bounds.x
  }
}

// ---------------------------------------------------------------------------
// Freezing
// ---------------------------------------------------------------------------

/**
 * Turns the copies into plain layers: flattens main components, then detaches
 * every instance, outermost first.
 *
 * Detaching an instance turns it into a frame, but instances nested inside it
 * stay linked to their own components. Figma also gives those nested layers
 * new ids when their parent is detached, so a list made before the detach goes
 * stale. We therefore work one level at a time: detach a level, then search
 * only inside the frames that detachInstance() returned for the next level.
 *
 * Note for the future: on a 2,000 instance test frame, about half the time is
 * Figma's own work after each detach, which it does the first time the new
 * layers are read. That cost is the same however we search, so searching
 * frame by frame is mainly about keeping Figma and the progress bar
 * responsive, not about the total time.
 */
export async function freezeCopies(roots: SceneNode[], onProgress: ProgressCallback): Promise<FreezeResult> {
  const copies = roots.slice()
  const skipped: SkippedLayer[] = []

  // One search per copy finds instances and main components together.
  const found = copies.map((root) => nodesOfTypes(root, ['INSTANCE', 'COMPONENT', 'COMPONENT_SET']))
  let instancesPerCopy = found.map((nodes) => nodes.filter((node): node is InstanceNode => node.type === 'INSTANCE'))
  const allFound = found.reduce<SceneNode[]>((all, nodes) => all.concat(nodes), [])

  // Rare in a design frame, and flattening variants would break the set.
  for (const componentSet of allFound.filter((node) => node.type === 'COMPONENT_SET')) {
    skipped.push({ name: componentSet.name, reason: 'component set, copied as a new component set' })
  }

  const components = allFound.filter(
    (node): node is ComponentNode => node.type === 'COMPONENT' && node.parent?.type !== 'COMPONENT_SET',
  )
  const flattened = flattenComponents(components)
  if (flattened > 0) {
    // Flattening replaced layers, so the instance lists above are stale.
    instancesPerCopy = copies.map(instancesIn)
  }

  const total = instancesPerCopy.reduce((sum, instances) => sum + instances.length, 0)
  const report = createProgressReporter(total, onProgress)
  const rootIndexById = new Map(copies.map((root, index) => [root.id, index]))
  let detached = 0
  let depth = 0

  let level = copies.reduce<InstanceNode[]>(
    (all, root, index) => all.concat(outermostWithin(root, instancesPerCopy[index])),
    [],
  )

  while (level.length > 0) {
    const frames: FrameNode[] = []

    for (const instance of level) {
      const { id, name } = instance
      try {
        const frame = instance.detachInstance()
        // If a selected layer was itself an instance, keep our reference to it valid.
        const rootIndex = rootIndexById.get(id)
        if (rootIndex !== undefined) copies[rootIndex] = frame
        frames.push(frame)
        detached++
      } catch (error) {
        // Instances inside a failed one stay linked; they show up as "left" in the report.
        skipped.push({ name, reason: error instanceof Error ? error.message : String(error) })
      }
      await report(detached, depth + 1)
    }

    if (frames.length === 0) break
    depth++

    // Only the inside of a frame we just detached can hold the next level.
    const nextLevel: InstanceNode[] = []
    for (const frame of frames) {
      for (const instance of outermostWithin(frame, frame.findAllWithCriteria({ types: ['INSTANCE'] }))) {
        nextLevel.push(instance)
      }
      await report(detached, depth + 1)
    }
    level = nextLevel
  }

  return { copies, total, detached, depth, remaining: total - detached, flattened, skipped }
}

/**
 * Swaps each main component for a plain frame.
 *
 * The typings say clone() turns nested main components into instances, but
 * testing showed they come out as brand new main components, which would
 * clutter the assets panel. There is no API to turn a component into a frame,
 * so we place an instance of it in the same spot, detach that instance, and
 * delete the component.
 */
function flattenComponents(components: ComponentNode[]): number {
  let flattened = 0

  for (const component of components) {
    const parent = component.parent
    if (!parent || !('insertChild' in parent)) continue

    const instance = component.createInstance()
    parent.insertChild(parent.children.indexOf(component), instance)
    copyPlacement(component, instance)
    const frame = instance.detachInstance()
    frame.name = component.name
    component.remove()
    flattened++
  }

  return flattened
}

/** Copies the properties that place a layer in its parent (the rest comes from the component). */
function copyPlacement(from: ComponentNode, to: InstanceNode) {
  to.layoutPositioning = from.layoutPositioning
  to.relativeTransform = from.relativeTransform
  to.layoutAlign = from.layoutAlign
  to.layoutGrow = from.layoutGrow
  to.constraints = from.constraints
  to.visible = from.visible
  to.locked = from.locked
}

/**
 * Returns an async function that sends progress at most every
 * PROGRESS_EVERY_COUNT instances or PROGRESS_EVERY_MS, and pauses each time
 * it does so Figma can redraw.
 */
function createProgressReporter(total: number, onProgress: ProgressCallback) {
  let lastCount = 0
  let lastTime = Date.now()

  return async (done: number, depth: number) => {
    const now = Date.now()
    if (done - lastCount < PROGRESS_EVERY_COUNT && now - lastTime < PROGRESS_EVERY_MS) return
    lastCount = done
    lastTime = now
    onProgress(done, total, depth)
    await yieldToFigma()
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The node itself if it matches `types`, plus every matching node inside it at any depth. */
function nodesOfTypes(node: SceneNode, types: NodeType[]): SceneNode[] {
  const found: SceneNode[] = types.indexOf(node.type) !== -1 ? [node] : []
  // findAllWithCriteria searches the whole subtree, including inside instances,
  // and is much faster than findAll with a callback.
  if ('findAllWithCriteria' in node) return found.concat(node.findAllWithCriteria({ types }))
  return found
}

function instancesIn(node: SceneNode): InstanceNode[] {
  return nodesOfTypes(node, ['INSTANCE']) as InstanceNode[]
}

/** The instances in `instances` that have no other instance between them and `container`. */
function outermostWithin(container: SceneNode, instances: InstanceNode[]): InstanceNode[] {
  if (container.type === 'INSTANCE') return [container]
  return instances.filter((instance) => {
    // Stops at the first instance above, so nested ones cost a step or two.
    for (let parent = instance.parent; parent && parent.id !== container.id; parent = parent.parent) {
      if (parent.type === 'INSTANCE') return false
    }
    return true
  })
}

function hasSelectedAncestor(node: SceneNode, selectedIds: Set<string>): boolean {
  for (let parent = node.parent; parent && parent.type !== 'PAGE'; parent = parent.parent) {
    if (selectedIds.has(parent.id)) return true
  }
  return false
}

function rectOf(node: SceneNode): Rect {
  // absoluteBoundingBox is null for invisible layers, so fall back to the
  // transform and size.
  if ('absoluteBoundingBox' in node && node.absoluteBoundingBox) return node.absoluteBoundingBox
  const [[, , x], [, , y]] = node.absoluteTransform
  return { x, y, width: node.width, height: node.height }
}

function unionRect(rects: Rect[]): Rect {
  const left = Math.min(...rects.map((r) => r.x))
  const top = Math.min(...rects.map((r) => r.y))
  const right = Math.max(...rects.map((r) => r.x + r.width))
  const bottom = Math.max(...rects.map((r) => r.y + r.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/** Gives Figma a moment to redraw and handle input between batches. */
function yieldToFigma(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function timestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
