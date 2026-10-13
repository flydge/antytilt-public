import puppeteer from 'puppeteer-core'

const appPort = process.argv[2] || '5173'
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--no-sandbox'],
})

try {
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto(`http://127.0.0.1:${appPort}`, { waitUntil: 'domcontentloaded' })
  const result = await page.evaluate(async () => {
    const { getMarketDataAdapter } = await import('/src/marketData/index.ts')
    const { BINANCE_MINI_TICKER_WS } = await import('/src/hooks/useMarketCatalog.ts')
    const exchanges = ['binance', 'bingx', 'bybit', 'okx']
    const exchangeResults = await Promise.all(exchanges.map(async (exchange) => {
      const adapter = getMarketDataAdapter(exchange)
      const request = { baseAsset: 'BTC', interval: '1m', fallbackPrice: 78_000 }
      const snapshot = await adapter.loadInitial(request, new AbortController().signal)
      let opened = false
      let updates = 0
      let candleUpdates = 0
      let tickerUpdates = 0
      let depthUpdates = 0
      let tradeUpdates = 0
      let stop = () => undefined
      await new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
          stop()
          reject(new Error(`${exchange} WebSocket timed out`))
        }, 15_000)
        stop = adapter.subscribe(request, {
          onOpen: () => { opened = true },
          onClose: () => undefined,
          onUpdate: (update) => {
            updates += 1
            if (update.candles?.length) candleUpdates += 1
            if (update.ticker) tickerUpdates += 1
            if (update.asks?.length || update.bids?.length) depthUpdates += 1
            if (update.trades?.length) tradeUpdates += 1
            if (!opened || candleUpdates < 2 || tickerUpdates < 1 || depthUpdates < 1 || tradeUpdates < 1) return
            window.clearTimeout(timer)
            stop()
            resolve(undefined)
          },
        })
      })
      return {
        exchange,
        candles: snapshot.candles?.length ?? 0,
        asks: snapshot.asks?.length ?? 0,
        trades: snapshot.trades?.length ?? 0,
        opened,
        updates,
        candleUpdates,
        tickerUpdates,
        depthUpdates,
        tradeUpdates,
      }
    }))
    const catalog = await new Promise((resolve, reject) => {
      const socket = new WebSocket(BINANCE_MINI_TICKER_WS)
      const timer = window.setTimeout(() => {
        socket.close()
        reject(new Error('Binance catalog mini ticker timed out'))
      }, 15_000)
      socket.onerror = () => {
        window.clearTimeout(timer)
        reject(new Error('Binance catalog mini ticker failed'))
      }
      socket.onmessage = (event) => {
        const rows = JSON.parse(String(event.data))
        if (!Array.isArray(rows)) return
        const btc = rows.find((item) => item?.s === 'BTCUSDT')
        if (!btc || !(Number(btc.c) > 0)) return
        window.clearTimeout(timer)
        socket.close()
        resolve({ messages: 1, btcPrice: Number(btc.c) })
      }
    })
    return { exchangeResults, catalog }
  })
  const passed = pageErrors.length === 0
    && result.catalog.messages > 0
    && result.catalog.btcPrice > 0
    && result.exchangeResults.every((item) => (
    item.candles >= 100
      && item.asks > 0
      && item.trades > 0
      && item.opened
      && item.candleUpdates >= 2
      && item.tickerUpdates > 0
      && item.depthUpdates > 0
      && item.tradeUpdates > 0
    ))
  console.log(JSON.stringify({ passed, result, pageErrors }, null, 2))
  if (!passed) process.exitCode = 1
} finally {
  await browser.close()
}
