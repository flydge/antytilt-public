import assert from 'node:assert/strict'
import { evaluatePositionRisk, evaluateProtection, roundBreakEvenStop, roundInitialStop } from './riskAutomation'
import type { BingxPosition } from './bingxClient'

const contract = { pricePrecision: 2, quantityPrecision: 3, tradeMinQuantity: 0.001, tradeMinUSDT: 5 }
const profile = {
  fixedStopLoss: { enabled: true, value: 2, workingType: 'MARK_PRICE' as const },
  breakEven: { enabled: true, triggerMode: 'PERCENT' as const, triggerValue: 1, offsetPercent: 0.05 },
}
const position = (direction: 'LONG' | 'SHORT', quantity = '1'): BingxPosition => ({
  symbol: 'ETH-USDT', positionId: `position-${direction}`, positionSide: direction,
  isolated: false, positionAmt: quantity, availableAmt: quantity, unrealizedProfit: '0',
  initialMargin: '10', liquidationPrice: 0, avgPrice: '100', leverage: 10,
  positionValue: String(Number(quantity) * 100), currency: 'USDT',
})

assert.equal(roundInitialStop(100.001, 'LONG', 2, 2), 98.01)
assert.equal(roundInitialStop(100.001, 'SHORT', 2, 2), 102)
assert.equal(roundBreakEvenStop(100, 'LONG', 0.05, 2), 100.05)
assert.equal(roundBreakEvenStop(100, 'SHORT', 0.05, 2), 99.95)

const initial = evaluateProtection({ position: position('LONG'), openOrders: [], contract, profile, markPrice: 100 })
assert.equal(initial.kind, 'PLACE_STOP')
assert.equal(initial.targetStop, 98)

const tighterManual = evaluateProtection({
  position: position('LONG'), contract, profile, markPrice: 100,
  openOrders: [{ orderId: 'manual', symbol: 'ETH-USDT', positionSide: 'LONG', side: 'SELL', type: 'STOP_MARKET', stopPrice: '99', origQty: '1' }],
})
assert.equal(tighterManual.kind, 'NONE')
assert.equal(tighterManual.targetStop, 99)

const partial = evaluateProtection({
  position: position('LONG', '2'), contract, profile, markPrice: 100,
  openOrders: [{ orderId: 'partial', symbol: 'ETH-USDT', positionSide: 'LONG', side: 'SELL', type: 'STOP_MARKET', stopPrice: '99', origQty: '1' }],
})
assert.equal(partial.kind, 'REPLACE_STOP')
assert.deepEqual(partial.cancelOrderIds, ['partial'])

const acceptedButNotVisible = evaluateProtection({
  position: position('LONG'), openOrders: [], contract, profile, markPrice: 100,
  state: { entryPrice: 100, bestPrice: 100, triggered: false, managedOrderId: 'accepted-stop', managedPlacedAt: 50_000 },
  now: 70_000,
})
assert.equal(acceptedButNotVisible.kind, 'WAIT', 'a recently accepted stop must get an exchange-visibility grace period')

const triggered = evaluateProtection({
  position: position('LONG'), openOrders: [], contract, profile, markPrice: 101,
  state: { entryPrice: 100, bestPrice: 100, triggered: false },
})
assert.equal(triggered.triggered, true)
assert.equal(triggered.targetStop, 100.05)

const retraced = evaluateProtection({
  position: position('LONG'), openOrders: [], contract, profile, markPrice: 100.5,
  state: { entryPrice: 100, bestPrice: 101, triggered: true },
})
assert.equal(retraced.triggered, true)
assert.equal(retraced.targetStop, 100.05)

const scaledInAfterTrigger = evaluateProtection({
  position: { ...position('LONG', '2'), avgPrice: '100.5', positionValue: '201' },
  openOrders: [], contract, profile, markPrice: 100.8,
  state: { entryPrice: 100, bestPrice: 101, triggered: true },
})
assert.equal(scaledInAfterTrigger.triggered, true, 'a scale-in must not clear the persistent break-even latch')
assert.equal(scaledInAfterTrigger.targetStop, 100.56)

const crossed = evaluateProtection({
  position: position('LONG'), openOrders: [], contract, profile, markPrice: 97.9,
})
assert.equal(crossed.kind, 'CLOSE_POSITION')

const rMultipleWaiting = evaluateProtection({
  position: position('SHORT'), openOrders: [], contract,
  profile: { ...profile, breakEven: { enabled: true, triggerMode: 'R_MULTIPLE', triggerValue: 1, offsetPercent: 0 } },
  markPrice: 98.1,
})
assert.equal(rMultipleWaiting.triggered, false)
const rMultipleTriggered = evaluateProtection({
  position: position('SHORT'), openOrders: [], contract,
  profile: { ...profile, breakEven: { enabled: true, triggerMode: 'R_MULTIPLE', triggerValue: 1, offsetPercent: 0 } },
  markPrice: 98,
})
assert.equal(rMultipleTriggered.triggered, true)

const unprotectedRisk = evaluatePositionRisk({
  position: position('LONG'), openOrders: [], equity: 1_000, limitPercent: 1, quantityPrecision: 3,
})
assert.equal(unprotectedRisk.status, 'UNPROTECTED')

const excessiveExternalRisk = evaluatePositionRisk({
  position: position('LONG'), equity: 1_000, limitPercent: 0.1, quantityPrecision: 3,
  openOrders: [{
    orderId: 'external-stop', symbol: 'ETH-USDT', positionSide: 'LONG', side: 'SELL',
    type: 'STOP_MARKET', stopPrice: '98', origQty: '1', executedQty: '0',
  }],
})
assert.equal(excessiveExternalRisk.status, 'VIOLATION')
assert.equal(excessiveExternalRisk.riskUsdt, 2)
assert.equal(excessiveExternalRisk.riskPercent, 0.2)

const partialExternalStop = evaluatePositionRisk({
  position: position('SHORT', '2'), equity: 1_000, limitPercent: 1, quantityPrecision: 3,
  openOrders: [{
    orderId: 'partial-external-stop', symbol: 'ETH-USDT', positionSide: 'SHORT', side: 'BUY',
    type: 'STOP_MARKET', stopPrice: '101', origQty: '1', executedQty: '0',
  }],
})
assert.equal(partialExternalStop.status, 'UNPROTECTED', 'a partial stop must not qualify as full-position risk protection')

const managedExternalRisk = evaluatePositionRisk({
  position: position('SHORT', '2'), openOrders: [], equity: 1_000, limitPercent: 1, quantityPrecision: 3,
  managedStopPrice: 101,
  managedQuantity: 2,
})
assert.equal(managedExternalRisk.status, 'COMPLIANT')
assert.equal(managedExternalRisk.riskUsdt, 2)

console.log('Risk automation tests passed')
