import { fetchJson, safeRecord, sortedCandles } from './common'
import { candleFromArray, marketInterval, marketSymbol, normalizeBookRows, tickerFromValues, tradeFromValues } from './normalizers'
import type { MarketDataAdapter, MarketDataHandlers } from './types'

const REST_URL = 'https://www.okx.com'
const PUBLIC_WS_URL = 'wss://ws.okx.com:8443/ws/v5/public'
const BUSINESS_WS_URL = 'wss://ws.okx.com:8443/ws/v5/business'

type OkxResponse<T> = { code: string; msg?: string; data: T }

async function okxJson<T>(path: string, signal: AbortSignal) {
  const response = await fetchJson<OkxResponse<T>>(`${REST_URL}${path}`, signal)
  if (response.code !== '0') throw new Error(response.msg || `OKX market data error ${response.code}`)
  return response.data
}

function subscribe(socket: WebSocket, args: Array<Record<string, string>>) {
  socket.send(JSON.stringify({ op: 'subscribe', args }))
}

function attachClose(socket: WebSocket, handlers: MarketDataHandlers, isDisposed: () => boolean) {
  socket.onerror = () => socket.close()
  socket.onclose = () => {
    if (!isDisposed()) handlers.onClose()
  }
}

export const okxMarketAdapter: MarketDataAdapter = {
  exchange: 'okx',
  label: 'OKX',
  async loadInitial(request, signal) {
    const instId = marketSymbol('okx', request.baseAsset)
    const bar = marketInterval('okx', request.interval)
    const [history, tickers, fundingRows, depthRows, recentTrades] = await Promise.all([
      okxJson<unknown[]>(`/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=300`, signal),
      okxJson<Array<Record<string, unknown>>>(`/api/v5/market/ticker?instId=${instId}`, signal),
      okxJson<Array<Record<string, unknown>>>(`/api/v5/public/funding-rate?instId=${instId}`, signal),
      okxJson<Array<Record<string, unknown>>>(`/api/v5/market/books?instId=${instId}&sz=20`, signal),
      okxJson<Array<Record<string, unknown>>>(`/api/v5/market/trades?instId=${instId}&limit=24`, signal),
    ])
    const ticker = tickers[0] ?? {}
    const funding = fundingRows[0] ?? {}
    const depth = depthRows[0] ?? {}
    const lastPrice = Number(ticker.last) || request.fallbackPrice
    const openPrice = Number(ticker.open24h) || lastPrice
    return {
      candles: sortedCandles(history.map(candleFromArray), true),
      ticker: tickerFromValues({
        lastPrice,
        priceChangePercent: openPrice > 0 ? ((lastPrice - openPrice) / openPrice) * 100 : 0,
        highPrice: Number(ticker.high24h),
        lowPrice: Number(ticker.low24h),
        volume: Number(ticker.vol24h),
        quoteVolume: Number(ticker.volCcy24h),
      }, request.fallbackPrice),
      fundingRate: Number(funding.fundingRate) || 0,
      nextFundingTime: Number(funding.nextFundingTime) || 0,
      asks: normalizeBookRows(depth.asks),
      bids: normalizeBookRows(depth.bids),
      trades: recentTrades.map((trade) => tradeFromValues({
        id: String(trade.tradeId ?? ''),
        price: trade.px,
        quantity: trade.sz,
        time: trade.ts,
        side: String(trade.side).toLowerCase() === 'sell' ? 'sell' : 'buy',
      })).filter((trade) => trade !== null),
    }
  },
  subscribe(request, handlers) {
    const instId = marketSymbol('okx', request.baseAsset)
    const bar = marketInterval('okx', request.interval)
    const publicSocket = new WebSocket(PUBLIC_WS_URL)
    const businessSocket = new WebSocket(BUSINESS_WS_URL)
    let disposed = false
    let publicOpen = false
    let businessOpen = false
    let announcedOpen = false
    let lastTicker = tickerFromValues({ lastPrice: request.fallbackPrice }, request.fallbackPrice)

    const markOpen = () => {
      if (publicOpen && businessOpen && !announcedOpen) {
        announcedOpen = true
        handlers.onOpen()
      }
    }

    publicSocket.onopen = () => {
      publicOpen = true
      subscribe(publicSocket, [
        { channel: 'tickers', instId },
        { channel: 'books5', instId },
        { channel: 'trades', instId },
        { channel: 'funding-rate', instId },
      ])
      markOpen()
    }
    businessSocket.onopen = () => {
      businessOpen = true
      subscribe(businessSocket, [{ channel: `candle${bar}`, instId }])
      markOpen()
    }
    attachClose(publicSocket, handlers, () => disposed)
    attachClose(businessSocket, handlers, () => disposed)

    publicSocket.onmessage = (event) => {
      if (String(event.data) === 'pong') return
      const message = safeRecord(JSON.parse(String(event.data)))
      const arg = safeRecord(message.arg)
      const channel = String(arg.channel ?? '')
      const rows = Array.isArray(message.data) ? message.data : []
      if (!channel || !rows.length) return

      if (channel === 'books5') {
        const depth = safeRecord(rows[0])
        handlers.onUpdate({ asks: normalizeBookRows(depth.asks), bids: normalizeBookRows(depth.bids) })
      } else if (channel === 'trades') {
        const trades = rows.map((value) => {
          const trade = safeRecord(value)
          return tradeFromValues({
            id: String(trade.tradeId ?? ''), price: trade.px, quantity: trade.sz, time: trade.ts,
            side: String(trade.side).toLowerCase() === 'sell' ? 'sell' : 'buy',
          })
        }).filter((trade) => trade !== null)
        if (trades.length) handlers.onUpdate({ trades })
      } else if (channel === 'tickers') {
        const ticker = safeRecord(rows[0])
        const nextLast = Number(ticker.last ?? lastTicker.lastPrice)
        const open = Number(ticker.open24h) || nextLast
        lastTicker = tickerFromValues({
          lastPrice: nextLast,
          priceChangePercent: open > 0 ? ((nextLast - open) / open) * 100 : lastTicker.priceChangePercent,
          highPrice: Number(ticker.high24h ?? lastTicker.highPrice),
          lowPrice: Number(ticker.low24h ?? lastTicker.lowPrice),
          volume: Number(ticker.vol24h ?? lastTicker.volume),
          quoteVolume: Number(ticker.volCcy24h ?? lastTicker.quoteVolume),
        }, request.fallbackPrice)
        handlers.onUpdate({ ticker: lastTicker })
      } else if (channel === 'funding-rate') {
        const funding = safeRecord(rows[0])
        handlers.onUpdate({ fundingRate: Number(funding.fundingRate) || 0, nextFundingTime: Number(funding.nextFundingTime) || 0 })
      }
    }

    businessSocket.onmessage = (event) => {
      if (String(event.data) === 'pong') return
      const message = safeRecord(JSON.parse(String(event.data)))
      const arg = safeRecord(message.arg)
      if (!String(arg.channel ?? '').startsWith('candle')) return
      const rows = Array.isArray(message.data) ? message.data : []
      const candle = candleFromArray(rows[0])
      if (candle) handlers.onUpdate({ candles: [candle] })
    }

    return () => {
      disposed = true
      publicSocket.close()
      businessSocket.close()
    }
  },
}
