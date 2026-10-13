import { PublicKey, Transaction } from '@solana/web3.js'
import {
  idl,
  discriminator,
  hash,
  PROGRAM,
  TOKEN,
  WSOL,
  associated,
  positionAddress,
  prepareTicket,
  u64,
} from './builder.js'
import { OperatorError } from './types.js'
import type { Binding, Prepared } from './types.js'
export class BindingInvalidation extends Error {
  constructor(
    readonly reason:
      | 'TARGET_CHANGED'
      | 'NONCE_CHANGED'
      | 'RECIPIENT_CHANGED'
      | 'PROGRAM_CHANGED',
  ) {
    super('Definitive binding invalidation: ' + reason)
  }
}
type Account = {
  owner: string
  executable: boolean
  lamports: number
  data: [string, string]
}
const allowed = new Set([
  'getGenesisHash',
  'getMultipleAccounts',
  'getAccountInfo',
  'getProgramAccounts',
  'getSignatureStatuses',
  'getTransaction',
  'getFeeForMessage',
  'getMinimumBalanceForRentExemption',
  'getLatestBlockhash',
  'getBlockHeight',
  'getSignaturesForAddress',
  'getBlock',
  'simulateTransaction',
])
export class ReadOnlyRpc {
  constructor(readonly url: string) {
    const u = new URL(url)
    if (
      !['http:', 'https:'].includes(u.protocol) ||
      u.username ||
      u.password ||
      u.search ||
      u.hash
    )
      throw new Error('RPC URL must not carry credentials')
  }
  async call(method: string, params: unknown[]): Promise<any> {
    if (!allowed.has(method)) throw new Error('Read-only RPC method required')
    return boundedRpc(this.url, method, params)
  }
}
export async function boundedRpc(
  url: string,
  method: string,
  params: unknown[],
): Promise<any> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
  })
  if (!response.ok || !response.body) throw new Error('RPC transport rejected')
  const stream = response.body.getReader(),
    parts: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await stream.read()
      if (done) break
      size += value.length
      if (size > 300000) throw new Error('RPC response exceeds bound')
      parts.push(value)
    }
  } finally {
    await stream.cancel().catch(() => {})
    stream.releaseLock()
  }
  const result = JSON.parse(Buffer.concat(parts).toString())
  if (result.error)
    throw new OperatorError(
      'RPC_REJECTED',
      'RPC operation rejected (details redacted)',
    )
  return result.result
}
class Borsh {
  offset = 0
  constructor(readonly raw: Buffer) {}
  take(n: number) {
    if (n < 0 || this.offset + n > this.raw.length)
      throw new Error('Truncated IDL account')
    const b = this.raw.subarray(this.offset, this.offset + n)
    this.offset += n
    return b
  }
  decode(type: any): any {
    if (type === 'publicKey') return new PublicKey(this.take(32)).toBase58()
    if (type === 'u64') return this.take(8).readBigUInt64LE().toString()
    if (type === 'i64') return this.take(8).readBigInt64LE().toString()
    if (type === 'u128') {
      const b = this.take(16)
      return (b.readBigUInt64LE() + (b.readBigUInt64LE(8) << 64n)).toString()
    }
    if (type === 'u32') return this.take(4).readUInt32LE()
    if (type === 'f32') {
      const n = this.take(4).readFloatLE()
      if (!Number.isFinite(n)) throw new Error('Invalid IDL float')
      return n
    }
    if (type === 'u8') return this.take(1)[0]
    if (type === 'bool') {
      const b = this.take(1)[0]
      if (b > 1) throw new Error('Invalid bool')
      return b === 1
    }
    if (type === 'string') {
      const n = this.take(4).readUInt32LE()
      if (n > 1024) throw new Error('IDL string bound')
      return this.take(n).toString()
    }
    if (type.option) {
      const b = this.take(1)[0]
      if (b > 1) throw new Error('Invalid option')
      return b ? this.decode(type.option) : null
    }
    if (type.vec) {
      const n = this.take(4).readUInt32LE()
      if (n > 128) throw new Error('IDL vector bound')
      return Array.from({ length: n }, () => this.decode(type.vec))
    }
    if (type.array) {
      if (type.array[1] > 128) throw new Error('IDL array bound')
      return Array.from({ length: type.array[1] }, () =>
        this.decode(type.array[0]),
      )
    }
    if (type.defined) {
      const d = idl.types.find((t: any) => t.name === type.defined)?.type
      if (d?.kind === 'struct') return this.struct(d.fields)
      if (d?.kind === 'enum') {
        const v = d.variants[this.take(1)[0]]
        if (!v || v.fields) throw new Error('Invalid enum')
        return v.name
      }
    }
    throw new Error('Unsupported IDL type')
  }
  struct(fields: any[]) {
    return Object.fromEntries(fields.map((f) => [f.name, this.decode(f.type)]))
  }
}
export function decodeAccount(name: string, raw: Buffer): any {
  const d = idl.accounts.find((a: any) => a.name === name)
  if (!d || !raw.subarray(0, 8).equals(discriminator('account', name)))
    throw new Error('Account discriminator mismatch')
  const reader = new Borsh(raw)
  reader.take(8)
  return reader.struct(d.type.fields)
}
export function decodeEvent(name: string, raw: Buffer): any {
  const definition = idl.events.find((e: any) => e.name === name)
  if (
    !definition ||
    raw.length > 2048 ||
    !raw.subarray(0, 8).equals(discriminator('event', name))
  )
    throw new Error('Event discriminator/bound mismatch')
  const reader = new Borsh(raw)
  reader.take(8)
  const value = reader.struct(definition.fields)
  // Decode pinned fields only; bounded appended fields do not supply any evidence.
  if (raw.length - reader.offset > 64)
    throw new Error('Event extension exceeds coverage bound')
  return value
}
export function accountBytes(account: Account | null, max = 16384) {
  if (
    !account ||
    account.data[1] !== 'base64' ||
    account.data[0].length > max * 2
  )
    throw new Error('Missing or oversized account')
  const b = Buffer.from(account.data[0], 'base64')
  if (b.length > max) throw new Error('Account size bound')
  return b
}
function jupiterAccount(name: string, account: Account | null) {
  if (!account || account.owner !== PROGRAM.toBase58() || account.executable)
    throw new Error('Jupiter account owner mismatch')
  return decodeAccount(name, accountBytes(account))
}
export function nonceState(account: Account | null) {
  if (
    !account ||
    account.owner !== '11111111111111111111111111111111' ||
    account.executable
  )
    throw new Error('Invalid nonce account owner')
  const b = accountBytes(account, 80)
  if (b.length !== 80 || b.readUInt32LE() !== 1 || b.readUInt32LE(4) !== 1)
    throw new Error('Nonce must be current initialized durable nonce')
  return {
    authority: new PublicKey(b.subarray(8, 40)).toBase58(),
    value: new PublicKey(b.subarray(40, 72)).toBase58(),
  }
}
export function tokenState(account: Account | null) {
  if (!account || account.owner !== TOKEN.toBase58() || account.executable)
    throw new Error('Invalid token owner')
  const b = accountBytes(account, 165)
  if (b.length !== 165 || b[108] !== 1)
    throw new Error('Recipient token must be initialized')
  return {
    mint: new PublicKey(b.subarray(0, 32)).toBase58(),
    owner: new PublicKey(b.subarray(32, 64)).toBase58(),
    amount: b.readBigUInt64LE(64).toString(),
  }
}
function fixedSize(t: any): number {
  if (t === 'publicKey') return 32
  if (['u64', 'i64'].includes(t)) return 8
  if (t === 'u8' || t === 'bool') return 1
  throw new Error('Nonfixed prefix')
}
export function fieldOffset(name: string, field: string) {
  let offset = 8
  for (const f of idl.accounts.find((a: any) => a.name === name).type.fields) {
    if (f.name === field) return offset
    offset += fixedSize(f.type)
  }
  throw new Error('IDL field absent')
}
export class JupiterReader {
  constructor(readonly rpc: ReadOnlyRpc) {}
  async snapshot(
    input: Omit<
      Binding,
      'positionHash' | 'sizeUsd' | 'collateralUsd' | 'openTime' | 'observedSlot'
    >,
    minContextSlot?: number,
  ): Promise<Binding> {
    if ((await this.rpc.call('getGenesisHash', [])) !== input.genesis)
      throw new Error('Genesis mismatch')
    const keys = [
      input.position,
      input.pool,
      input.custody,
      input.collateralCustody,
      input.recipient,
      input.nonce,
      PROGRAM.toBase58(),
      input.owner,
    ]
    const cfg = {
      encoding: 'base64',
      commitment: 'finalized',
      ...(minContextSlot !== undefined ? { minContextSlot } : {}),
    }
    const response = await this.rpc.call('getMultipleAccounts', [keys, cfg])
    const [
      position,
      pool,
      custody,
      collateral,
      recipient,
      nonce,
      program,
      owner,
    ] = response.value as (Account | null)[]
    if (position === null) throw new BindingInvalidation('TARGET_CHANGED')
    const p = jupiterAccount('Position', position),
      po = jupiterAccount('Pool', pool),
      c = jupiterAccount('Custody', custody),
      co = jupiterAccount('Custody', collateral)
    if (
      p.owner !== input.owner ||
      p.pool !== input.pool ||
      p.custody !== input.custody ||
      p.collateralCustody !== input.collateralCustody ||
      p.side !== 'Long' ||
      input.position !== positionAddress(input) ||
      BigInt(p.sizeUsd) <= 0n
    )
      throw new BindingInvalidation('TARGET_CHANGED')
    if (
      c.pool !== input.pool ||
      co.pool !== input.pool ||
      c.mint !== WSOL ||
      co.mint !== WSOL ||
      !po.custodies.includes(input.custody) ||
      input.custody !== input.collateralCustody ||
      input.mint !== WSOL
    )
      throw new Error('SOL pool/custody/mint mismatch')
    const n = nonceState(nonce),
      r = tokenState(recipient)
    if (
      n.authority !== input.owner ||
      n.authority !== input.nonceAuthority ||
      n.value !== input.nonceValue
    )
      throw new BindingInvalidation('NONCE_CHANGED')
    if (
      r.owner !== input.owner ||
      r.mint !== input.mint ||
      input.recipient !== associated(input.owner, input.mint)
    )
      throw new BindingInvalidation('RECIPIENT_CHANGED')
    if (
      !program?.executable ||
      program.owner !== 'BPFLoaderUpgradeab1e11111111111111111111111'
    )
      throw new Error('Jupiter executable identity mismatch')
    const prog = accountBytes(program, 64)
    if (prog.length !== 36 || prog.readUInt32LE() !== 2)
      throw new Error('Invalid Jupiter program identity')
    const address = new PublicKey(prog.subarray(4)).toBase58()
    const pd = (
      await this.rpc.call('getAccountInfo', [
        address,
        { ...cfg, dataSlice: { offset: 0, length: 13 } },
      ])
    ).value as Account | null
    const header = accountBytes(pd, 13)
    if (
      !pd ||
      pd.owner !== program.owner ||
      header.readUInt32LE() !== 3 ||
      header.readBigUInt64LE(4).toString() !== input.programDeployment
    )
      throw new BindingInvalidation('PROGRAM_CHANGED')
    return {
      ...input,
      positionHash: hash(accountBytes(position)),
      sizeUsd: p.sizeUsd,
      collateralUsd: p.collateralUsd,
      openTime: p.openTime,
      observedSlot: response.context.slot,
    }
  }
  async assertNoPending(position: string, minContextSlot: number) {
    const bs58 = (await import('bs58')).default
    const result = await this.rpc.call('getProgramAccounts', [
      PROGRAM.toBase58(),
      {
        encoding: 'base64',
        commitment: 'finalized',
        minContextSlot,
        withContext: true,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: bs58.encode(discriminator('account', 'PositionRequest')),
            },
          },
          {
            memcmp: {
              offset: fieldOffset('PositionRequest', 'position'),
              bytes: position,
            },
          },
        ],
        dataSlice: { offset: 0, length: 8 },
      },
    ])
    if (!result || !Array.isArray(result.value) || result.value.length)
      throw new Error('Existing request or unavailable pending coverage')
  }
  async assertDerivedUnoccupied(p: Prepared) {
    const r = await this.rpc.call('getMultipleAccounts', [
      [p.request, p.requestAta],
      {
        encoding: 'base64',
        commitment: 'finalized',
        minContextSlot: p.binding.observedSlot,
        dataSlice: { offset: 0, length: 0 },
      },
    ])
    if (
      !Array.isArray(r.value) ||
      r.value.length !== 2 ||
      r.value.some((v: any) => v !== null)
    )
      throw new Error('Derived request or request ATA occupied')
  }
  async checkBudget(p: Prepared) {
    const fee = (
      await this.rpc.call('getFeeForMessage', [
        Transaction.from(Buffer.from(p.unsignedPacket, 'base64'))
          .serializeMessage()
          .toString('base64'),
        { commitment: 'finalized' },
      ])
    ).value
    // Conservative 512-byte request allocation plus token ATA; no fee/slippage quote guarantee.
    const rent =
      BigInt(await this.rpc.call('getMinimumBalanceForRentExemption', [512])) +
      BigInt(await this.rpc.call('getMinimumBalanceForRentExemption', [165]))
    if (
      !Number.isSafeInteger(fee) ||
      fee < 0 ||
      BigInt(fee) > u64(p.binding.maxFeeLamports, 'fee') ||
      rent > u64(p.binding.maxRentLamports, 'rent')
    )
      throw new Error('Explicit fee/rent budget exceeded or unavailable')
  }
  async prepare(
    input: Omit<
      Binding,
      'positionHash' | 'sizeUsd' | 'collateralUsd' | 'openTime' | 'observedSlot'
    >,
    version: Prepared['version'] = 1,
  ) {
    const b = await this.snapshot(input)
    await this.assertNoPending(b.position, b.observedSlot)
    const p = prepareTicket(b, version)
    await this.assertDerivedUnoccupied(p)
    await this.checkBudget(p)
    return p
  }
  async validateCurrent(p: Prepared) {
    const fresh = await this.snapshot(p.binding, p.binding.observedSlot)
    if (
      fresh.positionHash !== p.binding.positionHash ||
      fresh.sizeUsd !== p.binding.sizeUsd ||
      fresh.collateralUsd !== p.binding.collateralUsd ||
      fresh.openTime !== p.binding.openTime
    )
      throw new BindingInvalidation('TARGET_CHANGED')
    await this.assertNoPending(fresh.position, fresh.observedSlot)
    await this.assertDerivedUnoccupied(p)
    await this.checkBudget(p)
  }
  async simulate(packet: Buffer) {
    // Never disclose reusable owner authority to an RPC during read-only preflight.
    const unsigned = Transaction.from(packet)
    if (!unsigned.verifySignatures(true))
      throw new OperatorError(
        'SIGNATURE_INVALID',
        'Valid owner signature required locally before simulation',
      )
    const exactMessage = unsigned.serializeMessage()
    unsigned.signatures = unsigned.signatures.map(({ publicKey }) => ({
      publicKey,
      signature: null,
    }))
    const simulationPacket = unsigned.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    })
    if (!unsigned.serializeMessage().equals(exactMessage))
      throw new Error('Simulation message changed')
    const result = await this.rpc.call('simulateTransaction', [
      simulationPacket.toString('base64'),
      {
        encoding: 'base64',
        sigVerify: false,
        replaceRecentBlockhash: false,
        commitment: 'finalized',
      },
    ])
    if (result.value?.err !== null)
      throw new OperatorError(
        'SIMULATION_FAILED',
        'Simulation failed; submission blocked',
      )
  }
}
