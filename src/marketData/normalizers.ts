import type { BookLevel, Candle, MarketTrade, Ticker } from '../types'
import type { MarketDataExchange } from './types'

export function marketSymbol(exchange: MarketDataExchange, baseAsset: string) {
  const base = baseAsset.trim().toUpperCase()
  if (!/^[A-Z0-9]{2,20}$/.test(base)) throw new Error('Unsupported market symbol')
  if (exchange === 'bingx') return `${base}-USDT`
  if (exchange === 'okx') return `${base}-USDT-SWAP`
  return `${base}USDT`
}

export function marketInterval(exchange: MarketDataExchange, interval: string) {
  const supported = new Set(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '1w', '1M'])
  if (!supported.has(interval)) throw new Error(`Unsupported market interval: ${interval}`)
  if (exchange === 'bybit') {
    return ({ '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '2h': '120', '4h': '240', '6h': '360', '8h': '480', '12h': '720', '1d': 'D', '1w': 'W', '1M': 'M' } as Record<string, string>)[interval] ?? interval
  }
  if (exchange === 'okx') {
    return ({ '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1H', '2h': '2H', '4h': '4H', '6h': '6H', '8h': '8H', '12h': '12H', '1d': '1D', '1w': '1W', '1M': '1M' } as Record<string, string>)[interval] ?? interval
  }
  return interval
}

export function normalizeBookRows(rows: unknown, limit = 20): BookLevel[] {
  if (!Array.isArray(rows)) return []
  let runningTotal = 0
  const levels: BookLevel[] = []
  for (const row of rows.slice(0, limit)) {
    if (!Array.isArray(row)) continue
    const price = Number(row[0])
    const quantity = Number(row[1])
    if (!(price > 0) || !(quantity >= 0)) continue
    runningTotal += quantity
    levels.push({ price, quantity, total: runningTotal })
  }
  return levels
}

export function candleFromArray(row: unknown): Candle | null {
  if (!Array.isArray(row)) return null
  const candle = {
    time: Math.floor(Number(row[0]) / 1_000),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  }
  return candle.time > 0 && candle.open > 0 && candle.high > 0 && candle.low > 0 && candle.close > 0 ? candle : null
}

export function tickerFromValues(values: Partial<Ticker> & Pick<Ticker, 'lastPrice'>, fallbackPrice: number): Ticker {
  const lastPrice = Number(values.lastPrice) > 0 ? Number(values.lastPrice) : fallbackPrice
  return {
    lastPrice,
    priceChangePercent: Number(values.priceChangePercent) || 0,
    highPrice: Number(values.highPrice) || lastPrice,
    lowPrice: Number(values.lowPrice) || lastPrice,
    volume: Number(values.volume) || 0,
    quoteVolume: Number(values.quoteVolume) || 0,
  }
}

export function tradeFromValues(values: {
  id: string | number
  price: unknown
  quantity: unknown
  time: unknown
  side: 'buy' | 'sell'
}): MarketTrade | null {
  const price = Number(values.price)
  const quantity = Number(values.quantity)
  const time = Number(values.time)
  if (!(price > 0) || !(quantity >= 0) || !(time > 0)) return null
  const numericId = Number(values.id)
  return {
    id: Number.isSafeInteger(numericId) ? numericId : hashMarketId(String(values.id)),
    price,
    quantity,
    time,
    side: values.side,
  }
}

export function hashMarketId(value: string) {
  let hash = 2_166_136_261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return hash >>> 0
}

export function mergeCandle(candles: Candle[], next: Candle) {
  const last = candles[candles.length - 1]
  if (last?.time === next.time) return [...candles.slice(0, -1), next]
  if (last && next.time < last.time) return candles
  return [...candles.slice(-499), next]
}

export function levelsFromMap(levels: Map<number, number>, direction: 'asks' | 'bids', limit = 20) {
  const rows = [...levels.entries()]
    .filter(([price, quantity]) => price > 0 && quantity > 0)
    .sort(([left], [right]) => direction === 'asks' ? left - right : right - left)
    .slice(0, limit)
    .map(([price, quantity]) => [String(price), String(quantity)])
  return normalizeBookRows(rows, limit)
}
