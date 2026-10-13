import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, chmodSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { Pool } from 'pg'
import { Transaction } from '@solana/web3.js'
import { fixture } from './testFixture.js'
import { PacketVault } from './vault.js'
const module: any = await import('./store.js').catch(() => ({}))
import { postgresBinDir, postgresSkipReason } from '../testPostgres.js'
const pg = postgresBinDir() ?? ''
const skipWithoutPostgres = pg ? false : postgresSkipReason
async function port() {
  const s = createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const n = (s.address() as any).port
  await new Promise<void>((r) => s.close(() => r()))
  return n
}
function child(file: string, id: string) {
  return new Promise<string>((resolve, reject) => {
    const p = spawn(
      process.execPath,
      [
        'node_modules/tsx/dist/cli.mjs',
        'server/jupiterCloseTicket/store-process.fixture.ts',
        file,
        id,
        'event',
      ],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let result = ''
    p.stdout.on('data', (b) => {
      result += b
    })
    p.stderr.on('data', () => {})
    p.on('exit', (c) =>
      c === 0
        ? resolve(result.trim())
        : reject(new Error('Child store failed')),
    )
  })
}
test('encrypted PostgreSQL restart, duplicate nonce/position reservation, tamper and separate-process send intent', { skip: skipWithoutPostgres }, async () => {
  assert.equal(
    typeof module.TicketStore,
    'function',
    'transactional TicketStore missing',
  )
  const dir = mkdtempSync(join(tmpdir(), 'jupiter-ticket-pg-'))
  chmodSync(dir, 0o700)
  const key = join(dir, 'key')
  writeFileSync(key, Buffer.alloc(32, 21), { mode: 0o600 })
  const n = await port(),
    data = join(dir, 'cluster')
  execFileSync(
    pg + 'initdb',
    ['-D', data, '-A', 'trust', '--no-locale', '-U', 'ticket_test'],
    { stdio: 'pipe' },
  )
  execFileSync(
    pg + 'pg_ctl',
    [
      '-D',
      data,
      '-l',
      join(dir, 'postgres.log'),
      '-o',
      `-h 127.0.0.1 -p ${n} -k ${dir}`,
      '-w',
      'start',
    ],
    { stdio: 'pipe' },
  )
  const database = {
      host: '127.0.0.1',
      port: n,
      user: 'ticket_test',
      database: 'postgres',
    },
    config = join(dir, 'config.json')
  writeFileSync(config, JSON.stringify({ database, keyFile: key }), {
    mode: 0o600,
  })
  let pool = new Pool(database)
  try {
    const vault = new PacketVault(key, process.cwd())
    let store = new module.TicketStore(pool, vault)
    await store.migrate()
    const f = fixture(),
      p = f.prepared,
      created = await store.create(p)
    await assert.rejects(() => store.create(p))
    const altered = { ...p.binding, nonce: fixture().prepared.binding.nonce }
    const { prepareTicket } = await import('./builder.js')
    await assert.rejects(() => store.create(prepareTicket(altered)))
    const tx = Transaction.from(Buffer.from(p.unsignedPacket, 'base64'))
    tx.sign(f.owner)
    const raw = tx.serialize()
    const armed = await store.arm(created.id, raw)
    const row = (
      await pool.query('SELECT * FROM jupiter_close_tickets WHERE id=$1', [
        created.id,
      ])
    ).rows[0]
    assert.ok(!JSON.stringify(row).includes(raw.toString('base64')))
    assert.ok(!JSON.stringify(row).includes(p.unsignedPacket))
    assert.ok(!JSON.stringify(row).includes(p.binding.absolutePriceBound))
    await pool.end()
    pool = new Pool(database)
    store = new module.TicketStore(pool, new PacketVault(key, process.cwd()))
    assert.ok(store.packet(await store.get(created.id)).equals(raw))
    const results = await Promise.all([
      child(config, created.id),
      child(config, created.id),
    ])
    assert.deepEqual(results.sort(), ['CLAIMED', 'REFUSED'])
    const pending = await store.get(created.id)
    assert.equal(pending.status, 'SUBMITTING')
    assert.equal(pending.signature, armed.signature)
    assert.equal(pending.intentEvent, 'event')
    assert.ok(pending.intentAt)
    await assert.rejects(() => store.claim(created.id, 'event'))
    await store.transition(created.id, 'UNKNOWN', 'RPC timeout')
    await assert.rejects(() => store.claim(created.id, 'event'))
    // Actual persistent disable/revoke sequence: no simulation/send, only finalized observation.
    const revokeFixture = fixture(),
      revokePrepared = await store.create(revokeFixture.prepared),
      revokeTx = Transaction.from(
        Buffer.from(revokeFixture.prepared.unsignedPacket, 'base64'),
      )
    revokeTx.sign(revokeFixture.owner)
    await store.arm(revokePrepared.id, revokeTx.serialize())
    const { CloseTicketBot } = await import('./bot.js'),
      { JupiterReader } = await import('./reader.js')
    const b = revokeFixture.prepared.binding,
      nonceData = Buffer.alloc(80)
    nonceData.writeUInt32LE(1, 0)
    nonceData.writeUInt32LE(1, 4)
    new (await import('@solana/web3.js')).PublicKey(b.owner)
      .toBuffer()
      .copy(nonceData, 8)
    new (await import('@solana/web3.js')).PublicKey(b.nonceValue)
      .toBuffer()
      .copy(nonceData, 40)
    const reader = new JupiterReader({
        call: async (method: string) =>
          method === 'getGenesisHash'
            ? b.genesis
            : {
                value: {
                  owner: '11111111111111111111111111111111',
                  executable: false,
                  data: [nonceData.toString('base64'), 'base64'],
                },
              },
      } as any),
      revokeBot = new CloseTicketBot(store, reader)
    await revokeBot.disable(revokePrepared.id)
    assert.equal((await store.get(revokePrepared.id)).status, 'DISABLED')
    await assert.rejects(() => revokeBot.confirmRevoke(revokePrepared.id))
    assert.equal((await store.get(revokePrepared.id)).status, 'DISABLED')
    Buffer.alloc(32, 17).copy(nonceData, 40)
    const revoked = await revokeBot.confirmRevoke(revokePrepared.id)
    assert.equal(revoked.status, 'REVOKED')
    assert.equal(revoked.intentAt, null)
    assert.equal(revoked.intentEvent, null)
    await assert.rejects(() => store.claim(revokePrepared.id, 'event'))
    await assert.rejects(() => revokeBot.confirmRevoke(created.id))
    // Budget and trigger fields are not encoded into message; authenticated manifest must resist DB edits.
    await pool.query(
      'UPDATE jupiter_close_tickets SET prepared_ciphertext=$2 WHERE id=$1',
      [created.id, row.prepared_ciphertext.slice(0, -4) + 'xxxx'],
    )
    await assert.rejects(() => store.get(created.id))
    await pool.query(
      'UPDATE jupiter_close_tickets SET prepared_ciphertext=$2 WHERE id=$1',
      [created.id, row.prepared_ciphertext],
    )
    await pool.query(
      'UPDATE jupiter_close_tickets SET nonce_value=$2 WHERE id=$1',
      [created.id, p.binding.genesis],
    )
    await assert.rejects(() => store.get(created.id), /binding/i)
    console.log(
      JSON.stringify({
        postgres: 'isolated native PostgreSQL17',
        crossProcess: 'one claimant',
        restartExactBytes: true,
        encryptedMetadata: true,
        artifactDirectory: dir,
      }),
    )
  } finally {
    await pool.end()
    execFileSync(pg + 'pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'], {
      stdio: 'pipe',
    })
  }
})
