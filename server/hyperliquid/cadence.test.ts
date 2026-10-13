import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { closeDatabase } from '../postgres'
const queue = await import('./queue')
after(closeDatabase)

test('single-demo baseline reads plus three fresh attempts fit official 1200 weight/minute ceiling', () => {
  // Official empty retained history: fills20 + mode20 + meta20 + mids2 + grants20 + role60 + position2.
  const baselineReadWeight = 144
  const freshAttemptReadBudget = 3 * baselineReadWeight
  const normalize = queue.hyperliquidMonitorInterval
  assert.equal(typeof normalize, 'function')
  for (const requested of [
    undefined,
    1,
    5000,
    14999,
    15000,
    30000,
    2147483648,
    Number.NaN,
    Infinity,
    -1
  ]) {
    const interval = normalize(requested)
    assert.ok(Number.isFinite(interval) && interval > 0 && interval <= 2147483647)
    const scheduledPollsPerMinute = Math.floor(60000 / interval) + 1
    assert.ok(scheduledPollsPerMinute * baselineReadWeight + freshAttemptReadBudget + 3 <= 1200)
  }
})
