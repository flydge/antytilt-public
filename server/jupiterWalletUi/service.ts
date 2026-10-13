import { randomBytes, randomUUID } from 'node:crypto'
import { ComputeBudgetProgram, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import type { Pool } from 'pg'
import { TicketStore } from '../jupiterCloseTicket/store.js'
import {
  JupiterReader,
  ReadOnlyRpc,
  boundedRpc,
} from '../jupiterCloseTicket/reader.js'
import {
  CloseTicketBot,
  LocalOnlySender,
  ProtectedPublicSender,
  type LiveEnvelope,
} from '../jupiterCloseTicket/bot.js'
import { associated, hash, WSOL } from '../jupiterCloseTicket/builder.js'
import type { Ticket } from '../jupiterCloseTicket/types.js'
import { WalletOwnership, type Scope } from './ownership.js'
import { discoverPositions, deployment } from './discovery.js'
import {
  decimalUnits,
  prepareSetup,
  setupState,
  validateSetupPacket,
  type SetupPreview,
} from './setup.js'
import { discoverReceipts } from './receipts.js'
export interface UiConfiguration {
  rpc: string
  genesis: string
  trustedOrigin: string
  mode: 'native-rehearsal' | 'live'
  keyFile: string
}
interface Review {
  expiresAt: string
  reviewHash: string
  triggerEvent: string
  endpoint: string
  mode: string
}
export function publicTicket(
  t: Ticket,
  review: Pick<Review, 'expiresAt' | 'reviewHash'>,
) {
  const b = t.prepared.binding
  return {
    id: t.id,
    status: t.status,
    owner: b.owner,
    position: b.position,
    recipient: b.recipient,
    mint: b.mint,
    genesis: b.genesis,
    floorUsd: formatUnits(b.absolutePriceBound, 6),
    maxFeeSol: formatUnits(b.maxFeeLamports, 9),
    maxRentSol: formatUnits(b.maxRentLamports, 9),
    sizeUsd: formatUnits(b.sizeUsd, 6),
    collateralUsd: formatUnits(b.collateralUsd, 6),
    messageHash: t.prepared.messageHash,
    nonce: b.nonce,
    request: t.prepared.request,
    requestAta: t.prepared.requestAta,
    signature: t.signature || null,
    intentAt: t.intentAt,
    detail: t.detail,
    expiresAt: review.expiresAt,
    reviewHash: review.reviewHash,
  }
}
export function formatUnits(n: string, decimals: number) {
  const value = BigInt(n),
    scale = 10n ** BigInt(decimals)
  return `${value / scale}.${(value % scale).toString().padStart(decimals, '0')}`
}
const refuse = (message: string, status = 409) =>
  Object.assign(new Error(message), { status })
export class WalletUiService {
  readonly reader: JupiterReader
  readonly ownership: WalletOwnership
  constructor(
    readonly pool: Pool,
    readonly store: TicketStore,
    readonly config: UiConfiguration,
  ) {
    this.reader = new JupiterReader(new ReadOnlyRpc(config.rpc))
    if (config.mode === 'native-rehearsal')
      new LocalOnlySender(config.rpc, true)
    else if (new URL(config.rpc).protocol !== 'https:')
      throw new Error('Live read/send requires HTTPS')
    this.ownership = new WalletOwnership(
      pool,
      config.genesis,
      config.trustedOrigin,
    )
  }
  actionPreview(row: any): SetupPreview {
    const preview = JSON.parse(
      this.store.vault
        .decrypt(row.prepared_json, row.id + ':action')
        .toString(),
    ) as SetupPreview
    if (
      preview.owner !== row.wallet_owner ||
      preview.genesis !== this.config.genesis ||
      preview.genesis !== row.genesis ||
      preview.kind !== row.kind
    )
      throw refuse('Setup review integrity mismatch')
    return preview
  }
  async session(scope: Scope) {
    return {
      ...(await this.ownership.session(scope)),
      mode: this.config.mode,
      network:
        this.config.mode === 'native-rehearsal'
          ? 'Isolated native rehearsal'
          : 'Solana mainnet',
      senderAvailable: true,
    }
  }
  async positions(scope: Scope) {
    return discoverPositions(
      this.reader.rpc,
      await this.ownership.owner(scope),
      this.config.genesis,
    )
  }
  async budget(scope: Scope) {
    const owner = await this.ownership.owner(scope),
      latest = (
        await this.reader.rpc.call('getLatestBlockhash', [
          { commitment: 'finalized' },
        ])
      ).value
    const tx = new Transaction({
      feePayer: new PublicKey(owner),
      recentBlockhash: latest.blockhash,
    }).add(
      SystemProgram.transfer({
        fromPubkey: new PublicKey(owner),
        toPubkey: new PublicKey(owner),
        lamports: 0,
      }),
    )
    const fee = (
      await this.reader.rpc.call('getFeeForMessage', [
        tx.serializeMessage().toString('base64'),
        { commitment: 'finalized' },
      ])
    ).value
    const rent =
      BigInt(
        await this.reader.rpc.call('getMinimumBalanceForRentExemption', [512]),
      ) +
      BigInt(
        await this.reader.rpc.call('getMinimumBalanceForRentExemption', [165]),
      )
    if (!Number.isSafeInteger(fee) || fee < 0)
      throw refuse('Current fee quote unavailable')
    return {
      feeSol: formatUnits(String(fee), 9),
      rentSol: formatUnits(String(rent), 9),
      quotedAt: new Date().toISOString(),
      priceQuote: null,
      payoutEstimate: null,
    }
  }
  private async registry(scope: Scope) {
    const owner = await this.ownership.owner(scope),
      seed = 'at' + randomBytes(14).toString('hex'),
      nonce = await PublicKey.createWithSeed(
        new PublicKey(owner),
        seed,
        SystemProgram.programId,
      )
    await this.pool.query(
      'INSERT INTO jupiter_ui_setups(id,user_id,wallet_owner,genesis,nonce_key,seed,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(genesis,wallet_owner) DO NOTHING',
      [
        randomUUID(),
        scope.userId,
        owner,
        this.config.genesis,
        nonce.toBase58(),
        seed,
        'RESERVED',
        Date.now(),
      ],
    )
    const row = (
      await this.pool.query(
        'SELECT * FROM jupiter_ui_setups WHERE genesis=$1 AND wallet_owner=$2 AND user_id=$3',
        [this.config.genesis, owner, scope.userId],
      )
    ).rows[0]
    if (!row)
      throw refuse(
        'This dedicated wallet setup belongs to another application account',
      )
    return row
  }
  async setup(scope: Scope) {
    const row = await this.registry(scope)
    return {
      ...(await setupState(this.reader.rpc, row.wallet_owner, row.nonce_key)),
      nonce: row.nonce_key,
    }
  }
  async prepareAction(
    scope: Scope,
    kind: 'SETUP' | 'REVOKE',
    ticketId?: string,
  ): Promise<{id:string|null;status:string;preview:SetupPreview|null;signature:string|null}> {
    const row = await this.registry(scope)
    if (kind === 'REVOKE') {
      const { ticket } = await this.owned(scope, ticketId!)
      if (
        !['ARMED', 'DISABLED', 'PREPARED'].includes(ticket.status) ||
        ticket.intentAt ||
        ticket.intentEvent
      )
        throw refuse('Pending send cannot be reset or revoked as unused')
      if (ticket.prepared.binding.nonce !== row.nonce_key)
        throw refuse('Dedicated nonce mismatch')
    }
    const previous = (
      await this.pool.query(
        "SELECT * FROM jupiter_ui_actions WHERE user_id=$1 AND wallet_owner=$2 AND genesis=$3 AND kind=$4 AND status IN ('PREPARED','SUBMITTING','UNKNOWN') ORDER BY created_at DESC LIMIT 1",
        [scope.userId, row.wallet_owner, this.config.genesis, kind],
      )
    ).rows[0]
    if (previous) {
      const preview = this.actionPreview(previous)
      if (previous.status !== 'PREPARED') {
        const observed = await this.actionStatus(scope, previous.id)
        if (
          observed.status === 'EXPIRED' ||
          observed.status === 'FAILED' ||
          observed.status === 'FINALIZED'
        )
          return this.prepareAction(scope, kind, ticketId)
        return {
          id: previous.id,
          status: observed.status,
          preview,
          signature: previous.signature,
        }
      }
      const height = await this.reader.rpc.call('getBlockHeight', [
        { commitment: 'finalized' },
      ])
      const explicitFee = Transaction.from(Buffer.from(preview.unsignedPacket, 'base64'))
        .instructions.some((ix) => ix.programId.equals(ComputeBudgetProgram.programId)
          && ix.data.equals(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }).data))
      if (height <= preview.lastValidBlockHeight && explicitFee)
        return {
          id: previous.id,
          status: previous.status,
          preview,
          signature: null,
        }
      const superseded = await this.pool.query(
        "UPDATE jupiter_ui_actions SET status='EXPIRED' WHERE id=$1 AND status='PREPARED'",
        [previous.id],
      )
      if (!superseded.rowCount) {
        const observed = await this.actionStatus(scope, previous.id)
        return { id: previous.id, status: observed.status, preview, signature: observed.signature }
      }
    }
    const preview = await prepareSetup(this.reader.rpc, {
      owner: row.wallet_owner,
      genesis: this.config.genesis,
      nonce: row.nonce_key,
      seed: row.seed,
      kind,
    })
    if (!preview)
      return { id: null, status: 'READY', preview: null, signature: null }
    const id = randomUUID()
    await this.pool.query(
      "INSERT INTO jupiter_ui_actions(id,user_id,wallet_owner,genesis,kind,ticket_id,prepared_json,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,'PREPARED',$8)",
      [
        id,
        scope.userId,
        row.wallet_owner,
        this.config.genesis,
        kind,
        ticketId ?? null,
        this.store.vault.encrypt(
          Buffer.from(JSON.stringify(preview)),
          id + ':action',
        ),
        Date.now(),
      ],
    )
    return { id, status: 'PREPARED', preview, signature: null }
  }
  async submitAction(
    scope: Scope,
    id: string,
    packet: Buffer,
    reviewHash: string,
  ) {
    const owner = await this.ownership.owner(scope),
      row = (
        await this.pool.query(
          'SELECT * FROM jupiter_ui_actions WHERE id=$1 AND user_id=$2 AND wallet_owner=$3 AND genesis=$4',
          [id, scope.userId, owner, this.config.genesis],
        )
      ).rows[0]
    if (!row) throw refuse('Action unavailable', 404)
    if (row.status !== 'PREPARED')
      return { id, status: row.status, signature: row.signature }
    const preview = this.actionPreview(row)
    if (reviewHash !== preview.messageHash) throw refuse('Review mismatch')
    const receipt = validateSetupPacket(preview, packet)
    if (
      (await this.reader.rpc.call('getGenesisHash', [])) !== this.config.genesis
    )
      throw refuse('Genesis changed')
    if (
      (await this.reader.rpc.call('getBlockHeight', [
        { commitment: 'finalized' },
      ])) > preview.lastValidBlockHeight
    )
      throw refuse('Setup review expired; refresh the preview')
    if (row.kind === 'REVOKE') {
      const { ticket } = await this.owned(scope, row.ticket_id)
      if (
        !['ARMED', 'PREPARED', 'DISABLED'].includes(ticket.status) ||
        ticket.intentAt
      )
        throw refuse('Send intent prevents unused revocation')
      if (ticket.status !== 'DISABLED')
        await new CloseTicketBot(this.store, this.reader).disable(ticket.id)
    }
    const tx = Transaction.from(packet)
    tx.signatures = tx.signatures.map(({ publicKey }) => ({
      publicKey,
      signature: null,
    }))
    const simulation = await this.reader.rpc.call('simulateTransaction', [
      tx
        .serialize({ requireAllSignatures: false, verifySignatures: false })
        .toString('base64'),
      {
        encoding: 'base64',
        sigVerify: false,
        replaceRecentBlockhash: false,
        commitment: 'finalized',
      },
    ])
    if (simulation.value?.err !== null)
      throw refuse('Reviewed setup simulation failed')
    const claimed = await this.pool.query(
      "UPDATE jupiter_ui_actions SET status='SUBMITTING',signature=$2 WHERE id=$1 AND status='PREPARED' RETURNING id",
      [id, receipt.signature],
    )
    if (!claimed.rowCount)
      throw refuse('Action already submitted; reconcile only')
    try {
      const returned = await boundedRpc(this.config.rpc, 'sendTransaction', [
        packet.toString('base64'),
        {
          encoding: 'base64',
          skipPreflight: false,
          preflightCommitment: 'finalized',
          maxRetries: 0,
        },
      ])
      if (returned !== receipt.signature) throw new Error('Signature mismatch')
    } catch {
      await this.pool.query(
        "UPDATE jupiter_ui_actions SET status='UNKNOWN' WHERE id=$1",
        [id],
      )
    }
    return this.actionStatus(scope, id)
  }
  async actionStatus(scope: Scope, id: string) {
    const owner = await this.ownership.owner(scope),
      row = (
        await this.pool.query(
          'SELECT * FROM jupiter_ui_actions WHERE id=$1 AND user_id=$2 AND wallet_owner=$3',
          [id, scope.userId, owner],
        )
      ).rows[0]
    if (!row) throw refuse('Action unavailable', 404)
    if (row.signature && ['SUBMITTING', 'UNKNOWN'].includes(row.status)) {
      if (
        (await this.reader.rpc.call('getGenesisHash', [])) !==
        this.config.genesis
      )
        throw refuse('Genesis mismatch')
      const status = (
        await this.reader.rpc.call('getSignatureStatuses', [
          [row.signature],
          { searchTransactionHistory: true },
        ])
      ).value[0]
      if (status?.confirmationStatus === 'finalized') {
        row.status = status.err === null ? 'FINALIZED' : 'FAILED'
        await this.pool.query(
          'UPDATE jupiter_ui_actions SET status=$2 WHERE id=$1',
          [id, row.status],
        )
      } else if (
        !status &&
        (await this.reader.rpc.call('getBlockHeight', [
          { commitment: 'finalized' },
        ])) > this.actionPreview(row).lastValidBlockHeight
      ) {
        row.status = 'EXPIRED'
        await this.pool.query(
          "UPDATE jupiter_ui_actions SET status='EXPIRED' WHERE id=$1 AND status IN ('SUBMITTING','UNKNOWN')",
          [id],
        )
      }
    }
    return {
      id: row.id,
      status: row.status,
      signature: row.signature,
      kind: row.kind,
    }
  }
  async owned(scope: Scope, id: string) {
    const owner = await this.ownership.owner(scope),
      row = (
        await this.pool.query(
          'SELECT * FROM jupiter_ui_tickets WHERE ticket_id=$1 AND user_id=$2 AND wallet_owner=$3',
          [id, scope.userId, owner],
        )
      ).rows[0]
    if (!row) throw refuse('Ticket unavailable', 404)
    const ticket = await this.store.get(id),
      review = JSON.parse(
        this.store.vault.decrypt(row.review_json, id + ':review').toString(),
      ) as Review
    if (
      ticket.prepared.binding.owner !== owner ||
      ticket.prepared.binding.genesis !== this.config.genesis
    )
      throw refuse('Ticket ownership binding mismatch')
    return { ticket, review, row }
  }
  async list(scope: Scope) {
    const owner = await this.ownership.owner(scope),
      rows = (
        await this.pool.query(
          "SELECT u.ticket_id FROM jupiter_ui_tickets u JOIN jupiter_close_tickets t ON t.id=u.ticket_id WHERE u.user_id=$1 AND u.wallet_owner=$2 ORDER BY (t.status IN ('PREPARED','ARMED','SUBMITTING','UNKNOWN','REQUEST_PENDING')) DESC,u.ticket_id LIMIT 32",
          [scope.userId, owner],
        )
      ).rows
    return Promise.all(
      rows.map(async (r) => {
        const { ticket, review } = await this.owned(scope, r.ticket_id)
        return publicTicket(ticket, review)
      }),
    )
  }
  async detail(scope: Scope, id: string) {
    const { ticket, review } = await this.owned(scope, id)
    return publicTicket(ticket, review)
  }
  async signingMessage(scope: Scope, id: string) {
    const { ticket, review } = await this.owned(scope, id)
    if (
      ticket.status !== 'PREPARED' ||
      Date.parse(review.expiresAt) <= Date.now()
    )
      throw refuse('Ticket unavailable for signing')
    return {
      unsignedPacket: ticket.prepared.unsignedPacket,
      messageHash: ticket.prepared.messageHash,
    }
  }
  async prepare(
    scope: Scope,
    input: {
      clientRequestId: string
      position: string
      floorUsd: string
      maxFeeSol: string
      maxRentSol: string
      expiresMinutes: number
    },
  ) {
    const owner = await this.ownership.owner(scope)
    const recovered = (
      await this.pool.query(
        'SELECT ticket_id FROM jupiter_ui_tickets WHERE user_id=$1 AND client_request_id=$2',
        [scope.userId, input.clientRequestId],
      )
    ).rows[0]
    if (recovered) return this.detail(scope, recovered.ticket_id)
    const target = (await this.positions(scope)).find(
      (p) => p.position === input.position,
    )
    if (!target) throw refuse('Choose a currently verified SOL Long position')
    const registry = await this.registry(scope),
      state = await setupState(this.reader.rpc, owner, registry.nonce_key)
    if (!state.nonceReady || !state.recipientReady || !state.nonceValue)
      throw refuse('Complete dedicated nonce and recipient setup first')
    const triggerEvent = randomUUID(),
      expiresAt = new Date(
        Date.now() + input.expiresMinutes * 60_000,
      ).toISOString()
    const prepared = await this.reader.prepare({
      ...target,
      genesis: this.config.genesis,
      side: 'Long',
      mint: WSOL,
      recipient: associated(owner, WSOL),
      nonce: registry.nonce_key,
      nonceAuthority: owner,
      nonceValue: state.nonceValue,
      counter: BigInt('0x' + randomBytes(8).toString('hex')).toString(),
      absolutePriceBound: decimalUnits(input.floorUsd, 6),
      maxFeeLamports: decimalUnits(input.maxFeeSol, 9),
      maxRentLamports: decimalUnits(input.maxRentSol, 9),
      triggerEvent,
      programDeployment: await deployment(this.reader.rpc),
    }, 2)
    const review: Review = {
      expiresAt,
      triggerEvent,
      endpoint: this.config.rpc,
      mode: this.config.mode,
      reviewHash: hash(
        JSON.stringify({
          messageHash: prepared.messageHash,
          binding: prepared.binding,
          expiresAt,
          triggerEvent,
        }),
      ),
    }
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        this.config.genesis + owner,
      ])
      const previous = (
        await client.query(
          'SELECT ticket_id FROM jupiter_ui_tickets WHERE user_id=$1 AND client_request_id=$2',
          [scope.userId, input.clientRequestId],
        )
      ).rows[0]
      if (previous) {
        await client.query('COMMIT')
        return this.detail(scope, previous.ticket_id)
      }
      const ticket = await this.store.create(prepared, client)
      await client.query(
        'INSERT INTO jupiter_ui_tickets(ticket_id,user_id,wallet_owner,client_request_id,review_json) VALUES($1,$2,$3,$4,$5)',
        [
          ticket.id,
          scope.userId,
          owner,
          input.clientRequestId,
          this.store.vault.encrypt(
            Buffer.from(JSON.stringify(review)),
            ticket.id + ':review',
          ),
        ],
      )
      await client.query('COMMIT')
      return publicTicket(ticket, review)
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  }
  async arm(scope: Scope, id: string, packet: Buffer, reviewHash: string) {
    const { ticket, review } = await this.owned(scope, id)
    if (ticket.status === 'ARMED') return publicTicket(ticket, review)
    if (
      reviewHash !== review.reviewHash ||
      Date.parse(review.expiresAt) <= Date.now()
    )
      throw refuse('Review mismatch or expired')
    const armed = await new CloseTicketBot(this.store, this.reader).arm(
      id,
      packet,
      async (saved, client) => {
        const envelope: LiveEnvelope = {
          version: 1,
          kind: 'EXACT_REVIEWED_LIVE_CLOSE_TICKET',
          ticketId: id,
          messageHash: saved.prepared.messageHash,
          packetHash: saved.packetHash,
          signature: saved.signature,
          endpoint: this.config.rpc,
          genesis: this.config.genesis,
          triggerEvent: review.triggerEvent,
          maxFeeLamports: saved.prepared.binding.maxFeeLamports,
          maxRentLamports: saved.prepared.binding.maxRentLamports,
          expiresAt: review.expiresAt,
          ownerApprovalReference: randomUUID(),
        }
        await client.query(
          'UPDATE jupiter_ui_tickets SET authorization_ciphertext=$2 WHERE ticket_id=$1',
          [
            id,
            this.store.vault.encrypt(
              Buffer.from(JSON.stringify(envelope)),
              id + ':authorization',
            ),
          ],
        )
      },
    )
    return publicTicket(armed, review)
  }
  async trigger(scope: Scope, id: string, reviewHash: string) {
    const { ticket, review, row } = await this.owned(scope, id)
    if (ticket.status !== 'ARMED') return publicTicket(ticket, review)
    if (
      reviewHash !== review.reviewHash ||
      Date.parse(review.expiresAt) <= Date.now() ||
      !row.authorization_ciphertext
    )
      throw refuse('Reviewed trigger authorization expired or unavailable')
    const envelope = JSON.parse(
      this.store.vault
        .decrypt(row.authorization_ciphertext, id + ':authorization')
        .toString(),
    ) as LiveEnvelope
    const sender =
      this.config.mode === 'native-rehearsal'
        ? new LocalOnlySender(this.config.rpc, true)
        : new ProtectedPublicSender(this.config.rpc, envelope)
    return publicTicket(
      await new CloseTicketBot(this.store, this.reader, sender).trigger(
        id,
        review.triggerEvent,
      ),
      review,
    )
  }
  async reconcile(scope: Scope, id: string) {
    const { ticket, review } = await this.owned(scope, id)
    const result = await discoverReceipts(ticket, this.reader.rpc)
    return publicTicket(
      await new CloseTicketBot(this.store, this.reader).reconcile(
        id,
        result.execution,
        result.payout,
        result.ordering,
      ),
      review,
    )
  }
  async disable(scope: Scope, id: string) {
    const { review } = await this.owned(scope, id)
    return publicTicket(
      await new CloseTicketBot(this.store, this.reader).disable(id),
      review,
    )
  }
  async confirmRevoke(scope: Scope, id: string) {
    const { review } = await this.owned(scope, id)
    return publicTicket(
      await new CloseTicketBot(this.store, this.reader).confirmRevoke(id),
      review,
    )
  }
}
