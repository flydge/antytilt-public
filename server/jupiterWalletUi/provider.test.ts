import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ComputeBudgetProgram, Keypair, SystemProgram, Transaction } from '@solana/web3.js'
import { fixture } from '../jupiterCloseTicket/testFixture.js'
import { prepareTicket, validateSignedPacket } from '../jupiterCloseTicket/builder.js'
const implementation: any =
  await import('../../src/jupiterWallet/provider.js').catch(() => ({}))
test('Phantom fee-injection reproduction accepts version 2 exact tickets and retains legacy version 1', async () => {
  const {owner,prepared:legacy} = fixture()
  // Characterization of installed Phantom: it injects fees only without SetComputeUnitPrice.
  const provider = {publicKey:owner.publicKey, async signTransaction(tx: Transaction) {
    if (!tx.instructions.some(ix => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 3)) {
      tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({microLamports:1000}))
    }
    tx.sign(owner); return tx
  }}
  await assert.rejects(() => implementation.signExact(provider,legacy.unsignedPacket,owner.publicKey.toBase58()),/modified/)
  const reviewed = prepareTicket(legacy.binding,2 as any)
  const packet = await implementation.signExact(provider,reviewed.unsignedPacket,owner.publicKey.toBase58())
  assert.equal(reviewed.version,2)
  const tx = Transaction.from(Buffer.from(packet,'base64'))
  assert.equal(tx.instructions[0].data.readUInt32LE(),4,'Durable nonce must remain first')
  assert.equal(tx.instructions[1].data[0],3)
  assert.equal(tx.instructions[1].data.readBigUInt64LE(1),0n)
  assert.deepEqual(tx.instructions.at(-1)!.data,Transaction.from(Buffer.from(legacy.unsignedPacket,'base64')).instructions.at(-1)!.data)
  assert.ok(Buffer.from(packet,'base64').length <= 1232)
  assert.ok(validateSignedPacket(reviewed,Buffer.from(packet,'base64')).signature)
  assert.throws(() => validateSignedPacket({...reviewed,version:1},Buffer.from(packet,'base64')),/immutable/)
  const oldTx = Transaction.from(Buffer.from(legacy.unsignedPacket,'base64')); oldTx.sign(owner)
  assert.ok(validateSignedPacket(legacy,oldTx.serialize()).signature)
  tx.instructions[1] = ComputeBudgetProgram.setComputeUnitPrice({microLamports:1});tx.sign(owner)
  assert.throws(() => validateSignedPacket(reviewed,tx.serialize()),/modified/)
})
test('an already verified matching wallet resumes read-only without another signature', () => {
  assert.equal(typeof implementation.canResumeVerified, 'function')
  const owner = Keypair.generate(),
    other = Keypair.generate()
  const provider = {
    isPhantom: true,
    publicKey: owner.publicKey,
    connect() {
      throw new Error('must not connect')
    },
    signMessage() {
      throw new Error('must not sign')
    },
    signTransaction() {
      throw new Error('must not sign')
    },
  }
  assert.equal(
    implementation.canResumeVerified(provider, owner.publicKey.toBase58()),
    true,
  )
  assert.equal(
    implementation.canResumeVerified(provider, other.publicKey.toBase58()),
    false,
  )
  assert.equal(
    implementation.canResumeVerified(
      { ...provider, publicKey: null },
      owner.publicKey.toBase58(),
    ),
    false,
  )
})
test('missing sign-only capability cannot fall back to sign-and-send', () => {
  assert.equal(
    typeof implementation.capability,
    'function',
    'wallet capability adapter missing',
  )
  const provider = {
    isPhantom: true,
    connect() {},
    signMessage() {},
    signAndSendTransaction() {},
  }
  assert.equal(implementation.capability(provider).available, false)
})
test('wallet account changes and modified signing messages cannot be armed', async () => {
  assert.equal(
    typeof implementation.signExact,
    'function',
    'immutable wallet signing missing',
  )
  const owner = Keypair.generate(),
    other = Keypair.generate()
  const tx = new Transaction({
    feePayer: owner.publicKey,
    recentBlockhash: other.publicKey.toBase58(),
  }).add(
    SystemProgram.nonceAdvance({
      noncePubkey: other.publicKey,
      authorizedPubkey: owner.publicKey,
    }),
  )
  const packet = tx
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString('base64')
  const provider = {
    publicKey: owner.publicKey,
    async signTransaction(t: Transaction) {
      t.add(
        SystemProgram.transfer({
          fromPubkey: owner.publicKey,
          toPubkey: other.publicKey,
          lamports: 1,
        }),
      )
      t.sign(owner)
      return t
    },
  }
  await assert.rejects(
    implementation.signExact(provider, packet, owner.publicKey.toBase58()),
    /modified/i,
  )
  provider.publicKey = other.publicKey
  await assert.rejects(
    implementation.signExact(provider, packet, owner.publicKey.toBase58()),
    /account/i,
  )
})
