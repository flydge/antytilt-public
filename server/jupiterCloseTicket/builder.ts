import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js'
import bs58 from 'bs58'
import { OperatorError } from './types.js'
import type { Binding, Prepared, SignedReceipt } from './types.js'
export const PROGRAM = new PublicKey(
  'PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu',
)
export const TOKEN = new PublicKey(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
)
export const ATA = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
export const WSOL = 'So11111111111111111111111111111111111111112'
export const IDL_SHA =
  'd879c33428655c5d68ab099664c7403adddeb24df84a05a2e7049b75e18364af'
export const hash = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex')
const idlBytes = readFileSync(new URL('./idl.json', import.meta.url))
if (hash(idlBytes) !== IDL_SHA) throw new Error('IDL provenance mismatch')
export const idl = JSON.parse(idlBytes.toString())
export function discriminator(namespace: string, name: string) {
  return createHash('sha256')
    .update(`${namespace}:${name}`)
    .digest()
    .subarray(0, 8)
}
export function u64(value: unknown, name: string, positive = false): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value))
    throw new Error(`${name} requires canonical decimal U64`)
  const n = BigInt(value)
  if (
    n > 0xffffffffffffffffn ||
    (positive && (n === 0n || n === 0xffffffffffffffffn))
  )
    throw new Error(`${name} out of finite range`)
  return n
}
function integer(n: bigint, size = 8, signed = false) {
  const b = Buffer.alloc(size)
  if (size === 8) {
    if (signed) b.writeBigInt64LE(n)
    else b.writeBigUInt64LE(n)
  } else b[0] = Number(n)
  return b
}
// Pinned IDL is the authority for Borsh layouts, including enum/option tags.
export function encode(type: any, value: any): Buffer {
  if (type === 'u64') return integer(u64(value, 'IDL u64'))
  if (type === 'i64') return integer(BigInt(value), 8, true)
  if (type === 'u8') return integer(BigInt(value), 1)
  if (type === 'bool') return Buffer.from([value ? 1 : 0])
  if (type === 'publicKey') return new PublicKey(value).toBuffer()
  if (type === 'u128') {
    let n = BigInt(value)
    const b = Buffer.alloc(16)
    for (let i = 0; i < 16; i++) {
      b[i] = Number(n & 255n)
      n >>= 8n
    }
    return b
  }
  if (type === 'string') {
    const b = Buffer.from(value)
    const l = Buffer.alloc(4)
    l.writeUInt32LE(b.length)
    return Buffer.concat([l, b])
  }
  if (type.option)
    return value === null
      ? Buffer.from([0])
      : Buffer.concat([Buffer.from([1]), encode(type.option, value)])
  if (type.vec) {
    const l = Buffer.alloc(4)
    l.writeUInt32LE(value.length)
    return Buffer.concat([l, ...value.map((v: any) => encode(type.vec, v))])
  }
  if (type.defined) {
    const d = idl.types.find((t: any) => t.name === type.defined)?.type
    if (!d) throw new Error('Unknown IDL type')
    if (d.kind === 'struct')
      return Buffer.concat(
        d.fields.map((f: any) => encode(f.type, value[f.name])),
      )
    if (d.kind === 'enum') {
      const i = d.variants.findIndex((v: any) => v.name === value)
      if (i < 0 || d.variants[i].fields) throw new Error('Unsupported enum')
      return Buffer.from([i])
    }
  }
  if (type.array)
    return Buffer.concat(value.map((v: any) => encode(type.array[0], v)))
  throw new Error('Unsupported IDL encoding')
}
export function associated(owner: string, mint: string) {
  return PublicKey.findProgramAddressSync(
    [
      new PublicKey(owner).toBuffer(),
      TOKEN.toBuffer(),
      new PublicKey(mint).toBuffer(),
    ],
    ATA,
  )[0].toBase58()
}
export function positionAddress(
  b: Pick<Binding, 'owner' | 'pool' | 'custody' | 'collateralCustody'>,
) {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('position'),
      ...['owner', 'pool', 'custody', 'collateralCustody'].map((k) =>
        new PublicKey(b[k as keyof typeof b]).toBuffer(),
      ),
      Buffer.from([1]),
    ],
    PROGRAM,
  )[0].toBase58()
}
export function prepareTicket(b: Binding, version: Prepared['version'] = 1): Prepared {
  if (version !== 1 && version !== 2) throw new Error('Unsupported prepared ticket version')
  if (b.side !== 'Long' || b.mint !== WSOL || b.custody !== b.collateralCustody)
    throw new Error('Only dedicated SOL Long with collateral wSOL supported')
  if (b.position !== positionAddress(b))
    throw new Error('Position PDA binding mismatch')
  if (b.owner !== b.nonceAuthority)
    throw new Error('Owner must be nonce authority and fee payer')
  if (b.recipient !== associated(b.owner, b.mint))
    throw new Error('Recipient must be owner pinned wSOL ATA')
  for (const k of [
    'genesis',
    'owner',
    'position',
    'pool',
    'custody',
    'collateralCustody',
    'mint',
    'recipient',
    'nonce',
    'nonceAuthority',
    'nonceValue',
  ] as const)
    new PublicKey(b[k])
  const bound = u64(b.absolutePriceBound, 'absolutePriceBound', true),
    counter = u64(b.counter, 'counter')
  u64(b.maxFeeLamports, 'maxFeeLamports', true)
  u64(b.maxRentLamports, 'maxRentLamports', true)
  if (
    u64(b.sizeUsd, 'sizeUsd', true) === 0n ||
    !/^[a-f0-9]{64}$/.test(b.positionHash) ||
    !b.triggerEvent ||
    b.triggerEvent.length > 160 ||
    !Number.isSafeInteger(b.observedSlot) ||
    b.observedSlot < 0 ||
    !/^[0-9]+$/.test(b.programDeployment)
  )
    throw new Error('Invalid snapshot binding')
  const request = PublicKey.findProgramAddressSync(
      [
        Buffer.from('position_request'),
        new PublicKey(b.position).toBuffer(),
        integer(counter),
        Buffer.from([2]),
      ],
      PROGRAM,
    )[0].toBase58(),
    requestAta = associated(request, b.mint)
  const accounts: Record<string, string> = {
    owner: b.owner,
    receivingAccount: b.recipient,
    perpetuals: PublicKey.findProgramAddressSync(
      [Buffer.from('perpetuals')],
      PROGRAM,
    )[0].toBase58(),
    pool: b.pool,
    position: b.position,
    positionRequest: request,
    positionRequestAta: requestAta,
    custody: b.custody,
    collateralCustody: b.collateralCustody,
    desiredMint: b.mint,
    referral: PROGRAM.toBase58(),
    tokenProgram: TOKEN.toBase58(),
    associatedTokenProgram: ATA.toBase58(),
    systemProgram: SystemProgram.programId.toBase58(),
    eventAuthority: PublicKey.findProgramAddressSync(
      [Buffer.from('__event_authority')],
      PROGRAM,
    )[0].toBase58(),
    program: PROGRAM.toBase58(),
  }
  const def = idl.instructions.find(
    (i: any) => i.name === 'createDecreasePositionMarketRequest',
  )
  const data = Buffer.concat([
    discriminator('global', 'create_decrease_position_market_request'),
    encode(def.args[0].type, {
      collateralUsdDelta: '0',
      sizeUsdDelta: '0',
      priceSlippage: bound.toString(),
      jupiterMinimumOut: null,
      entirePosition: true,
      counter: counter.toString(),
    }),
  ])
  const close = new TransactionInstruction({
    programId: PROGRAM,
    keys: def.accounts.map((a: any) => ({
      pubkey: new PublicKey(accounts[a.name]),
      isSigner: a.isSigner,
      isWritable: a.isMut,
    })),
    data,
  })
  const tx = new Transaction({
    feePayer: new PublicKey(b.owner),
    recentBlockhash: b.nonceValue,
  })
  tx.add(
    SystemProgram.nonceAdvance({
      noncePubkey: new PublicKey(b.nonce),
      authorizedPubkey: new PublicKey(b.owner),
    }),
  )
  // v1 stays compatible with saved authority. v2 fixes fees before signing.
  if (version === 2) tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }))
  tx.add(close)
  const message = tx.serializeMessage()
  return {
    version,
    binding: structuredClone(b),
    messageHash: hash(message),
    unsignedPacket: tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64'),
    request,
    requestAta,
  }
}
export function validateSignedPacket(
  p: Prepared,
  packet: Uint8Array,
): SignedReceipt {
  if (packet.length > 1232) throw new Error('Packet too large')
  const expected = prepareTicket(p.binding, p.version)
  if (
    (p.version !== 1 && p.version !== 2) ||
    p.messageHash !== expected.messageHash ||
    p.request !== expected.request ||
    p.requestAta !== expected.requestAta ||
    p.unsignedPacket !== expected.unsignedPacket
  )
    throw new Error('Invalid immutable prepared ticket')
  const tx = Transaction.from(Buffer.from(packet))
  if (hash(tx.serializeMessage()) !== p.messageHash)
    throw new OperatorError(
      'MESSAGE_MODIFIED',
      'Wallet modified immutable message',
    )
  if (
    tx.signatures.length !== 1 ||
    tx.signatures[0].publicKey.toBase58() !== p.binding.owner ||
    !tx.verifySignatures(true) ||
    !tx.signature
  )
    throw new OperatorError(
      'SIGNATURE_INVALID',
      'Valid owner signature required',
    )
  if (!tx.serialize().equals(Buffer.from(packet)))
    throw new Error('Noncanonical signed packet')
  return { signature: bs58.encode(tx.signature), packetHash: hash(packet) }
}
