import { useEffect, useState } from 'react'
import { excludedMarketCapSymbols, fallbackTopMarkets } from '../data/topMarkets'
import type { MarketInstrument } from '../types'

const BINANCE_INFO_URL = 'https://fapi.binance.com/fapi/v1/exchangeInfo'
const BYBIT_INFO_URL = 'https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000'
const MARKET_CAP_URL = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=200&page=1&sparkline=false&price_change_percentage=24h'
export const BINANCE_MINI_TICKER_WS = 'wss://fstream.binance.com/market/ws/!miniTicker@arr'

type CatalogStatus = 'loading' | 'live' | 'fallback'

type CoinGeckoMarket = {
  id: string
  name: string
  symbol: string
  image: string
  market_cap_rank: number | null
  current_price: number | null
  price_change_percentage_24h: number | null
}

type BinanceExchangeInfo = {
  symbols: Array<{ status: string; contractType: string; baseAsset: string; quoteAsset: string }>
}

type BybitExchangeInfo = {
  result: { list: Array<{ status: string; contractType: string; baseCoin: string; quoteCoin: string; settleCoin: string }> }
}

type BinanceMiniTicker = {
  s: string
  c: string
  o: string
}

export function useMarketCatalog() {
  const [markets, setMarkets] = useState<MarketInstrument[]>(fallbackTopMarkets)
  const [status, setStatus] = useState<CatalogStatus>('loading')

  useEffect(() => {
    const controller = new AbortController()
    let disposed = false
    const requestTimeout = window.setTimeout(() => controller.abort(), 8_000)

    const load = async () => {
      try {
        const [marketCapResponse, binanceResponse, bybitResponse] = await Promise.all([
          fetch(MARKET_CAP_URL, { signal: controller.signal }),
          fetch(BINANCE_INFO_URL, { signal: controller.signal }),
          fetch(BYBIT_INFO_URL, { signal: controller.signal }),
        ])
        if (!marketCapResponse.ok || !binanceResponse.ok || !bybitResponse.ok) {
          throw new Error('One or more market catalogs are unavailable')
        }

        const [marketCapRows, binanceInfo, bybitInfo] = await Promise.all([
          marketCapResponse.json() as Promise<CoinGeckoMarket[]>,
          binanceResponse.json() as Promise<BinanceExchangeInfo>,
          bybitResponse.json() as Promise<BybitExchangeInfo>,
        ])

        const binanceAssets = new Set(
          binanceInfo.symbols
            .filter((item) => item.status === 'TRADING' && item.contractType === 'PERPETUAL' && item.quoteAsset === 'USDT')
            .map((item) => item.baseAsset),
        )
        const bybitAssets = new Set(
          bybitInfo.result.list
            .filter((item) => item.status === 'Trading' && item.contractType === 'LinearPerpetual' && item.quoteCoin === 'USDT' && item.settleCoin === 'USDT')
            .map((item) => item.baseCoin),
        )

        const nextMarkets = marketCapRows
          .map((item) => ({ ...item, normalizedSymbol: item.symbol.toUpperCase() }))
          .filter((item) => (
            item.market_cap_rank
            && !excludedMarketCapSymbols.has(item.normalizedSymbol)
            && binanceAssets.has(item.normalizedSymbol)
            && bybitAssets.has(item.normalizedSymbol)
          ))
          .slice(0, 30)
          .map<MarketInstrument>((item) => ({
            id: item.id,
            symbol: `${item.normalizedSymbol}USDT`,
            baseAsset: item.normalizedSymbol,
            quoteAsset: 'USDT',
            name: item.name.replace(' (prev. Toncoin)', ''),
            logoUrl: item.image,
            marketCapRank: item.market_cap_rank as number,
            lastPrice: item.current_price ?? 0,
            priceChangePercent: item.price_change_percentage_24h ?? 0,
            exchanges: ['binance', 'bybit'],
          }))

        if (nextMarkets.length !== 30) throw new Error('The live intersection contains fewer than 30 assets')
        setMarkets(nextMarkets)
        setStatus('live')
      } catch (error) {
        if (disposed) return
        setMarkets(fallbackTopMarkets)
        setStatus('fallback')
      } finally {
        window.clearTimeout(requestTimeout)
      }
    }

    void load()
    return () => {
      disposed = true
      window.clearTimeout(requestTimeout)
      controller.abort()
    }
  }, [])

  useEffect(() => {
    let socket: WebSocket | null = null
    let reconnectTimer: number | undefined
    let stopped = false

    const connect = () => {
      const nextSocket = new WebSocket(BINANCE_MINI_TICKER_WS)
      socket = nextSocket
      nextSocket.onmessage = (event) => {
        try {
          const updates = JSON.parse(String(event.data)) as unknown
          if (!Array.isArray(updates)) throw new Error('Unexpected Binance mini ticker payload')
          const updateMap = new Map(
            updates
              .filter((item): item is BinanceMiniTicker => Boolean(item) && typeof item === 'object' && 's' in item)
              .map((item) => [item.s, item]),
          )
          setMarkets((current) => current.map((market) => {
            const update = updateMap.get(market.symbol)
            if (!update) return market
            const lastPrice = Number(update.c)
            const openPrice = Number(update.o)
            if (!(lastPrice > 0)) return market
            return {
              ...market,
              lastPrice,
              priceChangePercent: openPrice ? ((lastPrice - openPrice) / openPrice) * 100 : market.priceChangePercent,
            }
          }))
        } catch {
          nextSocket.close()
        }
      }
      nextSocket.onerror = () => nextSocket.close()
      nextSocket.onclose = () => {
        if (!stopped && reconnectTimer === undefined) {
          reconnectTimer = window.setTimeout(() => {
            reconnectTimer = undefined
            connect()
          }, 3_000)
        }
      }
    }

    connect()
    return () => {
      stopped = true
      if (reconnectTimer) window.clearTimeout(reconnectTimer)
      socket?.close()
    }
  }, [])

  return { markets, status }
}
