// Plugin entry point. Runs in Figma's sandbox and talks to ui.html via messages.

import { cloneBeside, detachAll, flattenComponents, partitionSelection, summarizeSelection } from './freeze'

// This is already false in Figma (true only in Dev Mode), but we set it
// explicitly: a hidden nested instance is still a link to a component, so the
// traversal must not skip it.
figma.skipInvisibleInstanceChildren = false

figma.showUI(__html__, { width: 320, height: 420, themeColors: false })

let busy = false

function postSelection() {
  figma.ui.postMessage({ type: 'selection', summary: summarizeSelection(figma.currentPage.selection) })
}

figma.on('selectionchange', () => {
  if (!busy) postSelection()
})

figma.ui.onmessage = async (message: { type: string; rename?: boolean }) => {
  if (message.type === 'ready') postSelection()
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
    const flattening = flattenComponents(copies)
    const result = await detachAll(copies, (done, total, depth) => {
      figma.ui.postMessage({ type: 'progress', done, total, depth })
    })

    // Until commitUndo() is called, everything the plugin has changed counts as
    // one undo step. Committing here closes this freeze as its own step, so a
    // second run in the same session can be undone separately.
    figma.commitUndo()

    // Select the copies so the readout shows their instance count (zero when
    // everything worked). The selection update goes out before the result.
    figma.currentPage.selection = result.copies
    busy = false
    postSelection()
    figma.ui.postMessage({
      type: 'result',
      detached: result.detached,
      depth: result.depth,
      remaining: result.remaining,
      copies: result.copies.length,
      flattened: flattening.flattened,
      skipped: skipped.concat(flattening.skipped, result.skipped),
    })
  } catch (error) {
    busy = false
    postSelection()
    figma.ui.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}
