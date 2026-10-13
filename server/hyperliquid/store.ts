import { randomUUID, createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import type { PoolClient } from 'pg'
import { queryDatabase, withDatabaseTransaction } from '../postgres'
import type {
  HlConnection,
  HlEvent,
  HlOutcome,
  HlPolicy,
  HlStatusResponse
} from '../../shared/hyperliquid'
import {
  sameEconomicFill,
  NATIVE_URL,
  realActionsEnabled,
  tradingDay,
  type ClosePlan,
  type Fill
} from './client'
export class ConsentBudgetExceeded extends Error {}
export type ConnectionRow = {
  id: string
  user_id: string
  data: HlConnection
  signer_ciphertext: string | null
  nonce: number
  claim_epoch: number
  claim_token: string | null
  claim_until: number
  consent_version: number | null
}
export type Intent = {
  id: string
  connection_id: string
  episode_id: string
  policy_version: number
  day: string
  target_size: string
  opened_at: number
  outcome: HlOutcome
}
export type Attempt = {
  id: string
  intent_id: string
  ordinal: number
  cloid: string
  payload_hash: string
  payload: ClosePlan
  nonce: number
  claim_epoch: number
  status: string
  submitted_at: number
  expires_at: number
  provider_oid: string | null
}
export const defaultPolicy = (): HlPolicy => ({
  version: 1,
  dailyEntryLimit: 1,
  timezone: 'Europe/Warsaw',
  slippageBps: 25,
  maxCloseNotionalUsd: '20',
  consentExpiresAt: Date.now() + 3600000
})
export async function linkConnection(userId: string, account: string, client?: PoolClient) {
  const policy = defaultPolicy(),
    id = randomUUID(),
    data: HlConnection = {
      id,
      network: 'testnet',
      account,
      mode: null,
      coin: 'BTC',
      status: 'LINKED_READ_ONLY',
      reason: 'Owner proof verified; background protection is not armed',
      policy,
      day: tradingDay(Date.now(), policy.timezone).day,
      entryCount: 0,
      remainingSize: '0',
      historyComplete: false,
      agentAddress: null,
      agentName: null,
      grantExpiresAt: null,
      lastCheckedAt: null,
      workerLastSeenAt: null,
      enabled: false
    }
  await queryDatabase(
    'INSERT INTO hl_connections(id,user_id,network,account,data,created_at) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, userId, 'testnet', account, data, Date.now()],
    client
  )
  return data
}
export async function getRow(id: string, client?: PoolClient, lock = false) {
  return (
    (
      await queryDatabase<ConnectionRow>(
        `SELECT * FROM hl_connections WHERE id=$1${lock ? ' FOR UPDATE' : ''}`,
        [id],
        client
      )
    ).rows[0] ?? null
  )
}
export async function getConnection(userId: string, id?: string) {
  return (
    (
      await queryDatabase<ConnectionRow>(
        `SELECT * FROM hl_connections WHERE user_id=$1${id ? ' AND id=$2' : ''}`,
        [userId, ...(id ? [id] : [])]
      )
    ).rows[0]?.data ?? null
  )
}
export async function updateConnection(data: HlConnection, client?: PoolClient) {
  await queryDatabase('UPDATE hl_connections SET data=$2 WHERE id=$1', [data.id, data], client)
}
export async function audit(
  connectionId: string,
  eventKey: string,
  outcome: HlOutcome,
  reason: string,
  fields: Partial<HlEvent> = {},
  client?: PoolClient
) {
  const data: HlEvent = {
    id: randomUUID(),
    occurredAt: Date.now(),
    outcome,
    reason,
    episodeId: null,
    intentId: null,
    providerOrderIds: [],
    fillIds: [],
    remainingSize: '0',
    agentClosedSize: '0',
    externalClosedSize: '0',
    ...fields
  }
  await queryDatabase(
    'INSERT INTO hl_events(id,connection_id,event_key,data) VALUES ($1,$2,$3,$4) ON CONFLICT(connection_id,event_key) DO NOTHING',
    [data.id, connectionId, eventKey, data],
    client
  )
}
export async function status(userId: string): Promise<HlStatusResponse> {
  const c = await getConnection(userId)
  if (
    c?.enabled &&
    (c.status === 'ARMED' || c.status === 'CLOSING' || c.status === 'BREACH_DETECTED') &&
    (!c.workerLastSeenAt || Date.now() - c.workerLastSeenAt > 15000)
  ) {
    c.status = 'DEGRADED'
    c.reason = 'Worker heartbeat stale; fresh protection readiness is unknown'
  }
  if (c?.enabled && c.policy.consentExpiresAt <= Date.now()) {
    c.status = 'EXPIRED'
    c.reason = 'Policy consent expired; no new actions'
  }
  const events = c
    ? (
        await queryDatabase<{ data: HlEvent }>(
          "SELECT data FROM hl_events WHERE connection_id=$1 ORDER BY (data->>'occurredAt')::bigint DESC LIMIT 50",
          [c.id]
        )
      ).rows.map((r) => r.data)
    : []
  return { connection: c, events, realActionsEnabled: realActionsEnabled(), nativeUrl: NATIVE_URL }
}
export async function claim(id: string, token: string, now: number) {
  const r = await queryDatabase<{ claim_epoch: number }>(
    'UPDATE hl_connections SET claim_token=$2,claim_epoch=claim_epoch+1,claim_until=$3 WHERE id=$1 AND claim_until<$4 RETURNING claim_epoch',
    [id, token, now + 30000, now]
  )
  return r.rows[0] ? { token, epoch: r.rows[0].claim_epoch } : null
}
export async function assertClaim(id: string, token: string, epoch: number, client?: PoolClient) {
  const row = await getRow(id, client, Boolean(client))
  if (
    !row ||
    row.claim_token !== token ||
    row.claim_epoch !== epoch ||
    row.claim_until <= Date.now()
  )
    throw Error('Account claim lost; reconcile only')
  return row
}
export async function releaseClaim(id: string, token: string, epoch: number) {
  await queryDatabase(
    'UPDATE hl_connections SET claim_until=0,claim_token=NULL WHERE id=$1 AND claim_token=$2 AND claim_epoch=$3',
    [id, token, epoch]
  )
}
export async function historyConsistent(id: string, fills: Fill[], start: number) {
  const old = await queryDatabase<{ data: Fill }>(
      'SELECT data FROM hl_fills WHERE connection_id=$1 AND occurred_at>=$2',
      [id, start]
    ),
    observed = new Map(fills.map((f) => [f.id, f]))
  return old.rows.every(
    (r) => observed.has(r.data.id) && sameEconomicFill(r.data, observed.get(r.data.id)!)
  )
}
export async function checkpoint(
  row: ConnectionRow,
  data: HlConnection,
  fills: Fill[],
  token: string,
  epoch: number
) {
  await withDatabaseTransaction(async (tx) => {
    const fresh = await assertClaim(row.id, token, epoch, tx)
    if (
      fresh.data.policy.version !== data.policy.version ||
      fresh.data.enabled !== row.data.enabled
    )
      throw Error('Policy or enabled state changed')
    for (const fill of fills) {
      await queryDatabase(
        'INSERT INTO hl_fills(connection_id,fill_id,occurred_at,data) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [row.id, fill.id, fill.time, fill],
        tx
      )
    }

    const oldFills = await queryDatabase<{ fill_id: string; data: Fill }>(
      'SELECT fill_id,data FROM hl_fills WHERE connection_id=$1 AND occurred_at>=$2',
      [row.id, tradingDay(Date.now(), data.policy.timezone).start],
      tx
    )
    const observed = new Map(fills.map((f) => [f.id, f]))
    if (
      oldFills.rows.some(
        (f) => !observed.has(f.fill_id) || !sameEconomicFill(f.data, observed.get(f.fill_id)!)
      )
    ) {
      data.historyComplete = false
      data.status = 'DATA_GAP'
      data.reason =
        'Provider history omitted or contradicted previously committed current-day fills'
    }
    if (!data.historyComplete) {
      const previous = (
        await queryDatabase<{ entry_count: number }>(
          'SELECT entry_count FROM hl_days WHERE connection_id=$1 AND timezone=$2 AND day=$3',
          [row.id, data.policy.timezone, data.day],
          tx
        )
      ).rows[0]
      if (previous) data.entryCount = previous.entry_count
    }
    await queryDatabase(
      'INSERT INTO hl_days(connection_id,timezone,day,entry_count,cursor_at,history_complete) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(connection_id,timezone,day) DO UPDATE SET entry_count=EXCLUDED.entry_count,cursor_at=EXCLUDED.cursor_at,history_complete=EXCLUDED.history_complete',
      [
        row.id,
        data.policy.timezone,
        data.day,
        data.entryCount,
        data.lastCheckedAt,
        data.historyComplete
      ],
      tx
    )
    if (data.historyComplete) {
      const { reconstructEntries } = await import('./client'),
        ledger = reconstructEntries(fills, data.remainingSize)
      for (const episode of ledger.episodes.filter(
        (e) => e.ordinal > data.policy.dailyEntryLimit
      )) {
        const active = episode.id === ledger.episodeId
        const intentResult = await queryDatabase<Intent>(
          'INSERT INTO hl_intents(id,connection_id,episode_id,policy_version,day,target_size,opened_at,outcome) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(connection_id,episode_id,policy_version) DO NOTHING RETURNING *',
          [
            randomUUID(),
            row.id,
            episode.id,
            data.policy.version,
            data.day,
            active
              ? new (await import('decimal.js')).default(data.remainingSize).abs().toFixed()
              : '0',
            episode.openedAt,
            active ? 'BREACH_DETECTED' : 'RESOLVED_EXTERNALLY'
          ],
          tx
        )
        const intent = intentResult.rows[0]
        if (intent)
          await audit(
            row.id,
            `breach:${intent.id}`,
            'BREACH_DETECTED',
            `Entry ${episode.ordinal} exceeds daily limit ${data.policy.dailyEntryLimit}`,
            {
              episodeId: episode.id,
              intentId: intent.id,
              remainingSize: data.remainingSize,
              fillIds: [episode.id]
            },
            tx
          )
        if (intent && !active)
          await audit(
            row.id,
            `external:${intent.id}`,
            'RESOLVED_EXTERNALLY',
            'Violating episode already closed before observation; no close was submitted',
            { episodeId: episode.id, intentId: intent.id, remainingSize: '0' },
            tx
          )
      }
    }
    await updateConnection(data, tx)
  })
}
export async function unresolved(id: string, tx?: PoolClient) {
  return (
    await queryDatabase<Intent>(
      "SELECT * FROM hl_intents WHERE connection_id=$1 AND outcome IN ('BREACH_DETECTED','CLOSING','PARTIAL','UNCERTAIN')",
      [id],
      tx
    )
  ).rows
}
export async function getIntent(
  id: string,
  episodeId: string,
  policyVersion: number,
  day: string,
  target: string,
  openedAt: number,
  fence: { token: string; epoch: number }
) {
  return withDatabaseTransaction(async (tx) => {
    await assertClaim(id, fence.token, fence.epoch, tx)
    const result = await queryDatabase<Intent>(
      'INSERT INTO hl_intents(id,connection_id,episode_id,policy_version,day,target_size,opened_at,outcome) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(connection_id,episode_id,policy_version) DO UPDATE SET episode_id=EXCLUDED.episode_id RETURNING *',
      [randomUUID(), id, episodeId, policyVersion, day, target, openedAt, 'BREACH_DETECTED'],
      tx
    )
    return result.rows[0]
  })
}
export async function attempts(id: string) {
  return (
    await queryDatabase<Attempt>('SELECT * FROM hl_attempts WHERE intent_id=$1 ORDER BY ordinal', [
      id
    ])
  ).rows
}
export async function setAttempt(
  id: string,
  status: string,
  oid: string | undefined,
  connectionId: string,
  token: string,
  epoch: number
) {
  await withDatabaseTransaction(async (tx) => {
    await assertClaim(connectionId, token, epoch, tx)
    await queryDatabase(
      'UPDATE hl_attempts SET status=$2,provider_oid=COALESCE($3,provider_oid) WHERE id=$1',
      [id, status, oid ?? null],
      tx
    )
  })
}
export async function setOutcome(
  intent: Intent,
  outcome: HlOutcome,
  reason: string,
  fields: Partial<HlEvent> = {},
  fence?: { token: string; epoch: number }
) {
  await withDatabaseTransaction(async (tx) => {
    if (fence) await assertClaim(intent.connection_id, fence.token, fence.epoch, tx)
    await queryDatabase('UPDATE hl_intents SET outcome=$2 WHERE id=$1', [intent.id, outcome], tx)
    await audit(
      intent.connection_id,
      `intent:${intent.id}:${outcome}:${createHash('sha256').update(JSON.stringify({ reason, fields })).digest('hex')}`,
      outcome,
      reason,
      { episodeId: intent.episode_id, intentId: intent.id, ...fields },
      tx
    )
  })
}
export async function persistSubmitting(
  row: ConnectionRow,
  intent: Intent,
  plan: ClosePlan,
  token: string,
  epoch: number
) {
  return withDatabaseTransaction(async (tx) => {
    const fresh = await assertClaim(row.id, token, epoch, tx)
    if (
      !fresh.data.enabled ||
      fresh.data.policy.version !== intent.policy_version ||
      fresh.data.day !== intent.day ||
      fresh.consent_version !== intent.policy_version
    )
      throw Error('Policy/day/consent changed before submit')
    const previous = await attempts(intent.id)
    if (previous.some((a) => a.status !== 'TERMINAL'))
      throw Error('Previous attempt unresolved; no retry')
    if (previous.length >= 3) throw Error('Three-attempt ceiling reached')
    const budget = (
      await queryDatabase<{ count: number }>(
        'SELECT COUNT(*)::integer AS count FROM hl_attempts a JOIN hl_intents i ON i.id=a.intent_id WHERE i.connection_id=$1 AND i.policy_version=$2',
        [row.id, intent.policy_version],
        tx
      )
    ).rows[0].count
    if (budget >= 3)
      throw new ConsentBudgetExceeded(
        'Three total persisted attempts exhausted for this consent version; rearm/restart does not reset budget'
      )
    const nonce = Math.max(Date.now(), fresh.nonce + 1),
      id = randomUUID(),
      hash = createHash('sha256').update(JSON.stringify({ plan, nonce })).digest('hex')
    await queryDatabase('UPDATE hl_connections SET nonce=$2 WHERE id=$1', [row.id, nonce], tx)
    const result = await queryDatabase<Attempt>(
      'INSERT INTO hl_attempts(id,intent_id,ordinal,cloid,payload_hash,payload,nonce,claim_epoch,status,submitted_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
      [
        id,
        intent.id,
        previous.length + 1,
        plan.order.c,
        hash,
        plan,
        nonce,
        epoch,
        'SUBMITTING',
        Date.now(),
        plan.expiresAfter
      ],
      tx
    )
    await queryDatabase("UPDATE hl_intents SET outcome='CLOSING' WHERE id=$1", [intent.id], tx)
    await audit(
      row.id,
      `intent:${intent.id}:attempt:${id}`,
      'CLOSING',
      'Close attempt persisted before network; acknowledgement is not closure',
      {
        episodeId: intent.episode_id,
        intentId: intent.id,
        remainingSize: fresh.data.remainingSize
      },
      tx
    )
    return result.rows[0]
  })
}
function encryptionKey(inert?: Buffer) {
  if (inert) {
    if (process.env.NODE_ENV !== 'test') throw Error('Test-only encryption injection')
    return inert
  }
  const raw = process.env.HL_AGENT_ENCRYPTION_KEY
  if (!raw) throw Error('HL_AGENT_ENCRYPTION_KEY is required before creating an agent')
  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) throw Error('Invalid HL agent encryption key')
  return key
}
export function encryptAgent(secret: string, id: string, inert?: Buffer) {
  const nonce = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', encryptionKey(inert), nonce)
  cipher.setAAD(Buffer.from(`hl:testnet:${id}`))
  const data = Buffer.concat([cipher.update(secret), cipher.final()])
  return [nonce, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.')
}
export function decryptAgent(raw: string, id: string, inert?: Buffer): `0x${string}` {
  const [nonce, tag, data] = raw.split('.').map((s) => Buffer.from(s, 'base64url'))
  const c = createDecipheriv('aes-256-gcm', encryptionKey(inert), nonce)
  c.setAAD(Buffer.from(`hl:testnet:${id}`))
  c.setAuthTag(tag)
  return Buffer.concat([c.update(data), c.final()]).toString() as `0x${string}`
}
