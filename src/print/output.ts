// Print mode output: replaces the copy's contents with one group per ink, each
// holding a single compound path.

import { createProgressReporter, ProgressCallback } from '../freeze'
import { fromHex } from './color'
import { Paths, pathsToData } from './geometry'

/**
 * Empties the copy and writes the inks into it. `order` lists the inks to
 * write, largest first; the first one ends up as the top layer. Returns the
 * hex of each group written, in that order.
 */
export async function writeInks(
  copy: FrameNode,
  inks: Map<string, Paths>,
  order: string[],
  onProgress: ProgressCallback,
): Promise<string[]> {
  for (const child of copy.children.slice()) child.remove()
  copy.fills = []
  copy.strokes = []
  // Auto layout would rearrange the ink groups into a row or column.
  if (copy.layoutMode !== 'NONE') copy.layoutMode = 'NONE'

  const written = order.filter((hex) => inks.has(hex))
  const report = createProgressReporter(written.length, onProgress)

  // Each new child goes on top, so write from the last ink to the first.
  for (let index = written.length - 1; index >= 0; index--) {
    const hex = written[index]
    const paths = inks.get(hex) as Paths
    // The vector sits at the frame origin and its path data is frame-local, so
    // it lands in place. Figma then moves the data to start at 0,0 and shifts
    // the vector to match (checked, rotated frames included).
    const vector = figma.createVector()
    copy.appendChild(vector)
    vector.vectorPaths = [{ windingRule: 'EVENODD', data: pathsToData(paths, copy.absoluteTransform) }]
    vector.fills = [{ type: 'SOLID', color: fromHex(hex) }]
    vector.strokes = []
    vector.name = hex

    const group = figma.group([vector], copy)
    group.name = hex
    await report(written.length - index, 0)
  }
  return written
}
