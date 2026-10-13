import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { randomUUID } from 'node:crypto'
import { queryDatabase, closeDatabase } from '../postgres'
import { closeRedis } from '../redis'
import * as store from './store'
import type { Provider } from './client'
const queue = (await import('./queue').catch(() => ({}))) as typeof import('./queue')
after(async () => {
  await closeRedis()
  await closeDatabase()
})
test('accepted timeout persists uncertainty and never blindly retries after restart or duplicate job', async () => {
  assert.equal(typeof queue.processConnection, 'function')
  const user = randomUUID()
  await queryDatabase('INSERT INTO users(id,email,password_hash,created_at) VALUES ($1,$2,$3,$4)', [
    user,
    `${user}@fixture.invalid`,
    'inert',
    Date.now()
  ])
  const c = await store.linkConnection(user, '0x' + 'b'.repeat(40)),
    key = Buffer.alloc(32, 5),
    secret = '0x' + '2'.repeat(64)
  let sends = 0
  const now = Date.now(),
    fills = [
      {
        id: '1',
        time: now - 100,
        coin: 'BTC',
        startPosition: '0',
        sz: '0.0001',
        side: 'B' as const,
        oid: '1',
        px: '100000'
      },
      {
        id: '2',
        time: now - 80,
        coin: 'BTC',
        startPosition: '0.0001',
        sz: '0.0001',
        side: 'A' as const,
        oid: '2',
        px: '100000'
      },
      {
        id: '3',
        time: now - 50,
        coin: 'BTC',
        startPosition: '0',
        sz: '0.0001',
        side: 'B' as const,
        oid: '3',
        px: '100000'
      }
    ]
  c.enabled = true
  c.status = 'ARMED'
  c.agentAddress = '0x' + 'c'.repeat(40)
  c.agentName = 'AT-fixture'
  c.grantExpiresAt = now + 60000
  c.policy.maxCloseNotionalUsd = '20'
  c.policy.slippageBps = 25
  await store.updateConnection(c)
  await queryDatabase(
    'UPDATE hl_connections SET signer_ciphertext=$2,consent_version=$3 WHERE id=$1',
    [c.id, store.encryptAgent(secret, c.id, key), c.policy.version]
  )
  const provider: Provider = {
    read: async () => ({
      mode: 'disabled',
      position: '0.0001',
      mid: '100000',
      asset: 3,
      szDecimals: 5,
      fills,
      historyComplete: true,
      grants: [{ address: c.agentAddress!, name: c.agentName!, validUntil: now + 60000 }],
      checkedAt: Date.now()
    }),
    orders: async () => ({ status: 'unknownOid' }),
    submit: async () => {
      sends++
      throw Error('accepted then timeout')
    }
  }
  const deps = { provider, actionsEnabled: () => true, encryptionKey: key, health: async () => {} }
  try {
    await queue.processConnection(c.id, deps)
    assert.equal(sends, 1)
    const a = await store.unresolved(c.id)
    assert.equal(a[0].outcome, 'UNCERTAIN')
    assert.equal((await store.attempts(a[0].id))[0].status, 'UNCERTAIN')
    await Promise.all([queue.processConnection(c.id, deps), queue.processConnection(c.id, deps)])
    assert.equal(sends, 1)
    assert.equal((await store.getConnection(user, c.id))!.status, 'UNCERTAIN')
  } finally {
    await queryDatabase('DELETE FROM users WHERE id=$1', [user])
  }
})
