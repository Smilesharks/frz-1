// Core logic: duplicate the selection next to itself, then detach every
// component instance inside the copy until none are left.

const GAP = 80
const BATCH_SIZE = 50

export interface SkippedLayer {
  name: string
  reason: string
}

export interface SelectionSummary {
  names: string[]
  layerCount: number
  instanceCount: number
  depth: number
  skipped: SkippedLayer[]
}

export interface FreezeResult {
  copies: SceneNode[]
  detached: number
  depth: number
  remaining: number
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

export function summarizeSelection(selection: readonly SceneNode[]): SelectionSummary {
  const { accepted, skipped } = partitionSelection(selection)
  const instances = accepted.reduce<InstanceNode[]>((all, node) => all.concat(instancesIn(node)), [])
  const depth = instances.reduce((max, instance) => Math.max(max, instanceNestingLevel(instance)), 0)

  return {
    names: accepted.map((node) => node.name),
    layerCount: accepted.length,
    instanceCount: instances.length,
    depth,
    skipped,
  }
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
// Flattening main components
// ---------------------------------------------------------------------------

/**
 * Swaps every main component inside the copies for a plain frame.
 *
 * The typings say clone() turns nested main components into instances, but
 * testing showed they come out as brand new main components, which would
 * clutter the assets panel. There is no API to turn a component into a frame,
 * so we place an instance of it in the same spot, detach that instance, and
 * delete the component.
 */
export function flattenComponents(roots: SceneNode[]): { flattened: number; skipped: SkippedLayer[] } {
  const skipped: SkippedLayer[] = []
  let flattened = 0

  for (const root of roots) {
    if (!('findAllWithCriteria' in root)) continue

    // Rare in a design frame, and flattening variants would break the set.
    for (const componentSet of root.findAllWithCriteria({ types: ['COMPONENT_SET'] })) {
      skipped.push({ name: componentSet.name, reason: 'component set, copied as a new component set' })
    }

    const components = root
      .findAllWithCriteria({ types: ['COMPONENT'] })
      .filter((component) => component.parent?.type !== 'COMPONENT_SET')

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
  }

  return { flattened, skipped }
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

// ---------------------------------------------------------------------------
// Detaching
// ---------------------------------------------------------------------------

/**
 * Detaches every instance inside `roots`, outermost first.
 *
 * Detaching an instance turns it into a frame, but instances nested inside it
 * stay linked to their own components. So we detach one layer of nesting per
 * round, re-query, and repeat until nothing is left.
 */
export async function detachAll(roots: SceneNode[], onProgress: ProgressCallback): Promise<FreezeResult> {
  const copies = roots.slice()
  const failedIds = new Set<string>()
  const skipped: SkippedLayer[] = []
  const total = countInstances(copies)
  let detached = 0
  let depth = 0

  for (;;) {
    // Node references go stale after a detach (the detached children get new
    // ids), so we query the tree fresh at the start of every round.
    const outermost = copies
      .reduce<InstanceNode[]>((all, root) => all.concat(instancesIn(root)), [])
      .filter((instance) => !failedIds.has(instance.id) && !hasInstanceAncestor(instance))

    if (outermost.length === 0) break

    let detachedThisRound = 0
    for (let start = 0; start < outermost.length; start += BATCH_SIZE) {
      for (const instance of outermost.slice(start, start + BATCH_SIZE)) {
        const { id, name } = instance
        try {
          const frame = instance.detachInstance()
          // If a selected layer was itself an instance, keep our reference to it valid.
          const rootIndex = copies.findIndex((root) => root.id === id)
          if (rootIndex !== -1) copies[rootIndex] = frame
          detached++
          detachedThisRound++
        } catch (error) {
          failedIds.add(id)
          skipped.push({ name, reason: error instanceof Error ? error.message : String(error) })
        }
      }
      onProgress(detached, total, depth + 1)
      await yieldToFigma()
    }

    if (detachedThisRound === 0) break
    depth++
  }

  return { copies, detached, depth, remaining: countInstances(copies), skipped }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The node itself if it is an instance, plus every instance inside it at any depth. */
function instancesIn(node: SceneNode): InstanceNode[] {
  const found: InstanceNode[] = node.type === 'INSTANCE' ? [node] : []
  // findAllWithCriteria searches the whole subtree, including inside instances,
  // and is much faster than findAll with a callback.
  if ('findAllWithCriteria' in node) {
    return found.concat(node.findAllWithCriteria({ types: ['INSTANCE'] }))
  }
  return found
}

function countInstances(nodes: SceneNode[]): number {
  return nodes.reduce((sum, node) => sum + instancesIn(node).length, 0)
}

function hasInstanceAncestor(node: SceneNode): boolean {
  for (let parent = node.parent; parent && parent.type !== 'PAGE'; parent = parent.parent) {
    if (parent.type === 'INSTANCE') return true
  }
  return false
}

/** 1 for a top level instance, 2 for an instance inside an instance, and so on. */
function instanceNestingLevel(instance: InstanceNode): number {
  let level = 1
  for (let parent = instance.parent; parent && parent.type !== 'PAGE'; parent = parent.parent) {
    if (parent.type === 'INSTANCE') level++
  }
  return level
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
