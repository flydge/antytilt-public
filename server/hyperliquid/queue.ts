import { randomUUID, createHash } from 'node:crypto'
import Decimal from 'decimal.js'
import { Queue, Worker, type Job } from 'bullmq'
import { queryDatabase, withDatabaseTransaction } from '../postgres'
import {
  redisHealth,
  redisConnection,
  redisConfigured,
  bullMqConnection,
  bullMqPrefix,
  initializeRedis
} from '../redis'
import type { HlConnection } from '../../shared/hyperliquid'
import {
  createProvider,
  agentNameBase,
  ProviderRejected,
  UnsupportedMasterRole,
  realActionsEnabled,
  tradingDay,
  reconstructEntries,
  planClose,
  terminalOrderStatus,
  resolveOutcome,
  type Provider,
  type Snapshot,
  type Fill
} from './client'
import type { TestDependencies } from './protection'
import * as store from './store'
type QueueJob = { connectionId: string; scheduledAt: number }
let timer: NodeJS.Timeout | undefined,
  running: Promise<void> | undefined,
  queue: Queue<QueueJob> | undefined,
  worker: Worker<QueueJob> | undefined
const queueName = 'hyperliquid-protection'
let connections: ReturnType<typeof bullMqConnection>[] = []
const productionProvider = createProvider()

function agentReduced(fills: Fill[], attempts: store.Attempt[], openedAt: number) {
  const ids = new Set(attempts.map((a) => a.provider_oid).filter(Boolean)),
    cloids = new Set(attempts.map((a) => a.cloid))
  let total = new Decimal(0)
  const fillIds: string[] = []
  for (const f of fills.filter(
    (f) =>
      f.coin === 'BTC' &&
      f.time >= openedAt &&
      (ids.has(f.oid) || Boolean(f.cloid && cloids.has(f.cloid)))
  )) {
    const start = new Decimal(f.startPosition),
      qty = new Decimal(f.sz)
    if ((start.gt(0) && f.side === 'A') || (start.lt(0) && f.side === 'B')) {
      total = total.plus(Decimal.min(qty, start.abs()))
      fillIds.push(f.id)
    }
  }
  return { total, fillIds }
}
function episodeFills(fills: Fill[], episodeId: string) {
  const ordered = fills
      .filter((f) => f.coin === 'BTC')
      .sort((a, b) => a.time - b.time || Number(a.id) - Number(b.id)),
    first = ordered.findIndex((f) => f.id === episodeId)
  if (first < 0) return []
  const interval: Fill[] = []
  for (let i = first; i < ordered.length; i++) {
    const f = ordered[i],
      start = new Decimal(f.startPosition),
      next = start.plus(new Decimal(f.sz).mul(f.side === 'B' ? 1 : -1))
    interval.push(f)
    if (
      i > first &&
      (next.isZero() ||
        (!start.isZero() && !next.isZero() && start.isPositive() !== next.isPositive()))
    )
      break
  }
  return interval
}
function episodeExposure(fills: Fill[], episodeId: string, fallback: Decimal) {
  const ordered = fills
    .filter((f) => f.coin === 'BTC')
    .sort((a, b) => a.time - b.time || Number(a.id) - Number(b.id))
  const first = ordered.findIndex((f) => f.id === episodeId)
  if (first < 0) return fallback
  let total = new Decimal(0)
  for (let i = first; i < ordered.length; i++) {
    const f = ordered[i],
      start = new Decimal(f.startPosition),
      delta = new Decimal(f.sz).mul(f.side === 'B' ? 1 : -1),
      next = start.plus(delta)
    if (i === first) total = next.abs()
    else if (!start.isZero() && start.isPositive() === delta.isPositive())
      total = total.plus(delta.abs())
    if (
      i > first &&
      (next.isZero() ||
        (!start.isZero() && !next.isZero() && start.isPositive() !== next.isPositive()))
    )
      break
  }
  return Decimal.max(total, fallback)
}
async function writeState(id: string, token: string, epoch: number, patch: Partial<HlConnection>) {
  await withDatabaseTransaction(async (tx) => {
    const fresh = await store.assertClaim(id, token, epoch, tx)
    await store.updateConnection({ ...fresh.data, ...patch, workerLastSeenAt: Date.now() }, tx)
  })
}
export async function processConnection(id: string, testDependencies?: TestDependencies) {
  if (testDependencies && process.env.NODE_ENV !== 'test')
    throw Error('Hyperliquid dependency injection is test-only')
  const provider: Provider = testDependencies?.provider ?? productionProvider,
    actions = testDependencies?.actionsEnabled ?? realActionsEnabled
  const leaseToken = randomUUID(),
    leaseKey = `${process.env.REDIS_PREFIX ?? 'antytilt'}:hl-lease:${id}`,
    redis = testDependencies ? undefined : redisConnection()
  const health = async () => {
    if (testDependencies?.health) return testDependencies.health()
    const h = await redisHealth()
    if (!h.enabled || !h.ok) throw Error('Redis unavailable; no send')
    if (redis && (await redis.get(leaseKey)) !== leaseToken)
      throw Error('Redis lease lost; no send')
  }
  // Existing Redis test no-op locks must never become permission to send.
  if (!testDependencies && !redisConfigured()) return
  if (redis) {
    if (redis.status === 'wait') await redis.connect()
    if ((await redis.set(leaseKey, leaseToken, 'PX', 30000, 'NX')) !== 'OK') return
  }
  try {
    await health()
    await (async () => {
      const token = randomUUID(),
        claim = await store.claim(id, token, Date.now())
      if (!claim) return
      const epoch = claim.epoch,
        fence = { token, epoch }
      let activeAttempt: store.Attempt | undefined, activeIntent: store.Intent | undefined
      try {
        let row = await store.assertClaim(id, token, epoch),
          c = row.data
        await writeState(id, token, epoch, { workerLastSeenAt: Date.now() })
        if (!c.agentAddress && !c.enabled) return
        const window = tradingDay(Date.now(), c.policy.timezone),
          pending = await store.unresolved(id),
          historyStart = Math.min(window.start, ...pending.map((i) => i.opened_at)),
          snap = await provider.read(c.account, historyStart, Date.now()),
          ledger = reconstructEntries(
            snap.fills.filter((f) => f.time >= window.start),
            snap.position
          )
        let data: HlConnection = {
          ...c,
          mode: snap.mode,
          day: window.day,
          entryCount: ledger.entryCount,
          remainingSize: snap.position,
          historyComplete: snap.historyComplete && ledger.historyComplete,
          lastCheckedAt: snap.checkedAt,
          workerLastSeenAt: Date.now()
        }
        data.historyComplete =
          data.historyComplete && (await store.historyConsistent(id, snap.fills, historyStart))
        const grant = snap.grants.find(
          (g) =>
            g.address.toLowerCase() === c.agentAddress &&
            agentNameBase(g.name) === agentNameBase(c.agentName ?? '')
        )
        // Reconcile persisted submissions even after explicit disable/revoke/expiry. No sends required.
        for (const intent of pending) {
          const attempts = await store.attempts(intent.id)
          for (const attempt of attempts.filter((a) => a.status !== 'TERMINAL')) {
            const response = await provider.orders(c.account, attempt.cloid)
            if (terminalOrderStatus(response.status))
              await store.setAttempt(attempt.id, 'TERMINAL', response.oid, id, token, epoch)
            else {
              await store.setAttempt(attempt.id, 'UNCERTAIN', response.oid, id, token, epoch)
              await store.setOutcome(
                intent,
                'UNCERTAIN',
                `Provider order state ${response.status}; no repeat until terminal evidence`,
                {
                  remainingSize: snap.position,
                  providerOrderIds: response.oid ? [response.oid] : []
                },
                fence
              )
            }
          }
          const latest = await store.attempts(intent.id),
            attributed = agentReduced(
              episodeFills(snap.fills, intent.episode_id),
              latest,
              intent.opened_at
            )
          const unresolvedAttempt = latest.some((a) => a.status !== 'TERMINAL')
          const allFlat = new Decimal(snap.position).isZero()
          if (unresolvedAttempt) {
            data.status = 'UNCERTAIN'
            data.reason = 'Persisted attempt requires reconciliation; no new sends'
            continue
          }
          if (allFlat && data.historyComplete) {
            const target = episodeExposure(
              episodeFills(snap.fills, intent.episode_id),
              intent.episode_id,
              new Decimal(intent.target_size)
            )
            // Attribution must match the entire originally authorized violating residual.
            const outcome = resolveOutcome(target.toFixed(), '0', attributed.total.toFixed())
            await store.setOutcome(
              intent,
              outcome,
              'Fresh flat position reconciled with agent fills; no future-flat guarantee',
              {
                remainingSize: '0',
                agentClosedSize: attributed.total.toFixed(),
                externalClosedSize: Decimal.max(0, target.minus(attributed.total)).toFixed(),
                fillIds: attributed.fillIds,
                providerOrderIds: latest
                  .map((a) => a.provider_oid)
                  .filter((x): x is string => Boolean(x))
              },
              fence
            )
          } else if (latest.length) {
            await store.setOutcome(
              intent,
              'PARTIAL',
              'Terminal prior order has a remaining BTC residual',
              {
                remainingSize: snap.position,
                agentClosedSize: attributed.total.toFixed(),
                fillIds: attributed.fillIds
              },
              fence
            )
          }
        }
        const blockers = await store.unresolved(id)
        if (blockers.some((i) => i.outcome === 'UNCERTAIN')) {
          data.status = 'UNCERTAIN'
          data.reason = 'Unknown prior result; reconcile only'
        } else if (!c.enabled) {
          data.status = c.status === 'DISABLED' ? 'DISABLED' : 'AWAITING_GRANT'
          data.reason =
            c.status === 'DISABLED'
              ? c.reason
              : 'Not armed; native grant and explicit policy consent required'
        } else if (!data.historyComplete) {
          data.status = 'DATA_GAP'
          data.reason = 'Current-day fill history incomplete or inconsistent; sends paused'
        } else if (!['disabled', 'unifiedAccount'].includes(snap.mode)) {
          data.status = 'UNSUPPORTED_MODE'
          data.reason = 'Only explicitly disabled or unifiedAccount modes are supported'
        } else if (c.policy.consentExpiresAt <= Date.now()) {
          data.status = 'EXPIRED'
          data.reason = 'Policy consent expired; no new sends'
        } else if (!grant) {
          data.status = 'REVOKED'
          data.reason = 'Dedicated agent grant absent; no new sends'
        } else if (
          !grant.validUntil ||
          grant.validUntil <= Date.now() ||
          !c.grantExpiresAt ||
          grant.validUntil > c.grantExpiresAt
        ) {
          data.status = 'EXPIRED'
          data.reason = 'Agent grant expired or unbounded expiry cannot be verified'
        } else if (!actions()) {
          data.status = 'DEGRADED'
          data.reason = 'Real action gate is disabled; no new sends'
        } else {
          data.status = 'ARMED'
          data.reason = 'Fresh worker, history, mode and grant verified'
        }
        await store.checkpoint(row, data, ledger.fills, token, epoch)
        row = await store.assertClaim(id, token, epoch)
        data = row.data
        if (data.status !== 'ARMED') return
        if (
          ledger.entryCount <= data.policy.dailyEntryLimit ||
          !ledger.episodeId ||
          ledger.episodeId.startsWith('carry:') ||
          new Decimal(snap.position).isZero()
        )
          return
        const episode = ledger.episodes.find((e) => e.id === ledger.episodeId)
        if (!episode || episode.ordinal <= data.policy.dailyEntryLimit) return
        const intent = await store.getIntent(
          id,
          episode.id,
          data.policy.version,
          window.day,
          new Decimal(snap.position).abs().toFixed(),
          episode.openedAt,
          fence
        )
        activeIntent = intent
        const previous = await store.attempts(intent.id)
        if (intent.outcome === 'ACTION_FAILED') {
          await writeState(id, token, epoch, {
            status: 'ACTION_FAILED',
            reason: 'Episode attempt ceiling remains exhausted; residual is not protected'
          })
          return
        }
        if (
          ['CONFIRMED_CLOSED', 'MIXED_RESOLUTION', 'RESOLVED_EXTERNALLY'].includes(intent.outcome)
        )
          return
        if (previous.length >= 3) {
          await store.setOutcome(
            intent,
            'ACTION_FAILED',
            'Three terminal attempts exhausted; residual remains',
            { remainingSize: snap.position },
            fence
          )
          await writeState(id, token, epoch, {
            status: 'ACTION_FAILED',
            reason: 'Three-attempt ceiling reached'
          })
          return
        }
        if (previous.some((a) => a.status !== 'TERMINAL')) return
        // Every send gets a fresh complete history, position, quote, grant and mode recheck.
        const latestWindow = tradingDay(Date.now(), data.policy.timezone),
          fresh = await provider.read(data.account, latestWindow.start, Date.now()),
          newLedger = reconstructEntries(fresh.fills, fresh.position)
        await health()
        row = await store.assertClaim(id, token, epoch)
        const latestGrant = fresh.grants.find(
          (g) =>
            g.address.toLowerCase() === data.agentAddress &&
            agentNameBase(g.name) === agentNameBase(data.agentName ?? '')
        )
        if (
          !actions() ||
          !row.data.enabled ||
          row.data.policy.version !== intent.policy_version ||
          row.consent_version !== intent.policy_version ||
          latestWindow.day !== intent.day ||
          !fresh.historyComplete ||
          !newLedger.historyComplete ||
          !(await store.historyConsistent(id, fresh.fills, latestWindow.start)) ||
          !['disabled', 'unifiedAccount'].includes(fresh.mode) ||
          Date.now() - fresh.checkedAt > 3000 ||
          !latestGrant?.validUntil ||
          latestGrant.validUntil <= Date.now() ||
          !row.data.grantExpiresAt ||
          latestGrant.validUntil > row.data.grantExpiresAt
        )
          throw Error('Fresh pre-send authorization/history/mode/day/grant check failed')
        if (
          newLedger.episodeId !== intent.episode_id ||
          newLedger.entryCount <= row.data.policy.dailyEntryLimit
        ) {
          await store.setOutcome(
            intent,
            'RESOLVED_EXTERNALLY',
            'Original violating episode changed before submit; no send',
            { remainingSize: fresh.position },
            fence
          )
          return
        }
        const cloid = `0x${createHash('sha256')
          .update(`${intent.id}:${previous.length + 1}`)
          .digest('hex')
          .slice(0, 32)}`
        const plan = planClose({
          position: fresh.position,
          mid: fresh.mid,
          asset: fresh.asset,
          szDecimals: fresh.szDecimals,
          slippageBps: row.data.policy.slippageBps,
          maxCloseNotionalUsd: row.data.policy.maxCloseNotionalUsd,
          now: Date.now(),
          dayEnd: latestWindow.end,
          consentExpiry: row.data.policy.consentExpiresAt,
          grantExpiry: latestGrant.validUntil,
          cloid
        })
        if (!row.signer_ciphertext) throw Error('Encrypted agent signer missing')
        const secret = store.decryptAgent(
          row.signer_ciphertext,
          id,
          testDependencies?.encryptionKey
        )
        activeAttempt = await store.persistSubmitting(row, intent, plan, token, epoch)
        // Persisted SUBMITTING is the irreversible submission boundary; no automatic retry on any exception.
        await health()
        const boundaryRow = await store.assertClaim(id, token, epoch)
        if (
          !boundaryRow.data.enabled ||
          boundaryRow.consent_version !== intent.policy_version ||
          boundaryRow.data.policy.version !== intent.policy_version ||
          tradingDay(Date.now(), boundaryRow.data.policy.timezone).day !== intent.day ||
          !actions() ||
          Date.now() - fresh.checkedAt > 3000 ||
          Date.now() >= plan.expiresAfter
        )
          throw Error('Action gate, snapshot, or expiry changed at submit boundary')
        const result = await provider.submit(plan, secret, activeAttempt.nonce)
        await store.setAttempt(activeAttempt.id, 'ACKNOWLEDGED', result.oid, id, token, epoch)
        await writeState(id, token, epoch, {
          status: 'CLOSING',
          reason: 'Provider acknowledged close; fills and fresh flat confirmation pending'
        })
      } catch (error) {
        try {
          await store.assertClaim(id, token, epoch)
          if (error instanceof store.ConsentBudgetExceeded && activeIntent) {
            await store.setOutcome(
              activeIntent,
              'ACTION_FAILED',
              error.message,
              { remainingSize: (await store.getRow(id))?.data.remainingSize ?? '0' },
              fence
            )
          }
          if (activeAttempt) {
            const rejected = error instanceof ProviderRejected
            await store.setAttempt(
              activeAttempt.id,
              rejected ? 'TERMINAL' : 'UNCERTAIN',
              undefined,
              id,
              token,
              epoch
            )
            const intent = (await store.unresolved(id)).find(
              (i) => i.id === activeAttempt!.intent_id
            )
            if (intent)
              await store.setOutcome(
                intent,
                rejected ? 'PARTIAL' : 'UNCERTAIN',
                rejected
                  ? 'Provider explicitly rejected this order; later bounded attempt requires fresh verification'
                  : 'Submission may have executed; persisted attempt will be reconciled without retry',
                {},
                fence
              )
          }
          await writeState(id, token, epoch, {
            status: activeAttempt
              ? error instanceof ProviderRejected
                ? 'ACTION_FAILED'
                : 'UNCERTAIN'
              : error instanceof store.ConsentBudgetExceeded
                ? 'ACTION_FAILED'
                : error instanceof UnsupportedMasterRole
                  ? 'UNSUPPORTED_MODE'
                  : 'DEGRADED',
            reason: activeAttempt
              ? error instanceof ProviderRejected
                ? 'Provider explicitly rejected close'
                : 'Unknown submitted action result; reconcile only'
              : error instanceof Error
                ? error.message
                : 'Provider unavailable; no send'
          })
        } catch {
          /* A lost claim cannot overwrite its successor. SUBMITTING persists for takeover reconciliation. */
        }
      } finally {
        await store.releaseClaim(id, token, epoch)
      }
    })()
  } finally {
    if (redis)
      await redis
        .eval(
          "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",
          1,
          leaseKey,
          leaseToken
        )
        .catch(() => undefined)
  }
}
async function tick(intervalMs: number) {
  if (!queue) return
  const scheduledAt = Date.now(),
    slot = Math.floor(scheduledAt / intervalMs),
    rows = (await queryDatabase<{ id: string }>('SELECT id FROM hl_connections')).rows
  for (const row of rows)
    await queue.add(
      'reconcile-account',
      { connectionId: row.id, scheduledAt },
      {
        jobId: `hl-${row.id}-${slot}`,
        attempts: 1,
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 86400, count: 1000 }
      }
    )
}
// One demo account: 4 baseline empty-history reads/minute plus up to 3 fresh
// pre-submit reads consume 1008/1200 documented IP weight. Retained history adds
// weight and must be measured before approval; this is not a general rate governor.
export function hyperliquidMonitorInterval(intervalMs = 15000) {
  return Number.isFinite(intervalMs)
    ? Math.min(2147483647, Math.max(15000, Math.floor(intervalMs)))
    : 15000
}
export async function startHyperliquidQueue(intervalMs = 15000) {
  if (queue || worker) return
  await initializeRedis()
  const normalized = hyperliquidMonitorInterval(intervalMs),
    prefix = bullMqPrefix()
  connections = [bullMqConnection(), bullMqConnection()]
  queue = new Queue<QueueJob>(queueName, {
    connection: connections[0],
    prefix,
    defaultJobOptions: { attempts: 1 }
  })
  worker = new Worker<QueueJob>(
    queueName,
    async (job: Job<QueueJob>) => processConnection(job.data.connectionId),
    { connection: connections[1], prefix, concurrency: 1, lockDuration: 60000, maxStalledCount: 0 }
  )
  worker.on('error', () => {
    console.error('[hl-queue] Worker transport unavailable; protection readiness will become stale')
  })
  const run = () => {
    if (!running)
      running = tick(normalized)
        .catch(() => undefined)
        .finally(() => {
          running = undefined
        })
  }
  timer = setInterval(run, normalized)
  timer.unref()
  run()
}
export async function stopHyperliquidQueue() {
  if (timer) clearInterval(timer)
  timer = undefined
  await running
  await worker?.close()
  await queue?.close()
  worker = undefined
  queue = undefined
  await Promise.all(connections.map((c) => c.quit().catch(() => c.disconnect())))
  connections = []
}
