import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { randomUUID } from 'node:crypto'
import { queryDatabase, closeDatabase } from '../postgres'
import * as store from './store'
import { processConnection } from './queue'
import { tradingDay, type Fill, type Snapshot, type Provider } from './client'
import type { TestDependencies } from './protection'
after(closeDatabase)
async function fixture(
  run: (f: {
    c: ReturnType<typeof store.defaultPolicy> extends never
      ? never
      : Awaited<ReturnType<typeof store.linkConnection>>
    snap: Snapshot
    deps: TestDependencies
    sent: () => number
    user: string
    replaceSubmit: (fn: Provider['submit']) => void
  }) => Promise<void>
) {
  const user = randomUUID(),
    account = '0x' + randomUUID().replaceAll('-', '') + '00000000'
  await queryDatabase('INSERT INTO users(id,email,password_hash,created_at) VALUES ($1,$2,$3,$4)', [
    user,
    `${user}@fixture.invalid`,
    'inert',
    Date.now()
  ])
  const c = await store.linkConnection(user, account),
    now = Date.now(),
    key = Buffer.alloc(32, 4)
  c.enabled = true
  c.status = 'ARMED'
  c.agentAddress = '0x' + 'c'.repeat(40)
  c.agentName = 'AT-fixture'
  c.grantExpiresAt = now + 60000
  const fills: Fill[] = [
    {
      id: '1',
      time: now - 100,
      coin: 'BTC',
      startPosition: '0',
      sz: '0.0001',
      side: 'B',
      oid: '1',
      px: '100000'
    },
    {
      id: '2',
      time: now - 80,
      coin: 'BTC',
      startPosition: '0.0001',
      sz: '0.0001',
      side: 'A',
      oid: '2',
      px: '100000'
    },
    {
      id: '3',
      time: now - 50,
      coin: 'BTC',
      startPosition: '0',
      sz: '0.0001',
      side: 'B',
      oid: '3',
      px: '100000'
    }
  ]
  const snap: Snapshot = {
    mode: 'disabled',
    position: '0.0001',
    mid: '100000',
    asset: 4,
    szDecimals: 5,
    fills,
    historyComplete: true,
    grants: [{ address: c.agentAddress, name: c.agentName, validUntil: c.grantExpiresAt }],
    checkedAt: now
  }
  let sends = 0,
    submit: Provider['submit'] = async () => ({ oid: '99' })
  const provider: Provider = {
    read: async () => ({
      ...snap,
      checkedAt: snap.checkedAt === now ? Date.now() : snap.checkedAt
    }),
    orders: async () => ({ status: 'canceled', oid: '99' }),
    submit: async (...args) => {
      sends++
      return submit(...args)
    }
  }
  await store.updateConnection(c)
  await queryDatabase(
    'UPDATE hl_connections SET signer_ciphertext=$2,consent_version=$3 WHERE id=$1',
    [c.id, store.encryptAgent('0x' + '2'.repeat(64), c.id, key), c.policy.version]
  )
  try {
    await run({
      c,
      snap,
      deps: { provider, actionsEnabled: () => true, encryptionKey: key, health: async () => {} },
      sent: () => sends,
      user,
      replaceSubmit: (fn) => {
        submit = fn
      }
    })
  } finally {
    await queryDatabase('DELETE FROM users WHERE id=$1', [user])
  }
}
for (const [label, change, expected] of [
  ['revoked grant', (s: Snapshot) => (s.grants = []), 'REVOKED'],
  ['expired grant', (s: Snapshot) => (s.grants[0].validUntil = Date.now() - 1), 'EXPIRED'],
  ['unresolved default mode', (s: Snapshot) => (s.mode = 'default'), 'UNSUPPORTED_MODE'],
  ['partial history', (s: Snapshot) => (s.historyComplete = false), 'DATA_GAP'],
  ['stale snapshot', (s: Snapshot) => (s.checkedAt = Date.now() - 10000), 'DEGRADED'],
  ['full residual beyond ceiling', (s: Snapshot) => (s.mid = '1000000'), 'DEGRADED']
] as const) {
  test(`${label} prevents any send`, () =>
    fixture(async (f) => {
      change(f.snap)
      await processConnection(f.c.id, f.deps)
      assert.equal(f.sent(), 0)
      assert.equal((await store.getConnection(f.user))!.status, expected)
    }))
}
test('disable after SUBMITTING and before network prevents send', () =>
  fixture(async (f) => {
    let calls = 0
    f.deps.health = async () => {
      if (++calls === 3) {
        const c = (await store.getConnection(f.user))!
        await store.updateConnection({ ...c, enabled: false, status: 'DISABLED' })
        await queryDatabase('UPDATE hl_connections SET consent_version=NULL WHERE id=$1', [c.id])
      }
    }
    await processConnection(f.c.id, f.deps)
    assert.equal(f.sent(), 0)
    assert.ok((await store.unresolved(f.c.id)).length)
  }))
test('claim loss after accepted submit preserves SUBMITTING and prevents replay', () =>
  fixture(async (f) => {
    f.replaceSubmit(async () => {
      await queryDatabase(
        'UPDATE hl_connections SET claim_epoch=claim_epoch+1,claim_until=0 WHERE id=$1',
        [f.c.id]
      )
      return { oid: '99' }
    })
    await processConnection(f.c.id, f.deps)
    assert.equal(f.sent(), 1)
    const intent = (await store.unresolved(f.c.id))[0]
    assert.equal((await store.attempts(intent.id))[0].status, 'SUBMITTING')
    f.deps.provider.orders = async () => ({ status: 'unknownOid' })
    await processConnection(f.c.id, f.deps)
    assert.equal(f.sent(), 1)
    assert.equal((await store.unresolved(f.c.id))[0].outcome, 'UNCERTAIN')
  }))
test('three terminal attempts is the hard episode ceiling', () =>
  fixture(async (f) => {
    for (let i = 0; i < 4; i++) await processConnection(f.c.id, f.deps)
    assert.equal(f.sent(), 3)
    const rows = await queryDatabase<{ outcome: string }>(
      'SELECT outcome FROM hl_intents WHERE connection_id=$1',
      [f.c.id]
    )
    assert.equal(rows.rows[0].outcome, 'ACTION_FAILED')
  }))
test('rapid violating roundtrip persists breach then external resolution and keeps count on restart', () =>
  fixture(async (f) => {
    f.snap.fills.push({
      id: '4',
      time: Date.now() - 10,
      coin: 'BTC',
      startPosition: '0.0001',
      sz: '0.0001',
      side: 'A',
      oid: '4',
      px: '100000'
    })
    f.snap.position = '0'
    await processConnection(f.c.id, f.deps)
    await processConnection(f.c.id, f.deps)
    assert.equal(f.sent(), 0)
    assert.equal((await store.getConnection(f.user))!.entryCount, 2)
    const events = (await store.status(f.user)).events
    assert.ok(events.some((e) => e.outcome === 'BREACH_DETECTED'))
    assert.ok(events.some((e) => e.outcome === 'RESOLVED_EXTERNALLY'))
    const verified = (await store.getConnection(f.user))!.entryCount
    f.snap.fills = f.snap.fills.slice(2)
    f.snap.historyComplete = false
    await processConnection(f.c.id, f.deps)
    assert.equal((await store.getConnection(f.user))!.entryCount, verified)
  }))
for (const kind of ['full', 'mixed', 'growth'] as const) {
  test(`${kind} closure uses episode volume and agent fill attribution`, () =>
    fixture(async (f) => {
      f.c.policy.maxCloseNotionalUsd = '100'
      await store.updateConnection(f.c)
      await processConnection(f.c.id, f.deps)
      assert.equal(f.sent(), 1)
      let current = '0.0001',
        id = 4
      if (kind === 'mixed') {
        f.snap.fills.push({
          id: String(id++),
          time: Date.now() + id,
          coin: 'BTC',
          startPosition: current,
          sz: '0.00005',
          side: 'A',
          oid: 'owner',
          px: '100000'
        })
        current = '0.00005'
        f.snap.fills.push({
          id: String(id++),
          time: Date.now() + id,
          coin: 'BTC',
          startPosition: current,
          sz: '0.00005',
          side: 'B',
          oid: 'owner-scale',
          px: '100000'
        })
        current = '0.0001'
      }
      if (kind === 'growth') {
        f.snap.fills.push({
          id: String(id++),
          time: Date.now() + id,
          coin: 'BTC',
          startPosition: current,
          sz: '0.0001',
          side: 'B',
          oid: 'owner-scale',
          px: '100000'
        })
        current = '0.0002'
      }
      f.snap.fills.push({
        id: String(id),
        time: Date.now() + 20,
        coin: 'BTC',
        startPosition: current,
        sz: current,
        side: 'A',
        oid: '99',
        px: '100000'
      })
      f.snap.position = '0'
      await processConnection(f.c.id, f.deps)
      assert.equal(f.sent(), 1)
      const events = (await store.status(f.user)).events
      assert.ok(
        events.some(
          (e) => e.outcome === (kind === 'mixed' ? 'MIXED_RESOLUTION' : 'CONFIRMED_CLOSED')
        )
      )
    }))
}
test('status degrades independently when worker stopped with persisted ARMED', () =>
  fixture(async (f) => {
    f.c.workerLastSeenAt = Date.now() - 16000
    await store.updateConnection(f.c)
    assert.equal((await store.status(f.user)).connection!.status, 'DEGRADED')
    assert.equal((await store.getConnection(f.user))!.status, 'ARMED')
  }))

test('contradictory replay with the same persisted fill ID preserves verified counter and blocks send', () =>
  fixture(async (f) => {
    f.snap.fills.push({
      id: '4',
      time: Date.now() - 10,
      coin: 'BTC',
      startPosition: '0.0001',
      sz: '0.0001',
      side: 'A',
      oid: '4',
      px: '100000'
    })
    f.snap.position = '0'
    await processConnection(f.c.id, f.deps)
    assert.equal((await store.getConnection(f.user))!.entryCount, 2)
    // Internally coherent alternate history, same IDs, different economic fills.
    f.snap.fills[2] = { ...f.snap.fills[2], side: 'A' }
    f.snap.fills[3] = { ...f.snap.fills[3], startPosition: '-0.0001', side: 'B' }
    await processConnection(f.c.id, f.deps)
    assert.equal(f.sent(), 0)
    assert.equal((await store.getConnection(f.user))!.entryCount, 2)
    assert.equal((await store.getConnection(f.user))!.status, 'DATA_GAP')
  }))

test('three total attempts per consent version persist across a different violating episode', () =>
  fixture(async (f) => {
    for (let i = 0; i < 4; i++) await processConnection(f.c.id, f.deps)
    assert.equal(f.sent(), 3)
    f.snap.fills.push({
      id: '4',
      time: Date.now() - 10,
      coin: 'BTC',
      startPosition: '0.0001',
      sz: '0.0001',
      side: 'A',
      oid: 'owner-close',
      px: '100000'
    })
    f.snap.fills.push({
      id: '5',
      time: Date.now() - 5,
      coin: 'BTC',
      startPosition: '0',
      sz: '0.0001',
      side: 'B',
      oid: 'owner-next',
      px: '100000'
    })
    await processConnection(f.c.id, f.deps)
    assert.equal(f.sent(), 3)
    assert.equal((await store.getConnection(f.user))!.entryCount, 3)
    assert.equal((await store.getConnection(f.user))!.status, 'ACTION_FAILED')
  }))

test('contradictory replay arriving only in final pre-send refresh prevents submission', () =>
  fixture(async (f) => {
    const read = f.deps.provider.read
    let reads = 0
    f.deps.provider.read = async (...args) => {
      const value = await read(...args)
      if (++reads === 2) {
        return {
          ...value,
          position: '0.00015',
          fills: value.fills.map((fill) => (fill.id === '3' ? { ...fill, sz: '0.00015' } : fill))
        }
      }
      return value
    }
    await processConnection(f.c.id, f.deps)
    assert.equal(f.sent(), 0)
  }))
