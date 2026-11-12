// Print mode paint list: everything the copy paints, bottom to top, as filled
// polygons in page space with one solid color each.

import { createProgressReporter, ProgressCallback, SkippedLayer } from '../freeze'
import { compose, geometryToPaths, IDENTITY, intersect, Paths, rectToPaths, union } from './geometry'
import { hasVisibleStroke, isSupportedMask, layerProblem, topPaint, TopPaint } from './scan'

export interface PaintItem {
  /** `#RRGGBB`, uppercase. */
  color: string
  /** Page coordinates times GEOMETRY_SCALE, non-zero winding, already self-unioned. */
  paths: Paths
  /** Index into `PaintList.regions`, or -1 when unclipped. */
  clipKey: number
  kind: 'fill' | 'stroke' | 'text'
}

export interface PaintList {
  /** Bottom to top, in the order Figma paints them. */
  items: PaintItem[]
  /** Clip regions referenced by `PaintItem.clipKey`. */
  regions: Paths[]
  skipped: SkippedLayer[]
  strokesOutlined: number
  textOutlined: number
  clipsApplied: number
  masksApplied: number
}

/** A clip region: `key` indexes `PaintList.regions`, `path` names the chain of clips that made it. */
interface Clip {
  key: number
  path: string
}

/**
 * Walks the copy in paint order. A frame paints its fill, then its children,
 * then its stroke; a shape paints its fill, then its stroke. Groups paint
 * nothing themselves.
 */
export async function buildPaintList(root: SceneNode, onProgress: ProgressCallback): Promise<PaintList> {
  const list: PaintList = {
    items: [],
    regions: [],
    skipped: [],
    strokesOutlined: 0,
    textOutlined: 0,
    clipsApplied: 0,
    masksApplied: 0,
  }
  const report = createProgressReporter(0, onProgress)
  const keyByPath = new Map<string, number>()
  let layers = 0

  /** Nested clips intersect; each distinct chain of clips is computed once. */
  function clipWithin(parent: Clip | null, node: SceneNode, region: Paths): Clip {
    const path = parent ? `${parent.path}|${node.id}` : node.id
    let key = keyByPath.get(path)
    if (key === undefined) {
      key = list.regions.length
      list.regions.push(parent ? intersect(list.regions[parent.key], region) : region)
      keyByPath.set(path, key)
    }
    return { key, path }
  }

  /** The area a mask cuts to: its fill plus its visible stroke, as Figma renders it. */
  function maskArea(mask: SceneNode): Paths {
    let area = 'fillGeometry' in mask ? geometryToPaths(mask.fillGeometry, mask.absoluteTransform) : []
    if (hasVisibleStroke(mask)) {
      const stroke = outlineStroke(mask)
      if (stroke) area = union(area.concat(stroke))
    }
    return area
  }

  function skip(node: SceneNode, reason: string) {
    list.skipped.push({ name: node.name, reason })
  }

  function add(node: SceneNode, paint: TopPaint, paths: Paths, clip: Clip | null, kind: PaintItem['kind']) {
    if (!paint) return
    if ('reason' in paint) {
      skip(node, paint.reason)
      return
    }
    if (paths.length === 0) return
    list.items.push({ color: paint.hex, paths, clipKey: clip ? clip.key : -1, kind })
  }

  function addFill(node: SceneNode, clip: Clip | null) {
    if (!('fills' in node) || !('fillGeometry' in node)) return
    const paint = topPaint(node.fills)
    if (!paint || 'reason' in paint) return add(node, paint, [], clip, 'fill')
    const paths = geometryToPaths(node.fillGeometry, node.absoluteTransform)
    // Text fill geometry is the outlined glyphs.
    const kind = node.type === 'TEXT' ? 'text' : 'fill'
    if (kind === 'text' && paths.length) list.textOutlined++
    add(node, paint, paths, clip, kind)
  }

  function addStroke(node: SceneNode, clip: Clip | null) {
    if (!hasVisibleStroke(node) || !('strokes' in node)) return
    const paint = topPaint(node.strokes)
    if (!paint || 'reason' in paint) return add(node, paint, [], clip, 'stroke')
    const paths = outlineStroke(node)
    if (paths === null) return skip(node, 'stroke could not be outlined')
    list.strokesOutlined++
    add(node, paint, paths, clip, 'stroke')
  }

  async function visit(node: SceneNode, clip: Clip | null) {
    if (!node.visible) return
    layers++
    await report(layers, 0)

    const problem = layerProblem(node)
    if (problem) {
      skip(node, problem)
      return
    }

    addFill(node, clip)

    // A boolean paints its combined shape; its children are only operands.
    if (node.type === 'BOOLEAN_OPERATION' || !('children' in node)) {
      addStroke(node, clip)
      return
    }
    let childClip = clip
    if ('clipsContent' in node && node.clipsContent) {
      childClip = clipWithin(clip, node, rectToPaths(node.width, node.height, node.absoluteTransform))
      list.clipsApplied++
      if ('cornerRadius' in node && node.cornerRadius !== 0) skip(node, 'clip corner radius ignored')
    }

    // A mask clips the siblings above it, up to the end of the parent or the
    // next mask. The mask itself is never painted.
    let current = childClip
    for (const child of node.children) {
      if ('isMask' in child && child.isMask) {
        if (!child.visible) continue
        if (isSupportedMask(child)) {
          current = clipWithin(childClip, child, maskArea(child))
          list.masksApplied++
        } else {
          // The layers above it stay unclipped, and the report says why.
          skip(child, 'unsupported mask')
          current = childClip
        }
        continue
      }
      await visit(child, current)
    }
    // A frame's stroke paints above its children.
    addStroke(node, clip)
  }

  await visit(root, null)
  return list
}

/**
 * The node's stroke as filled polygons in page space, using Figma's own outline
 * so inside, center and outside alignment all come out right. Returns null if
 * Figma cannot outline it.
 *
 * outlineStroke() adds the new vector to the page, but gives it a transform
 * relative to the source's parent and drops any rotation or mirroring held
 * there. Composing it with the parent's page transform puts it back in place
 * (checked on mirrored lines, rotated rectangles and frame strokes).
 */
export function outlineStroke(node: SceneNode): Paths | null {
  if (!('outlineStroke' in node)) return null
  const outlined = node.outlineStroke()
  if (!outlined) return null
  const parent = node.parent
  const parentTransform = parent && 'absoluteTransform' in parent ? parent.absoluteTransform : IDENTITY
  const paths = geometryToPaths(outlined.fillGeometry, compose(parentTransform, outlined.relativeTransform))
  outlined.remove()
  return paths
}
