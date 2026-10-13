import { binanceMarketAdapter } from './binanceAdapter'
import { bingxMarketAdapter } from './bingxAdapter'
import { bybitMarketAdapter } from './bybitAdapter'
import { okxMarketAdapter } from './okxAdapter'
import { getHyperliquidMarketAdapter, hyperliquidMarketAdapter } from './hyperliquidAdapter'
import type { HyperliquidMarketNetwork, MarketDataAdapter, MarketDataExchange } from './types'

const adapters: Record<MarketDataExchange, MarketDataAdapter> = {
  binance: binanceMarketAdapter,
  bingx: bingxMarketAdapter,
  bybit: bybitMarketAdapter,
  okx: okxMarketAdapter,
  hyperliquid: hyperliquidMarketAdapter,
}

export function getMarketDataAdapter(exchange: MarketDataExchange, network: HyperliquidMarketNetwork = 'mainnet') {
  if (exchange === 'hyperliquid') return getHyperliquidMarketAdapter(network)
  return adapters[exchange]
}

export { MARKET_DATA_LABELS, marketDataSourceLabel } from './types'
export type { HyperliquidMarketNetwork, MarketDataExchange } from './types'
