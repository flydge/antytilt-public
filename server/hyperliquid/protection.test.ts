import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import express from 'express'
import { randomUUID } from 'node:crypto'
import { privateKeyToAccount } from 'viem/accounts'
import { queryDatabase, closeDatabase } from '../postgres'
import { closeRedis } from '../redis'
import type { Provider } from './client'
const protection = (await import('./protection').catch(() => ({}))) as typeof import('./protection')
after(async () => {
  await closeDatabase()
  await closeRedis()
})
test('signed challenge binds session/account/user, replay is rejected and secret stays encrypted', async () => {
  assert.equal(typeof protection.createProtectionRouter, 'function')
  const user = randomUUID()
  await queryDatabase('INSERT INTO users(id,email,password_hash,created_at) VALUES ($1,$2,$3,$4)', [
    user,
    `${user}@fixture.invalid`,
    'inert',
    Date.now()
  ])
  const wallet = privateKeyToAccount(('0x' + '1'.repeat(64)) as `0x${string}`)
  const provider: Provider = {
    read: async () => ({
      mode: 'disabled',
      position: '0',
      mid: '100000',
      asset: 3,
      szDecimals: 5,
      fills: [],
      historyComplete: true,
      grants: [],
      checkedAt: Date.now()
    }),
    orders: async () => ({ status: 'unknownOid' }),
    submit: async () => {
      throw Error('Never called')
    }
  }
  const app = express()
  app.use(express.json())
  app.use(
    protection.createProtectionRouter({
      requireUser: async () => ({ id: user }),
      testDependencies: { provider, actionsEnabled: () => true, encryptionKey: Buffer.alloc(32, 8) }
    })
  )
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${(server.address() as any).port}`
  const req = async (path: string, body: unknown, cookie = 'antytilt_auth=inert-a') => {
    const r = await fetch(base + path, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    return { code: r.status, body: (await r.json()) as any }
  }
  try {
    const c = await req('/challenge', { account: wallet.address, network: 'testnet' })
    assert.equal(c.code, 200)
    assert.match(c.body.message, /Purpose: AntyTILT Hyperliquid master ownership/)
    const signature = await wallet.signMessage({ message: c.body.message })
    assert.equal(
      (await req('/link', { challengeId: c.body.id, signature }, 'antytilt_auth=inert-b')).code,
      403
    )
    const link = await req('/link', { challengeId: c.body.id, signature })
    assert.equal(link.code, 200)
    assert.equal((await req('/link', { challengeId: c.body.id, signature })).code, 409)
    const agent = await req('/agent', { connectionId: link.body.connection.id })
    assert.equal(agent.code, 200)
    assert.equal(agent.body.secret, undefined)
    const row = (
      await queryDatabase<{ signer_ciphertext: string }>(
        'SELECT signer_ciphertext FROM hl_connections WHERE user_id=$1',
        [user]
      )
    ).rows[0]
    assert.ok(row.signer_ciphertext)
    assert.match(row.signer_ciphertext, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
    await queryDatabase('DELETE FROM users WHERE id=$1', [user])
  }
})
