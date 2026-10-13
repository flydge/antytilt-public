import type { Candle, MarketInstrument, Ticker } from '../types'
import { safeRecord, sortedCandles } from './common'
import { candleFromArray, normalizeBookRows, tradeFromValues } from './normalizers'
import { marketDataSourceLabel, type HyperliquidMarketNetwork, type MarketDataAdapter, type MarketDataRequest, type MarketDataUpdate } from './types'

// Public native perpetual data only; chart network does not confer execution rights.
const endpoints = {
  mainnet: { info: 'https://api.hyperliquid.xyz/info', ws: 'wss://api.hyperliquid.xyz/ws' },
  testnet: { info: 'https://api.hyperliquid-testnet.xyz/info', ws: 'wss://api.hyperliquid-testnet.xyz/ws' },
}
const intervalMs: Record<string, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '8h': 28_800_000, '12h': 43_200_000,
  '1d': 86_400_000, '3d': 259_200_000, '1w': 604_800_000, '1M': 2_678_400_000,
}
const isNativeCoin = (coin: unknown): coin is string => typeof coin === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(coin)
function resolveNetwork(network: HyperliquidMarketNetwork) {
  if (network !== 'mainnet' && network !== 'testnet') throw new Error('Unsupported Hyperliquid market network')
  return network
}
function validate(request: MarketDataRequest) {
  if (!isNativeCoin(request.baseAsset)) throw new Error('Unsupported Hyperliquid native coin symbol')
  if (!intervalMs[request.interval]) throw new Error('Unsupported Hyperliquid interval')
}
function parseCandle(value: unknown, coin: string, interval: string): Candle | null {
  const row = safeRecord(value)
  if (row.s !== coin || row.i !== interval) return null
  const candle = candleFromArray([row.t, row.o, row.h, row.l, row.c, row.v])
  if (!candle || !Object.values(candle).every(Number.isFinite) || candle.volume < 0
    || candle.high < Math.max(candle.open, candle.close) || candle.low > Math.min(candle.open, candle.close)) return null
  return candle
}
function parseContext(value: unknown): MarketDataUpdate | null {
  const row = safeRecord(value)
  const lastPrice = Number(row.markPx), previous = Number(row.prevDayPx)
  const quoteVolume = Number(row.dayNtlVlm), volume = Number(row.dayBaseVlm), fundingRate = Number(row.funding)
  if (!(lastPrice > 0) || !(previous > 0) || !(quoteVolume >= 0)
    || ![lastPrice, previous, quoteVolume, fundingRate].every(Number.isFinite)) return null
  const ticker: Ticker = {
    lastPrice, priceChangePercent: ((lastPrice - previous) / previous) * 100,
    highPrice: NaN, lowPrice: NaN, volume: Number.isFinite(volume) && volume >= 0 ? volume : NaN, quoteVolume,
  }
  return { ticker, fundingRate, nextFundingTime: (Math.floor(Date.now() / 3_600_000) + 1) * 3_600_000 }
}
function parseBook(value: unknown, coin: string): MarketDataUpdate | null {
  const row = safeRecord(value)
  if (row.coin !== coin || !Array.isArray(row.levels) || row.levels.length !== 2 || !row.levels.every(Array.isArray)) return null
  const sides = row.levels.map(side => side.map((level: unknown) => { const item = safeRecord(level); return [item.px, item.sz] }))
  const bids = normalizeBookRows(sides[0]), asks = normalizeBookRows(sides[1])
  if (![...bids, ...asks].every(level => [level.price, level.quantity, level.total].every(Number.isFinite))) return null
  return { bids, asks }
}
function parseTrades(value: unknown, coin: string) {
  if (!Array.isArray(value)) return []
  return value.map(item => {
    const row = safeRecord(item)
    if (row.coin !== coin || (row.side !== 'A' && row.side !== 'B')) return null
    const trade = tradeFromValues({ id: `${row.time}:${coin}:${row.tid}`, price: row.px, quantity: row.sz, time: row.time, side: row.side === 'A' ? 'sell' : 'buy' })
    return trade && [trade.price, trade.quantity, trade.time].every(Number.isFinite) ? trade : null
  }).filter(trade => trade !== null)
}
function metadata(value: unknown) {
  const universe = Array.isArray(value) ? safeRecord(value[0]).universe : undefined
  const contexts = Array.isArray(value) ? value[1] : undefined
  if (!Array.isArray(universe) || !Array.isArray(contexts) || universe.length !== contexts.length) throw new Error('Hyperliquid native market metadata unavailable or invalid')
  const names = universe.map(item => safeRecord(item).name)
  if (new Set(names).size !== names.length) throw new Error('Hyperliquid native market metadata contains ambiguous coins')
  return { universe, contexts }
}
async function info(network: HyperliquidMarketNetwork, body: object, signal: AbortSignal) {
  signal.throwIfAborted()
  const response = await fetch(endpoints[network].info, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })
  if (!response.ok) throw new Error(`${marketDataSourceLabel('hyperliquid', network)} market data failed (${response.status})`)
  return response.json() as Promise<unknown>
}

/** Hourly candles cannot determine rolling extrema through a partial boundary hour. */
export function hyperliquid24hExtrema(candles: Candle[], interval: string, now: number) {
  const unavailable = { highPrice: NaN, lowPrice: NaN }, hour = 3_600_000
  if (interval !== '1h' || now % hour !== 0) return unavailable
  const rows = candles.filter(candle => candle.time * 1000 >= now - 24 * hour && candle.time * 1000 < now)
  if (rows.length !== 24 || rows.some((candle, index) => candle.time * 1000 !== now - (24 - index) * hour)) return unavailable
  return { highPrice: Math.max(...rows.map(row => row.high)), lowPrice: Math.min(...rows.map(row => row.low)) }
}

export async function loadHyperliquidMarketCatalog(network: HyperliquidMarketNetwork, signal: AbortSignal): Promise<MarketInstrument[]> {
  resolveNetwork(network)
  const data = metadata(await info(network, { type: 'metaAndAssetCtxs' }, AbortSignal.any([signal, AbortSignal.timeout(10_000)])))
  signal.throwIfAborted()
  const markets: MarketInstrument[] = []
  data.universe.forEach((value, index) => {
    const item = safeRecord(value)
    if (!isNativeCoin(item.name) || item.isDelisted === true) return
    const ticker = parseContext(data.contexts[index])?.ticker
    if (!ticker) return
    markets.push({
      id: `hyperliquid:${network}:${item.name}`, symbol: `${item.name}/USD`, baseAsset: item.name,
      quoteAsset: 'USD', name: item.name, logoUrl: '', marketCapRank: 0,
      lastPrice: ticker.lastPrice, priceChangePercent: ticker.priceChangePercent, exchanges: ['hyperliquid'],
    })
  })
  if (!markets.length) throw new Error(`${marketDataSourceLabel('hyperliquid', network)} native market catalog unavailable`)
  return markets
}

function createAdapter(defaultNetwork: HyperliquidMarketNetwork): MarketDataAdapter {
  return {
    exchange: 'hyperliquid', label: marketDataSourceLabel('hyperliquid', defaultNetwork),
    async loadInitial(request, signal) {
      validate(request); signal.throwIfAborted()
      const network = resolveNetwork(request.network ?? defaultNetwork), coin = request.baseAsset, endTime = Date.now()
      const batch = new AbortController(), scoped = AbortSignal.any([signal, batch.signal, AbortSignal.timeout(10_000)])
      try {
        const [history, meta, book, trades] = await Promise.all([
          info(network, { type: 'candleSnapshot', req: { coin, interval: request.interval, startTime: endTime - 500 * intervalMs[request.interval], endTime } }, scoped),
          info(network, { type: 'metaAndAssetCtxs' }, scoped), info(network, { type: 'l2Book', coin }, scoped), info(network, { type: 'recentTrades', coin }, scoped),
        ])
        signal.throwIfAborted()
        const data = metadata(meta)
        const index = data.universe.findIndex(item => safeRecord(item).name === coin && safeRecord(item).isDelisted !== true)
        if (index < 0) throw new Error(`${marketDataSourceLabel('hyperliquid', network)} ${coin} unavailable or delisted`)
        const candles = sortedCandles((Array.isArray(history) ? history : []).map(row => parseCandle(row, coin, request.interval)))
        const context = parseContext(data.contexts[index]), depth = parseBook(book, coin)
        if (!candles.length || !context?.ticker || !depth) throw new Error(`${marketDataSourceLabel('hyperliquid', network)} ${coin} market data unavailable: Invalid or empty snapshot`)
        const uniqueCandles = [...new Map(candles.map(candle => [candle.time, candle])).values()]
        return { candles: uniqueCandles, ...context, ticker: { ...context.ticker, ...hyperliquid24hExtrema(uniqueCandles, request.interval, endTime) }, ...depth, trades: parseTrades(trades, coin) }
      } finally { batch.abort() }
    },
    subscribe(request, handlers) {
      validate(request)
      const network = resolveNetwork(request.network ?? defaultNetwork), coin = request.baseAsset
      const socket = new WebSocket(endpoints[network].ws)
      let disposed = false, heartbeat: ReturnType<typeof setInterval> | undefined
      const stopHeartbeat = () => { if (heartbeat !== undefined) clearInterval(heartbeat); heartbeat = undefined }
      socket.onopen = () => {
        if (disposed) return
        for (const subscription of [{ type: 'candle', coin, interval: request.interval }, { type: 'l2Book', coin }, { type: 'trades', coin }, { type: 'activeAssetCtx', coin }]) socket.send(JSON.stringify({ method: 'subscribe', subscription }))
        handlers.onOpen()
        heartbeat = setInterval(() => { if (!disposed && socket.readyState === 1) socket.send(JSON.stringify({ method: 'ping' })) }, 30_000)
      }
      socket.onmessage = event => {
        if (disposed) return
        try {
          const message = safeRecord(JSON.parse(String(event.data)))
          let update: MarketDataUpdate | null = null
          if (message.channel === 'candle') {
            const candles = (Array.isArray(message.data) ? message.data : [message.data]).map(row => parseCandle(row, coin, request.interval)).filter(candle => candle !== null)
            if (candles.length) update = { candles: sortedCandles(candles) }
          } else if (message.channel === 'l2Book') update = parseBook(message.data, coin)
          else if (message.channel === 'trades') { const trades = parseTrades(message.data, coin); if (trades.length) update = { trades } }
          else if (message.channel === 'activeAssetCtx') { const data = safeRecord(message.data); if (data.coin === coin) update = parseContext(data.ctx) }
          else if (message.channel === 'error') { socket.close(); return }
          if (update) handlers.onUpdate(update)
        } catch { socket.close() }
      }
      socket.onclose = () => { stopHeartbeat(); if (!disposed) handlers.onClose() }
      socket.onerror = () => socket.close()
      return () => {
        if (disposed) return
        disposed = true; stopHeartbeat()
        socket.onopen = null; socket.onmessage = null; socket.onclose = null; socket.onerror = null
        socket.close()
      }
    },
  }
}
const adapters = { mainnet: createAdapter('mainnet'), testnet: createAdapter('testnet') }
export const hyperliquidMarketAdapter = adapters.mainnet
export function getHyperliquidMarketAdapter(network: HyperliquidMarketNetwork = 'mainnet') {
  return adapters[resolveNetwork(network)]
}
