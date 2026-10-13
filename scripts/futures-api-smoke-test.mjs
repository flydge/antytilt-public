const signal = AbortSignal.timeout(15_000)
const getJson = async (url) => {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`)
  return response.json()
}

const [binanceInfo, bybitInfo, klines, funding, depth] = await Promise.all([
  getJson('https://fapi.binance.com/fapi/v1/exchangeInfo'),
  getJson('https://api.bybit.com/v5/market/instruments-info?category=linear&symbol=HYPEUSDT'),
  getJson('https://fapi.binance.com/fapi/v1/klines?symbol=HYPEUSDT&interval=1m&limit=10'),
  getJson('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=HYPEUSDT'),
  getJson('https://fapi.binance.com/fapi/v1/depth?symbol=HYPEUSDT&limit=10'),
])

const binanceHype = binanceInfo.symbols.find((item) => item.symbol === 'HYPEUSDT')
const bybitHype = bybitInfo.result?.list?.find((item) => item.symbol === 'HYPEUSDT')
const passed = binanceHype?.status === 'TRADING'
  && binanceHype?.contractType === 'PERPETUAL'
  && bybitHype?.status === 'Trading'
  && bybitHype?.contractType === 'LinearPerpetual'
  && klines.length === 10
  && Number.isFinite(Number(funding.lastFundingRate))
  && depth.asks?.length > 0
  && depth.bids?.length > 0

console.log(JSON.stringify({
  passed,
  binance: { symbol: binanceHype?.symbol, status: binanceHype?.status, contractType: binanceHype?.contractType },
  bybit: { symbol: bybitHype?.symbol, status: bybitHype?.status, contractType: bybitHype?.contractType },
  candles: klines.length,
  fundingRate: funding.lastFundingRate,
  bestAsk: depth.asks?.[0]?.[0],
  bestBid: depth.bids?.[0]?.[0],
}, null, 2))

if (!passed) process.exitCode = 1
