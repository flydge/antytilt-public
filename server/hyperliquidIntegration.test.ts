import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'

process.env.NODE_ENV = 'test'
process.env.HL_REAL_ACTIONS_CONFIRMED = 'false'
process.env.ALLOW_LIVE_TRADING = 'false'
process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64')
const { app } = await import('./index')
const { closeDatabase } = await import('./postgres')
const server = app.listen(0, '127.0.0.1')
await new Promise<void>((resolve) => server.once('listening', resolve))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
async function request(path: string, options: RequestInit = {}) {
  const response = await fetch(`${base}${path}`, options)
  const raw = await response.text()
  let body: any
  try {
    body = JSON.parse(raw)
  } catch {
    body = { error: 'Non-JSON response' }
  }
  return { response, body }
}
try {
  const anon = await request('/api/hyperliquid-protection/status')
  assert.equal(anon.response.status, 401, 'HL endpoint must use existing authentication')
  const registered = await request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `hl-integration-${Date.now()}@example.com`,
      password: 'local-test-password-123'
    })
  })
  assert.equal(registered.response.status, 201)
  const cookie = registered.response.headers.get('set-cookie')!.split(';')[0]
  const status = await request('/api/hyperliquid-protection/status', { headers: { cookie } })
  assert.equal(status.response.status, 200)
  assert.equal(status.body.connection, null)
  assert.equal(status.body.realActionsEnabled, false)
  assert.deepEqual(status.body.events, [])
  assert.match(status.body.nativeUrl, /testnet/)
  const agent = await request('/api/hyperliquid-protection/agent', {
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ connectionId: '00000000-0000-4000-8000-000000000001' })
  })
  assert.equal(agent.response.status, 403, 'real credential preparation remains gated')
  const origin = await request('/api/hyperliquid-protection/challenge', {
    method: 'POST',
    headers: { cookie, origin: 'https://untrusted.invalid', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      account: '0x0000000000000000000000000000000000000001',
      network: 'testnet'
    })
  })
  assert.equal(origin.response.status, 403)
  const legacy = await request('/api/exchange/session', { headers: { cookie } })
  assert.equal(legacy.response.status, 200)
  assert.equal(legacy.body.connected, false, 'HL does not become a BingX trading session')
  const logout = await fetch(`${base}/api/auth/logout`, { method: 'DELETE', headers: { cookie } })
  assert.equal(logout.status, 204)
  assert.equal(
    (await request('/api/hyperliquid-protection/status', { headers: { cookie } })).response.status,
    401
  )
  console.log('Hyperliquid mounted auth/origin/action gate and BingX isolation tests passed')
} finally {
  server.closeIdleConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await closeDatabase()
}
