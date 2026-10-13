import assert from 'node:assert/strict'
import crypto from 'node:crypto'

process.env.REDIS_URL ||= 'redis://127.0.0.1:6379'
process.env.REDIS_PREFIX = `antytilt-test-${crypto.randomUUID()}`
process.env.NODE_ENV = 'redis-test'

const {
  closeRedis,
  getLatestWorkerHeartbeat,
  getRmAccountWorkerState,
  initializeRedis,
  setRmAccountWorkerState,
  setWorkerHeartbeat,
  withAccountLock,
} = await import('./redis')

try {
  assert.equal((await initializeRedis()).enabled, true)
  const accountId = crypto.randomUUID()
  let releaseFirst!: () => void
  const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve })
  let entered = false
  const first = withAccountLock(accountId, async () => {
    entered = true
    await holdFirst
    return 'first'
  }, 5_000)
  while (!entered) await new Promise((resolve) => setTimeout(resolve, 5))
  const competing = await withAccountLock(accountId, async () => 'second', 5_000)
  assert.equal(competing.acquired, false)
  releaseFirst()
  assert.deepEqual(await first, { acquired: true, value: 'first' })
  assert.equal((await withAccountLock(accountId, async () => 'third', 5_000)).acquired, true)

  await setRmAccountWorkerState(accountId, { status: 'IDLE', lastCheckedAt: Date.now(), updatedAt: Date.now() })
  assert.equal((await getRmAccountWorkerState(accountId))?.status, 'IDLE')
  await setWorkerHeartbeat('test-worker', { status: 'RUNNING', checkedAt: Date.now() })
  assert.equal((await getLatestWorkerHeartbeat())?.instanceId, 'test-worker')
  console.log('Redis distributed lock and heartbeat tests passed')
} finally {
  await closeRedis()
}
