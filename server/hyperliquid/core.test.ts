import assert from 'node:assert/strict'
import { test } from 'node:test'
const core = (await import('./client').catch(() => ({}))) as typeof import('./client')
test('close planner is available', () => assert.equal(typeof core.planClose, 'function'))
test('fills count episodes, partials, scale in, flips and fast roundtrips', () => {
  const fill = (id: number, start: string, size: string, side: 'B' | 'A') => ({
    id: String(id),
    time: id,
    coin: 'BTC',
    startPosition: start,
    sz: size,
    side,
    oid: String(id),
    px: '100'
  })
  const fills = [
    fill(1, '0', '1', 'B'),
    fill(2, '1', '0.5', 'B'),
    fill(3, '1.5', '1.5', 'A'),
    fill(4, '0', '1', 'A'),
    fill(5, '-1', '2', 'B')
  ]
  const result = core.reconstructEntries([...fills, fills[0]], '1')
  assert.equal(result.entryCount, 3)
  assert.equal(result.remainingSize, '1')
  assert.equal(result.historyComplete, true)
  assert.equal(core.reconstructEntries([fill(1, '1', '1', 'B')], '2').entryCount, 0)
  assert.equal(
    core.reconstructEntries([fill(1, '0', '1', 'B'), fill(2, '2', '1', 'B')], '3').historyComplete,
    false
  )
})
test('planner is opposite reduce-only IOC, floors size and caps price/notional/deadline', () => {
  const input = {
    position: '0.123456',
    mid: '100000',
    asset: 3,
    szDecimals: 3,
    slippageBps: 50,
    maxCloseNotionalUsd: '20000',
    now: 1000,
    dayEnd: 9000,
    consentExpiry: 6000,
    grantExpiry: 4000,
    cloid: '0x' + '1'.repeat(32)
  }
  const plan = core.planClose(input)
  assert.equal(plan.order.a, 3)
  assert.equal(plan.order.b, false)
  assert.equal(plan.order.r, true)
  assert.equal(plan.order.s, '0.123')
  assert.equal(plan.order.p, '99500')
  assert.equal(plan.order.t.limit.tif, 'Ioc')
  assert.equal(plan.expiresAfter, 4000)
  assert.equal(core.planClose({ ...input, position: '-0.123456' }).order.b, true)
  assert.throws(() => core.planClose({ ...input, maxCloseNotionalUsd: '1' }), /ceiling/)
  assert.throws(() => core.planClose({ ...input, grantExpiry: 999 }), /expired/)
  assert.throws(() => core.planClose({ ...input, position: '0.0001' }), /dust/)
})
test('IANA day handles DST and UTC midnight', () => {
  const d = core.tradingDay(Date.parse('2026-10-25T12:00:00Z'), 'Europe/Warsaw')
  assert.equal(d.day, '2026-10-25')
  assert.equal(d.end - d.start, 25 * 3600000)
})
test('unknownOid never counts as terminal, ack alone cannot close', () => {
  assert.equal(core.terminalOrderStatus('unknownOid'), false)
  assert.equal(core.terminalOrderStatus('open'), false)
  assert.equal(core.terminalOrderStatus('filled'), true)
  assert.equal(core.resolveOutcome('1', '0', '0.4'), 'MIXED_RESOLUTION')
  assert.equal(core.resolveOutcome('1', '0', '0'), 'RESOLVED_EXTERNALLY')
  assert.equal(core.resolveOutcome('1', '0', '1'), 'CONFIRMED_CLOSED')
  assert.equal(core.resolveOutcome('1', '0.2', '0.8'), 'PARTIAL')
})
