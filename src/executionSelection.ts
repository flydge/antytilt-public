import type { MarketDataExchange } from './marketData'
export type ExecutionProvider = 'bingx' | 'hyperliquid'
export type HyperliquidNetwork = 'testnet' | 'mainnet'
export function readExecutionProvider(value: string | null): ExecutionProvider { return value === 'hyperliquid' ? value : 'bingx' }
export function readHyperliquidNetwork(value: string | null, fallback: HyperliquidNetwork): HyperliquidNetwork { return value === 'mainnet' || value === 'testnet' ? value : fallback }
/** A foreign chart mark must never price a BingX execution estimate. */
export function selectExecutionPrice(source: MarketDataExchange, chartPrice: number, mark?: number, contract?: number) {
  if (Number.isFinite(mark) && Number(mark) > 0) return Number(mark)
  if (Number.isFinite(contract) && Number(contract) > 0) return Number(contract)
  return source === 'hyperliquid' ? NaN : chartPrice
}
export function showBingxChartOverlays(provider: ExecutionProvider, source: MarketDataExchange, chartBase: string, executionBase: string) { return provider === 'bingx' && source !== 'hyperliquid' && chartBase === executionBase }
export function normalizeInstrumentSymbol(symbol: string) { return symbol.replace(/[-/]/g, '').toUpperCase() }
export function showHyperliquidChartOverlays(provider: ExecutionProvider, source: MarketDataExchange, chartBase: string, chartNetwork: HyperliquidNetwork, executionNetwork: HyperliquidNetwork) { return provider === 'hyperliquid' && source === 'hyperliquid' && chartBase === 'BTC' && chartNetwork === executionNetwork }
