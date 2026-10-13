import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import { hash } from '../jupiterCloseTicket/builder.js'
const implementation: any = await import('./setup.js').catch(() => ({}))
test('setup and revoke quote an explicit zero priority fee before Phantom can alter the message', async () => {
  const owner = Keypair.generate().publicKey, seed = 'phantom-fee-test'
  const nonce = await PublicKey.createWithSeed(owner, seed, SystemProgram.programId)
  const blockhash = Keypair.generate().publicKey.toBase58()
  for (const kind of ['SETUP', 'REVOKE']) {
    const data = Buffer.alloc(80)
    data.writeUInt32LE(1, 0); data.writeUInt32LE(1, 4)
    owner.toBuffer().copy(data, 8); new PublicKey(blockhash).toBuffer().copy(data, 40)
    let quoted: string | undefined
    const rpc = { async call(method: string, params: any[]) {
      switch (method) {
        case 'getGenesisHash': return blockhash
        case 'getMultipleAccounts': return {context:{slot:1},value:[kind === 'REVOKE' ? {owner:SystemProgram.programId.toBase58(),data:[data.toString('base64'),'base64']} : null,null]}
        case 'getLatestBlockhash': return {value:{blockhash,lastValidBlockHeight:100}}
        case 'getMinimumBalanceForRentExemption': return 1000000
        case 'getFeeForMessage': quoted=params[0]; return {value:5000}
        default: throw new Error('Unexpected RPC '+method)
      }
    }}
    const preview = await implementation.prepareSetup(rpc,{owner:owner.toBase58(),genesis:blockhash,nonce:nonce.toBase58(),seed,kind})
    const tx = Transaction.from(Buffer.from(preview.unsignedPacket,'base64'))
    const prices = tx.instructions.filter((ix: any) => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 3)
    assert.equal(prices.length,1,'Explicit priority price missing; Phantom would rewrite setup')
    assert.equal(prices[0].data.readBigUInt64LE(1),0n)
    assert.equal(quoted,tx.serializeMessage().toString('base64'))
    assert.equal(preview.messageHash,hash(tx.serializeMessage()))
    assert.equal(preview.feeLamports,'5000')
  }
})
test('USD limits retain decimal precision and reject invented/extreme price floors', () => {
  assert.equal(
    typeof implementation.decimalUnits,
    'function',
    'human price conversion missing',
  )
  assert.equal(implementation.decimalUnits('150.000001', 6), '150000001')
  assert.equal(
    implementation.decimalUnits('9007199254.740993', 6),
    '9007199254740993',
  )
  for (const bad of [
    '0',
    '-1',
    '1e8',
    'Infinity',
    '1.0000001',
    '18446744073709.551615',
  ])
    assert.throws(() => implementation.decimalUnits(bad, 6))
})
test('setup packet validation rejects wallet assertions and wrong signature before transport', () => {
  assert.equal(
    typeof implementation.validateSetupPacket,
    'function',
    'immutable setup validation missing',
  )
  const owner = Keypair.generate(),
    target = Keypair.generate()
  const tx = new Transaction({
    feePayer: owner.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  }).add(
    SystemProgram.nonceAdvance({
      noncePubkey: target.publicKey,
      authorizedPubkey: owner.publicKey,
    }),
  )
  const expected = {
    owner: owner.publicKey.toBase58(),
    messageHash: hash(tx.serializeMessage()),
  }
  tx.sign(owner)
  assert.ok(
    implementation.validateSetupPacket(expected, tx.serialize()).signature,
  )
  tx.add(
    SystemProgram.transfer({
      fromPubkey: owner.publicKey,
      toPubkey: target.publicKey,
      lamports: 1,
    }),
  )
  tx.sign(owner)
  assert.throws(
    () => implementation.validateSetupPacket(expected, tx.serialize()),
    /modified/i,
  )
})
