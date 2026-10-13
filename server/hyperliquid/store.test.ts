import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test, after } from 'node:test'
import { queryDatabase, closeDatabase } from '../postgres'
const store = (await import('./store').catch(() => ({}))) as typeof import('./store')
after(closeDatabase)
test('durable scoped connection and one keeper per master', async () => {
  assert.equal(typeof store.linkConnection, 'function')
  const u = randomUUID(),
    other = randomUUID(),
    account = '0x' + 'a'.repeat(40)
  await queryDatabase(
    'INSERT INTO users(id,email,password_hash,created_at) VALUES ($1,$2,$3,$4),($5,$6,$3,$4)',
    [u, `${u}@fixture.invalid`, 'inert', Date.now(), other, `${other}@fixture.invalid`]
  )
  try {
    const c = await store.linkConnection(u, account)
    assert.equal((await store.getConnection(u, c.id))?.account, account)
    assert.equal(await store.getConnection(other, c.id), null)
    await assert.rejects(store.linkConnection(other, account))
    const [a, b] = await Promise.all([
      store.claim(c.id, 'a', Date.now()),
      store.claim(c.id, 'b', Date.now())
    ])
    assert.equal([a, b].filter(Boolean).length, 1)
    const claimed = a || b
    assert.ok(claimed)
    await assert.rejects(store.assertClaim(c.id, 'wrong', claimed.epoch))
    await store.releaseClaim(c.id, claimed.token, claimed.epoch)
  } finally {
    await queryDatabase('DELETE FROM users WHERE id=ANY($1::uuid[])', [[u, other]])
  }
})
