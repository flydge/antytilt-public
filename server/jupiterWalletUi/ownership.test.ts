import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { Pool } from 'pg'
import bs58 from 'bs58'
const module: any = await import('./ownership.js').catch(() => ({}))
import { postgresBinDir, postgresSkipReason } from '../testPostgres.js'
const pg = postgresBinDir() ?? ''
const skipWithoutPostgres = pg ? false : postgresSkipReason
const origin = 'http://localhost:5173',
  genesis = bs58.encode(Buffer.alloc(32, 3))
function scope() {
  return {
    userId: randomUUID(),
    sessionId: createHash('sha256').update(randomUUID()).digest('hex'),
    origin,
  }
}
function wallet() {
  const pair = generateKeyPairSync('ed25519')
  const owner = bs58.encode(
    pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32),
  )
  return {
    owner,
    signature: (message: string) =>
      sign(null, Buffer.from(message), pair.privateKey).toString('base64'),
  }
}
async function unusedPort() {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}
function status(expected: number) {
  return (error: any) =>
    error.status === expected && !error.message.includes('signatureBase64')
}

test('wallet ownership enforces real PostgreSQL session, proof, replay and atomicity boundaries', { skip: skipWithoutPostgres }, async (t) => {
  assert.equal(
    typeof module.WalletOwnership,
    'function',
    'wallet ownership implementation missing',
  )
  const directory = mkdtempSync(join(tmpdir(), 'antytilt-wallet-ownership-'))
  chmodSync(directory, 0o700)
  const data = join(directory, 'cluster'),
    port = await unusedPort()
  execFileSync(
    pg + 'initdb',
    ['-D', data, '-A', 'trust', '--no-locale', '-U', 'wallet_test'],
    { stdio: 'pipe' },
  )
  execFileSync(
    pg + 'pg_ctl',
    [
      '-D',
      data,
      '-l',
      join(directory, 'postgres.log'),
      '-o',
      `-h 127.0.0.1 -p ${port} -k ${directory}`,
      '-w',
      'start',
    ],
    { stdio: 'pipe' },
  )
  const pool = new Pool({
    host: '127.0.0.1',
    port,
    user: 'wallet_test',
    database: 'postgres',
  })
  let now = Date.parse('2026-10-12T12:00:00Z')
  const ownership = new module.WalletOwnership(pool, genesis, origin, () => now)
  try {
    await pool.query(
      readFileSync(
        new URL('../migrations/011_jupiter_close_tickets.sql', import.meta.url),
        'utf8',
      ),
    )
    await pool.query(
      readFileSync(
        new URL('../migrations/012_jupiter_wallet_ui.sql', import.meta.url),
        'utf8',
      ),
    )
    await t.test(
      'scope requires an authenticated scalar user and SHA256 session ID',
      async () => {
        const s = scope()
        for (const invalid of [
          { ...s, userId: '' },
          { ...s, userId: 'a\nuser' },
          { ...s, sessionId: 'raw-cookie' },
          { ...s, sessionId: { toString: () => s.sessionId } },
        ]) {
          await assert.rejects(() => ownership.session(invalid), status(401))
        }
      },
    )
    await t.test(
      'CSRF persists through service restart and cannot cross origin, user, session or expiry',
      async () => {
        const s = scope(),
          session = await ownership.session(s)
        assert.match(session.csrf, /^[0-9a-f]{64}$/)
        assert.deepEqual(
          {
            owner: session.owner,
            genesis: session.genesis,
            origin: session.origin,
          },
          { owner: null, genesis, origin },
        )
        assert.equal(
          (
            await new module.WalletOwnership(
              pool,
              genesis,
              origin,
              () => now,
            ).session(s)
          ).csrf,
          session.csrf,
        )
        await ownership.requireMutation(s, session.csrf)
        await assert.rejects(
          () =>
            ownership.requireMutation(
              { ...s, origin: 'https://evil.example' },
              session.csrf,
            ),
          status(403),
        )
        await assert.rejects(
          () =>
            ownership.requireMutation(
              { ...s, sessionId: scope().sessionId },
              session.csrf,
            ),
          status(403),
        )
        await assert.rejects(
          () =>
            ownership.requireMutation(
              { ...s, userId: scope().userId },
              session.csrf,
            ),
          status(403),
        )
        await assert.rejects(
          () => ownership.requireMutation(s, 'a'.repeat(64)),
          status(403),
        )
        now += 24 * 60 * 60 * 1000
        await assert.rejects(
          () => ownership.requireMutation(s, session.csrf),
          status(403),
        )
        const fresh = await ownership.session(s)
        assert.notEqual(fresh.csrf, session.csrf)
        now -= 24 * 60 * 60 * 1000
      },
    )
    await t.test(
      'stored sign-in message binds domain, URI, owner, genesis, nonce and exact expiry',
      async () => {
        const s = scope(),
          w = wallet()
        await ownership.session(s)
        const c = await ownership.challenge(s, w.owner)
        assert.match(
          c.id,
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        )
        assert.equal(c.owner, w.owner)
        assert.equal(c.genesis, genesis)
        assert.equal(c.expiresAt, now + 300_000)
        assert.ok(
          c.message.startsWith(
            'localhost:5173 wants you to sign in with your Solana account:\n' +
              w.owner,
          ),
        )
        assert.ok(
          c.message.includes(
            'URI: http://localhost:5173\nVersion: 1\nChain ID: localnet\n',
          ),
        )
        assert.ok(c.message.endsWith('Resources:\n- urn:solana:genesis:' + genesis))
        assert.match(c.message, /Nonce: [0-9a-f]{64}\n/)
        assert.ok(
          c.message.includes('Issued At: ' + new Date(now).toISOString()),
        )
        assert.ok(
          c.message.includes(
            'Expiration Time: ' + new Date(now + 300_000).toISOString(),
          ),
        )
        assert.equal(
          await ownership.verify(s, c.id, w.signature(c.message)),
          w.owner,
        )
        assert.equal(await ownership.owner(s), w.owner)
        assert.equal((await ownership.session(s)).owner, w.owner)
        await assert.rejects(
          () => ownership.verify(s, c.id, w.signature(c.message)),
          status(401),
        )
      },
    )
    await t.test(
      'mainnet challenge obeys Phantom SIWS chain grammar and signs the exact genesis resource',
      async () => {
        const mainnetGenesis = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
        const mainnetOrigin = 'http://127.0.0.1:15974'
        const service = new module.WalletOwnership(pool, mainnetGenesis, mainnetOrigin, () => now)
        const s = { ...scope(), origin: mainnetOrigin }, w = wallet()
        await service.session(s)
        const c = await service.challenge(s, w.owner)
        // Phantom's published SIWS ABNF allows names, not arbitrary genesis hashes here.
        const chain = /^Chain ID: (.+)$/m.exec(c.message)?.[1]
        assert.ok(['mainnet', 'testnet', 'devnet', 'localnet', 'solana:mainnet', 'solana:testnet', 'solana:devnet'].includes(chain ?? ''), 'Phantom rejects unsupported SIWS Chain ID')
        assert.equal(chain, 'mainnet')
        assert.ok(c.message.startsWith('127.0.0.1:15974 wants you to sign in with your Solana account:\n' + w.owner + '\n\n'))
        assert.match(c.message, /\nURI: http:\/\/127\.0\.0\.1:15974\n/)
        const resource = 'urn:solana:genesis:' + mainnetGenesis
        assert.equal(new URL(resource).protocol, 'urn:')
        assert.ok(c.message.endsWith('\nResources:\n- ' + resource))
        await assert.rejects(() => service.verify(s, c.id, w.signature(c.message.replace(mainnetGenesis, genesis))), status(401))
        await assert.rejects(() => service.owner(s), status(401))
        const fresh = await service.challenge(s, w.owner)
        assert.equal(await service.verify(s, fresh.id, w.signature(fresh.message)), w.owner)
      },
    )
    await t.test(
      'wrong scope, signature, altered message, chain and malformed inputs never establish authority',
      async () => {
        const s = scope(),
          w = wallet(),
          other = wallet()
        await ownership.session(s)
        const c = await ownership.challenge(s, w.owner),
          signature = w.signature(c.message)
        for (const invalid of [
          { ...s, userId: scope().userId },
          { ...s, sessionId: scope().sessionId },
        ]) {
          await assert.rejects(
            () => ownership.verify(invalid, c.id, signature),
            status(401),
          )
        }
        await assert.rejects(
          () =>
            ownership.verify(
              { ...s, origin: 'https://evil.example' },
              c.id,
              signature,
            ),
          status(403),
        )
        await assert.rejects(
          () =>
            new module.WalletOwnership(
              pool,
              bs58.encode(Buffer.alloc(32, 4)),
              origin,
              () => now,
            ).verify(s, c.id, signature),
          status(401),
        )
        for (const invalid of [
          other.signature(c.message),
          w.signature(c.message + '\n'),
          signature.slice(0, -2),
          'A'.repeat(1000),
          '!!!!',
          Buffer.alloc(63).toString('base64'),
        ]) {
          await assert.rejects(
            () => ownership.verify(s, c.id, invalid),
            status(401),
          )
        }
        await assert.rejects(
          () => ownership.verify(s, c.id.toUpperCase(), signature),
          status(401),
        )
        await assert.rejects(() => ownership.owner(s), status(401))
        for (const invalid of [
          'x',
          '1'.repeat(500),
          bs58.encode(Buffer.alloc(31)),
          'O'.repeat(44),
        ]) {
          await assert.rejects(
            () => ownership.challenge(s, invalid),
            status(400),
          )
        }
        assert.equal(await ownership.verify(s, c.id, signature), w.owner)
      },
    )
    await t.test(
      'challenge expiry and authority expiry use strict time boundaries',
      async () => {
        const s = scope(),
          w = wallet()
        await ownership.session(s)
        const c = await ownership.challenge(s, w.owner)
        now += 300_000
        await assert.rejects(
          () => ownership.verify(s, c.id, w.signature(c.message)),
          status(401),
        )
        const valid = await ownership.challenge(s, w.owner)
        await ownership.verify(s, valid.id, w.signature(valid.message))
        now += 24 * 60 * 60 * 1000
        await assert.rejects(() => ownership.owner(s), status(401))
        assert.equal((await ownership.session(s)).owner, null)
        now -= 24 * 60 * 60 * 1000 + 300_000
      },
    )
    await t.test(
      'fresh account proof invalidates previous ownership and older challenges; disconnect preserves CSRF',
      async () => {
        const s = scope(),
          w = wallet(),
          next = wallet(),
          session = await ownership.session(s)
        const old = await ownership.challenge(s, w.owner)
        await ownership.verify(s, old.id, w.signature(old.message))
        const pending = await ownership.challenge(s, w.owner)
        const fresh = await ownership.challenge(s, next.owner)
        await assert.rejects(() => ownership.owner(s), status(401))
        await assert.rejects(
          () => ownership.verify(s, pending.id, w.signature(pending.message)),
          status(401),
        )
        await ownership.verify(s, fresh.id, next.signature(fresh.message))
        assert.equal(await ownership.owner(s), next.owner)
        await ownership.disconnect(s)
        await assert.rejects(() => ownership.owner(s), status(401))
        assert.equal((await ownership.session(s)).csrf, session.csrf)
        await ownership.requireMutation(s, session.csrf)
      },
    )
    await t.test(
      'concurrent valid proof consumes once across separate instances',
      async () => {
        const s = scope(),
          w = wallet()
        await ownership.session(s)
        const c = await ownership.challenge(s, w.owner),
          signature = w.signature(c.message)
        const second = new module.WalletOwnership(
          pool,
          genesis,
          origin,
          () => now,
        )
        const results = await Promise.allSettled([
          ownership.verify(s, c.id, signature),
          second.verify(s, c.id, signature),
        ])
        assert.equal(
          results.filter((result) => result.status === 'fulfilled').length,
          1,
        )
        assert.equal(
          results.filter((result) => result.status === 'rejected').length,
          1,
        )
        assert.equal(await ownership.owner(s), w.owner)
      },
    )
    await t.test(
      'disconnect cancels an in-flight signed ownership challenge',
      async () => {
        const s = scope(),
          w = wallet()
        await ownership.session(s)
        const c = await ownership.challenge(s, w.owner)
        await ownership.disconnect(s)
        await assert.rejects(
          () => ownership.verify(s, c.id, w.signature(c.message)),
          status(401),
        )
        await assert.rejects(() => ownership.owner(s), status(401))
      },
    )
    await t.test(
      'failed owner persistence rolls back challenge consumption',
      async () => {
        const s = scope(),
          w = wallet()
        await ownership.session(s)
        const c = await ownership.challenge(s, w.owner)
        await pool.query(
          `CREATE FUNCTION refuse_wallet_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.wallet_owner IS NOT NULL THEN RAISE EXCEPTION 'injected test fault'; END IF; RETURN NEW; END $$`,
        )
        await pool.query(
          'CREATE TRIGGER refuse_wallet_test BEFORE UPDATE ON jupiter_ui_sessions FOR EACH ROW EXECUTE FUNCTION refuse_wallet_test()',
        )
        try {
          await assert.rejects(() =>
            ownership.verify(s, c.id, w.signature(c.message)),
          )
        } finally {
          await pool.query(
            'DROP TRIGGER refuse_wallet_test ON jupiter_ui_sessions',
          )
          await pool.query('DROP FUNCTION refuse_wallet_test()')
        }
        assert.equal(
          await ownership.verify(s, c.id, w.signature(c.message)),
          w.owner,
        )
      },
    )
  } finally {
    await pool.end()
    execFileSync(pg + 'pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'], {
      stdio: 'pipe',
    })
  }
})
