import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Keypair, PublicKey, Transaction, SystemProgram } from '@solana/web3.js'
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Missing behavior is reported as an assertion, so initial RED is meaningful.
const builder: any = await import('./builder.js').catch(() => ({}))
const vault: any = await import('./vault.js').catch(() => ({}))
const bot: any = await import('./bot.js').catch(() => ({}))
const owner = Keypair.generate(),
  nonce = Keypair.generate().publicKey
const pk = (n: number) => new PublicKey(Buffer.alloc(32, n)).toBase58()
const input: any = {
  genesis: pk(4),
  owner: owner.publicKey.toBase58(),
  position: pk(8),
  pool: pk(9),
  custody: pk(10),
  collateralCustody: pk(10),
  side: 'Long',
  mint: 'So11111111111111111111111111111111111111112',
  recipient: '',
  nonce: nonce.toBase58(),
  nonceAuthority: owner.publicKey.toBase58(),
  nonceValue: pk(7),
  counter: '9007199254740993',
  absolutePriceBound: '150000000',
  maxFeeLamports: '5000',
  maxRentLamports: '4000000',
  triggerEvent: 'demo-session-5',
  programDeployment: '123',
  positionHash: 'a'.repeat(64),
  sizeUsd: '200000000',
  collateralUsd: '10000000',
  openTime: '123',
  observedSlot: 10,
}
const ataProgram = new PublicKey(
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  ),
  tokenProgram = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
input.position = PublicKey.findProgramAddressSync(
  [
    Buffer.from('position'),
    owner.publicKey.toBuffer(),
    new PublicKey(input.pool).toBuffer(),
    new PublicKey(input.custody).toBuffer(),
    new PublicKey(input.collateralCustody).toBuffer(),
    Buffer.from([1]),
  ],
  new PublicKey('PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu'),
)[0].toBase58()
input.recipient = PublicKey.findProgramAddressSync(
  [
    owner.publicKey.toBuffer(),
    tokenProgram.toBuffer(),
    new PublicKey(input.mint).toBuffer(),
  ],
  ataProgram,
)[0].toBase58()
function prepare(overrides: any = {}) {
  assert.equal(
    typeof builder.prepareTicket,
    'function',
    'prepareTicket missing',
  )
  return builder.prepareTicket({ ...input, ...overrides })
}
function signed(p: any) {
  const tx = Transaction.from(Buffer.from(p.unsignedPacket, 'base64'))
  tx.sign(owner)
  return tx.serialize()
}

test('explicit price bound, U64 precision and nonce authority are enforced', () => {
  const p = prepare()
  const tx = Transaction.from(Buffer.from(p.unsignedPacket, 'base64'))
  assert.equal(
    tx.instructions[0].programId.toBase58(),
    '11111111111111111111111111111111',
  )
  assert.equal(tx.instructions[0].data.readUInt32LE(), 4)
  assert.equal(
    tx.instructions.at(-1)!.data.toString('hex'),
    '4ac6c356c163014f0000000000000000000000000000000080d1f008000000000001010100000000002000',
  )
  for (const v of [undefined, '0', '18446744073709551615', '1e9', 150000000])
    assert.throws(() => prepare({ absolutePriceBound: v }))
  assert.throws(() => prepare({ position: pk(8) }), /position/i)
  assert.throws(() => prepare({ nonceAuthority: pk(11) }))
  assert.throws(() => prepare({ side: 'Short' }))
  assert.throws(() => prepare({ recipient: pk(12) }))
})
test('owner signed exact bytes accepted; wallet alterations, extra instruction, wrong and absent signatures rejected', () => {
  const p = prepare()
  const packet = signed(p)
  assert.equal(
    typeof builder.validateSignedPacket,
    'function',
    'validator missing',
  )
  const receipt = builder.validateSignedPacket(p, packet)
  assert.equal(receipt.packetHash.length, 64)
  const altered = Transaction.from(packet)
  altered.add(
    SystemProgram.transfer({
      fromPubkey: owner.publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1,
    }),
  )
  altered.sign(owner)
  assert.throws(
    () => builder.validateSignedPacket(p, altered.serialize()),
    /message|immutable/i,
  )
  assert.throws(
    () =>
      builder.validateSignedPacket(p, Buffer.from(p.unsignedPacket, 'base64')),
    /signature/i,
  )
  const bad = Buffer.from(packet)
  bad[1] ^= 1
  assert.throws(() => builder.validateSignedPacket(p, bad), /signature/i)
  const changed = prepare({ counter: '4' })
  assert.throws(
    () => builder.validateSignedPacket(changed, packet),
    /message|immutable/i,
  )
})
test('AES-GCM exact-packet persistence rejects tamper wrong key and context; external restrictive key required', () => {
  assert.equal(typeof vault.PacketVault, 'function', 'vault missing')
  const dir = mkdtempSync(join(tmpdir(), 'ticket-test-'))
  chmodSync(dir, 0o700)
  const key = join(dir, 'key')
  writeFileSync(key, Buffer.alloc(32, 2), { mode: 0o600 })
  const v = new vault.PacketVault(key, process.cwd()),
    raw = Buffer.from('sensitive-authority-bytes')
  const encrypted = v.encrypt(raw, 'ticket-a')
  assert.ok(!encrypted.includes(raw.toString()))
  assert.deepEqual(v.decrypt(encrypted, 'ticket-a'), raw)
  assert.throws(() => v.decrypt(encrypted, 'ticket-b'))
  const parts = encrypted.split('.')
  const bytes = Buffer.from(parts[3], 'base64url')
  bytes[0] ^= 1
  parts[3] = bytes.toString('base64url')
  assert.throws(() => v.decrypt(parts.join('.'), 'ticket-a'))
  const other = join(dir, 'other')
  writeFileSync(other, Buffer.alloc(32, 3), { mode: 0o600 })
  assert.throws(() =>
    new vault.PacketVault(other, process.cwd()).decrypt(encrypted, 'ticket-a'),
  )
  chmodSync(key, 0o644)
  assert.throws(
    () => new vault.PacketVault(key, process.cwd()),
    /permission|0600/i,
  )
  assert.throws(
    () => new vault.PacketVault(join(process.cwd(), 'key'), process.cwd()),
  )
})
test('closure requires a correlated keeper payout and finalized zero position; cancel/disappearance alone stay unknown', () => {
  assert.equal(
    typeof bot.classifyReconciliation,
    'function',
    'reconciliation missing',
  )
  assert.equal(
    bot.classifyReconciliation({
      requestPresent: false,
      requestSubmission: 'finalized',
      positionSize: '0',
    }),
    'UNKNOWN',
  )
  assert.equal(
    bot.classifyReconciliation({
      requestPresent: true,
      requestSubmission: 'confirmed',
      positionSize: input.sizeUsd,
    }),
    'REQUEST_PENDING',
  )
  assert.equal(
    bot.classifyReconciliation({
      requestPresent: false,
      requestSubmission: 'failed',
      nonceChanged: true,
    }),
    'FAILED_CONSUMED',
  )
  assert.equal(
    bot.classifyReconciliation({
      requestPresent: false,
      requestSubmission: 'missing',
      nonceChanged: true,
    }),
    'UNKNOWN',
  )
  assert.equal(
    bot.classifyReconciliation({
      requestPresent: false,
      positionSize: '0',
      positionFinalized: true,
      keeperCorrelated: true,
      recipientOutcome: true,
    }),
    'CLOSED',
  )
  for (const key of [
    'positionFinalized',
    'keeperCorrelated',
    'recipientOutcome',
  ])
    assert.equal(
      bot.classifyReconciliation({
        requestPresent: false,
        positionSize: '0',
        positionFinalized: true,
        keeperCorrelated: true,
        recipientOutcome: true,
        [key]: false,
      }),
      'UNKNOWN',
    )
})
test('default transport refuses public sends before RPC invocation', async () => {
  assert.equal(typeof bot.LocalOnlySender, 'function', 'sender missing')
  assert.throws(
    () => new bot.LocalOnlySender('https://api.mainnet-beta.solana.com'),
    /loopback|disabled/i,
  )
  assert.throws(
    () => new bot.LocalOnlySender('http://localhost.evil.example:18990'),
    /loopback|disabled/i,
  )
})
