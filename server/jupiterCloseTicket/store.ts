import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Pool, type PoolClient } from 'pg'
import { PacketVault } from './vault.js'
import { hash, prepareTicket, validateSignedPacket } from './builder.js'
import type { Prepared, Ticket, Status } from './types.js'
export class TicketStore {
  constructor(
    readonly pool: Pool,
    readonly vault: PacketVault,
  ) {}
  async migrate() {
    await this.pool.query(
      readFileSync(
        new URL('../migrations/011_jupiter_close_tickets.sql', import.meta.url),
        'utf8',
      ),
    )
  }
  private hydrate(row: any): Ticket {
    if (!row) throw new Error('Ticket unavailable')
    const prepared = JSON.parse(
      this.vault
        .decrypt(row.prepared_ciphertext, `${row.id}:prepared`)
        .toString(),
    ) as Prepared
    const expected = prepareTicket(prepared.binding, prepared.version)
    if (JSON.stringify(expected) !== JSON.stringify(prepared))
      throw new Error('Prepared manifest integrity mismatch')
    const b = prepared.binding
    if (
      b.genesis !== row.genesis ||
      b.owner !== row.owner_key ||
      b.position !== row.position_key ||
      b.nonce !== row.nonce_key ||
      b.nonceValue !== row.nonce_value
    )
      throw new Error('Indexed binding mismatch')
    return {
      id: row.id,
      prepared,
      ciphertext: row.packet_ciphertext ?? '',
      signature: row.signature ?? '',
      packetHash: row.packet_hash ?? '',
      status: row.status,
      intentEvent: row.intent_event,
      intentAt: row.intent_at,
      detail: row.detail,
    }
  }
  async create(prepared: Prepared, connection?: PoolClient) {
    const expected = prepareTicket(prepared.binding, prepared.version)
    if (JSON.stringify(expected) !== JSON.stringify(prepared))
      throw new Error('Prepared mismatch')
    const id = randomUUID(),
      b = prepared.binding
    const inserted = await (connection ?? this.pool).query(
      'INSERT INTO jupiter_close_tickets (id,genesis,owner_key,position_key,nonce_key,nonce_value,prepared_ciphertext,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [
        id,
        b.genesis,
        b.owner,
        b.position,
        b.nonce,
        b.nonceValue,
        this.vault.encrypt(
          Buffer.from(JSON.stringify(prepared)),
          `${id}:prepared`,
        ),
        'PREPARED',
      ],
    )
    return this.hydrate(inserted.rows[0])
  }
  async get(id: string) {
    return this.hydrate(
      (
        await this.pool.query(
          'SELECT * FROM jupiter_close_tickets WHERE id=$1',
          [id],
        )
      ).rows[0],
    )
  }
  private async locked<T>(
    id: string,
    fn: (ticket: Ticket, client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const ticket = this.hydrate(
        (
          await client.query(
            'SELECT * FROM jupiter_close_tickets WHERE id=$1 FOR UPDATE',
            [id],
          )
        ).rows[0],
      )
      const result = await fn(ticket, client)
      await client.query('COMMIT')
      return result
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  }
  packet(t: Ticket) {
    const p = this.vault.decrypt(
        t.ciphertext,
        `${t.id}:${hash(JSON.stringify(t.prepared))}`,
      ),
      r = validateSignedPacket(t.prepared, p)
    if (r.signature !== t.signature || r.packetHash !== t.packetHash)
      throw new Error('Signed receipt integrity mismatch')
    return p
  }
  async arm(id: string, packet: Buffer, afterArm?: (ticket: Ticket, client: PoolClient) => Promise<void>) {
    await this.locked(id, async (t, c) => {
      if (t.status !== 'PREPARED') throw new Error('Ticket is not prepared')
      const receipt = validateSignedPacket(t.prepared, packet)
      const updated = await c.query(
        'UPDATE jupiter_close_tickets SET status=$2,packet_ciphertext=$3,signature=$4,packet_hash=$5 WHERE id=$1 RETURNING *',
        [
          id,
          'ARMED',
          this.vault.encrypt(
            packet,
            `${id}:${hash(JSON.stringify(t.prepared))}`,
          ),
          receipt.signature,
          receipt.packetHash,
        ],
      )
      await afterArm?.(this.hydrate(updated.rows[0]), c)
    })
    return this.get(id)
  }
  async claim(id: string, event: string) {
    await this.locked(id, async (t, c) => {
      if (t.status !== 'ARMED')
        throw new Error('Ticket not armed; never resend')
      if (event !== t.prepared.binding.triggerEvent)
        throw new Error('Trigger mismatch')
      this.packet(t)
      await c.query(
        'UPDATE jupiter_close_tickets SET status=$2,intent_event=$3,intent_at=$4 WHERE id=$1',
        [id, 'SUBMITTING', event, new Date().toISOString()],
      )
    })
    return this.get(id)
  }
  async transition(id: string, to: Status, detail: string) {
    await this.locked(id, async (t, c) => {
      const permitted: Partial<Record<Status, Status[]>> = {
        PREPARED: ['DISABLED', 'INVALIDATED'],
        ARMED: ['DISABLED', 'INVALIDATED', 'REVOKED'],
        DISABLED: ['REVOKED'],
        SUBMITTING: ['UNKNOWN', 'REQUEST_PENDING', 'FAILED_CONSUMED', 'CLOSED'],
        UNKNOWN: ['UNKNOWN', 'REQUEST_PENDING', 'FAILED_CONSUMED', 'CLOSED'],
        REQUEST_PENDING: [
          'UNKNOWN',
          'REQUEST_PENDING',
          'CLOSED',
          'FAILED_CONSUMED',
        ],
      }
      if (to === 'REVOKED' && (t.intentAt !== null || t.intentEvent !== null))
        throw new Error('Prior send intent prevents unused revoke confirmation')
      if (!permitted[t.status]?.includes(to))
        throw new Error('State transition refused')
      await c.query(
        'UPDATE jupiter_close_tickets SET status=$2,detail=$3 WHERE id=$1',
        [id, to, detail.slice(0, 160)],
      )
    })
    return this.get(id)
  }
}
