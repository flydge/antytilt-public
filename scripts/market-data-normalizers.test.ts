import assert from 'node:assert/strict'
import { candleFromArray, marketInterval, marketSymbol, mergeCandle, normalizeBookRows, tradeFromValues } from '../src/marketData/normalizers'

assert.equal(marketSymbol('binance', 'btc'), 'BTCUSDT')
assert.equal(marketSymbol('bybit', 'btc'), 'BTCUSDT')
assert.equal(marketSymbol('bingx', 'btc'), 'BTC-USDT')
assert.equal(marketSymbol('okx', 'btc'), 'BTC-USDT-SWAP')
assert.equal(marketInterval('bybit', '8h'), '480')
assert.equal(marketInterval('okx', '8h'), '8H')

const candle = candleFromArray([1_700_000_000_000, '100', '110', '90', '105', '12.5'])
assert.deepEqual(candle, { time: 1_700_000_000, open: 100, high: 110, low: 90, close: 105, volume: 12.5 })
assert.equal(candleFromArray(['bad']), null)

assert.deepEqual(normalizeBookRows([['101', '2'], ['102', '3']]), [
  { price: 101, quantity: 2, total: 2 },
  { price: 102, quantity: 3, total: 5 },
])

const first = { time: 1, open: 100, high: 105, low: 99, close: 102, volume: 10 }
const replacement = { ...first, close: 104 }
const next = { ...first, time: 2 }
assert.deepEqual(mergeCandle([first], replacement), [replacement])
assert.deepEqual(mergeCandle([first], next), [first, next])

const trade = tradeFromValues({ id: '9223372036854775808', price: '100', quantity: '0.5', time: '1700000000000', side: 'buy' })
assert.equal(trade?.price, 100)
assert.equal(trade?.side, 'buy')
assert.ok(Number.isSafeInteger(trade?.id))

console.log('Market data normalizer tests passed')
