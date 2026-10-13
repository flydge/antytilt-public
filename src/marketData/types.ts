import type { BookLevel, Candle, MarketTrade, Ticker } from '../types'

export type MarketDataExchange = 'binance' | 'bingx' | 'bybit' | 'okx' | 'hyperliquid'
export type HyperliquidMarketNetwork = 'mainnet' | 'testnet'

export const MARKET_DATA_LABELS: Record<MarketDataExchange, string> = {
  binance: 'Binance',
  bingx: 'BingX',
  bybit: 'Bybit',
  okx: 'OKX',
  hyperliquid: 'Hyperliquid',
}

export function marketDataSourceLabel(exchange: MarketDataExchange, network: HyperliquidMarketNetwork = 'mainnet') {
  return exchange === 'hyperliquid' ? `Hyperliquid ${network === 'testnet' ? 'Testnet' : 'Mainnet'}` : MARKET_DATA_LABELS[exchange]
}

export type MarketDataSnapshot = {
  candles: Candle[]
  ticker: Ticker
  asks: BookLevel[]
  bids: BookLevel[]
  trades: MarketTrade[]
  fundingRate: number
  nextFundingTime: number
}

export type MarketDataUpdate = Partial<MarketDataSnapshot>

export type MarketDataRequest = {
  baseAsset: string
  interval: string
  fallbackPrice: number
  network?: HyperliquidMarketNetwork
}

export type MarketDataHandlers = {
  onOpen: () => void
  onClose: () => void
  onUpdate: (update: MarketDataUpdate) => void
}

export type MarketDataAdapter = {
  exchange: MarketDataExchange
  label: string
  loadInitial: (request: MarketDataRequest, signal: AbortSignal) => Promise<MarketDataUpdate>
  subscribe: (request: MarketDataRequest, handlers: MarketDataHandlers) => () => void
}
