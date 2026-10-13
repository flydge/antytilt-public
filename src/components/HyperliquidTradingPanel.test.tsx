/// <reference types="node" />
import React from 'react'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { privateKeyToAccount } from 'viem/accounts'
import { recoverTypedDataAddress, serializeSignature } from 'viem'
import { createL1ActionHash } from '@nktkas/hyperliquid/signing'
import { validateManualAuthorization, type HlManualPreview, type HlManualSnapshot } from '../../shared/hyperliquidManualTrading'
const panel = await import('./HyperliquidTradingPanel').catch(() => ({})) as typeof import('./HyperliquidTradingPanel')
const owner = privateKeyToAccount(('0x' + '1'.repeat(64)) as `0x${string}`)
const preview = (): HlManualPreview => ({ network: 'testnet', coin: 'BTC', account: owner.address.toLowerCase(), mode: 'disabled', action: 'open-long', positionBefore: '0', requestedNotionalUsd: '20', limitNotionalUsd: '19.0475', referenceMid: '100000', szDecimals: 5, checkedAt: Date.now(), createdAt: Date.now(), expiresAfter: Date.now() + 60000, order: { a: 3, b: true, p: '100250', s: '0.00019', r: false, t: { limit: { tif: 'Ioc' } }, c: ('0x' + 'a'.repeat(32)) as `0x${string}` } })
test('owner browser SDK signs testnet phantom domain, exact IOC payload and expiry without server signer', async () => {
  assert.equal(typeof panel.submitOwnerManualOrder, 'function')
  const p = preview(); let calls = 0
  const originalFetch = globalThis.fetch
  const wallet = { request: async ({ method, params }: { method: string; params?: unknown[] }) => {
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [owner.address]
    if (method === 'eth_chainId') return '0x1'
    if (method === 'eth_signTypedData_v4') {
      const data = JSON.parse(String(params?.[1])); assert.equal(data.message.source, 'b'); assert.equal(Number(data.domain.chainId), 1337)
      return owner.signTypedData(data)
    }
    throw Error(`Unexpected wallet method ${method}`)
  } }
  globalThis.fetch = async (url, options) => {
    calls++; assert.equal(String(url), 'https://api.hyperliquid-testnet.xyz/exchange')
    const payload = JSON.parse(String(options?.body))
    assert.equal(payload.expiresAfter, p.expiresAfter); assert.equal(payload.vaultAddress, undefined)
    assert.deepEqual(payload.action.orders, [p.order]); assert.equal(payload.action.grouping, 'na')
    const recovered = await recoverTypedDataAddress({ domain: { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: '0x0000000000000000000000000000000000000000' }, types: { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] }, primaryType: 'Agent', message: { source: 'b', connectionId: createL1ActionHash({ action: payload.action, nonce: payload.nonce, expiresAfter: payload.expiresAfter }) }, signature: serializeSignature({ ...payload.signature, v: BigInt(payload.signature.v) }) })
    assert.equal(recovered.toLowerCase(), owner.address.toLowerCase())
    return new Response(JSON.stringify({ status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { oid: 42, totalSz: '0.00019', avgPx: '100000' } }] } } }), { headers: { 'content-type': 'application/json' } })
  }
  try { const result = await panel.submitOwnerManualOrder(p, wallet); assert.equal(result.kind, 'FILLED'); assert.equal(calls, 1) } finally { globalThis.fetch = originalFetch }
})
test('wallet mismatch, stale or altered preview never requests an order signature', async () => {
  assert.equal(typeof panel.submitOwnerManualOrder, 'function')
  let signatures = 0
  const wallet = { request: async ({ method }: { method: string; params?: unknown[] }) => { if (method === 'eth_signTypedData_v4') signatures++; return ['0x' + 'b'.repeat(40)] } }
  await assert.rejects(panel.submitOwnerManualOrder(preview(), wallet), /linked master/i)
  const expired = preview(); expired.expiresAfter = Date.now() - 1
  await assert.rejects(panel.submitOwnerManualOrder(expired, wallet), /expired/i)
  const altered = preview(); altered.order.s = '1'
  await assert.rejects(panel.submitOwnerManualOrder(altered, wallet), /bound|notional/i)
  assert.equal(signatures, 0)
})
test('unknown order outcome remains locked rather than presented as filled', () => {
  assert.equal(typeof panel.HyperliquidTradingView, 'function')
  const html = renderToStaticMarkup(<panel.HyperliquidTradingView data={null} now={Date.now()} pending={{ cloid: '0x' + 'a'.repeat(32), message: 'Unknown result; reconcile before another order', unknown: true }} />)
  assert.match(html, /Unknown result/); assert.match(html, /disabled=""[^>]*>Open Long/); assert.match(html, /Reconcile Order/)
  assert.doesNotMatch(html, /BingX balance/)
})
test('signature finishing after preview expiry never sends; timeout submits once and remains uncertain', async () => {
  let signed = 0, sent = 0
  const originalFetch = globalThis.fetch
  const p = preview()
  const wallet = { request: async ({ method, params }: { method: string; params?: unknown[] }) => {
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [owner.address]
    if (method === 'eth_chainId') return '0x1'
    if (method === 'eth_signTypedData_v4') { signed++; const signature = await owner.signTypedData(JSON.parse(String(params?.[1]))); p.expiresAfter = Date.now() - 1; return signature }
    throw Error(`Unexpected method ${method}`)
  } }
  globalThis.fetch = async () => { sent++; throw Error('inert timeout') }
  try {
    await assert.rejects(panel.submitOwnerManualOrder(p, wallet), e => e instanceof panel.ManualSubmissionError && !e.uncertain)
    assert.equal(signed, 1); assert.equal(sent, 0)
    const fresh = preview()
    const timelyWallet = { request: async ({ method, params }: { method: string; params?: unknown[] }) => method === 'eth_signTypedData_v4' ? owner.signTypedData(JSON.parse(String(params?.[1]))) : method === 'eth_chainId' ? '0x1' : [owner.address] }
    await assert.rejects(panel.submitOwnerManualOrder(fresh, timelyWallet), e => e instanceof panel.ManualSubmissionError && e.uncertain)
    assert.equal(sent, 1)
  } finally { globalThis.fetch = originalFetch }
})
test('owner gate revoked during wallet prompt prevents network submission after signature', async () => {
  let sent = 0, gateChecks = 0
  const originalFetch = globalThis.fetch
  const wallet = { request: async ({ method, params }: { method: string; params?: unknown[] }) => method === 'eth_signTypedData_v4' ? owner.signTypedData(JSON.parse(String(params?.[1]))) : method === 'eth_chainId' ? '0x1' : [owner.address] }
  globalThis.fetch = async () => { sent++; throw Error('must not send') }
  try {
    await assert.rejects(panel.submitOwnerManualOrder(preview(), wallet, async () => { gateChecks++; throw Error('Owner gate disabled') }), /gate disabled/)
    assert.equal(gateChecks, 1); assert.equal(sent, 0)
  } finally { globalThis.fetch = originalFetch }
})
test('one literal SDK per-order rejection is terminal REJECTED without retry; ambiguous bulk errors remain unknown', async () => {
  const originalFetch = globalThis.fetch
  const wallet = { request: async ({ method, params }: { method: string; params?: unknown[] }) => method === 'eth_signTypedData_v4' ? owner.signTypedData(JSON.parse(String(params?.[1]))) : method === 'eth_chainId' ? '0x1' : [owner.address] }
  let calls = 0
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ status: 'ok', response: { type: 'order', data: { statuses: [{ error: 'Insufficient margin to place order. asset=3' }] } } }), { headers: { 'content-type': 'application/json' } }) }
  try {
    const result = await panel.submitOwnerManualOrder(preview(), wallet)
    assert.equal(result.kind, 'REJECTED'); assert.match(result.reason ?? '', /Insufficient margin/); assert.equal(calls, 1)
    calls = 0
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ status: 'ok', response: { type: 'order', data: { statuses: [{ error: 'one rejected' }, { filled: { oid: 42, totalSz: '0.0001', avgPx: '100000' } }] } } }), { headers: { 'content-type': 'application/json' } }) }
    await assert.rejects(panel.submitOwnerManualOrder(preview(), wallet), e => e instanceof panel.ManualSubmissionError && e.uncertain); assert.equal(calls, 1)
    calls = 0
    globalThis.fetch = async () => { calls++; return new Response('Order rejected', { status: 400 }) }
    await assert.rejects(panel.submitOwnerManualOrder(preview(), wallet), e => e instanceof panel.ManualSubmissionError && e.uncertain); assert.equal(calls, 1)
  } finally { globalThis.fetch = originalFetch }
})
test('external position, mode or stale snapshot after owner signs aborts before exchange and cannot become a scale-in', async () => {
  const originalFetch = globalThis.fetch; let sent = 0
  globalThis.fetch = async () => { sent++; throw Error('must not submit') }
  try {
    for (const patch of [{ position: '0.0001' }, { mode: 'unifiedAccount' }, { checkedAt: Date.now() - 5000 }] as Partial<HlManualSnapshot>[]) {
      const p = preview(); let signed = false
      const status = { network: 'testnet' as const, realActionsEnabled: true, snapshot: { network: 'testnet', coin: 'BTC', account: p.account, mode: 'disabled', masterRole: 'user', position: '0', entryPrice: null, unrealizedPnl: null, mid: '100000', asset: 3, szDecimals: 5, perpsAccountValue: '0', withdrawable: '0', spotUsdc: '999', checkedAt: Date.now() } as HlManualSnapshot }
      validateManualAuthorization(p, status, Date.now())
      const wallet = { request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        if (method === 'eth_signTypedData_v4') { const signature = await owner.signTypedData(JSON.parse(String(params?.[1]))); signed = true; Object.assign(status.snapshot, patch); return signature }
        return method === 'eth_chainId' ? '0x1' : [owner.address]
      } }
      await assert.rejects(panel.submitOwnerManualOrder(p, wallet, async () => validateManualAuthorization(p, status, Date.now())), e => e instanceof panel.ManualSubmissionError && !e.uncertain)
      assert.equal(signed, true); assert.equal(sent, 0)
    }
  } finally { globalThis.fetch = originalFetch }
})
test('offline mainnet owner SDK signs source a and routes to mainnet only after explicit authorization callback', async () => {
  const p = preview(); p.network = 'mainnet' as HlManualPreview['network']
  let sent = 0, authorized = 0
  const originalFetch = globalThis.fetch
  const wallet = { request: async ({ method, params }: { method: string; params?: unknown[] }) => {
    if (method === 'eth_signTypedData_v4') { const typed = JSON.parse(String(params?.[1])); assert.equal(typed.message.source, 'a'); return owner.signTypedData(typed) }
    return method === 'eth_chainId' ? '0x1' : [owner.address]
  } }
  globalThis.fetch = async (url, options) => { sent++; assert.equal(String(url), 'https://api.hyperliquid.xyz/exchange'); assert.equal(JSON.parse(String(options?.body)).expiresAfter, p.expiresAfter); return new Response(JSON.stringify({ status: 'ok', response: { type: 'order', data: { statuses: [{ error: 'inert mainnet fixture rejection' }] } } }), { headers: { 'content-type': 'application/json' } }) }
  try {
    await assert.rejects(panel.submitOwnerManualOrder(p, wallet), /mainnet|authorization/i)
    assert.equal(sent, 0)
    const result = await panel.submitOwnerManualOrder(p, wallet, async () => { authorized++ })
    assert.equal(result.kind, 'REJECTED'); assert.equal(sent, 1); assert.ok(authorized >= 1)
  } finally { globalThis.fetch = originalFetch }
})
test('compact mainnet panel labels real funds and keeps actions disabled while displaying actual account/orders', () => {
  const snapshot: HlManualSnapshot = { network: 'mainnet', coin: 'BTC', account: owner.address.toLowerCase(), mode: 'unifiedAccount', masterRole: 'user', position: '0.00012', entryPrice: '100000', unrealizedPnl: '-0.01', mid: '100000', asset: 3, szDecimals: 5, perpsAccountValue: '17', withdrawable: '5', spotUsdc: '9', checkedAt: Date.now(), openOrders: [{ oid: '87', side: 'A', price: '101000', size: '0.00012', reduceOnly: true, orderType: 'Limit' }] }
  const html = renderToStaticMarkup(<panel.HyperliquidTradingView network="mainnet" data={{ network: 'mainnet', realActionsEnabled: false, snapshot }} now={Date.now()} />)
  assert.match(html, /Mainnet/); assert.match(html, /Real funds/i); assert.match(html, /0\.00012/); assert.match(html, /87/); assert.match(html, /disabled=""[^>]*>Open Long/)
  assert.doesNotMatch(html, /test USDC/)
  const crossNetwork = renderToStaticMarkup(<panel.HyperliquidTradingView network="testnet" data={{ network: 'mainnet', realActionsEnabled: true, snapshot }} now={Date.now()} />)
  assert.doesNotMatch(crossNetwork, /0\.00012/); assert.match(crossNetwork, /disabled=""[^>]*>Open Long/)
})
test('changing execution network or leaving the panel blocks old wallet signature requests', async () => {
  assert.equal(typeof panel.bindOwnerWalletNetwork, 'function')
  let selected: 'testnet' | 'mainnet' | null = 'testnet', forwarded = 0
  const wallet = panel.bindOwnerWalletNetwork({ request: async () => { forwarded++; return [] } }, 'testnet', () => selected)
  await wallet.request({ method: 'eth_accounts' }); assert.equal(forwarded, 1)
  selected = 'mainnet'; await assert.rejects(wallet.request({ method: 'eth_signTypedData_v4' }), /network|selection/i)
  selected = null; await assert.rejects(wallet.request({ method: 'eth_requestAccounts' }), /network|selection/i)
  assert.equal(forwarded, 1)
})
