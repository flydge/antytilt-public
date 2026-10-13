import puppeteer from 'puppeteer-core'

const port = process.argv[2] || '9223'
const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, protocolTimeout: 30000 })
const pages = await browser.pages()
const page = pages.find((item) => item.url().includes('127.0.0.1'))

if (!page) throw new Error('Terminal page was not found in the Chrome debugging session')
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 })

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
if (await page.$('.auth-card')) {
  await page.click('.auth-tabs button:nth-child(2)')
  await page.type('.auth-card input[type="email"]', `drawing-smoke-${Date.now()}@example.com`)
  await page.type('.auth-card input[type="password"]', 'correct-horse-battery-staple')
  await page.click('.auth-submit')
  await page.waitForSelector('.chart-viewport')
}
const authSession = await page.evaluate(() => fetch('/api/auth/session').then((response) => response.json()))
if (!authSession?.user?.id) throw new Error('Drawing smoke test requires an authenticated user')
const storageKey = `antytilt:${authSession.user.id}:drawings:BINANCE:PERPETUAL:BTCUSDT:v2`
const readDrawings = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '[]'), storageKey)
const clickElement = (selector) => page.evaluate((value) => {
  const element = document.querySelector(value)
  if (!(element instanceof HTMLElement || element instanceof SVGElement)) throw new Error(`Missing element: ${value}`)
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
}, selector)
const pointerAt = (type, x, y, buttons = 0) => page.evaluate(({ eventType, clientX, clientY, pressedButtons }) => {
  const element = document.elementFromPoint(clientX, clientY)
  if (!element) throw new Error('No element at pointer coordinates')
  element.dispatchEvent(new PointerEvent(eventType, {
    bubbles: true,
    clientX,
    clientY,
    button: 0,
    buttons: pressedButtons,
    pointerId: 1,
  }))
}, { eventType: type, clientX: x, clientY: y, pressedButtons: buttons })
const selectTool = async (label, group) => {
  const selector = `[aria-label="${label}"]`
  if (!(await page.$(selector)) && group) {
    await clickElement(`[aria-label="Open ${group}"]`)
    await page.waitForSelector(selector)
  }
  await clickElement(selector)
}

await page.evaluate((key) => {
  localStorage.removeItem(key)
  localStorage.setItem(`antytilt:${key.split(':')[1]}:selected-market`, 'BTCUSDT')
}, storageKey)
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForSelector('.chart-viewport')
await wait(1200)

const results = {}
results.groupedToolbar = (await page.$$('.drawing-tool-group')).length >= 3
await selectTool('Trend line · T', 'Line tools')
const viewport = await page.$eval('.chart-viewport', (element) => {
  const rect = element.getBoundingClientRect()
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
})

await pointerAt('pointerdown', viewport.left + viewport.width * 0.25, viewport.top + viewport.height * 0.67, 1)
await pointerAt('pointerup', viewport.left + viewport.width * 0.25, viewport.top + viewport.height * 0.67)
await pointerAt('pointermove', viewport.left + viewport.width * 0.62, viewport.top + viewport.height * 0.3)
results.previewVisible = Boolean(await page.$('.chart-drawing.preview'))
await pointerAt('pointerdown', viewport.left + viewport.width * 0.62, viewport.top + viewport.height * 0.3, 1)
await pointerAt('pointerup', viewport.left + viewport.width * 0.62, viewport.top + viewport.height * 0.3)
await wait(200)

let stored = await readDrawings()
results.createdCount = stored.length
results.propertiesVisible = Boolean(await page.$('.drawing-properties'))
results.propertiesClearOfRightEdge = await page.$eval('.drawing-properties', (element) => {
  const panel = element.getBoundingClientRect()
  const viewport = document.querySelector('.chart-viewport')?.getBoundingClientRect()
  return Boolean(viewport && panel.right < viewport.right - 55)
})
if (stored.length !== 1) throw new Error(`Expected one drawing, received ${stored.length}`)
const anchorsBeforeDrag = stored[0].anchors

const handle = await page.$eval('.drawing-anchor', (element) => {
  const rect = element.getBoundingClientRect()
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
})
await pointerAt('pointerdown', handle.x, handle.y, 1)
await wait(50)
results.propertiesHiddenWhileDragging = !(await page.$('.drawing-properties'))
await page.evaluate(({ x, y }) => {
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1 }))
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, button: 0, buttons: 0, pointerId: 1 }))
}, { x: handle.x + 55, y: handle.y - 28 })
await wait(250)

stored = await readDrawings()
const anchorsAfterDrag = stored[0].anchors
results.anchorMoved = JSON.stringify(anchorsBeforeDrag) !== JSON.stringify(anchorsAfterDrag)
await page.screenshot({ path: '/tmp/antytilt-drawing-interaction.png' })

const lineCenter = await page.$eval('.drawing-hit', (element) => {
  const svgRect = element.ownerSVGElement.getBoundingClientRect()
  return {
    x: svgRect.left + (Number(element.getAttribute('x1')) + Number(element.getAttribute('x2'))) / 2,
    y: svgRect.top + (Number(element.getAttribute('y1')) + Number(element.getAttribute('y2'))) / 2,
  }
})
await pointerAt('pointerdown', lineCenter.x, lineCenter.y, 1)
await page.evaluate(({ x, y }) => {
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1 }))
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, button: 0, buttons: 0, pointerId: 1 }))
}, { x: lineCenter.x + 42, y: lineCenter.y + 20 })
await wait(200)
stored = await readDrawings()
const anchorsAfterBodyDrag = stored[0].anchors
results.wholeLineMoved = JSON.stringify(anchorsAfterBodyDrag) !== JSON.stringify(anchorsAfterDrag)

await clickElement('[aria-label="Undo drawing"]')
await wait(150)
stored = await readDrawings()
results.bodyUndoRestored = JSON.stringify(stored[0].anchors) === JSON.stringify(anchorsAfterDrag)

await clickElement('[aria-label="Undo drawing"]')
await wait(150)
stored = await readDrawings()
results.anchorUndoRestored = JSON.stringify(stored[0].anchors) === JSON.stringify(anchorsBeforeDrag)

await clickElement('[aria-label="Redo drawing"]')
await wait(150)
stored = await readDrawings()
results.anchorRedoRestored = JSON.stringify(stored[0].anchors) === JSON.stringify(anchorsAfterDrag)

await clickElement('[aria-label="Redo drawing"]')
await wait(150)
stored = await readDrawings()
results.bodyRedoRestored = JSON.stringify(stored[0].anchors) === JSON.stringify(anchorsAfterBodyDrag)

const currentLineCenter = await page.$eval('.drawing-hit', (element) => {
  const svgRect = element.ownerSVGElement.getBoundingClientRect()
  return {
    x: svgRect.left + (Number(element.getAttribute('x1')) + Number(element.getAttribute('x2'))) / 2,
    y: svgRect.top + (Number(element.getAttribute('y1')) + Number(element.getAttribute('y2'))) / 2,
  }
})
await pointerAt('pointerdown', currentLineCenter.x, currentLineCenter.y, 1)
await pointerAt('pointerup', currentLineCenter.x, currentLineCenter.y)
await wait(100)
const edgeHandle = await page.$$eval('.drawing-anchor', (elements) => {
  const element = elements.at(-1)
  if (!element) throw new Error('Trend-line endpoint was not found')
  const rect = element.getBoundingClientRect()
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
})
await pointerAt('pointerdown', edgeHandle.x, edgeHandle.y, 1)
await page.evaluate(({ x, y }) => {
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1 }))
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, button: 0, buttons: 0, pointerId: 1 }))
}, { x: viewport.left + viewport.width + 160, y: viewport.top + viewport.height * 0.22 })
await wait(200)
results.edgeCoordinates = await page.$eval('.drawing-overlay', (element) => {
  const plotRight = element.viewBox.baseVal.width - 55
  const anchors = Array.from(element.querySelectorAll('.drawing-anchor')).map((anchor) => Number(anchor.getAttribute('cx')))
  return { plotRight, anchors }
})
results.edgeDragReachedPlot = results.edgeCoordinates.anchors.some((x) => Math.abs(x - results.edgeCoordinates.plotRight) <= 2)
stored = await readDrawings()
results.futureAnchorPersisted = stored[0].anchors.some((anchor) => Number.isFinite(anchor.logical))

await clickElement('.objects-control')
await clickElement('.object-row')
results.objectPanelVisible = Boolean(await page.$('.drawing-objects-panel'))
await clickElement('.drawing-property-actions .delete')
await wait(150)
results.deletedCount = (await readDrawings()).length
await clickElement('.objects-title button')

const toolCases = [
  { label: 'Trend line · T', group: 'Line tools', points: [[0.18, 0.7], [0.42, 0.46]] },
  { label: 'Ray', group: 'Line tools', points: [[0.2, 0.58], [0.4, 0.43]] },
  { label: 'Horizontal line · H', group: 'Line tools', points: [[0.35, 0.4]] },
  { label: 'Vertical line', group: 'Line tools', points: [[0.47, 0.54]] },
  { label: 'Fibonacci · F', group: 'Fibonacci & shapes', points: [[0.25, 0.72], [0.49, 0.35]] },
  { label: 'Rectangle · R', group: 'Fibonacci & shapes', points: [[0.53, 0.63], [0.68, 0.43]] },
  { label: 'Price range · M', points: [[0.58, 0.7], [0.73, 0.52]] },
  { label: 'Long position', group: 'Risk / reward', points: [[0.34, 0.5], [0.48, 0.66], [0.5, 0.28]] },
  { label: 'Short position', group: 'Risk / reward', points: [[0.52, 0.44], [0.65, 0.27], [0.67, 0.69]] },
  { label: 'Text note · N', points: [[0.72, 0.36]] },
]

for (const tool of toolCases) {
  await selectTool(tool.label, tool.group)
  for (const [x, y] of tool.points) {
    await pointerAt('pointerdown', viewport.left + viewport.width * x, viewport.top + viewport.height * y, 1)
    await pointerAt('pointerup', viewport.left + viewport.width * x, viewport.top + viewport.height * y)
  }
  if (tool.label.startsWith('Text note')) {
    await page.waitForSelector('.drawing-inline-editor input')
    await page.$eval('.drawing-inline-editor input', (input) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, '')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await page.type('.drawing-inline-editor input', 'Breakout confirmation')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => !document.querySelector('.drawing-inline-editor'))
  }
}
await wait(250)
stored = await readDrawings()
results.allToolsCreated = stored.length === toolCases.length
results.inlineTextSaved = stored.some((drawing) => drawing.type === 'text' && drawing.text === 'Breakout confirmation')
results.measurementDetails = await page.$$eval('.drawing-measure-label', (elements) => {
  const content = elements.map((element) => element.textContent?.replace(/\s+/g, ' ').trim()).find((text) => text?.includes('bar'))
  return { content, hasPercent: Boolean(content?.includes('%')), hasDuration: Boolean(content?.match(/\d+(?:s|m|h|d)/)), hasRange: Boolean(content?.includes('→')) }
})
results.horizontalLabelInsidePlot = await page.$eval('.drawing-axis-badge rect', (element) => {
  const x = Number(element.getAttribute('x'))
  const width = Number(element.getAttribute('width'))
  const svgWidth = element.ownerSVGElement.viewBox.baseVal.width
  const plotRight = svgWidth - 55
  return x >= 0 && x + width <= plotRight
})
await page.screenshot({ path: '/tmp/antytilt-drawing-tools.png' })

const passed = results.previewVisible
  && results.groupedToolbar
  && results.createdCount === 1
  && results.propertiesVisible
  && results.propertiesClearOfRightEdge
  && results.propertiesHiddenWhileDragging
  && results.anchorMoved
  && results.wholeLineMoved
  && results.bodyUndoRestored
  && results.anchorUndoRestored
  && results.anchorRedoRestored
  && results.bodyRedoRestored
  && results.edgeDragReachedPlot
  && results.futureAnchorPersisted
  && results.objectPanelVisible
  && results.deletedCount === 0
  && results.allToolsCreated
  && results.inlineTextSaved
  && results.measurementDetails.hasPercent
  && results.measurementDetails.hasDuration
  && results.measurementDetails.hasRange
  && results.horizontalLabelInsidePlot

console.log(JSON.stringify({ passed, ...results }, null, 2))
await browser.disconnect()
if (!passed) process.exitCode = 1
