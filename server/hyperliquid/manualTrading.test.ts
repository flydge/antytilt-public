import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import type { HlManualSnapshot } from '../../shared/hyperliquidManualTrading'
const manual = await import('./manualTrading').catch(() => ({})) as typeof import('./manualTrading')
const contract = await import('../../shared/hyperliquidManualTrading')
const now = 1800000000000
const account = '0x' + 'a'.repeat(40)
const snapshot = (patch: Partial<HlManualSnapshot> = {}): HlManualSnapshot => ({ network: 'testnet', coin: 'BTC', account, mode: 'unifiedAccount', masterRole: 'user', position: '0', entryPrice: null, unrealizedPnl: null, mid: '100000', asset: 3, szDecimals: 5, perpsAccountValue: '0', withdrawable: '0', spotUsdc: '999', checkedAt: now, ...patch })
test('fresh native metadata produces bounded owner open order with 60s signed review deadline', () => {
  assert.equal(typeof manual.previewManualOrder, 'function')
  const p = manual.previewManualOrder(snapshot(), { action: 'open-long', notionalUsd: '20' }, now, '0x' + '1'.repeat(32))
  assert.deepEqual(p.order, { a: 3, b: true, p: '100250', s: '0.00019', r: false, t: { limit: { tif: 'Ioc' } }, c: '0x' + '1'.repeat(32) })
  assert.equal(p.limitNotionalUsd, '19.0475')
  assert.equal(p.expiresAfter, now + 60000)
  assert.equal(p.account, account)
})
test('open rejects stale or unsupported provider data and nonflat or outside approved amount', () => {
  assert.equal(typeof manual.previewManualOrder, 'function')
  for (const patch of [{ checkedAt: now - 3001 }, { checkedAt: now + 5001 }, { mode: 'default' }, { masterRole: 'subAccount' }, { position: '0.0001' }, { asset: -1 }, { mid: 'NaN' }] as Partial<HlManualSnapshot>[]) {
    assert.throws(() => manual.previewManualOrder(snapshot(patch), { action: 'open-long', notionalUsd: '15' }, now, '0x' + '2'.repeat(32)))
  }
  for (const amount of ['9', '20.01', 'Infinity', '1e1', 'bad']) assert.throws(() => manual.previewManualOrder(snapshot(), { action: 'open-short', notionalUsd: amount }, now, '0x' + '2'.repeat(32)))
  assert.throws(() => manual.previewManualOrder(snapshot(), { action: 'open-long', notionalUsd: '10' }, now, '0x' + '2'.repeat(32)), /minimum/i)
})
test('manual close only reduces exact full residual and rejects cap excess or dust', () => {
  assert.equal(typeof manual.previewManualOrder, 'function')
  const p = manual.previewManualOrder(snapshot({ position: '0.00015' }), { action: 'close' }, now, '0x' + '3'.repeat(32))
  assert.equal(p.order.r, true); assert.equal(p.order.b, false); assert.equal(p.order.s, '0.00015'); assert.equal(p.order.p, '99750')
  for (const position of ['0', '0.00021', '-0.0002', '0.000001', '0.000151']) assert.throws(() => manual.previewManualOrder(snapshot({ position }), { action: 'close' }, now, '0x' + '3'.repeat(32)))
})
test('owner submission gate checks current position, account and mode again after wallet review', () => {
  assert.equal(typeof contract.validateManualAuthorization, 'function')
  const p = manual.previewManualOrder(snapshot(), { action: 'open-long', notionalUsd: '15' }, now, '0x' + '4'.repeat(32))
  contract.validateManualAuthorization(p, { network: 'testnet' as const, realActionsEnabled: true, snapshot: snapshot() }, now)
  for (const patch of [{ position: '0.0001' }, { account: '0x' + 'b'.repeat(40) }, { mode: 'default' }, { checkedAt: now - 3001 }, { asset: 1 }] as Partial<HlManualSnapshot>[]) assert.throws(() => contract.validateManualAuthorization(p, { network: 'testnet' as const, realActionsEnabled: true, snapshot: snapshot(patch) }, now))
  assert.throws(() => contract.validateManualAuthorization(p, { network: 'testnet' as const, realActionsEnabled: false, snapshot: snapshot() }, now))
})
test('authenticated preview remains public-read-only, scoped to linked master and action gate', async () => {
  const express = (await import('express')).default
  const { randomUUID } = await import('node:crypto')
  const { queryDatabase, closeDatabase } = await import('../postgres')
  const { closeRedis } = await import('../redis')
  const { createProtectionRouter } = await import('./protection')
  const store = await import('./store')
  after(async () => { await closeDatabase(); await closeRedis() })
  const user = randomUUID(); let enabled = false, reads = 0
  await queryDatabase('INSERT INTO users(id,email,password_hash,created_at) VALUES ($1,$2,$3,$4)', [user, `${user}@fixture.invalid`, 'inert', Date.now()])
  await store.linkConnection(user, account)
  const provider = { read: async () => { throw Error('Automatic provider must not be touched') }, orders: async () => { throw Error('Automatic provider must not be touched') }, submit: async () => { throw Error('No server trades permitted') } }
  const app = express(); app.use(express.json()); app.use(createProtectionRouter({ requireUser: async r => { if (r.headers.cookie !== 'antytilt_auth=inert') throw Object.assign(Error('Session required'), { status: 401 }); return { id: user } }, testDependencies: { provider, actionsEnabled: () => enabled, encryptionKey: Buffer.alloc(32, 8), manualProvider: { read: async master => { assert.equal(master, account); reads++; return snapshot({ checkedAt: Date.now() }) }, order: async (master, cloid) => { assert.equal(master, account); assert.equal(cloid, '0x' + 'a'.repeat(32)); return { status: 'unknownOid' } } } } }))
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const request = (path: string, body?: unknown, authenticated = true) => fetch(base + path, { method: body ? 'POST' : 'GET', headers: { ...(authenticated ? { cookie: 'antytilt_auth=inert' } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  try {
    assert.equal((await request('/manual/status?network=testnet', undefined, false)).status, 401); assert.equal(reads, 0)
    assert.equal((await request('/manual/preview', { network: 'testnet', action: 'open-long', notionalUsd: '15' })).status, 403); assert.equal(reads, 0)
    enabled = true
    const p = await request('/manual/preview', { network: 'testnet', action: 'open-long', notionalUsd: '15' }); assert.equal(p.status, 200)
    const payload = await p.json() as { account: string; order: { r: boolean }; signer?: unknown }; assert.equal(payload.account, account); assert.equal(payload.order.r, false); assert.equal(payload.signer, undefined)
    assert.equal((await request('/manual/preview', { network: 'testnet', action: 'open-long', notionalUsd: '15', account: '0x' + 'b'.repeat(40) })).status, 400)
    const result = await request('/manual/order/0x' + 'a'.repeat(32) + '?network=testnet'); assert.equal(result.status, 200); assert.equal((await result.json() as { status: string }).status, 'unknownOid')
    const c = await store.getRow((await store.getConnection(user))!.id); assert.equal(c!.signer_ciphertext, null); assert.equal(c!.consent_version, null); assert.equal(c!.data.enabled, false)
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await queryDatabase('DELETE FROM users WHERE id=$1', [user]) }
})
test('manual preview preserves explicit network identity and refuses authorization from another network', () => {
  const main = snapshot({ network: 'mainnet' as HlManualSnapshot['network'] })
  const p = manual.previewManualOrder(main, { action: 'open-long', notionalUsd: '15' }, now, '0x' + '5'.repeat(32))
  assert.equal(p.network, 'mainnet')
  assert.throws(() => contract.validateManualAuthorization(p, { network: 'testnet' as const, realActionsEnabled: true, snapshot: snapshot() }, now), /network|master|gate/i)
})
test('SDK account reads use selected network endpoint and expose BTC open orders only', async () => {
  const originalFetch = globalThis.fetch; const urls: string[] = []
  globalThis.fetch = async (url, options) => {
    urls.push(String(url)); const body = JSON.parse(String(options?.body))
    const value = body.type === 'userAbstraction' ? 'unifiedAccount' : body.type === 'userRole' ? { role: 'user' } : body.type === 'meta' ? { universe: [{ name: 'ETH', szDecimals: 4 }, { name: 'BTC', szDecimals: 5 }] } : body.type === 'allMids' ? { BTC: '100000' } : body.type === 'clearinghouseState' ? { assetPositions: [], marginSummary: { accountValue: '7' }, withdrawable: '6' } : body.type === 'spotClearinghouseState' ? { balances: [{ coin: 'USDC', token: 0, total: '999', hold: '0', entryNtl: '999' }] } : body.type === 'frontendOpenOrders' ? [{ coin: 'BTC', oid: 42, side: 'A', limitPx: '100001', sz: '0.0001', reduceOnly: true, orderType: 'Limit' }, { coin: 'ETH', oid: 43, side: 'B', limitPx: '3000', sz: '0.01', reduceOnly: false, orderType: 'Limit' }] : null
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
  }
  try {
    const provider = manual.createManualTradingProvider('mainnet')
    const result = await provider.read(account)
    assert.equal(result.network, 'mainnet'); assert.equal(result.asset, 1); assert.equal(result.openOrders?.length, 1); assert.equal(result.openOrders?.[0].oid, '42')
    assert.ok(urls.length > 0 && urls.every(url => url === 'https://api.hyperliquid.xyz/info'))
  } finally { globalThis.fetch = originalFetch }
})
test('manual routes require explicit network and isolate default-off mainnet writes from testnet flag', async () => {
  const express = (await import('express')).default
  const { randomUUID } = await import('node:crypto')
  const { queryDatabase } = await import('../postgres')
  const { createProtectionRouter } = await import('./protection')
  const store = await import('./store')
  const user = randomUUID(); let mainEnabled = false, mismatched = false
  const calls: string[] = []
  await queryDatabase('INSERT INTO users(id,email,password_hash,created_at) VALUES ($1,$2,$3,$4)', [user, `${user}@fixture.invalid`, 'inert', Date.now()]); await store.linkConnection(user, account)
  const automatic = { read: async () => { throw Error('Never touch agent provider') }, orders: async () => { throw Error('Never touch agent provider') }, submit: async () => { throw Error('Never submit') } }
  const readProvider = (network: 'testnet' | 'mainnet') => ({ read: async (master: string) => { assert.equal(master, account); calls.push(`${network}:read`); return snapshot({ network: mismatched ? 'testnet' : network, checkedAt: Date.now() }) }, order: async (_master: string, _cloid: `0x${string}`) => { calls.push(`${network}:order`); return { status: 'unknownOid' } } })
  const app = express(); app.use(express.json()); app.use(createProtectionRouter({ requireUser: async () => ({ id: user }), testDependencies: { provider: automatic, actionsEnabled: () => true, encryptionKey: Buffer.alloc(32, 9), manualProvider: readProvider('testnet'), manualProviders: { testnet: readProvider('testnet'), mainnet: readProvider('mainnet') }, manualMainnetActionsEnabled: () => mainEnabled } }))
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const request = (path: string, body?: unknown) => fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  try {
    const main = await request('/manual/status?network=mainnet'); assert.equal(main.status, 200)
    const body = await main.json() as { network: string; realActionsEnabled: boolean; snapshot: { network: string } }; assert.equal(body.network, 'mainnet'); assert.equal(body.snapshot.network, 'mainnet'); assert.equal(body.realActionsEnabled, false)
    assert.equal((await request('/manual/preview', { network: 'mainnet', action: 'open-long', notionalUsd: '15' })).status, 403); assert.deepEqual(calls, ['mainnet:read'])
    assert.equal((await request('/manual/status')).status, 400); assert.equal((await request('/manual/status?network=invalid')).status, 400)
    const test = await request('/manual/preview', { network: 'testnet', action: 'open-long', notionalUsd: '15' }); assert.equal(test.status, 200); assert.equal((await test.json() as { network: string }).network, 'testnet')
    mainEnabled = true
    const mainPreview = await request('/manual/preview', { network: 'mainnet', action: 'open-short', notionalUsd: '15' }); assert.equal(mainPreview.status, 200); assert.equal((await mainPreview.json() as { network: string }).network, 'mainnet')
    const order = await request('/manual/order/0x' + 'a'.repeat(32) + '?network=mainnet'); assert.equal(order.status, 200); assert.ok(calls.includes('mainnet:order'))
    mismatched = true; assert.equal((await request('/manual/preview', { network: 'mainnet', action: 'open-long', notionalUsd: '15' })).status, 409)
    const linked = await store.getConnection(user); assert.equal(linked!.network, 'testnet'); assert.equal(linked!.enabled, false); assert.equal(linked!.agentAddress, null)
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await queryDatabase('DELETE FROM users WHERE id=$1', [user]) }
})
