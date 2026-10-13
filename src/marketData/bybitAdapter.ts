import { fetchJson, safeRecord, sortedCandles } from './common'
import { candleFromArray, levelsFromMap, marketInterval, marketSymbol, normalizeBookRows, tickerFromValues, tradeFromValues } from './normalizers'
import type { MarketDataAdapter } from './types'

const REST_URL = 'https://api.bybit.com'
const WS_URL = 'wss://stream.bybit.com/v5/public/linear'

type BybitResponse<T> = { retCode: number; retMsg?: string; result: T }

async function bybitJson<T>(path: string, signal: AbortSignal) {
  const response = await fetchJson<BybitResponse<T>>(`${REST_URL}${path}`, signal)
  if (response.retCode !== 0) throw new Error(response.retMsg || `Bybit market data error ${response.retCode}`)
  return response.result
}

export const bybitMarketAdapter: MarketDataAdapter = {
  exchange: 'bybit',
  label: 'Bybit',
  async loadInitial(request, signal) {
    const symbol = marketSymbol('bybit', request.baseAsset)
    const interval = marketInterval('bybit', request.interval)
    const [history, tickers, depth, recentTrades] = await Promise.all([
      bybitJson<{ list?: unknown[] }>(`/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=500`, signal),
      bybitJson<{ list?: Array<Record<string, unknown>> }>(`/v5/market/tickers?category=linear&symbol=${symbol}`, signal),
      bybitJson<Record<string, unknown>>(`/v5/market/orderbook?category=linear&symbol=${symbol}&limit=50`, signal),
      bybitJson<{ list?: Array<Record<string, unknown>> }>(`/v5/market/recent-trade?category=linear&symbol=${symbol}&limit=24`, signal),
    ])
    const ticker = tickers.list?.[0] ?? {}
    const fundingRate = Number(ticker.fundingRate) || 0
    return {
      candles: sortedCandles((history.list ?? []).map(candleFromArray), true),
      ticker: tickerFromValues({
        lastPrice: Number(ticker.lastPrice),
        priceChangePercent: Number(ticker.price24hPcnt) * 100,
        highPrice: Number(ticker.highPrice24h),
        lowPrice: Number(ticker.lowPrice24h),
        volume: Number(ticker.volume24h),
        quoteVolume: Number(ticker.turnover24h),
      }, request.fallbackPrice),
      fundingRate,
      nextFundingTime: Number(ticker.nextFundingTime) || 0,
      asks: normalizeBookRows(depth.a),
      bids: normalizeBookRows(depth.b),
      trades: (recentTrades.list ?? []).map((trade) => tradeFromValues({
        id: String(trade.execId ?? ''),
        price: trade.price,
        quantity: trade.size,
        time: trade.time,
        side: String(trade.side).toLowerCase() === 'sell' ? 'sell' : 'buy',
      })).filter((trade) => trade !== null),
    }
  },
  subscribe(request, handlers) {
    const symbol = marketSymbol('bybit', request.baseAsset)
    const interval = marketInterval('bybit', request.interval)
    const bids = new Map<number, number>()
    const asks = new Map<number, number>()
    let lastTicker = tickerFromValues({ lastPrice: request.fallbackPrice }, request.fallbackPrice)
    const socket = new WebSocket(WS_URL)

    socket.onopen = () => {
      handlers.onOpen()
      socket.send(JSON.stringify({
        op: 'subscribe',
        args: [`kline.${interval}.${symbol}`, `orderbook.50.${symbol}`, `publicTrade.${symbol}`, `tickers.${symbol}`],
      }))
    }
    socket.onclose = handlers.onClose
    socket.onerror = () => socket.close()
    socket.onmessage = (event) => {
      const message = safeRecord(JSON.parse(String(event.data)))
      const topic = String(message.topic ?? '')
      if (!topic) return

      if (topic.startsWith('kline.')) {
        const rows = Array.isArray(message.data) ? message.data : []
        const row = safeRecord(rows[0])
        const candle = candleFromArray([row.start, row.open, row.high, row.low, row.close, row.volume])
        if (candle) handlers.onUpdate({ candles: [candle] })
        return
      }

      if (topic.startsWith('orderbook.')) {
        const data = safeRecord(message.data)
        if (message.type === 'snapshot') {
          bids.clear()
          asks.clear()
        }
        for (const [target, rows] of [[bids, data.b], [asks, data.a]] as Array<[Map<number, number>, unknown]>) {
          if (!Array.isArray(rows)) continue
          for (const row of rows) {
            if (!Array.isArray(row)) continue
            const price = Number(row[0])
            const quantity = Number(row[1])
            if (!(price > 0)) continue
            if (quantity > 0) target.set(price, quantity)
            else target.delete(price)
          }
        }
        handlers.onUpdate({ bids: levelsFromMap(bids, 'bids'), asks: levelsFromMap(asks, 'asks') })
        return
      }

      if (topic.startsWith('publicTrade.')) {
        const rows = Array.isArray(message.data) ? message.data : []
        const trades = rows.map((value) => {
          const trade = safeRecord(value)
          return tradeFromValues({
            id: String(trade.i ?? `${trade.T ?? ''}:${trade.p ?? ''}`),
            price: trade.p,
            quantity: trade.v,
            time: trade.T,
            side: String(trade.S).toLowerCase() === 'sell' ? 'sell' : 'buy',
          })
        }).filter((trade) => trade !== null)
        if (trades.length) handlers.onUpdate({ trades })
        return
      }

      if (topic.startsWith('tickers.')) {
        const data = safeRecord(message.data)
        lastTicker = tickerFromValues({
          lastPrice: Number(data.lastPrice ?? lastTicker.lastPrice),
          priceChangePercent: data.price24hPcnt === undefined ? lastTicker.priceChangePercent : Number(data.price24hPcnt) * 100,
          highPrice: Number(data.highPrice24h ?? lastTicker.highPrice),
          lowPrice: Number(data.lowPrice24h ?? lastTicker.lowPrice),
          volume: Number(data.volume24h ?? lastTicker.volume),
          quoteVolume: Number(data.turnover24h ?? lastTicker.quoteVolume),
        }, request.fallbackPrice)
        handlers.onUpdate({
          ticker: lastTicker,
          fundingRate: data.fundingRate === undefined ? undefined : Number(data.fundingRate) || 0,
          nextFundingTime: data.nextFundingTime === undefined ? undefined : Number(data.nextFundingTime) || 0,
        })
      }
    }
    return () => socket.close()
  },
}
