import { fetchJson, sortedCandles } from './common'
import { candleFromArray, marketInterval, marketSymbol, normalizeBookRows, tickerFromValues, tradeFromValues } from './normalizers'
import type { MarketDataAdapter } from './types'

const REST_URL = 'https://fapi.binance.com/fapi/v1'
const PUBLIC_WS_URL = 'wss://fstream.binance.com/public/stream'
const MARKET_WS_URL = 'wss://fstream.binance.com/market/stream'

export const binanceMarketAdapter: MarketDataAdapter = {
  exchange: 'binance',
  label: 'Binance',
  async loadInitial(request, signal) {
    const symbol = marketSymbol('binance', request.baseAsset)
    const interval = marketInterval('binance', request.interval)
    const [rows, ticker, funding, depth, trades] = await Promise.all([
      fetchJson<unknown[]>(`${REST_URL}/klines?symbol=${symbol}&interval=${interval}&limit=500`, signal),
      fetchJson<Record<string, unknown>>(`${REST_URL}/ticker/24hr?symbol=${symbol}`, signal),
      fetchJson<Record<string, unknown>>(`${REST_URL}/premiumIndex?symbol=${symbol}`, signal),
      fetchJson<Record<string, unknown>>(`${REST_URL}/depth?symbol=${symbol}&limit=20`, signal),
      fetchJson<Array<Record<string, unknown>>>(`${REST_URL}/aggTrades?symbol=${symbol}&limit=24`, signal),
    ])
    return {
      candles: sortedCandles(rows.map(candleFromArray)),
      ticker: tickerFromValues({
        lastPrice: Number(ticker.lastPrice),
        priceChangePercent: Number(ticker.priceChangePercent),
        highPrice: Number(ticker.highPrice),
        lowPrice: Number(ticker.lowPrice),
        volume: Number(ticker.volume),
        quoteVolume: Number(ticker.quoteVolume),
      }, request.fallbackPrice),
      fundingRate: Number(funding.lastFundingRate) || 0,
      nextFundingTime: Number(funding.nextFundingTime) || 0,
      asks: normalizeBookRows(depth.asks),
      bids: normalizeBookRows(depth.bids),
      trades: trades.map((trade) => tradeFromValues({
        id: String(trade.a ?? trade.id ?? ''), price: trade.p, quantity: trade.q, time: trade.T,
        side: trade.m ? 'sell' : 'buy',
      })).filter((trade) => trade !== null).reverse(),
    }
  },
  subscribe(request, handlers) {
    const symbol = marketSymbol('binance', request.baseAsset).toLowerCase()
    const interval = marketInterval('binance', request.interval)
    const marketStreams = [`${symbol}@kline_${interval}`, `${symbol}@aggTrade`, `${symbol}@ticker`, `${symbol}@markPrice@1s`]
    const publicStreams = [`${symbol}@depth20@100ms`]
    const marketSocket = new WebSocket(`${MARKET_WS_URL}?streams=${marketStreams.join('/')}`)
    const publicSocket = new WebSocket(`${PUBLIC_WS_URL}?streams=${publicStreams.join('/')}`)
    let disposed = false
    let marketOpen = false
    let publicOpen = false
    let opened = false
    let closed = false

    const announceOpen = () => {
      if (!opened && marketOpen && publicOpen) {
        opened = true
        handlers.onOpen()
      }
    }
    const announceClose = () => {
      if (disposed || closed) return
      closed = true
      handlers.onClose()
      marketSocket.close()
      publicSocket.close()
    }
    const handleMessage = (event: MessageEvent) => {
      try {
        const message = JSON.parse(String(event.data)) as { stream?: string; data?: Record<string, unknown> }
        const stream = message.stream ?? ''
        const normalizedStream = stream.toLowerCase()
        const data = message.data ?? {}
        if (normalizedStream.includes('@kline_')) {
          const row = data.k as Record<string, unknown>
          const candle = candleFromArray([row.t, row.o, row.h, row.l, row.c, row.v])
          if (candle) handlers.onUpdate({ candles: [candle] })
        } else if (normalizedStream.includes('@depth')) {
          handlers.onUpdate({ asks: normalizeBookRows(data.a ?? data.asks), bids: normalizeBookRows(data.b ?? data.bids) })
        } else if (normalizedStream.includes('@aggtrade')) {
          const trade = tradeFromValues({ id: String(data.a ?? ''), price: data.p, quantity: data.q, time: data.T, side: data.m ? 'sell' : 'buy' })
          if (trade) handlers.onUpdate({ trades: [trade] })
        } else if (normalizedStream.includes('@ticker')) {
          handlers.onUpdate({ ticker: tickerFromValues({ lastPrice: Number(data.c), priceChangePercent: Number(data.P), highPrice: Number(data.h), lowPrice: Number(data.l), volume: Number(data.v), quoteVolume: Number(data.q) }, request.fallbackPrice) })
        } else if (normalizedStream.includes('@markprice')) {
          handlers.onUpdate({ fundingRate: Number(data.r) || 0, nextFundingTime: Number(data.T) || 0 })
        }
      } catch {
        announceClose()
      }
    }

    marketSocket.onopen = () => {
      marketOpen = true
      announceOpen()
    }
    publicSocket.onopen = () => {
      publicOpen = true
      announceOpen()
    }
    marketSocket.onmessage = handleMessage
    publicSocket.onmessage = handleMessage
    marketSocket.onclose = announceClose
    publicSocket.onclose = announceClose
    marketSocket.onerror = () => marketSocket.close()
    publicSocket.onerror = () => publicSocket.close()

    return () => {
      disposed = true
      marketSocket.close()
      publicSocket.close()
    }
  },
}
