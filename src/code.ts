// Plugin entry point. Runs in Figma's sandbox and talks to ui.html via messages.

import { cloneBeside, countSelection, describeSelection, freezeCopies, partitionSelection } from './freeze'

// This is already false in Figma (true only in Dev Mode), but we set it
// explicitly: a hidden nested instance is still a link to a component, so the
// traversal must not skip it.
figma.skipInvisibleInstanceChildren = false

figma.showUI(__html__, { width: 320, height: 420, themeColors: false })

let busy = false

// Names only: searching a large frame on every selection change made
// selecting feel slow. Counting waits for the COUNT key.
function postSelection() {
  figma.ui.postMessage({ type: 'selection', summary: describeSelection(figma.currentPage.selection) })
}

figma.on('selectionchange', () => {
  if (!busy) postSelection()
})

figma.ui.onmessage = async (message: { type: string; rename?: boolean }) => {
  if (message.type === 'ready') postSelection()
  if (message.type === 'count' && !busy) {
    figma.ui.postMessage({ type: 'count', ...countSelection(figma.currentPage.selection) })
  }
  if (message.type === 'freeze' && !busy) await freeze(Boolean(message.rename))
}

async function freeze(rename: boolean) {
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
      skipped: skipped.concat(result.skipped),
    })
  } catch (error) {
    busy = false
    postSelection()
    figma.ui.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}
