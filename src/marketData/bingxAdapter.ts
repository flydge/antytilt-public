import { createSubscriptionId, decodeWebSocketData, fetchJson, safeRecord, sortedCandles } from './common'
import { candleFromArray, marketInterval, marketSymbol, normalizeBookRows, tickerFromValues, tradeFromValues } from './normalizers'
import type { MarketDataAdapter } from './types'

const REST_URL = '/api/market/bingx'
const WS_URL = 'wss://open-api-swap.bingx.com/swap-market'

type BingxResponse<T> = { code: number; msg?: string; data: T }

async function bingxJson<T>(path: string, signal: AbortSignal) {
  const response = await fetchJson<BingxResponse<T>>(`${REST_URL}${path}`, signal)
  if (response.code !== 0) throw new Error(response.msg || `BingX market data error ${response.code}`)
  return response.data
}

export const bingxMarketAdapter: MarketDataAdapter = {
  exchange: 'bingx',
  label: 'BingX',
  async loadInitial(request, signal) {
    const symbol = marketSymbol('bingx', request.baseAsset)
    const interval = marketInterval('bingx', request.interval)
    const [rows, ticker, funding, depth, trades] = await Promise.all([
      bingxJson<Array<Record<string, unknown>>>(`/klines?symbol=${symbol}&interval=${interval}&limit=500`, signal),
      bingxJson<Record<string, unknown>>(`/ticker?symbol=${symbol}`, signal),
      bingxJson<Record<string, unknown>>(`/funding?symbol=${symbol}`, signal),
      bingxJson<Record<string, unknown>>(`/depth?symbol=${symbol}&limit=20`, signal),
      bingxJson<Array<Record<string, unknown>>>(`/trades?symbol=${symbol}&limit=24`, signal),
    ])
    return {
      candles: sortedCandles(rows.map((row) => candleFromArray([row.time, row.open, row.high, row.low, row.close, row.volume]))),
      ticker: tickerFromValues({
        lastPrice: Number(ticker.lastPrice), priceChangePercent: Number(ticker.priceChangePercent),
        highPrice: Number(ticker.highPrice), lowPrice: Number(ticker.lowPrice),
        volume: Number(ticker.volume), quoteVolume: Number(ticker.quoteVolume),
      }, request.fallbackPrice),
      fundingRate: Number(funding.lastFundingRate) || 0,
      nextFundingTime: Number(funding.nextFundingTime) || 0,
      asks: normalizeBookRows(depth.asks),
      bids: normalizeBookRows(depth.bids),
      trades: trades.slice(-24).map((trade) => tradeFromValues({
        id: String(trade.fillId ?? trade.id ?? ''), price: trade.price, quantity: trade.qty, time: trade.time,
        side: trade.isBuyerMaker ? 'sell' : 'buy',
      })).filter((trade) => trade !== null).reverse(),
    }
  },
  subscribe(request, handlers) {
    const symbol = marketSymbol('bingx', request.baseAsset)
    const interval = marketInterval('bingx', request.interval)
    const socket = new WebSocket(WS_URL)
    socket.binaryType = 'arraybuffer'
    socket.onopen = () => {
      handlers.onOpen()
      const channels = [`${symbol}@kline_${interval}`, `${symbol}@depth20@500ms`, `${symbol}@trade`, `${symbol}@ticker`, `${symbol}@markPrice`]
      for (const dataType of channels) socket.send(JSON.stringify({ id: createSubscriptionId(), reqType: 'sub', dataType }))
    }
    socket.onclose = handlers.onClose
    socket.onerror = () => socket.close()
    socket.onmessage = async (event) => {
      try {
        const text = await decodeWebSocketData(event.data)
        if (!text) return
        if (text === 'Ping' || text === 'ping') {
          socket.send('Pong')
          return
        }
        const message = safeRecord(JSON.parse(text))
        const dataType = String(message.dataType ?? '')
        const data = safeRecord(message.data)
        if (dataType.includes('@kline_')) {
          const rows = Array.isArray(message.data) ? message.data : []
          const row = safeRecord(rows[0] ?? data.K ?? data)
          const candle = candleFromArray([row.T ?? row.t, row.o, row.h, row.l, row.c, row.v])
          if (candle) handlers.onUpdate({ candles: [candle] })
        } else if (dataType.includes('@depth')) {
          handlers.onUpdate({ asks: normalizeBookRows(data.asks), bids: normalizeBookRows(data.bids) })
        } else if (dataType.endsWith('@trade')) {
          const rows = Array.isArray(message.data) ? message.data : [data]
          const trades = rows.map((value) => {
            const trade = safeRecord(value)
            return tradeFromValues({ id: `${trade.T ?? ''}:${trade.p ?? ''}:${trade.q ?? ''}`, price: trade.p, quantity: trade.q, time: trade.T, side: trade.m ? 'sell' : 'buy' })
          }).filter((trade) => trade !== null)
          if (trades.length) handlers.onUpdate({ trades })
        } else if (dataType.endsWith('@ticker')) {
          handlers.onUpdate({ ticker: tickerFromValues({ lastPrice: Number(data.c), priceChangePercent: Number(data.P), highPrice: Number(data.h), lowPrice: Number(data.l), volume: Number(data.v), quoteVolume: 0 }, request.fallbackPrice) })
        }
      } catch {
        socket.close()
      }
    }
    return () => socket.close()
  },
}
