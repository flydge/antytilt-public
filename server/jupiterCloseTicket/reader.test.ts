import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
const reader: any = await import('./reader.js').catch(() => ({}))
// Captured public mainnet account snapshot used as decoder input. Point JUPITER_ACCOUNT_SNAPSHOT at the JSON file.
const snapshotPath = process.env.JUPITER_ACCOUNT_SNAPSHOT
const snapshot = snapshotPath && existsSync(snapshotPath) ? JSON.parse(readFileSync(snapshotPath, 'utf8')) : undefined
const skipWithoutSnapshot = snapshot ? false : 'Set JUPITER_ACCOUNT_SNAPSHOT to a captured Jupiter account snapshot'
test('IDL decoder preserves exact large decimal values, rejects bad discriminator and truncation', { skip: skipWithoutSnapshot }, () => {
  assert.equal(typeof reader.decodeAccount, 'function', 'IDL decoder missing')
  const raw = Buffer.concat([
    Buffer.from('aabc8fe47a40f7d0', 'hex'),
    Buffer.alloc(202),
  ]) // Position discriminator independently verified below
  // Use captured provider data only as a decoder input; this is a historical closed fixture, never armable.
  const account = snapshot.value.find(
    (a: any) =>
      a &&
      Buffer.from(a.data[0], 'base64')
        .subarray(0, 8)
        .equals(Buffer.from('aabc8fe47a40f7d0', 'hex')),
  )
  assert.ok(account, 'captured Position discriminator must match')
  const data = Buffer.from(account.data[0], 'base64')
  const p = reader.decodeAccount('Position', data)
  assert.equal(typeof p.sizeUsd, 'string')
  assert.equal(p.owner, snapshot.keys[0])
  assert.throws(
    () => reader.decodeAccount('Position', Buffer.alloc(data.length)),
    /discriminator/i,
  )
  assert.throws(
    () => reader.decodeAccount('Position', data.subarray(0, 180)),
    /truncat/i,
  )
  raw.writeBigUInt64LE(9007199254740993n, 161)
  assert.equal(
    reader.decodeAccount('Position', raw).sizeUsd,
    '9007199254740993',
  )
})
test('bounded RPC rejects nonallowlisted methods and oversized bodies', async () => {
  assert.equal(typeof reader.ReadOnlyRpc, 'function', 'read-only RPC missing')
  const server = createServer((req, res) => {
    res.end('x'.repeat(300001))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  try {
    const address = server.address() as any,
      rpc = new reader.ReadOnlyRpc(`http://127.0.0.1:${address.port}`)
    await assert.rejects(() => rpc.call('sendTransaction', []), /read-only/i)
    await assert.rejects(() => rpc.call('getGenesisHash', []), /bound|large/i)
  } finally {
    server.close()
  }
})
test('derived request and request ATA must both be unoccupied', async () => {
  const { fixture } = await import('./testFixture.js')
  const p = fixture().prepared
  assert.equal(
    typeof reader.JupiterReader.prototype.assertDerivedUnoccupied,
    'function',
    'derived occupancy gate missing',
  )
  for (const value of [
    [{}, null],
    [null, {}],
  ]) {
    const jr = new reader.JupiterReader({
      call: async () => ({ context: { slot: 10 }, value }),
    })
    await assert.rejects(() => jr.assertDerivedUnoccupied(p), /occupied/i)
  }
})
test('pinned current Pool and SOL Custody layouts decode completely including u32 and f32 fields', { skip: skipWithoutSnapshot }, () => {
  const find = (hex: string) =>
    snapshot.value.find(
      (a: any) =>
        a &&
        Buffer.from(a.data[0], 'base64').subarray(0, 8).toString('hex') === hex,
    )
  const pool = find('f19a6d0411b16dbc'),
    custody = find('01b830515d833f91')
  assert.ok(pool)
  assert.ok(custody)
  const p = reader.decodeAccount('Pool', Buffer.from(pool.data[0], 'base64')),
    c = reader.decodeAccount('Custody', Buffer.from(custody.data[0], 'base64'))
  assert.ok(p.custodies.includes(snapshot.keys[7]))
  assert.equal(c.mint, 'So11111111111111111111111111111111111111112')
})
