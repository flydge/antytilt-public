import type { MarketInstrument } from '../types'

type FallbackMarket = Pick<MarketInstrument, 'id' | 'baseAsset' | 'name' | 'marketCapRank' | 'lastPrice'>

// Snapshot used only when the live market-cap and exchange catalog requests are unavailable.
// Every asset has an active USDT perpetual market on both Binance and Bybit at the time of selection.
const fallbackAssets: FallbackMarket[] = [
  { id: 'bitcoin', baseAsset: 'BTC', name: 'Bitcoin', marketCapRank: 1, lastPrice: 80_000 },
  { id: 'ethereum', baseAsset: 'ETH', name: 'Ethereum', marketCapRank: 2, lastPrice: 2_500 },
  { id: 'binancecoin', baseAsset: 'BNB', name: 'BNB', marketCapRank: 4, lastPrice: 700 },
  { id: 'ripple', baseAsset: 'XRP', name: 'XRP', marketCapRank: 5, lastPrice: 1.5 },
  { id: 'solana', baseAsset: 'SOL', name: 'Solana', marketCapRank: 7, lastPrice: 110 },
  { id: 'tron', baseAsset: 'TRX', name: 'TRON', marketCapRank: 8, lastPrice: 0.34 },
  { id: 'hyperliquid', baseAsset: 'HYPE', name: 'Hyperliquid', marketCapRank: 10, lastPrice: 85 },
  { id: 'dogecoin', baseAsset: 'DOGE', name: 'Dogecoin', marketCapRank: 11, lastPrice: 0.09 },
  { id: 'zcash', baseAsset: 'ZEC', name: 'Zcash', marketCapRank: 12, lastPrice: 800 },
  { id: 'chainlink', baseAsset: 'LINK', name: 'Chainlink', marketCapRank: 15, lastPrice: 12 },
  { id: 'monero', baseAsset: 'XMR', name: 'Monero', marketCapRank: 16, lastPrice: 460 },
  { id: 'cardano', baseAsset: 'ADA', name: 'Cardano', marketCapRank: 19, lastPrice: 0.22 },
  { id: 'stellar', baseAsset: 'XLM', name: 'Stellar', marketCapRank: 20, lastPrice: 0.19 },
  { id: 'bitcoin-cash', baseAsset: 'BCH', name: 'Bitcoin Cash', marketCapRank: 21, lastPrice: 270 },
  { id: 'canton-network', baseAsset: 'CC', name: 'Canton', marketCapRank: 23, lastPrice: 0.11 },
  { id: 'the-open-network', baseAsset: 'GRAM', name: 'Gram', marketCapRank: 26, lastPrice: 1.45 },
  { id: 'litecoin', baseAsset: 'LTC', name: 'Litecoin', marketCapRank: 27, lastPrice: 50 },
  { id: 'hedera-hashgraph', baseAsset: 'HBAR', name: 'Hedera', marketCapRank: 28, lastPrice: 0.08 },
  { id: 'avalanche-2', baseAsset: 'AVAX', name: 'Avalanche', marketCapRank: 30, lastPrice: 7.5 },
  { id: 'sui', baseAsset: 'SUI', name: 'Sui', marketCapRank: 32, lastPrice: 0.79 },
  { id: 'uniswap', baseAsset: 'UNI', name: 'Uniswap', marketCapRank: 35, lastPrice: 4.6 },
  { id: 'memecore', baseAsset: 'M', name: 'MemeCore', marketCapRank: 39, lastPrice: 1.1 },
  { id: 'near', baseAsset: 'NEAR', name: 'NEAR Protocol', marketCapRank: 40, lastPrice: 1.9 },
  { id: 'bittensor', baseAsset: 'TAO', name: 'Bittensor', marketCapRank: 41, lastPrice: 250 },
  { id: 'aave', baseAsset: 'AAVE', name: 'Aave', marketCapRank: 46, lastPrice: 129 },
  { id: 'aster-2', baseAsset: 'ASTER', name: 'Aster', marketCapRank: 47, lastPrice: 0.71 },
  { id: 'world-liberty-financial', baseAsset: 'WLFI', name: 'World Liberty Financial', marketCapRank: 48, lastPrice: 0.06 },
  { id: 'ondo-finance', baseAsset: 'ONDO', name: 'Ondo', marketCapRank: 50, lastPrice: 0.38 },
  { id: 'morpho', baseAsset: 'MORPHO', name: 'Morpho', marketCapRank: 52, lastPrice: 2.6 },
  { id: 'ethena', baseAsset: 'ENA', name: 'Ethena', marketCapRank: 53, lastPrice: 0.17 },
]

export const fallbackTopMarkets: MarketInstrument[] = fallbackAssets.map((market) => ({
  ...market,
  symbol: `${market.baseAsset}USDT`,
  quoteAsset: 'USDT',
  logoUrl: `https://assets.coincap.io/assets/icons/${market.baseAsset.toLowerCase()}@2x.png`,
  priceChangePercent: 0,
  exchanges: ['binance', 'bybit'],
}))

export const excludedMarketCapSymbols = new Set([
  'USDT', 'USDC', 'USDS', 'DAI', 'FDUSD', 'PYUSD', 'USD1', 'TUSD', 'USDE', 'USDD', 'FRAX',
  'BUIDL', 'USDF', 'RLUSD', 'WBTC', 'WETH', 'WSTETH', 'STETH', 'WEETH', 'RETH', 'CBETH',
  'BTCB', 'XAUT', 'PAXG',
])
