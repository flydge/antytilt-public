import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createProvider, agentNameBase } from './client'
async function probe(total: number, sameMs = false, oldestBeforeDay = false, role = 'user') {
  const original = globalThis.fetch,
    now = Date.now(),
    start = now - 20000,
    base = oldestBeforeDay ? start - 1 : now - 10000
  const fills = Array.from({ length: total }, (_, i) => ({
    tid: i + 1,
    time: sameMs ? base : base + i,
    coin: 'ETH',
    startPosition: '0',
    sz: '1',
    side: 'B',
    oid: i + 1,
    px: '1'
  }))
  const calls: { type: string; at: number }[] = []
  globalThis.fetch = async (_url, opts) => {
    const b = JSON.parse(String(opts?.body))
    calls.push({ type: b.type, at: Date.now() })
    const value =
      b.type === 'userFillsByTime'
        ? fills.filter((f) => f.time >= b.startTime && f.time <= b.endTime).slice(0, 2000)
        : b.type === 'userRole'
          ? { role }
          : b.type === 'userAbstraction'
            ? 'disabled'
            : b.type === 'meta'
              ? {
                  universe: [
                    { name: 'ETH', szDecimals: 3 },
                    { name: 'BTC', szDecimals: 5 }
                  ]
                }
              : b.type === 'allMids'
                ? { BTC: '100000' }
                : b.type === 'extraAgents'
                  ? []
                  : b.type === 'clearinghouseState'
                    ? { assetPositions: [] }
                    : null
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }
  try {
    return {
      snapshot: await createProvider().read('0x' + 'a'.repeat(40), start, now + 10000),
      calls
    }
  } finally {
    globalThis.fetch = original
  }
}
test('official10000 retention ceiling wholly inside requested day is DATA_GAP', async () => {
  const p = await probe(10000)
  assert.equal(p.snapshot.historyComplete, false)
})
test('retention cap with verified older overlap preserves current-day completeness', async () => {
  const p = await probe(10000, false, true)
  assert.equal(p.snapshot.historyComplete, true)
})
test('same-millisecond saturated page never advances past unproven fills', async () => {
  const p = await probe(2000, true)
  assert.equal(p.snapshot.historyComplete, false)
})
test('authorizing grant/mode/quote reads follow backfill and native BTC asset index comes from metadata', async () => {
  const p = await probe(2100)
  const lastFill = p.calls.map((c) => c.type).lastIndexOf('userFillsByTime'),
    firstGrant = p.calls.findIndex((c) => c.type === 'extraAgents')
  assert.ok(firstGrant > lastFill)
  assert.equal(p.snapshot.asset, 1)
  assert.ok(p.snapshot.checkedAt <= p.calls[firstGrant].at)
})
test('only documented valid_until suffix is normalized for dedicated slot collision', () => {
  assert.equal(agentNameBase('AT-abcd valid_until 1234'), 'AT-abcd')
  assert.equal(agentNameBase('AT-abcd anything else'), 'AT-abcd anything else')
})

test('offline real SDK wire signs only bounded IOC close with explicit durable nonce and signed expiry', async () => {
  const { planClose } = await import('./client')
  const { createL1ActionHash } = await import('@nktkas/hyperliquid/signing')
  const { privateKeyToAccount } = await import('viem/accounts')
  const { recoverTypedDataAddress, serializeSignature } = await import('viem')
  const originalFetch = globalThis.fetch
  const originalFlag = process.env.HL_REAL_ACTIONS_CONFIRMED
  const now = Date.now(),
    nonce = now + 7
  const secret = ('0x' + '3'.repeat(64)) as `0x${string}` // Public inert fixture, never a funded owner.
  const plan = planClose({
    position: '0.0001234',
    mid: '100000',
    asset: 3,
    szDecimals: 5,
    slippageBps: 25,
    maxCloseNotionalUsd: '20',
    now,
    dayEnd: now + 60000,
    consentExpiry: now + 60000,
    grantExpiry: now + 60000,
    cloid: '0x' + '4'.repeat(32)
  })
  let wire: any,
    calls = 0
  // Interception is installed before the test-only action flag; every request is offline.
  globalThis.fetch = async (url, options) => {
    calls++
    assert.equal(String(url), 'https://api.hyperliquid-testnet.xyz/exchange')
    wire = JSON.parse(String(options?.body))
    return new Response(
      JSON.stringify({
        status: 'ok',
        response: {
          type: 'order',
          data: { statuses: [{ filled: { totalSz: '0.00012', avgPx: '100000', oid: 999 } }] }
        }
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }
  process.env.HL_REAL_ACTIONS_CONFIRMED = 'true'
  try {
    assert.deepEqual(await createProvider().submit(plan, secret, nonce), { oid: '999' })
    assert.equal(calls, 1)
    assert.deepEqual(Object.keys(wire).sort(), ['action', 'expiresAfter', 'nonce', 'signature'])
    assert.deepEqual(wire.action, { type: 'order', orders: [plan.order], grouping: 'na' })
    assert.equal(wire.action.orders[0].a, 3)
    assert.equal(wire.action.orders[0].b, false)
    assert.equal(wire.action.orders[0].r, true)
    assert.equal(wire.action.orders[0].t.limit.tif, 'Ioc')
    assert.equal(wire.nonce, nonce)
    assert.equal(wire.expiresAfter, now + 5000)
    const connectionId = createL1ActionHash({
      action: wire.action,
      nonce,
      expiresAfter: wire.expiresAfter
    })
    const recovered = await recoverTypedDataAddress({
      domain: {
        name: 'Exchange',
        version: '1',
        chainId: 1337,
        verifyingContract: '0x0000000000000000000000000000000000000000'
      },
      types: {
        Agent: [
          { name: 'source', type: 'string' },
          { name: 'connectionId', type: 'bytes32' }
        ]
      },
      primaryType: 'Agent',
      message: { source: 'b', connectionId },
      signature: serializeSignature({ ...wire.signature, v: BigInt(wire.signature.v) })
    })
    assert.equal(recovered.toLowerCase(), privateKeyToAccount(secret).address.toLowerCase())
    assert.notEqual(
      connectionId,
      createL1ActionHash({ action: wire.action, nonce, expiresAfter: wire.expiresAfter + 1 })
    )
  } finally {
    globalThis.fetch = originalFetch
    if (originalFlag === undefined) delete process.env.HL_REAL_ACTIONS_CONFIRMED
    else process.env.HL_REAL_ACTIONS_CONFIRMED = originalFlag
  }
})

test('agent role is rejected before signer preparation despite valid address control', async () => {
  await assert.rejects(probe(0, false, false, 'agent'), /Unsupported master account role/)
})
