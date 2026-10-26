// Renders the icon PNG, a UI screenshot and the README cover image.
// Dev only: run with `npm run render` after `npm run build`.
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fileUrl = (relative) => 'file://' + path.join(root, relative)

// Realistic data, sent to ui.html exactly as the plugin would send it.
const readySelection = {
  type: 'selection',
  summary: { names: ['Home / Desktop'], layerCount: 1, instanceCount: 148, depth: 3, skipped: [] },
}
// After a run the plugin selects the copy, which has no instances left.
const frozenSelection = {
  type: 'selection',
  summary: { names: ['Home / Desktop / frozen 2026-10-27 14:32'], layerCount: 1, instanceCount: 0, depth: 0, skipped: [] },
}
const result = {
  type: 'result',
  detached: 148,
  depth: 3,
  remaining: 0,
  copies: 1,
  skipped: [{ name: 'Logo', reason: 'main component, not an instance' }],
}

async function screenshotUi(browser, messages, outputPath) {
  const page = await browser.newPage({ viewport: { width: 320, height: 420 }, deviceScaleFactor: 2 })
  await page.goto(fileUrl('ui.html'))
  await page.evaluate((list) => list.forEach((message) => window.postMessage({ pluginMessage: message }, '*')), messages)
  await page.waitForTimeout(100)
  await page.screenshot({ path: path.join(root, outputPath) })
}

const browser = await chromium.launch()

// Icon at 128 x 128
const iconPage = await browser.newPage({ viewport: { width: 128, height: 128 } })
await iconPage.goto(fileUrl('assets/icon.svg'))
await iconPage.screenshot({ path: path.join(root, 'assets/icon-128.png'), omitBackground: true })

// UI on its own, at 2x: ready to run, and after a run
await screenshotUi(browser, [readySelection], 'docs/ui-ready.png')
await screenshotUi(browser, [frozenSelection, result], 'docs/ui-result.png')

// Cover at 1920 x 1080
const coverPage = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
await coverPage.goto(fileUrl('scripts/cover.html'))
await coverPage.waitForTimeout(300)
await coverPage.screenshot({ path: path.join(root, 'docs/cover.png') })

await browser.close()
console.log('Rendered assets/icon-128.png, docs/ui-ready.png, docs/ui-result.png, docs/cover.png')
