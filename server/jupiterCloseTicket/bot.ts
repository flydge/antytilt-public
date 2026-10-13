import { VersionedTransaction, PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'
import { TicketStore } from './store.js'
import {
  JupiterReader,
  ReadOnlyRpc,
  BindingInvalidation,
  boundedRpc,
  accountBytes,
  decodeAccount,
  decodeEvent,
  nonceState,
  tokenState,
} from './reader.js'
import {
  PROGRAM,
  TOKEN,
  idl,
  discriminator,
  hash,
  validateSignedPacket,
} from './builder.js'
import { OperatorError } from './types.js'
import type { Status, Ticket } from './types.js'
export interface TicketSender {
  enabled?: boolean
  authorize?(ticket: Ticket): void | Promise<void>
  send(packet: Buffer, signature: string): Promise<unknown>
}
export class LocalOnlySender {
  constructor(
    readonly url: string,
    readonly enabled = false,
  ) {
    const u = new URL(url)
    if (
      u.protocol !== 'http:' ||
      u.hostname !== '127.0.0.1' ||
      !u.port ||
      u.username ||
      u.password ||
      u.search ||
      u.hash
    )
      throw new Error('Public submission disabled; exact loopback required')
  }
  authorize(_ticket: Ticket) {
    if (!this.enabled)
      throw new OperatorError(
        'SENDER_DISABLED',
        'Sender disabled before send intent',
      )
  }
  async send(packet: Buffer, signature: string) {
    if (!this.enabled)
      throw new Error('Sender disabled; explicit local-test flag required')
    const returned = await boundedRpc(this.url, 'sendTransaction', [
      packet.toString('base64'),
      {
        encoding: 'base64',
        skipPreflight: false,
        preflightCommitment: 'finalized',
        maxRetries: 0,
      },
    ])
    if (returned !== signature) throw new Error('Returned signature mismatch')
    return returned
  }
}
export interface LiveEnvelope {
  version: 1
  kind: 'EXACT_REVIEWED_LIVE_CLOSE_TICKET'
  ticketId: string
  messageHash: string
  packetHash: string
  signature: string
  endpoint: string
  genesis: string
  triggerEvent: string
  maxFeeLamports: string
  maxRentLamports: string
  expiresAt: string
  ownerApprovalReference: string
}
export class ProtectedPublicSender implements TicketSender {
  readonly enabled = true
  private authorized = false
  constructor(
    readonly url: string,
    readonly envelope: LiveEnvelope,
    readonly transport: typeof boundedRpc = boundedRpc,
  ) {
    new ReadOnlyRpc(url)
    if (new URL(url).protocol !== 'https:')
      throw new Error('Public sender requires reviewed HTTPS endpoint')
  }
  authorize(t: Ticket) {
    const e = this.envelope,
      b = t.prepared.binding
    if (
      !e ||
      e.version !== 1 ||
      e.kind !== 'EXACT_REVIEWED_LIVE_CLOSE_TICKET' ||
      !e.ownerApprovalReference ||
      e.ticketId !== t.id ||
      e.messageHash !== t.prepared.messageHash ||
      e.packetHash !== t.packetHash ||
      e.signature !== t.signature ||
      e.endpoint !== this.url ||
      e.genesis !== b.genesis ||
      e.triggerEvent !== b.triggerEvent ||
      e.maxFeeLamports !== b.maxFeeLamports ||
      e.maxRentLamports !== b.maxRentLamports ||
      !Number.isFinite(Date.parse(e.expiresAt)) ||
      Date.parse(e.expiresAt) <= Date.now()
    )
      throw new OperatorError(
        'LIVE_ENVELOPE_REFUSED',
        'Exact reviewed live authorization envelope required',
      )
    this.authorized = true
  }
  async send(packet: Buffer, signature: string) {
    if (
      !this.authorized ||
      Date.parse(this.envelope.expiresAt) <= Date.now() ||
      hash(packet) !== this.envelope.packetHash ||
      signature !== this.envelope.signature
    )
      throw new Error('Live authorization invalid or expired')
    this.authorized = false
    const returned = await this.transport(this.url, 'sendTransaction', [
      packet.toString('base64'),
      {
        encoding: 'base64',
        skipPreflight: false,
        preflightCommitment: 'finalized',
        maxRetries: 0,
      },
    ])
    if (returned !== signature) throw new Error('Returned signature mismatch')
    return returned
  }
}
export function classifyReconciliation(e: {
  requestPresent: boolean
  requestSubmission?: string
  positionSize?: string
  positionFinalized?: boolean
  nonceChanged?: boolean
  keeperCorrelated?: boolean
  recipientOutcome?: boolean
}): Status {
  if (e.requestSubmission === 'failed' && e.nonceChanged)
    return 'FAILED_CONSUMED'
  if (
    e.positionSize === '0' &&
    e.positionFinalized &&
    e.keeperCorrelated &&
    e.recipientOutcome
  )
    return 'CLOSED'
  if (
    e.requestPresent &&
    ['confirmed', 'finalized'].includes(e.requestSubmission ?? '')
  )
    return 'REQUEST_PENDING'
  return 'UNKNOWN'
}
// Resolve v0 lookup addresses from finalized RPC transaction metadata. Missing
// metadata is a coverage gap, not a guessed ALT or a closure proof.
function resolvedReceipt(tx: any) {
  if (
    !tx ||
    tx.meta?.err !== null ||
    !Array.isArray(tx.transaction) ||
    tx.transaction[1] !== 'base64'
  )
    throw new Error('Invalid finalized receipt')
  const raw = Buffer.from(tx.transaction[0], 'base64')
  if (raw.length > 1232) throw new Error('Receipt packet bound')
  const message = VersionedTransaction.deserialize(raw).message
  const loaded = tx.meta.loadedAddresses
  const accountKeys =
    message.version === 0
      ? message.getAccountKeys({
          accountKeysFromLookups: {
            writable: (loaded?.writable ?? []).map(
              (k: string) => new PublicKey(k),
            ),
            readonly: (loaded?.readonly ?? []).map(
              (k: string) => new PublicKey(k),
            ),
          },
        })
      : message.getAccountKeys()
  if (accountKeys.length > 256 || message.compiledInstructions.length > 32)
    throw new Error('Receipt account/instruction bound')
  return { message, accountKeys }
}
export function keeperProof(
  t: Ticket,
  execution: any,
  payout: any = execution,
  ordering?: { slot: number; executionSignature: string; payoutSignature: string; executionIndex: number; payoutIndex: number },
): boolean {
  try {
    if (
      execution !== payout &&
      (!Number.isSafeInteger(execution?.slot) ||
        !Number.isSafeInteger(payout?.slot) ||
        payout.slot < execution.slot)
    )
      return false
    const decrease = resolvedReceipt(execution),
      pay = resolvedReceipt(payout),
      b = t.prepared.binding
    function match(
      receipt: ReturnType<typeof resolvedReceipt>,
      name: string,
      bindings: Record<string, string>,
    ) {
      const d = idl.instructions.find((i: any) => i.name === name),
        snake = name.replace(/[A-Z]/g, (s: string) => '_' + s.toLowerCase())
      return receipt.message.compiledInstructions.findIndex(
        (ix) =>
          receipt.accountKeys.get(ix.programIdIndex)?.equals(PROGRAM) &&
          Buffer.from(ix.data)
            .subarray(0, 8)
            .equals(discriminator('global', snake)) &&
          Object.entries(bindings).every(
            ([field, key]) =>
              receipt.accountKeys
                .get(
                  ix.accountKeyIndexes[
                    d.accounts.findIndex((a: any) => a.name === field)
                  ],
                )
                ?.toBase58() === key,
          ),
      )
    }
    const common = {
      owner: b.owner,
      pool: b.pool,
      position: b.position,
      positionRequest: t.prepared.request,
      positionRequestAta: t.prepared.requestAta,
    }
    if (
      match(decrease, 'decreasePosition4', {
        ...common,
        custody: b.custody,
        collateralCustody: b.collateralCustody,
      }) < 0 ||
      match(pay, 'closePositionRequest2', {
        ...common,
        ownerAta: b.recipient,
        mint: b.mint,
        tokenProgram: TOKEN.toBase58(),
      }) < 0
    )
      return false
    const decreaseIndex = match(decrease, 'decreasePosition4', {
      ...common,
      custody: b.custody,
      collateralCustody: b.collateralCustody,
    })
    const payoutIndex = match(pay, 'closePositionRequest2', {
      ...common,
      ownerAta: b.recipient,
      mint: b.mint,
      tokenProgram: TOKEN.toBase58(),
    })
    if (execution === payout && decreaseIndex >= payoutIndex) return false
    // Separate same-slot receipts have no transaction ordering proof here.
    if (execution !== payout && payout.slot <= execution.slot) {
      const signature = (tx: any) => bs58.encode(VersionedTransaction.deserialize(Buffer.from(tx.transaction[0], 'base64')).signatures[0])
      if (!ordering || ordering.slot !== execution.slot || ordering.slot !== payout.slot || ordering.executionSignature !== signature(execution) || ordering.payoutSignature !== signature(payout) || !Number.isSafeInteger(ordering.executionIndex) || !Number.isSafeInteger(ordering.payoutIndex) || ordering.executionIndex < 0 || ordering.payoutIndex <= ordering.executionIndex) return false
    }
    function actualEvent(
      tx: any,
      receipt: ReturnType<typeof resolvedReceipt>,
      instructionIndex: number,
      eventName: string,
    ) {
      const group = tx.meta.innerInstructions?.find(
          (g: any) => g.index === instructionIndex,
        ),
        authority = PublicKey.findProgramAddressSync(
          [Buffer.from('__event_authority')],
          PROGRAM,
        )[0].toBase58()
      if (!Array.isArray(group?.instructions) || group.instructions.length > 64)
        return []
      const events: any[] = []
      for (const ix of group.instructions) {
        if (
          receipt.accountKeys.get(ix.programIdIndex)?.toBase58() !==
            PROGRAM.toBase58() ||
          ix.stackHeight !== 2 ||
          !Array.isArray(ix.accounts) ||
          ix.accounts.length !== 1 ||
          receipt.accountKeys.get(ix.accounts[0])?.toBase58() !== authority ||
          typeof ix.data !== 'string' ||
          ix.data.length > 3000
        )
          continue
        const data = Buffer.from(bs58.decode(ix.data))
        if (!data.subarray(0, 8).equals(Buffer.from('e445a52e51cb9a1d', 'hex')))
          continue
        try {
          events.push(decodeEvent(eventName, data.subarray(8)))
        } catch {}
      }
      return events
    }
    const reduction = actualEvent(
      execution,
      decrease,
      decreaseIndex,
      'DecreasePositionEvent',
    ).some(
      (e) =>
        e.positionKey === b.position &&
        e.positionSide === 1 &&
        e.positionCustody === b.custody &&
        e.positionCollateralCustody === b.collateralCustody &&
        e.positionMint === b.mint &&
        e.positionRequestKey === t.prepared.request &&
        e.positionRequestMint === b.mint &&
        e.positionRequestChange === 2 &&
        e.positionRequestType === 0 &&
        e.owner === b.owner &&
        e.pool === b.pool &&
        e.positionOpenTime === b.openTime &&
        e.priceSlippage === b.absolutePriceBound &&
        BigInt(e.sizeUsdDelta) > 0n &&
        e.sizeUsdDelta === b.sizeUsd,
    )
    const closes = actualEvent(
      payout,
      pay,
      payoutIndex,
      'ClosePositionRequestEvent',
    ).filter(
      (e) =>
        e.entirePosition === true &&
        e.executed === true &&
        e.requestChange === 2 &&
        e.requestType === 0 &&
        e.side === 1 &&
        e.positionRequestKey === t.prepared.request &&
        e.owner === b.owner &&
        e.mint === b.mint &&
        BigInt(e.amount) > 0n,
    )
    if (!reduction || closes.length !== 1) return false
    const keys = pay.accountKeys
        .keySegments()
        .flat()
        .map((k) => k.toBase58()),
      index = keys.indexOf(b.recipient)
    const closeIndex = match(pay, 'closePositionRequest2', {
      ...common,
      ownerAta: b.recipient,
      mint: b.mint,
      tokenProgram: TOKEN.toBase58(),
    })
    const transfers = payout.meta.innerInstructions?.find(
      (group: any) => group.index === closeIndex,
    )?.instructions
    if (!Array.isArray(transfers) || transfers.length > 64) return false
    const payoutTransfer = transfers.some((ix: any) => {
      if (
        pay.accountKeys.get(ix.programIdIndex)?.toBase58() !==
          TOKEN.toBase58() ||
        typeof ix.data !== 'string'
      )
        return false
      const data = Buffer.from(bs58.decode(ix.data)),
        accounts = ix.accounts.map((i: number) =>
          pay.accountKeys.get(i)?.toBase58(),
        )
      if (data.length === 9 && data[0] === 3)
        return (
          accounts[0] === t.prepared.requestAta &&
          accounts[1] === b.recipient &&
          accounts[2] === t.prepared.request &&
          data.readBigUInt64LE(1) > 0n &&
          data.readBigUInt64LE(1).toString() === closes[0].amount
        )
      if (data.length === 10 && data[0] === 12)
        return (
          accounts[0] === t.prepared.requestAta &&
          accounts[1] === b.mint &&
          accounts[2] === b.recipient &&
          accounts[3] === t.prepared.request &&
          data.readBigUInt64LE(1) > 0n &&
          data.readBigUInt64LE(1).toString() === closes[0].amount
        )
      return false
    })
    if (!payoutTransfer) return false
    const pre = payout.meta.preTokenBalances?.find(
        (v: any) =>
          v.accountIndex === index && v.mint === b.mint && v.owner === b.owner,
      ),
      post = payout.meta.postTokenBalances?.find(
        (v: any) =>
          v.accountIndex === index && v.mint === b.mint && v.owner === b.owner,
      )
    return Boolean(
      pre &&
      post &&
      BigInt(post.uiTokenAmount.amount) > BigInt(pre.uiTokenAmount.amount),
    )
  } catch {
    return false
  }
}
export class CloseTicketBot {
  constructor(
    readonly store: TicketStore,
    readonly reader: JupiterReader,
    readonly sender?: TicketSender,
  ) {}
  private async validateCurrent(t: Ticket) {
    try {
      await this.reader.validateCurrent(t.prepared)
    } catch (e) {
      if (e instanceof BindingInvalidation)
        await this.store.transition(t.id, 'INVALIDATED', e.reason)
      throw e
    }
  }
  async arm(id: string, packet: Buffer, afterArm?: Parameters<TicketStore['arm']>[2]) {
    const t = await this.store.get(id)
    if (t.status !== 'PREPARED')
      throw new OperatorError('STATE_BLOCKED', 'Not prepared')
    validateSignedPacket(t.prepared, packet)
    await this.validateCurrent(t)
    await this.reader.simulate(packet)
    return this.store.arm(id, packet, afterArm)
  }
  async trigger(id: string, event: string) {
    const t = await this.store.get(id)
    if (t.status !== 'ARMED')
      throw new OperatorError('STATE_BLOCKED', 'Ticket not armed; never resend')
    if (event !== t.prepared.binding.triggerEvent)
      throw new OperatorError('TRIGGER_MISMATCH', 'Approved trigger required')
    if (!this.sender)
      throw new OperatorError('SENDER_DISABLED', 'Public sender disabled')
    if (this.sender.enabled === false)
      throw new OperatorError(
        'SENDER_DISABLED',
        'Sender disabled before send intent',
      )
    await this.sender.authorize?.(t)
    const packet = this.store.packet(t)
    await this.validateCurrent(t)
    await this.reader.simulate(packet)
    // Persist exactly one send intent/signature before any side effect. A crash
    // here remains SUBMITTING and is reconciled, never automatically re-sent.
    const claimed = await this.store.claim(id, event)
    try {
      await this.sender.send(packet, claimed.signature)
    } catch {
      return this.store.transition(
        id,
        'UNKNOWN',
        'Send outcome unknown; reconcile only',
      )
    }
    return claimed
  }
  async disable(id: string) {
    return this.store.transition(
      id,
      'DISABLED',
      'Local disable only; signed packet not cryptographically revoked',
    )
  }
  async reconcile(
    id: string,
    keeperSignature?: string,
    payoutSignature?: string,
    ordering?: Parameters<typeof keeperProof>[3],
  ) {
    const t = await this.store.get(id),
      b = t.prepared.binding
    if (!['SUBMITTING', 'UNKNOWN', 'REQUEST_PENDING'].includes(t.status))
      throw new OperatorError(
        'NO_SEND_INTENT',
        'No pending send intent to reconcile',
      )
    if ((await this.reader.rpc.call('getGenesisHash', [])) !== b.genesis)
      throw new Error('Genesis mismatch')
    const submission = (
      await this.reader.rpc.call('getSignatureStatuses', [
        [t.signature],
        { searchTransactionHistory: true },
      ])
    ).value[0]
    const response = await this.reader.rpc.call('getMultipleAccounts', [
      [b.position, t.prepared.request, b.nonce, b.recipient],
      {
        encoding: 'base64',
        commitment: 'finalized',
        minContextSlot: b.observedSlot,
      },
    ])
    const [position, request, nonce, recipient] = response.value
    let size: string | undefined
    try {
      if (position?.owner === PROGRAM.toBase58()) {
        const p = decodeAccount('Position', accountBytes(position))
        if (
          p.owner === b.owner &&
          p.openTime === b.openTime &&
          p.pool === b.pool &&
          p.custody === b.custody &&
          p.collateralCustody === b.collateralCustody
        )
          size = p.sizeUsd
      }
    } catch {}
    let changed = false
    try {
      changed = nonceState(nonce).value !== b.nonceValue
    } catch {}
    let requestValid = false
    try {
      if (request?.owner === PROGRAM.toBase58()) {
        const r = decodeAccount('PositionRequest', accountBytes(request))
        requestValid =
          r.owner === b.owner &&
          r.position === b.position &&
          r.pool === b.pool &&
          r.custody === b.custody &&
          r.mint === b.mint &&
          r.counter === b.counter &&
          r.requestChange === 'Decrease' &&
          r.requestType === 'Market' &&
          r.entirePosition === true &&
          r.priceSlippage === b.absolutePriceBound
      }
    } catch {}
    let keeper = false
    if (
      keeperSignature &&
      submission?.err === null &&
      submission?.confirmationStatus === 'finalized'
    ) {
      const tx = await this.reader.rpc.call('getTransaction', [
        keeperSignature,
        {
          encoding: 'base64',
          commitment: 'finalized',
          maxSupportedTransactionVersion: 0,
        },
      ])
      const payout = payoutSignature
        ? await this.reader.rpc.call('getTransaction', [
            payoutSignature,
            {
              encoding: 'base64',
              commitment: 'finalized',
              maxSupportedTransactionVersion: 0,
            },
          ])
        : tx
      keeper = Boolean(
        tx &&
        payout &&
        payout.slot >= tx.slot &&
        tx.slot >= submission.slot &&
        response.context.slot >= payout.slot &&
        keeperProof(t, tx, payout, ordering),
      )
    }
    let recipientValid = false
    try {
      const r = tokenState(recipient)
      recipientValid = r.owner === b.owner && r.mint === b.mint
    } catch {}
    const status = classifyReconciliation({
      requestPresent: requestValid,
      requestSubmission: submission
        ? submission.err !== null
          ? 'failed'
          : submission.confirmationStatus
        : 'missing',
      positionSize: size,
      positionFinalized: true,
      nonceChanged: changed,
      keeperCorrelated: keeper,
      recipientOutcome: keeper && recipientValid,
    })
    return this.store.transition(
      id,
      status,
      status === 'CLOSED'
        ? 'Correlated finalized keeper payout and zero position'
        : 'Read-only reconciliation; no resend',
    )
  }
  async confirmRevoke(id: string) {
    const t = await this.store.get(id)
    if (
      !['ARMED', 'DISABLED'].includes(t.status) ||
      t.intentAt !== null ||
      t.intentEvent !== null
    )
      throw new OperatorError(
        'STATE_BLOCKED',
        'Only unused armed or disabled ticket without send intent can be marked revoked',
      )
    if (
      (await this.reader.rpc.call('getGenesisHash', [])) !==
      t.prepared.binding.genesis
    )
      throw new Error('Genesis mismatch')
    const n = nonceState(
      (
        await this.reader.rpc.call('getAccountInfo', [
          t.prepared.binding.nonce,
          { encoding: 'base64', commitment: 'finalized' },
        ])
      ).value,
    )
    if (n.value === t.prepared.binding.nonceValue)
      throw new Error('Nonce unchanged; no cryptographic revoke observed')
    return this.store.transition(
      id,
      'REVOKED',
      'Finalized nonce value changed; owner action not performed by bot',
    )
  }
}
