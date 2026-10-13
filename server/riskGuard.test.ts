import assert from 'node:assert/strict'
import {
  KeyedAsyncMutex,
  classifyEntry,
  computeTradingDay,
  evaluateRisk,
  nextTradingDayAt,
  positionKey,
  type PreparedOrderCandidate,
  type RiskAccountSnapshot,
  type RiskGuardProfile,
} from './riskGuard'

const disabled = { enabled: false, value: 1 }
const baseProfile: RiskGuardProfile = {
  active: true,
  timezone: 'UTC',
  maxTradesPerDay: disabled,
  maxLeverage: disabled,
  maxOpenPositions: disabled,
  maxExposurePercent: disabled,
  fixedStopLoss: disabled,
  riskPerTrade: disabled,
  dailyLossLimit: disabled,
}

const emptySnapshot: RiskAccountSnapshot = {
  balances: [{ asset: 'USDT', equity: '1000' }],
  positions: [],
}

const candidate: PreparedOrderCandidate = {
  symbol: 'BTC-USDT',
  direction: 'LONG',
  leverage: 5,
  quantity: 0.01,
  entryPrice: 60_000,
  notional: 600,
  stopLossPrice: 59_000,
}

function decide(
  profile: Partial<RiskGuardProfile>,
  overrides: Partial<Parameters<typeof evaluateRisk>[0]> = {},
) {
  return evaluateRisk({
    profile: { ...baseProfile, ...profile },
    snapshot: emptySnapshot,
    candidate,
    daily: { usedTrades: 0, reservedTrades: 0, openingEquity: 1_000 },
    now: Date.parse('2026-09-26T12:00:00.000Z'),
    ...overrides,
  })
}

// Trading-day calculations are based on the user's IANA timezone, including DST days.
assert.equal(computeTradingDay(Date.parse('2024-03-10T04:30:00Z'), 'America/New_York'), '2024-03-09')
assert.equal(computeTradingDay(Date.parse('2024-03-10T05:00:00Z'), 'America/New_York'), '2024-03-10')
assert.equal(
  nextTradingDayAt(Date.parse('2024-03-10T06:30:00Z'), 'America/New_York'),
  Date.parse('2024-03-11T04:00:00.000Z'),
  'spring-forward day must end at midnight using the new UTC offset',
)
assert.equal(
  nextTradingDayAt(Date.parse('2024-11-03T05:30:00Z'), 'America/New_York'),
  Date.parse('2024-11-04T05:00:00.000Z'),
  'fall-back day must end at midnight using the new UTC offset',
)
assert.throws(() => computeTradingDay(Date.now(), 'Not/A_Timezone'), RangeError)

assert.equal(positionKey('btc-usdt', 'LONG'), 'BTC-USDT:LONG')
assert.equal(positionKey({ symbol: 'BTC-USDT', positionSide: 'BOTH', positionAmt: '-0.1' }), 'BTC-USDT:SHORT')

const maxTradesProfile = { maxTradesPerDay: { enabled: true, value: 3 } }
const exhaustedDailyTrades = decide(maxTradesProfile, {
  daily: { usedTrades: 3, reservedTrades: 0, openingEquity: 1_000 },
})
assert.equal(exhaustedDailyTrades.allowed, false)
assert.equal(exhaustedDailyTrades.code, 'MAX_TRADES_PER_DAY')
assert.equal(exhaustedDailyTrades.rule, 'maxTradesPerDay')
assert.equal(decide(maxTradesProfile, {
  daily: { usedTrades: 2, reservedTrades: 1, openingEquity: 1_000 },
}).code, 'MAX_TRADES_PER_DAY', 'a pending entry slot must prevent an eventual fourth trade')

const existingLong: RiskAccountSnapshot = {
  balances: emptySnapshot.balances,
  positions: [{
    symbol: 'BTC-USDT', positionSide: 'LONG', positionAmt: '0.02',
    positionValue: '1200', avgPrice: '60000',
  }],
}
assert.equal(classifyEntry(candidate, existingLong.positions), 'SCALE_IN')
const scaleIn = decide(maxTradesProfile, {
  snapshot: existingLong,
  daily: { usedTrades: 3, reservedTrades: 0, openingEquity: 1_000 },
})
assert.equal(scaleIn.allowed, true, 'scale-in must not consume another daily trade slot')
if (scaleIn.allowed) assert.equal(scaleIn.details.classification, 'SCALE_IN')

const reduceOnly = decide({
  maxTradesPerDay: { enabled: true, value: 1 },
  dailyLossLimit: { enabled: true, value: 1 },
  maxLeverage: { enabled: true, value: 1 },
}, {
  candidate: { ...candidate, reduceOnly: true, leverage: 100, stopLossPrice: undefined },
  daily: { usedTrades: 99, reservedTrades: 99, openingEquity: 2_000, currentEquity: 1_000 },
})
assert.equal(reduceOnly.allowed, true, 'RM must never trap the user by blocking a reduce-only exit')
if (reduceOnly.allowed) assert.equal(reduceOnly.details.classification, 'REDUCE_ONLY')

assert.equal(decide({ maxLeverage: { enabled: true, value: 3 } }).code, 'MAX_LEVERAGE')

const twoPositions: RiskAccountSnapshot = {
  balances: emptySnapshot.balances,
  positions: [
    { symbol: 'ETH-USDT', positionSide: 'LONG', positionAmt: '1', positionValue: '300' },
    { symbol: 'SOL-USDT', positionSide: 'SHORT', positionAmt: '2', positionValue: '200' },
  ],
}
assert.equal(decide({ maxOpenPositions: { enabled: true, value: 2 } }, {
  snapshot: twoPositions,
}).code, 'MAX_OPEN_POSITIONS')

assert.equal(decide({ maxExposurePercent: { enabled: true, value: 100 } }, {
  snapshot: {
    balances: [{ asset: 'USDT', equity: 1_000 }],
    positions: [{ symbol: 'ETH-USDT', positionSide: 'LONG', positionAmt: 1, positionValue: 500 }],
  },
}).code, 'MAX_EXPOSURE_PERCENT', '500 current + 600 requested must exceed 100% of 1000 equity')

assert.equal(decide({ fixedStopLoss: { enabled: true, value: 3 } }, {
  candidate: { ...candidate, stopLossPrice: undefined },
}).code, 'STOP_LOSS_REQUIRED')
assert.equal(decide({ fixedStopLoss: { enabled: true, value: 1 } }).code, 'FIXED_STOP_LOSS_EXCEEDED')
assert.equal(decide({ fixedStopLoss: { enabled: true, value: 5 } }, {
  candidate: { ...candidate, stopLossPrice: 61_000 },
}).code, 'INVALID_STOP_LOSS')

assert.equal(decide({ riskPerTrade: { enabled: true, value: 0.5 } }, {
  candidate: { ...candidate, quantity: 0.01, entryPrice: 60_000, stopLossPrice: 59_000 },
}).code, 'RISK_PER_TRADE', '10 USDT risk is 1% of 1000 USDT equity')
assert.equal(decide({ riskPerTrade: { enabled: true, value: 1 } }, {
  candidate: { ...candidate, quantity: 0.005, entryPrice: 60_000, stopLossPrice: 59_000 },
}).allowed, true)

const dailyPercent = decide({ dailyLossLimit: { enabled: true, value: 5, unit: 'PERCENT' } }, {
  snapshot: { positions: [], balances: [{ asset: 'USDT', equity: 940 }] },
  daily: { usedTrades: 0, reservedTrades: 0, openingEquity: 1_000 },
})
assert.equal(dailyPercent.code, 'DAILY_LOSS_LIMIT')
if (!dailyPercent.allowed) assert.equal(dailyPercent.details.lossPercent, 6)

const dailyUsdt = decide({ dailyLossLimit: { enabled: true, value: 50, unit: 'USDT' } }, {
  daily: { usedTrades: 0, reservedTrades: 0, openingEquity: 1_000, currentEquity: 949 },
})
assert.equal(dailyUsdt.code, 'DAILY_LOSS_LIMIT')

// Same-account actions serialize; unrelated accounts can run concurrently.
const mutex = new KeyedAsyncMutex()
const order: string[] = []
let releaseFirst!: () => void
const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve })
const first = mutex.runExclusive('account-a', async () => {
  order.push('first-start')
  await firstMayFinish
  order.push('first-end')
})
const second = mutex.runExclusive('account-a', () => { order.push('second') })
await Promise.resolve()
assert.deepEqual(order, ['first-start'])
releaseFirst()
await Promise.all([first, second])
assert.deepEqual(order, ['first-start', 'first-end', 'second'])
assert.equal(mutex.size, 0)

console.log('Risk Guard unit tests passed')
