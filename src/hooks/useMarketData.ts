import { useEffect, useMemo, useRef, useState } from 'react'
import { getMarketDataAdapter, marketDataSourceLabel, type HyperliquidMarketNetwork, type MarketDataExchange } from '../marketData'
import { mergeCandle } from '../marketData/normalizers'
import type { MarketDataUpdate } from '../marketData/types'
import type { BookLevel, Candle, MarketTrade, Ticker } from '../types'

function initialTicker(price: number, exchange?: MarketDataExchange): Ticker {
  if (exchange === 'hyperliquid') return { lastPrice: NaN, priceChangePercent: NaN, highPrice: NaN, lowPrice: NaN, volume: NaN, quoteVolume: NaN }
  const safePrice = price > 0 ? price : 100
  return {
    lastPrice: safePrice,
    priceChangePercent: 0,
    highPrice: safePrice * 1.018,
    lowPrice: safePrice * 0.982,
    volume: 0,
    quoteVolume: 0,
  }
}

function mergeTrades(current: MarketTrade[], incoming: MarketTrade[]) {
  const unique = new Map<number, MarketTrade>()
  for (const trade of [...incoming, ...current]) unique.set(trade.id, trade)
  return [...unique.values()].sort((left, right) => right.time - left.time).slice(0, 24)
}

export function replaceMarketBook(current: BookLevel[], incoming: BookLevel[] | undefined) {
  return incoming === undefined ? current : incoming
}

export function marketStreamCanBeLive(exchange: MarketDataExchange, snapshotInitialized: boolean, candleReceived: boolean) {
  return exchange === 'hyperliquid' ? snapshotInitialized : candleReceived
}

const CANDLE_STALE_AFTER_MS = 30_000
const CANDLE_WATCHDOG_INTERVAL_MS = 5_000
const CONNECTION_TIMEOUT_MS = 15_000

export function marketDataIdentity(exchange: MarketDataExchange, baseAsset: string, interval: string, network: HyperliquidMarketNetwork = 'mainnet') {
  return exchange === 'hyperliquid' ? `${exchange}:${network}:${baseAsset}:${interval}` : `${exchange}:${baseAsset}:${interval}`
}

export function useMarketData(exchange: MarketDataExchange, baseAsset: string, interval: string, fallbackPrice: number, network: HyperliquidMarketNetwork = 'mainnet') {
  const seedTicker = initialTicker(fallbackPrice, exchange)
  const effectiveNetwork = exchange === 'hyperliquid' ? network : undefined
  const identity = marketDataIdentity(exchange, baseAsset, interval, network)
  const [dataIdentity, setDataIdentity] = useState(identity)
  const [candles, setCandles] = useState<Candle[]>([])
  const [ticker, setTicker] = useState<Ticker>(seedTicker)
  const [asks, setAsks] = useState<BookLevel[]>([])
  const [bids, setBids] = useState<BookLevel[]>([])
  const [trades, setTrades] = useState<MarketTrade[]>([])
  const [fundingRate, setFundingRate] = useState(0)
  const [nextFundingTime, setNextFundingTime] = useState(0)
  const [connection, setConnection] = useState<'connecting' | 'live' | 'demo'>('connecting')
  const [error, setError] = useState<string | null>(null)
  const reconnectAttempt = useRef(0)

  useEffect(() => {
    const adapter = getMarketDataAdapter(exchange, network)
    const request = { baseAsset, interval, fallbackPrice, network: effectiveNetwork }
    const controller = new AbortController()
    let unsubscribe: (() => void) | undefined
    let reconnectTimer: number | undefined
    let candleWatchdogTimer: number | undefined
    let connectionTimeoutTimer: number | undefined
    let closedByCleanup = false
    let subscriptionGeneration = 0
    let connectionOpenedAt = 0
    let lastCandleUpdateAt = 0
    const nextSeed = initialTicker(fallbackPrice, exchange)

    setDataIdentity(identity)
    setCandles([])
    setTicker(nextSeed)
    setAsks([])
    setBids([])
    setTrades([])
    setFundingRate(0)
    setNextFundingTime(0)
    setConnection('connecting')
    setError(null)
    reconnectAttempt.current = 0

    const applyUpdate = (update: MarketDataUpdate, streaming = false) => {
      if (update.candles?.length) {
        if (streaming) setCandles((current) => update.candles!.reduce(mergeCandle, current))
        else setCandles(update.candles)
      }
      if (update.ticker) setTicker(update.ticker)
      setAsks((current) => replaceMarketBook(current, update.asks))
      setBids((current) => replaceMarketBook(current, update.bids))
      if (update.trades?.length) setTrades((current) => streaming ? mergeTrades(current, update.trades!) : update.trades!)
      if (update.fundingRate !== undefined) setFundingRate(update.fundingRate)
      if (update.nextFundingTime !== undefined) setNextFundingTime(update.nextFundingTime)
    }

    const clearCandleWatchdog = () => {
      if (candleWatchdogTimer !== undefined) window.clearInterval(candleWatchdogTimer)
      candleWatchdogTimer = undefined
    }

    const clearConnectionTimeout = () => {
      if (connectionTimeoutTimer !== undefined) window.clearTimeout(connectionTimeoutTimer)
      connectionTimeoutTimer = undefined
    }

    const scheduleReconnect = (message?: string) => {
      if (closedByCleanup || reconnectTimer !== undefined) return
      clearCandleWatchdog()
      clearConnectionTimeout()
      setConnection('demo')
      if (message) setError(message)
      const delay = Math.min(15_000, 1_000 * 2 ** reconnectAttempt.current)
      reconnectAttempt.current += 1
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined
        connect()
      }, delay)
    }

    const connect = () => {
      if (closedByCleanup) return
      const generation = ++subscriptionGeneration
      connectionOpenedAt = 0
      lastCandleUpdateAt = 0
      let streamedCandles: Candle[] = []
      let snapshotHasCandles = false
      let streamHasData = false
      setConnection('connecting')
      try {
        let stopSubscription: () => void = () => undefined
        stopSubscription = adapter.subscribe(request, {
          onOpen: () => {
            if (generation !== subscriptionGeneration) return
            connectionOpenedAt = Date.now()
            clearConnectionTimeout()
            clearCandleWatchdog()
            candleWatchdogTimer = window.setInterval(() => {
              const lastHealthyAt = lastCandleUpdateAt || connectionOpenedAt
              if (!lastHealthyAt || Date.now() - lastHealthyAt <= CANDLE_STALE_AFTER_MS) return
              scheduleReconnect(`${adapter.label} candle stream is stale; reconnecting`)
              stopSubscription()
            }, CANDLE_WATCHDOG_INTERVAL_MS)
          },
          onClose: () => {
            if (generation !== subscriptionGeneration) return
            scheduleReconnect()
          },
          onUpdate: (update) => {
            if (generation !== subscriptionGeneration) return
            if (exchange === 'hyperliquid') {
              streamHasData = true
              lastCandleUpdateAt = Date.now()
            }
            if (update.candles?.length) {
              streamedCandles = update.candles.reduce(mergeCandle, streamedCandles)
              lastCandleUpdateAt = Date.now()
            }
            if (marketStreamCanBeLive(exchange, snapshotHasCandles, Boolean(update.candles?.length))) {
              reconnectAttempt.current = 0
              setConnection('live')
              setError(null)
            }
            applyUpdate(update, true)
          },
        })
        unsubscribe = stopSubscription
        connectionTimeoutTimer = window.setTimeout(() => {
          if (generation !== subscriptionGeneration || connectionOpenedAt) return
          scheduleReconnect(`${adapter.label} market connection timed out; reconnecting`)
          stopSubscription()
        }, CONNECTION_TIMEOUT_MS)

        void adapter.loadInitial(request, controller.signal)
          .then((snapshot) => {
            if (controller.signal.aborted || generation !== subscriptionGeneration) return
            const candles = snapshot.candles?.length
              ? streamedCandles.reduce(mergeCandle, snapshot.candles)
              : undefined
            applyUpdate({ ...snapshot, ...(candles ? { candles } : {}) })
            snapshotHasCandles = Boolean(candles?.length)
            if (exchange === 'hyperliquid' && streamHasData && marketStreamCanBeLive(exchange, snapshotHasCandles, false)) {
              setConnection('live')
              setError(null)
            }
          })
          .catch((caught) => {
            if (controller.signal.aborted || generation !== subscriptionGeneration) return
            setError(caught instanceof Error ? caught.message : `${adapter.label} market history is unavailable`)
            if (exchange === 'hyperliquid') setConnection('demo')
          })
      } catch (caught) {
        scheduleReconnect(caught instanceof Error ? caught.message : `${adapter.label} market stream is unavailable`)
      }
    }

    connect()

    return () => {
      closedByCleanup = true
      subscriptionGeneration += 1
      controller.abort()
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
      clearCandleWatchdog()
      clearConnectionTimeout()
      unsubscribe?.()
    }
    // fallbackPrice is a live catalog quote. Reconnect only when source, instrument, or interval changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exchange, baseAsset, interval, effectiveNetwork])

  const currentSourceReady = dataIdentity === identity

  const spread = useMemo(() => {
    if (!asks[0] || !bids[0]) return 0
    return asks[0].price - bids[0].price
  }, [asks, bids])

  return {
    candles: currentSourceReady ? candles : [],
    ticker: currentSourceReady ? ticker : seedTicker,
    asks: currentSourceReady ? asks : [],
    bids: currentSourceReady ? bids : [],
    trades: currentSourceReady ? trades : [],
    fundingRate: currentSourceReady ? fundingRate : 0,
    nextFundingTime: currentSourceReady ? nextFundingTime : 0,
    connection: currentSourceReady ? connection : 'connecting' as const,
    spread: currentSourceReady ? spread : 0,
    error: currentSourceReady ? error : null,
    exchange,
    network: effectiveNetwork,
    sourceLabel: marketDataSourceLabel(exchange, network),
  }
}
