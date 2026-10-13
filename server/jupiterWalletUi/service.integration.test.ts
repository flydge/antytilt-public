import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { createPrivateKey, sign, randomBytes } from 'node:crypto'
import { mkdtempSync, chmodSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { Pool } from 'pg'
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { fixture } from '../jupiterCloseTicket/testFixture.js'
import { hash, prepareTicket } from '../jupiterCloseTicket/builder.js'
import { PacketVault } from '../jupiterCloseTicket/vault.js'
import { TicketStore } from '../jupiterCloseTicket/store.js'
import { WalletUiService } from './service.js'
import { postgresBinDir, postgresSkipReason } from '../testPostgres.js'
const pg = postgresBinDir() ?? ''
const skipWithoutPostgres = pg ? false : postgresSkipReason
test('native PostgreSQL recovery keeps active ticket visible, owns prepare atomically and arms authorization atomically', { skip: skipWithoutPostgres }, async () => {
  const listener = createServer()
  await new Promise<void>((r) => listener.listen(0, '127.0.0.1', r))
  const port = (listener.address() as any).port
  await new Promise<void>((r) => listener.close(() => r()))
  const dir = mkdtempSync(join(tmpdir(), 'jupiter-wallet-service-'))
  chmodSync(dir, 0o700)
  const data = join(dir, 'pg'),
    key = join(dir, 'key')
  writeFileSync(key, randomBytes(32), { mode: 0o600 })
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
      join(dir, 'pg.log'),
      '-o',
      `-h 127.0.0.1 -p ${port} -k ${dir}`,
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
      max: 2,
      options: '-c statement_timeout=2000',
    }),
    { owner, prepared } = fixture(),
    b = prepared.binding
  try {
    for (const migration of [
      '011_jupiter_close_tickets.sql',
      '012_jupiter_wallet_ui.sql',
    ])
      await pool.query(
        readFileSync(
          new URL('../migrations/' + migration, import.meta.url),
          'utf8',
        ),
      )
    const store = new TicketStore(pool, new PacketVault(key, process.cwd())),
      config = {
        rpc: 'http://127.0.0.1:19980',
        genesis: b.genesis,
        trustedOrigin: 'http://127.0.0.1:15973',
        mode: 'native-rehearsal' as const,
        keyFile: key,
      },
      s = new WalletUiService(pool, store, config)
    const scope = {
      userId: 'service-test-owner',
      sessionId: hash('test-app-session'),
      origin: config.trustedOrigin,
    }
    await s.ownership.session(scope)
    const c = await s.ownership.challenge(scope, b.owner),
      privateKey = createPrivateKey({
        key: Buffer.concat([
          Buffer.from('302e020100300506032b657004220420', 'hex'),
          Buffer.from(owner.secretKey).subarray(0, 32),
        ]),
        type: 'pkcs8',
        format: 'der',
      })
    await s.ownership.verify(
      scope,
      c.id,
      sign(null, Buffer.from(c.message), privateKey).toString('base64'),
    )
    // Native DB invariant test: only public RPC account reads are replaced.
    s.positions = async () => [
      {
        position: b.position,
        owner: b.owner,
        pool: b.pool,
        custody: b.custody,
        collateralCustody: b.collateralCustody,
        sizeUsd: b.sizeUsd,
        collateralUsd: b.collateralUsd,
        openTime: b.openTime,
        observedSlot: b.observedSlot,
      },
    ]
    s.reader.prepare = async (input, version) =>
      prepareTicket({
        ...input,
        positionHash: b.positionHash,
        sizeUsd: b.sizeUsd,
        collateralUsd: b.collateralUsd,
        openTime: b.openTime,
        observedSlot: b.observedSlot,
      }, version)
    s.reader.validateCurrent = async () => {}
    s.reader.simulate = async () => {}
    const nonce = Buffer.alloc(80)
    nonce.writeUInt32LE(1, 0)
    nonce.writeUInt32LE(1, 4)
    owner.publicKey.toBuffer().copy(nonce, 8)
    new PublicKey(b.nonceValue).toBuffer().copy(nonce, 40)
    const ata = Buffer.alloc(165)
    new PublicKey(b.mint).toBuffer().copy(ata)
    owner.publicKey.toBuffer().copy(ata, 32)
    ata[108] = 1
    const account = (data: Buffer, owner: string) => ({
      data: [data.toString('base64'), 'base64'],
      owner,
      executable: false,
      lamports: 10_000_000,
    })
    s.reader.rpc.call = async (method: string, params: any[]) => {
      if (method === 'getGenesisHash') return b.genesis
      if (method === 'getBlockHeight') return 101
      if (method === 'getSignatureStatuses') return { value: [null] }
      if (method === 'getLatestBlockhash')
        return {
          value: { blockhash: b.nonceValue, lastValidBlockHeight: 100 },
        }
      if (method === 'getFeeForMessage') return { value: 5000 }
      if (method === 'getMultipleAccounts')
        return {
          context: { slot: 10 },
          value: [
            account(nonce, '11111111111111111111111111111111'),
            account(ata, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
          ],
        }
      if (method === 'getAccountInfo') {
        const raw = Buffer.alloc(params[1].dataSlice ? 13 : 36)
        raw.writeUInt32LE(params[1].dataSlice ? 3 : 2)
        if (params[1].dataSlice) raw.writeBigUInt64LE(123n, 4)
        else Keypair.generate().publicKey.toBuffer().copy(raw, 4)
        return {
          value: {
            ...account(raw, 'BPFLoaderUpgradeab1e11111111111111111111111'),
            executable: !params[1].dataSlice,
          },
        }
      }
      throw new Error('Unexpected fixture RPC method')
    }
    const request = {
      clientRequestId: crypto.randomUUID(),
      position: b.position,
      floorUsd: '150',
      maxFeeSol: '0.000005',
      maxRentSol: '0.008',
      expiresMinutes: 30,
    }
    await pool.query(
      `CREATE FUNCTION refuse_ownership_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected ownership fault'; END $$`,
    )
    await pool.query(
      'CREATE TRIGGER refuse_ownership_test BEFORE INSERT ON jupiter_ui_tickets FOR EACH ROW EXECUTE FUNCTION refuse_ownership_test()',
    )
    await assert.rejects(s.prepare(scope, request))
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM jupiter_close_tickets'))
        .rows[0].n,
      0,
    )
    await pool.query('DROP TRIGGER refuse_ownership_test ON jupiter_ui_tickets')
    await pool.query('DROP FUNCTION refuse_ownership_test()')
    // Historical UUIDs sort lower than the new active row, exercising lost-response discovery.
    for (let i = 0; i < 33; i++) {
      const id = '00000000-0000-4000-8000-' + String(i).padStart(12, '0'),
        p = prepareTicket({
          ...b,
          nonce: Keypair.generate().publicKey.toBase58(),
          nonceValue: Keypair.generate().publicKey.toBase58(),
        })
      const t = await store.create(p)
      await pool.query(
        "UPDATE jupiter_close_tickets SET id=$2,status='REVOKED',prepared_ciphertext=$3 WHERE id=$1",
        [
          t.id,
          id,
          store.vault.encrypt(Buffer.from(JSON.stringify(p)), id + ':prepared'),
        ],
      )
      await pool.query(
        'INSERT INTO jupiter_ui_tickets(ticket_id,user_id,wallet_owner,client_request_id,review_json) VALUES($1,$2,$3,$4,$5)',
        [
          id,
          scope.userId,
          b.owner,
          id,
          store.vault.encrypt(
            Buffer.from(
              JSON.stringify({
                reviewHash: hash(id),
                expiresAt: new Date().toISOString(),
              }),
            ),
            id + ':review',
          ),
        ],
      )
    }
    const simultaneous = await Promise.allSettled(
      Array.from({ length: 6 }, () => s.prepare(scope, request)),
    )
    assert.equal(
      simultaneous.filter((r) => r.status === 'fulfilled').length,
      6,
      'six simultaneous same-request prepares recover the same reservation without pool starvation',
    )
    const ticket = (simultaneous[0] as PromiseFulfilledResult<any>).value
    assert.equal((await store.get(ticket.id)).prepared.version, 2, 'UI must persist the exact fee policy in version 2')
    assert.equal(
      (simultaneous[1] as PromiseFulfilledResult<any>).value.id,
      ticket.id,
    )
    assert.equal((await s.prepare(scope, request)).id, ticket.id)
    const reviewImage = (
      await pool.query(
        'SELECT review_json FROM jupiter_ui_tickets WHERE ticket_id=$1',
        [ticket.id],
      )
    ).rows[0].review_json
    await pool.query(
      'UPDATE jupiter_ui_tickets SET review_json=$2 WHERE ticket_id=$1',
      [
        ticket.id,
        JSON.stringify({ ...ticket, expiresAt: '2099-01-01T00:00:00Z' }),
      ],
    )
    await assert.rejects(
      s.detail(scope, ticket.id),
      /encrypted|authenticate|integrity/i,
      'persisted expiry/review cannot be silently widened',
    )
    await pool.query(
      'UPDATE jupiter_ui_tickets SET review_json=$2 WHERE ticket_id=$1',
      [ticket.id, reviewImage],
    )
    assert.ok(
      (await s.list(scope)).some((t) => t.id === ticket.id),
      'active ticket must remain discoverable after a lost prepare response',
    )
    const otherScope = {
      ...scope,
      userId: 'another-app-user',
      sessionId: hash('other-app-session'),
    }
    await s.ownership.session(otherScope)
    const otherChallenge = await s.ownership.challenge(otherScope, b.owner)
    await s.ownership.verify(
      otherScope,
      otherChallenge.id,
      sign(null, Buffer.from(otherChallenge.message), privateKey).toString(
        'base64',
      ),
    )
    assert.deepEqual(await s.list(otherScope), [])
    for (const action of [
      () => s.detail(otherScope, ticket.id),
      () => s.signingMessage(otherScope, ticket.id),
      () => s.arm(otherScope, ticket.id, Buffer.alloc(0), ticket.reviewHash),
      () => s.trigger(otherScope, ticket.id, ticket.reviewHash),
      () => s.disable(otherScope, ticket.id),
      () => s.confirmRevoke(otherScope, ticket.id),
    ])
      await assert.rejects(action, (e: any) => e.status === 404)
    const unsigned = await s.signingMessage(scope, ticket.id),
      tx = Transaction.from(Buffer.from(unsigned.unsignedPacket, 'base64'))
    tx.sign(owner)
    await pool.query(
      `CREATE FUNCTION refuse_envelope_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.authorization_ciphertext IS NOT NULL THEN RAISE EXCEPTION 'injected envelope fault'; END IF; RETURN NEW; END $$`,
    )
    await pool.query(
      'CREATE TRIGGER refuse_envelope_test BEFORE UPDATE ON jupiter_ui_tickets FOR EACH ROW EXECUTE FUNCTION refuse_envelope_test()',
    )
    await assert.rejects(
      s.arm(scope, ticket.id, tx.serialize(), ticket.reviewHash),
    )
    assert.equal((await store.get(ticket.id)).status, 'PREPARED')
    await pool.query('DROP TRIGGER refuse_envelope_test ON jupiter_ui_tickets')
    await pool.query('DROP FUNCTION refuse_envelope_test()')
    assert.equal(
      (await s.arm(scope, ticket.id, tx.serialize(), ticket.reviewHash)).status,
      'ARMED',
    )
    const restarted = new WalletUiService(
      pool,
      new TicketStore(pool, new PacketVault(key, process.cwd())),
      config,
    )
    assert.equal((await restarted.detail(scope, ticket.id)).status, 'ARMED')
    assert.equal((await restarted.store.get(ticket.id)).prepared.version, 2)
    assert.equal((await restarted.store.get(ticket.id)).prepared.messageHash, (await store.get(ticket.id)).prepared.messageHash)
    assert.equal(
      (await restarted.arm(scope, ticket.id, tx.serialize(), ticket.reviewHash))
        .status,
      'ARMED',
    )
    assert.ok(
      (
        await pool.query(
          'SELECT authorization_ciphertext FROM jupiter_ui_tickets WHERE ticket_id=$1',
          [ticket.id],
        )
      ).rows[0].authorization_ciphertext.startsWith('v1.'),
    )
    assert.ok(
      !JSON.stringify(await restarted.detail(scope, ticket.id)).includes(
        tx.serialize().toString('base64'),
      ),
    )
    let nativeAction = await s.prepareAction(scope, 'REVOKE', ticket.id)
    const legacyActionId = nativeAction.id!
    const legacyTx = Transaction.from(Buffer.from(nativeAction.preview!.unsignedPacket, 'base64'))
    legacyTx.instructions = legacyTx.instructions.filter(ix => !ix.programId.equals(ComputeBudgetProgram.programId))
    const oldPreview = {...nativeAction.preview!, unsignedPacket:legacyTx.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64'), messageHash:hash(legacyTx.serializeMessage()), lastValidBlockHeight:201}
    await pool.query('UPDATE jupiter_ui_actions SET prepared_json=$2 WHERE id=$1', [legacyActionId, store.vault.encrypt(Buffer.from(JSON.stringify(oldPreview)), legacyActionId+':action')])
    nativeAction = await s.prepareAction(scope, 'REVOKE', ticket.id)
    assert.notEqual(nativeAction.id, legacyActionId, 'Unexpired unsigned preview without explicit fee must be replaced before another Phantom signature')
    assert.deepEqual((await pool.query('SELECT status,signature FROM jupiter_ui_actions WHERE id=$1',[legacyActionId])).rows[0], {status:'EXPIRED',signature:null})
    const pendingId = nativeAction.id!
    await pool.query('UPDATE jupiter_ui_actions SET prepared_json=$2 WHERE id=$1', [pendingId, store.vault.encrypt(Buffer.from(JSON.stringify(oldPreview)), pendingId+':action')])
    const callBeforeRace = s.reader.rpc.call.bind(s.reader.rpc)
    let raced = false
    s.reader.rpc.call = async (method, params) => {
      if (method === 'getBlockHeight' && !raced) {
        raced = true
        await pool.query("UPDATE jupiter_ui_actions SET status='SUBMITTING',signature='pending-test-signature' WHERE id=$1",[pendingId])
      }
      return callBeforeRace(method,params)
    }
    const countBeforeRace = (await pool.query('SELECT count(*)::int AS n FROM jupiter_ui_actions')).rows[0].n
    const racingResult = await s.prepareAction(scope,'REVOKE',ticket.id)
    assert.equal(racingResult.id,pendingId)
    assert.equal(racingResult.status,'SUBMITTING','A concurrently claimed send must be preserved, not superseded')
    assert.equal(racingResult.signature,'pending-test-signature')
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM jupiter_ui_actions')).rows[0].n,countBeforeRace,'Lost CAS must not create a second action')
    s.reader.rpc.call = callBeforeRace
    await pool.query("UPDATE jupiter_ui_actions SET status='PREPARED',signature=NULL,prepared_json=$2 WHERE id=$1",[pendingId,store.vault.encrypt(Buffer.from(JSON.stringify(nativeAction.preview)),pendingId+':action')])
    const
      actionId = nativeAction.id!
    const actionImage = (
      await pool.query(
        'SELECT prepared_json FROM jupiter_ui_actions WHERE id=$1',
        [actionId],
      )
    ).rows[0].prepared_json
    await pool.query(
      "UPDATE jupiter_ui_actions SET status='SUBMITTING',signature=$2,prepared_json=$3 WHERE id=$1",
      [
        actionId,
        'missing-signature',
        JSON.stringify({ ...nativeAction.preview, lastValidBlockHeight: 999 }),
      ],
    )
    await assert.rejects(
      s.actionStatus(scope, actionId),
      /encrypted|authenticate|integrity/i,
      'stored unsigned setup review and expiry require authenticated integrity',
    )
    await pool.query(
      'UPDATE jupiter_ui_actions SET prepared_json=$2 WHERE id=$1',
      [actionId, actionImage],
    )
    assert.equal(
      (await s.actionStatus(scope, actionId)).status,
      'EXPIRED',
      'expired setup authority can no longer land; preserve old intent and require a fresh reviewed action',
    )
  } finally {
    await pool.end()
    execFileSync(pg + 'pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'], {
      stdio: 'pipe',
    })
  }
})
