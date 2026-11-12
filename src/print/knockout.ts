// Print mode knockout: each ink keeps only the area nothing above it covers.
//
// Paint items are grouped into runs of one color (consecutive in paint order),
// then swept from the top down. The area covered so far is kept per 64 px tile,
// because one region for the whole frame grows to tens of thousands of vertices
// on pixel art and every subtraction against it gets slower.

import { createProgressReporter, ProgressCallback } from '../freeze'
import { boundsOf, difference, GEOMETRY_SCALE, intersect, Paths, union } from './geometry'
import { PaintItem } from './paint-list'

/** Tile size for the covered area. 64 px measured fastest on the reference design. */
const TILE_PX = 64

export interface KnockoutResult {
  /** Visible area per ink, keyed by hex, in order of first appearance from the top. */
  inks: Map<string, Paths>
  /** Shirt-color paint items dropped. */
  shirtRemoved: number
}

interface Run {
  color: string
  items: PaintItem[]
}

/**
 * Sweeps the runs from the top down. Each run's visible part is its area minus
 * everything painted above it; shirt-color runs cover what is below them but
 * are never written.
 */
export async function knockout(
  items: PaintItem[],
  regions: Paths[],
  shirt: string,
  onProgress: ProgressCallback,
): Promise<KnockoutResult> {
  const runs = toRuns(items)
  const report = createProgressReporter(runs.length, onProgress)
  const coveredByTile = new Map<string, Paths>()
  const visibleByInk = new Map<string, Paths>()
  let shirtRemoved = 0

  for (let index = runs.length - 1; index >= 0; index--) {
    const run = runs[index]
    const isShirt = run.color === shirt
    if (isShirt) shirtRemoved += run.items.length
    for (const [tileKey, part] of runAreaByTile(run.items, regions)) {
      const covered = coveredByTile.get(tileKey) || []
      if (!isShirt) {
        const visible = covered.length ? difference(part, covered) : part
        if (visible.length) {
          const pieces = visibleByInk.get(run.color) || []
          for (const path of visible) pieces.push(path)
          visibleByInk.set(run.color, pieces)
        }
      }
      coveredByTile.set(tileKey, union(covered.concat(part)))
    }
    await report(runs.length - index, 0)
  }

  // Tiles meet edge to edge, so the final union joins pieces split by a tile border.
  const inks = new Map<string, Paths>()
  for (const [color, pieces] of visibleByInk) {
    const merged = union(pieces).filter((path) => path.length >= 3)
    if (merged.length) inks.set(color, merged)
  }
  return { inks, shirtRemoved }
}

function toRuns(items: PaintItem[]): Run[] {
  const runs: Run[] = []
  for (const item of items) {
    const last = runs[runs.length - 1]
    if (last && last.color === item.color) last.items.push(item)
    else runs.push({ color: item.color, items: [item] })
  }
  return runs
}

/**
 * A run's area per tile. Items are sorted into tiles first and merged per tile:
 * merging the whole run first and cutting the result into tiles measured three
 * times slower than not tiling at all.
 */
function runAreaByTile(items: PaintItem[], regions: Paths[]): Map<string, Paths> {
  const tilesByClip = new Map<number, Map<string, Paths>>()
  for (const item of items) {
    const tiles = tilesByClip.get(item.clipKey) || new Map<string, Paths>()
    addToTiles(item.paths, tiles)
    tilesByClip.set(item.clipKey, tiles)
  }

  const pieces = new Map<string, Paths>()
  for (const [clipKey, tiles] of tilesByClip) {
    for (const [tileKey, paths] of tiles) {
      let merged = union(paths)
      if (clipKey >= 0) merged = intersect(merged, regions[clipKey])
      if (merged.length === 0) continue
      const list = pieces.get(tileKey) || []
      for (const path of merged) list.push(path)
      pieces.set(tileKey, list)
    }
  }

  // Pieces under different clips can overlap; one clip's pieces are already a union.
  if (tilesByClip.size === 1) return pieces
  const result = new Map<string, Paths>()
  for (const [tileKey, paths] of pieces) result.set(tileKey, union(paths))
  return result
}

/** Adds a shape to every tile it overlaps. Most pixel-art shapes fall inside one tile whole. */
function addToTiles(paths: Paths, tiles: Map<string, Paths>) {
  const tile = TILE_PX * GEOMETRY_SCALE
  const { left, top, right, bottom } = boundsOf(paths)
  const firstColumn = Math.floor(left / tile)
  const firstRow = Math.floor(top / tile)
  const lastColumn = Math.max(firstColumn, Math.ceil(right / tile) - 1)
  const lastRow = Math.max(firstRow, Math.ceil(bottom / tile) - 1)
  const inside = firstColumn === lastColumn && firstRow === lastRow

  for (let row = firstRow; row <= lastRow; row++) {
    for (let column = firstColumn; column <= lastColumn; column++) {
      let part = paths
      if (!inside) {
        const x = column * tile
        const y = row * tile
        const square = [
          [
            { X: x, Y: y },
            { X: x + tile, Y: y },
            { X: x + tile, Y: y + tile },
            { X: x, Y: y + tile },
          ],
        ]
        part = intersect(paths, square)
        if (part.length === 0) continue
      }
      const tileKey = `${column},${row}`
      const bucket = tiles.get(tileKey) || []
      for (const path of part) bucket.push(path)
      tiles.set(tileKey, bucket)
    }
  }
}
