// Plugin entry point. Runs in Figma's sandbox and talks to ui.html via messages.

import { cloneBeside, countSelection, describeSelection, freezeCopies, partitionSelection, removeHiddenLayers } from './freeze'
import { knockout } from './print/knockout'
import { writeInks } from './print/output'
import { buildPaintList } from './print/paint-list'
import { ColorUse, findNearPairs, scanColors } from './print/scan'

// This is already false in Figma (true only in Dev Mode), but we set it
// explicitly: a hidden nested instance is still a link to a component, so the
// traversal must not skip it.
figma.skipInvisibleInstanceChildren = false

figma.showUI(__html__, { width: 320, height: 560, themeColors: false })

let busy = false

// Names only: searching a large frame on every selection change made
// selecting feel slow. Counting waits for the COUNT key.
function postSelection() {
  figma.ui.postMessage({ type: 'selection', summary: describeSelection(figma.currentPage.selection) })
}

figma.on('selectionchange', () => {
  if (!busy) postSelection()
})

figma.ui.onmessage = async (message: { type: string; rename?: boolean; removeHidden?: boolean; shirt?: string }) => {
  if (message.type === 'ready') postSelection()
  if (message.type === 'count' && !busy) {
    figma.ui.postMessage({ type: 'count', ...countSelection(figma.currentPage.selection) })
  }
  if (message.type === 'freeze' && !busy) await freeze(Boolean(message.rename), Boolean(message.removeHidden))
  if (message.type === 'scan' && !busy) await scan()
  if (message.type === 'prepare' && !busy) await prepare(String(message.shirt))
}

/** Print mode works on exactly one frame, or an instance (a frame once detached). */
function printTarget(): FrameNode | InstanceNode | null {
  const selection = figma.currentPage.selection
  if (selection.length !== 1) return null
  const [node] = selection
  return node.type === 'FRAME' || node.type === 'INSTANCE' ? node : null
}

async function scan() {
  const target = printTarget()
  if (!target) {
    figma.ui.postMessage({ type: 'error', message: 'Select one frame to prepare for print.' })
    return
  }

  busy = true
  try {
    const result = await scanColors(target, (done, total, depth) => {
      figma.ui.postMessage({ type: 'progress', stage: 'scan', done, total, depth })
    })
    busy = false
    // Selection changes are ignored while busy. If it moved on, this result
    // belongs to a frame that is no longer selected.
    const current = printTarget()
    if (!current || current.id !== target.id) {
      postSelection()
      figma.ui.postMessage({ type: 'error', message: 'Selection changed during the scan. Scan again.' })
      return
    }
    figma.ui.postMessage({ type: 'scan', ...result })
  } catch (error) {
    busy = false
    figma.ui.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}

type PrintStage = 'copy' | 'read' | 'knockout' | 'write'

function postStage(stage: PrintStage) {
  return (done: number, total: number, depth: number) => {
    figma.ui.postMessage({ type: 'progress', stage, done, total, depth })
  }
}

/**
 * Rebuilds a copy of the selected frame as one group per ink, with the shirt
 * color knocked out. The original is never touched; if anything fails the
 * copy is removed again.
 */
async function prepare(shirt: string) {
  const target = printTarget()
  if (!target) {
    figma.ui.postMessage({ type: 'error', message: 'Select one frame to prepare for print.' })
    return
  }
  if (!/^#[0-9A-F]{6}$/.test(shirt)) {
    figma.ui.postMessage({ type: 'error', message: 'Choose the shirt color first.' })
    return
  }

  busy = true
  const started = Date.now()
  let copy: SceneNode | null = null
  try {
    postStage('copy')(0, 0, 0)
    const [clone] = cloneBeside([target], true, 'print')
    copy = clone
    // Detaching the root here keeps one stable reference to the copy, so it can
    // be removed if a later step fails. freezeCopies then handles the rest.
    const frame = clone.type === 'INSTANCE' ? clone.detachInstance() : clone
    copy = frame
    if (frame.type !== 'FRAME') throw new Error('The copy is not a frame.')

    // Unlike freeze, a copy without instances is kept: print mode always has work to do.
    const frozen = await freezeCopies([frame], postStage('copy'))
    const hidden = removeHiddenLayers([frame])

    const list = await buildPaintList(frame, postStage('read'))
    const result = await knockout(list.items, list.regions, shirt, postStage('knockout'))

    const counts = new Map<string, number>()
    for (const item of list.items) counts.set(item.color, (counts.get(item.color) || 0) + 1)
    const colors: ColorUse[] = Array.from(counts, ([hex, count]) => ({ hex, count })).sort((a, b) => b.count - a.count)
    const inks = await writeInks(
      frame,
      result.inks,
      colors.map((color) => color.hex),
      postStage('write'),
    )

    // One undo step for the whole run, as in freeze.
    figma.commitUndo()
    figma.currentPage.selection = [frame]
    busy = false
    postSelection()
    figma.ui.postMessage({
      type: 'printResult',
      colors,
      nearPairs: findNearPairs(colors),
      shapes: list.items.length,
      strokesOutlined: list.strokesOutlined,
      textOutlined: list.textOutlined,
      clipsApplied: list.clipsApplied,
      masksApplied: list.masksApplied,
      inks,
      shirtRemoved: result.shirtRemoved,
      skipped: frozen.skipped.concat(hidden.skipped, list.skipped),
      durationMs: Date.now() - started,
    })
  } catch (error) {
    if (copy && !copy.removed) copy.remove()
    busy = false
    postSelection()
    figma.ui.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}

async function freeze(rename: boolean, removeHidden: boolean) {
  const { accepted, skipped } = partitionSelection(figma.currentPage.selection)
  if (accepted.length === 0) {
    figma.ui.postMessage({ type: 'error', message: 'Nothing to freeze. Select a frame or an instance.' })
    return
  }

  busy = true
  try {
    const copies = cloneBeside(accepted, rename)
    const result = await freezeCopies(copies, (done, total, depth) => {
      figma.ui.postMessage({ type: 'progress', done, total, depth })
    })

    // We only learn the instance count while freezing (counting up front would
    // mean an extra search). With nothing to detach or flatten, the copy is
    // pointless, so remove it again.
    if (result.total === 0 && result.flattened === 0) {
      result.copies.forEach((copy) => copy.remove())
      busy = false
      figma.ui.postMessage({ type: 'error', message: 'No instances in selection. Nothing was copied.' })
      return
    }

    const hidden = removeHidden ? removeHiddenLayers(result.copies) : { removed: 0, skipped: [] }

    // Until commitUndo() is called, everything the plugin has changed counts as
    // one undo step. Committing here closes this freeze as its own step, so a
    // second run in the same session can be undone separately.
    figma.commitUndo()

    // Select the copies, so the next COUNT confirms they hold no instances.
    // The selection update goes out before the result.
    figma.currentPage.selection = result.copies
    busy = false
    postSelection()
    figma.ui.postMessage({
      type: 'result',
      detached: result.detached,
      depth: result.depth,
      remaining: result.remaining,
      copies: result.copies.length,
      flattened: result.flattened,
      hiddenRemoved: hidden.removed,
      skipped: skipped.concat(result.skipped, hidden.skipped),
    })
  } catch (error) {
    busy = false
    postSelection()
    figma.ui.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}
