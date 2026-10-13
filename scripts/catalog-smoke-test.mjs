import puppeteer from 'puppeteer-core'

const port = process.argv[2] || '9223'
const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, protocolTimeout: 60_000 })
const page = (await browser.pages()).find((item) => item.url().includes('127.0.0.1'))

if (!page) throw new Error('Terminal page was not found in the Chrome debugging session')
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 })
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text())
})

await page.evaluate(() => {
  localStorage.setItem('antytilt:selected-market', 'BTCUSDT')
  localStorage.removeItem('antytilt:drawings:BINANCE:PERPETUAL:HYPEUSDT:v2')
})
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForSelector('.instrument-name')
await new Promise((resolve) => setTimeout(resolve, 800))

await page.evaluate(() => document.querySelector('.instrument-name')?.click())
await page.waitForSelector('.market-selector')
const catalog = await page.evaluate(() => ({
  count: document.querySelectorAll('.market-row').length,
  selected: document.querySelectorAll('.market-row.selected').length,
  source: document.querySelector('.catalog-source')?.textContent,
}))

await page.evaluate(() => {
  const input = document.querySelector('.market-search input')
  if (!(input instanceof HTMLInputElement)) throw new Error('Market search input is unavailable')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, 'HYPE')
  input.dispatchEvent(new Event('input', { bubbles: true }))
})
await new Promise((resolve) => setTimeout(resolve, 150))

const filtered = await page.evaluate(() => ({
  count: document.querySelectorAll('.market-row').length,
  name: document.querySelector('.market-row .market-identity strong')?.textContent,
}))
await page.evaluate(() => document.querySelector('.market-row')?.click())
await page.waitForFunction(() => document.querySelector('.instrument-name')?.textContent?.includes('HYPEUSDT'))
await new Promise((resolve) => setTimeout(resolve, 700))

const selectedMarket = await page.evaluate(() => ({
  symbol: document.querySelector('.instrument-name')?.textContent?.replace(/\s+/g, ' ').trim(),
  price: document.querySelector('.instrument-price strong')?.textContent,
  meta: document.querySelector('.instrument-meta')?.textContent,
  funding: [...document.querySelectorAll('.market-stat')]
    .find((item) => item.textContent?.includes('Funding'))?.textContent?.replace(/\s+/g, ' ').trim(),
  connection: document.querySelector('.connection-pill')?.textContent?.replace(/\s+/g, ' ').trim(),
  drawingCount: document.querySelectorAll('.chart-drawing:not(.preview)').length,
  catalogOpen: Boolean(document.querySelector('.market-selector')),
  chartCanvas: Boolean(document.querySelector('.chart-canvas canvas')),
  persistedSymbol: localStorage.getItem('antytilt:selected-market'),
}))

const passed = catalog.count === 30
  && catalog.selected === 1
  && filtered.count === 1
  && filtered.name?.includes('HYPE')
  && selectedMarket.persistedSymbol === 'HYPEUSDT'
  && selectedMarket.symbol?.includes('Perpetual')
  && selectedMarket.meta?.includes('Binance USDT-M')
  && selectedMarket.funding?.includes('%')
  && selectedMarket.drawingCount === 0
  && !selectedMarket.catalogOpen
  && selectedMarket.chartCanvas
  && selectedMarket.price !== '0.00'
  && errors.length === 0

console.log(JSON.stringify({ passed, catalog, filtered, selectedMarket, errors }, null, 2))
await browser.disconnect()
if (!passed) process.exitCode = 1
