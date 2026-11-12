// Print mode color scan: which solid colors a frame uses, and which layers
// cannot be printed as a single solid ink.

import { createProgressReporter, ProgressCallback, SkippedLayer } from '../freeze'
import { deltaE2000, NEAR_IDENTICAL_DELTA_E, toHex } from './color'

export type UnprintableReason =
  | 'gradient'
  | 'image'
  | 'video'
  | 'pattern'
  | 'shader'
  | 'effect'
  | 'blend mode'
  | 'partial opacity'
  | 'unsupported mask'
  | 'mixed text fills'

/** The topmost visible paint of a list: its color, the reason it cannot print, or null when nothing paints. */
export type TopPaint = { hex: string } | { reason: UnprintableReason } | null

// ---------------------------------------------------------------------------
// Printability rules
// ---------------------------------------------------------------------------

/**
 * A problem on the layer itself. It affects everything the layer draws,
 * children included, so the whole subtree is skipped.
 */
export function layerProblem(node: SceneNode): UnprintableReason | null {
  if ('opacity' in node && node.opacity < 1) return 'partial opacity'
  if ('effects' in node && node.effects.some((effect) => effect.visible)) return 'effect'
  if ('blendMode' in node && node.blendMode !== 'PASS_THROUGH' && node.blendMode !== 'NORMAL') return 'blend mode'
  return null
}

export function paintProblem(paint: Paint): UnprintableReason | null {
  switch (paint.type) {
    case 'SOLID':
      break
    case 'IMAGE':
      return 'image'
    case 'VIDEO':
      return 'video'
    case 'PATTERN':
      return 'pattern'
    case 'SHADER':
      return 'shader'
    default:
      return 'gradient'
  }
  if (paint.opacity !== undefined && paint.opacity < 1) return 'partial opacity'
  if (paint.blendMode && paint.blendMode !== 'NORMAL' && paint.blendMode !== 'PASS_THROUGH') return 'blend mode'
  return null
}

/**
 * Only the topmost visible paint matters: a solid paint at full opacity hides
 * every paint below it, and anything else is reported instead of guessed at.
 */
export function topPaint(paints: ReadonlyArray<Paint> | PluginAPI['mixed']): TopPaint {
  if (paints === figma.mixed) return { reason: 'mixed text fills' }
  for (let index = paints.length - 1; index >= 0; index--) {
    const paint = paints[index]
    if (paint.visible === false) continue
    const reason = paintProblem(paint)
    if (reason) return { reason }
    return { hex: toHex((paint as SolidPaint).color) }
  }
  return null
}

/** Whether a node draws a stroke at all: a visible stroke paint and a non-zero weight. */
export function hasVisibleStroke(node: SceneNode): boolean {
  if (!('strokes' in node) || !node.strokes.some((paint) => paint.visible !== false)) return false
  return !('strokeWeight' in node) || node.strokeWeight === figma.mixed || node.strokeWeight > 0
}

/**
 * A mask print mode can apply: an outline mask, or an alpha mask whose fill
 * and stroke are solid at full opacity, so it is a plain cut to its shape.
 */
export function isSupportedMask(node: SceneNode): boolean {
  if (!('isMask' in node) || !node.isMask) return false
  if (layerProblem(node)) return false
  if (node.maskType === 'VECTOR') return true
  if (node.maskType !== 'ALPHA') return false
  const fill = 'fills' in node ? topPaint(node.fills) : null
  if (fill && 'reason' in fill) return false
  if (hasVisibleStroke(node) && 'strokes' in node) {
    const stroke = topPaint(node.strokes)
    if (stroke && 'reason' in stroke) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

export interface ColorUse {
  hex: string
  count: number
}

export interface NearPair {
  a: string
  b: string
  deltaE: number
}

export interface ScanResult {
  /** Sorted by count, most used first. Mask shapes are not counted. */
  colors: ColorUse[]
  nearPairs: NearPair[]
  unprintable: SkippedLayer[]
  /** Supported masks found. */
  masks: number
  /** Visible layers walked. */
  layers: number
}

/**
 * Counts the solid colors a frame paints and lists what cannot print. It only
 * reads, so it can run on the original selection, instances included.
 * Hidden layers are skipped, as print mode removes them from its copy.
 */
export async function scanColors(root: SceneNode, onProgress: ProgressCallback): Promise<ScanResult> {
  const counts = new Map<string, number>()
  const unprintable: SkippedLayer[] = []
  const report = createProgressReporter(0, onProgress)
  let masks = 0
  let layers = 0

  // One entry per layer, with the first reason found.
  function flag(node: SceneNode, reason: UnprintableReason) {
    const last = unprintable[unprintable.length - 1]
    if (last && last.name === node.name && last.reason === reason) return
    unprintable.push({ name: node.name, reason })
  }

  function countPaint(node: SceneNode, paint: TopPaint) {
    if (!paint) return
    if ('reason' in paint) flag(node, paint.reason)
    else counts.set(paint.hex, (counts.get(paint.hex) || 0) + 1)
  }

  async function visit(node: SceneNode) {
    if (!node.visible) return
    layers++
    await report(layers, 0)

    const problem = layerProblem(node)
    if (problem) {
      flag(node, problem)
      return
    }
    if ('fills' in node) countPaint(node, topPaint(node.fills))
    if (hasVisibleStroke(node) && 'strokes' in node) countPaint(node, topPaint(node.strokes))

    // A boolean paints its combined shape; its children are only operands.
    if (node.type === 'BOOLEAN_OPERATION' || !('children' in node)) return
    for (const child of node.children) {
      if ('isMask' in child && child.isMask) {
        if (!child.visible) continue
        layers++
        if (isSupportedMask(child)) masks++
        else flag(child, 'unsupported mask')
        continue
      }
      await visit(child)
    }
  }

  await visit(root)

  const colors = Array.from(counts, ([hex, count]) => ({ hex, count })).sort((a, b) => b.count - a.count)
  return { colors, nearPairs: findNearPairs(colors), unprintable, masks, layers }
}

/** Pairs of colors closer than NEAR_IDENTICAL_DELTA_E, reported but never merged. */
export function findNearPairs(colors: ColorUse[]): NearPair[] {
  const pairs: NearPair[] = []
  for (let i = 0; i < colors.length; i++) {
    for (let j = i + 1; j < colors.length; j++) {
      const deltaE = deltaE2000(colors[i].hex, colors[j].hex)
      if (deltaE < NEAR_IDENTICAL_DELTA_E) {
        pairs.push({ a: colors[i].hex, b: colors[j].hex, deltaE: Math.round(deltaE * 10) / 10 })
      }
    }
  }
  return pairs
}
