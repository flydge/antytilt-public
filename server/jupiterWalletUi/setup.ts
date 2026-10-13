import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  NONCE_ACCOUNT_LENGTH,
} from '@solana/web3.js'
import bs58 from 'bs58'
import {
  hash,
  associated,
  ATA,
  TOKEN,
  WSOL,
  u64,
} from '../jupiterCloseTicket/builder.js'
import {
  nonceState,
  tokenState,
  type ReadOnlyRpc,
} from '../jupiterCloseTicket/reader.js'
export function decimalUnits(value: string, decimals: number) {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(value)
  if (!match || (match[2]?.length ?? 0) > decimals)
    throw new Error('Enter a finite positive decimal limit')
  const result = (
    BigInt(match[1]) * 10n ** BigInt(decimals) +
    BigInt((match[2] ?? '').padEnd(decimals, '0') || '0')
  ).toString()
  u64(result, 'Reviewed limit', true)
  return result
}
export interface SetupPreview {
  owner: string
  genesis: string
  nonce: string
  recipient: string
  unsignedPacket: string
  messageHash: string
  feeLamports: string
  rentLamports: string
  blockhash: string
  lastValidBlockHeight: number
  kind: 'SETUP' | 'REVOKE'
}
export function validateSetupPacket(
  expected: Pick<SetupPreview, 'owner' | 'messageHash'>,
  packet: Buffer,
) {
  if (packet.length > 1232) throw new Error('Packet bound exceeded')
  const tx = Transaction.from(packet)
  if (hash(tx.serializeMessage()) !== expected.messageHash)
    throw new Error('Wallet modified reviewed setup message')
  if (
    tx.signatures.length !== 1 ||
    tx.signatures[0].publicKey.toBase58() !== expected.owner ||
    !tx.verifySignatures(true) ||
    !tx.signature ||
    !tx.serialize().equals(packet)
  )
    throw new Error('Valid canonical owner signature required')
  return { signature: bs58.encode(tx.signature), packetHash: hash(packet) }
}
export async function setupState(
  rpc: ReadOnlyRpc,
  owner: string,
  nonce: string,
) {
  const recipient = associated(owner, WSOL)
  const r = await rpc.call('getMultipleAccounts', [
    [nonce, recipient],
    { encoding: 'base64', commitment: 'finalized' },
  ])
  const [n, ata] = r.value
  if (n && nonceState(n).authority !== owner)
    throw new Error('Dedicated nonce authority mismatch')
  if (ata) {
    const t = tokenState(ata)
    if (t.owner !== owner || t.mint !== WSOL)
      throw new Error('Owner recipient mismatch')
  }
  return {
    nonceReady: !!n,
    recipientReady: !!ata,
    nonceValue: n ? nonceState(n).value : null,
    recipient,
    slot: r.context.slot,
  }
}
export async function prepareSetup(
  rpc: ReadOnlyRpc,
  input: {
    owner: string
    genesis: string
    nonce: string
    seed: string
    kind?: 'SETUP' | 'REVOKE'
  },
): Promise<SetupPreview | null> {
  const owner = new PublicKey(input.owner),
    nonce = new PublicKey(input.nonce),
    kind = input.kind ?? 'SETUP'
  if ((await rpc.call('getGenesisHash', [])) !== input.genesis)
    throw new Error('Genesis mismatch')
  if (
    !(
      await PublicKey.createWithSeed(owner, input.seed, SystemProgram.programId)
    ).equals(nonce)
  )
    throw new Error('Dedicated nonce derivation mismatch')
  const state = await setupState(rpc, input.owner, input.nonce)
  if (kind === 'REVOKE' && !state.nonceReady)
    throw new Error('No nonce to revoke')
  if (kind === 'SETUP' && state.nonceReady && state.recipientReady) return null
  const latest = (
    await rpc.call('getLatestBlockhash', [{ commitment: 'finalized' }])
  ).value
  const tx = new Transaction({
    feePayer: owner,
    recentBlockhash: latest.blockhash,
  }).add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }))
  let rent = 0
  if (kind === 'REVOKE')
    tx.add(
      SystemProgram.nonceAdvance({
        noncePubkey: nonce,
        authorizedPubkey: owner,
      }),
    )
  else {
    if (!state.nonceReady) {
      const amount = await rpc.call('getMinimumBalanceForRentExemption', [
        NONCE_ACCOUNT_LENGTH,
      ])
      rent += amount
      tx.add(
        SystemProgram.createAccountWithSeed({
          fromPubkey: owner,
          newAccountPubkey: nonce,
          basePubkey: owner,
          seed: input.seed,
          lamports: amount,
          space: NONCE_ACCOUNT_LENGTH,
          programId: SystemProgram.programId,
        }),
        SystemProgram.nonceInitialize({
          noncePubkey: nonce,
          authorizedPubkey: owner,
        }),
      )
    }
    if (!state.recipientReady) {
      rent += await rpc.call('getMinimumBalanceForRentExemption', [165])
      tx.add(
        new TransactionInstruction({
          programId: ATA,
          data: Buffer.from([1]),
          keys: [
            { pubkey: owner, isSigner: true, isWritable: true },
            {
              pubkey: new PublicKey(state.recipient),
              isSigner: false,
              isWritable: true,
            },
            { pubkey: owner, isSigner: false, isWritable: false },
            { pubkey: new PublicKey(WSOL), isSigner: false, isWritable: false },
            {
              pubkey: SystemProgram.programId,
              isSigner: false,
              isWritable: false,
            },
            { pubkey: TOKEN, isSigner: false, isWritable: false },
          ],
        }),
      )
    }
  }
  const message = tx.serializeMessage(),
    fee = (
      await rpc.call('getFeeForMessage', [
        message.toString('base64'),
        { commitment: 'finalized' },
      ])
    ).value
  if (
    !Number.isSafeInteger(fee) ||
    fee < 0 ||
    !Number.isSafeInteger(rent) ||
    rent < 0
  )
    throw new Error('Setup cost quote unavailable')
  return {
    owner: input.owner,
    genesis: input.genesis,
    nonce: input.nonce,
    recipient: state.recipient,
    unsignedPacket: tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64'),
    messageHash: hash(message),
    feeLamports: String(fee),
    rentLamports: String(rent),
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    kind,
  }
}
