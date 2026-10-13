import { Router, type Request, type Response } from 'express'
import { createHash, randomUUID, randomBytes } from 'node:crypto'
import { recoverMessageAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import Decimal from 'decimal.js'
import { z } from 'zod'
import { queryDatabase, withDatabaseTransaction } from '../postgres'
import { redisHealth } from '../redis'
import { HL_CONSENT, type HlPolicyInput, type HlConnection } from '../../shared/hyperliquid'
import {
  canonicalAccount,
  agentNameBase,
  createProvider,
  realActionsEnabled,
  tradingDay,
  reconstructEntries,
  type Provider,
  type Snapshot
} from './client'
import * as store from './store'
import { createManualTradingProvider, previewManualOrder, type ManualTradingProvider } from './manualTrading'
import type { HlManualNetwork } from '../../shared/hyperliquidManualTrading'
class HttpError extends Error {
  constructor(
    public code: number,
    message: string
  ) {
    super(message)
  }
}
export type TestDependencies = {
  provider: Provider
  actionsEnabled: () => boolean
  encryptionKey: Buffer
  health?: () => Promise<void>
  manualProvider?: ManualTradingProvider
  manualProviders?: Partial<Record<HlManualNetwork, ManualTradingProvider>>
  manualMainnetActionsEnabled?: () => boolean
}
export function createProtectionRouter(options: {
  requireUser: (request: Request) => Promise<{ id: string }>
  testDependencies?: TestDependencies
}) {
  if (options.testDependencies && process.env.NODE_ENV !== 'test')
    throw Error('Hyperliquid dependency injection is test-only')
  const deps = options.testDependencies,
    provider = deps?.provider ?? createProvider(),
    enabled = deps?.actionsEnabled ?? realActionsEnabled,
    router = Router()
  const manualProviders: Record<HlManualNetwork, ManualTradingProvider> = {
    testnet: deps?.manualProviders?.testnet ?? deps?.manualProvider ?? createManualTradingProvider('testnet'),
    mainnet: deps?.manualProviders?.mainnet ?? createManualTradingProvider('mainnet')
  }
  const manualNetworkSchema = z.enum(['testnet', 'mainnet'])
  const manualEnabled = (network: HlManualNetwork) => network === 'testnet' ? enabled() : deps?.manualMainnetActionsEnabled?.() ?? process.env.HL_MAINNET_MANUAL_ACTIONS_CONFIRMED === 'true'
  const readManualSnapshot = async (account: string, network: HlManualNetwork) => {
    const snap = await manualProviders[network].read(account)
    if (snap.account !== account || snap.network !== network) throw new HttpError(409, 'Provider snapshot master or network mismatch')
    return snap
  }
  const gate = () => {
    if (!enabled())
      throw new HttpError(
        403,
        'Real Hyperliquid actions require owner confirmation; preparation is stopped'
      )
  }
  const session = (r: Request) => {
    const cookie = r.headers.cookie
      ?.split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith('antytilt_auth='))
    if (!cookie) throw new HttpError(403, 'Authenticated session cookie required')
    return createHash('sha256').update(cookie).digest('hex')
  }
  const origin = (r: Request) => r.get('origin') ?? `${r.protocol}://${r.get('host')}`
  const handler =
    (fn: (r: Request, s: Response, user: string) => Promise<void>) =>
    async (r: Request, s: Response) => {
      try {
        const user = await options.requireUser(r)
        await fn(r, s, user.id)
      } catch (e) {
        const code =
          e instanceof HttpError
            ? e.code
            : e instanceof z.ZodError
              ? 400
              : ((e as { status?: number }).status ??
                ((e as Error).message?.match(/auth|login|session/i) ? 401 : 500))
        s.status(code).json({
          error:
            code === 500
              ? 'Hyperliquid operation unavailable; no new action was authorized'
              : (e as Error).message
        })
      }
    }
  const scoped = async (user: string, id: unknown) => {
    const valid = z.string().uuid().parse(id),
      c = await store.getConnection(user, valid)
    if (!c) throw new HttpError(404, 'Connection not found')
    return c
  }
  const health = async () => {
    if (deps?.health) return deps.health()
    const h = await redisHealth()
    if (!h.enabled || !h.ok) throw new HttpError(503, 'Redis is unavailable; cannot arm or submit')
  }
  const fresh = async (c: HlConnection) => {
    const window = tradingDay(Date.now(), c.policy.timezone),
      snap = await provider.read(c.account, window.start, Date.now()),
      ledger = reconstructEntries(snap.fills, snap.position)
    return { window, snap, ledger }
  }
  const requireSnapshot = (snap: Snapshot, complete: boolean) => {
    if (Date.now() - snap.checkedAt > 3000)
      throw new HttpError(409, 'Provider snapshot stale; repeat synchronization')
    if (!['disabled', 'unifiedAccount'].includes(snap.mode))
      throw new HttpError(409, 'Unsupported or unresolved account mode')
    if (!complete)
      throw new HttpError(409, 'DATA_GAP: current-day history is incomplete or inconsistent')
  }
  router.get('/manual/status', handler(async (r, s, user) => {
    const network = manualNetworkSchema.parse(r.query.network)
    const c = await store.getConnection(user)
    s.json({ network, realActionsEnabled: manualEnabled(network), snapshot: c ? await readManualSnapshot(c.account, network) : null })
  }))
  router.post('/manual/preview', handler(async (r, s, user) => {
    const input = z.object({ network: manualNetworkSchema, action: z.enum(['open-long', 'open-short', 'close']), notionalUsd: z.string().max(32).optional() }).strict().parse(r.body)
    if (!manualEnabled(input.network)) throw new HttpError(403, input.network === 'mainnet' ? 'Mainnet owner trading is disabled; separate real-funds authorization is required' : 'Testnet owner trading is disabled pending confirmation')
    const c = await store.getConnection(user)
    if (!c) throw new HttpError(409, 'Link a master EOA in BTC Protection first')
    const snapshot = await readManualSnapshot(c.account, input.network)
    try { s.json(previewManualOrder(snapshot, input, Date.now(), `0x${randomBytes(16).toString('hex')}`)) }
    catch (error) { throw new HttpError(409, error instanceof Error ? error.message : 'Manual order preview unavailable') }
  }))
  router.get('/manual/order/:cloid', handler(async (r, s, user) => {
    const network = manualNetworkSchema.parse(r.query.network)
    const c = await store.getConnection(user)
    if (!c) throw new HttpError(409, 'Linked master EOA required')
    const cloid = z.string().regex(/^0x[0-9a-f]{32}$/).parse(r.params.cloid) as `0x${string}`
    const order = await manualProviders[network].order(c.account, cloid)
    s.json({ network, ...order, snapshot: await readManualSnapshot(c.account, network) })
  }))
  router.get(
    '/status',
    handler(async (_r, s, user) => {
      s.json(await store.status(user))
    })
  )
  router.post(
    '/challenge',
    handler(async (r, s, user) => {
      const body = z.object({ account: z.string(), network: z.literal('testnet') }).parse(r.body),
        account = canonicalAccount(body.account),
        id = randomUUID(),
        expiresAt = Date.now() + 5 * 60000,
        sessionHash = session(r),
        site = origin(r)
      const message = [
        'Purpose: AntyTILT Hyperliquid master ownership',
        'This signature links read-only identity; it does not grant trading permissions.',
        `Origin: ${site}`,
        `Session: ${sessionHash}`,
        `User: ${user}`,
        `Account: ${account}`,
        'Network: testnet',
        `Nonce: ${randomBytes(24).toString('hex')}`,
        `Expires: ${expiresAt}`
      ].join('\n')
      await queryDatabase(
        'INSERT INTO hl_challenges(id,user_id,account,network,session_hash,origin,message,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [id, user, account, 'testnet', sessionHash, site, message, expiresAt]
      )
      s.json({ id, message, expiresAt })
    })
  )
  router.post(
    '/link',
    handler(async (r, s, user) => {
      gate()
      const body = z
        .object({
          challengeId: z.string().uuid(),
          signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/)
        })
        .parse(r.body)
      await withDatabaseTransaction(async (tx) => {
        const c = (
          await queryDatabase<{
            account: string
            message: string
            session_hash: string
            origin: string
            expires_at: number
            consumed_at: number | null
          }>(
            'SELECT * FROM hl_challenges WHERE id=$1 AND user_id=$2 FOR UPDATE',
            [body.challengeId, user],
            tx
          )
        ).rows[0]
        if (!c) throw new HttpError(404, 'Challenge not found')
        if (c.consumed_at) throw new HttpError(409, 'Challenge already consumed')
        if (c.expires_at <= Date.now()) throw new HttpError(409, 'Challenge expired')
        if (c.session_hash !== session(r) || c.origin !== origin(r))
          throw new HttpError(403, 'Challenge session or origin mismatch')
        let recovered: string
        try {
          recovered = await recoverMessageAddress({
            message: c.message,
            signature: body.signature as `0x${string}`
          })
        } catch {
          throw new HttpError(403, 'Invalid ownership signature')
        }
        if (canonicalAccount(recovered) !== c.account)
          throw new HttpError(403, 'Signature does not match master account')
        await store.linkConnection(user, c.account, tx)
        await queryDatabase(
          'UPDATE hl_challenges SET consumed_at=$2 WHERE id=$1',
          [body.challengeId, Date.now()],
          tx
        )
      })
      s.json(await store.status(user))
    })
  )
  router.post(
    '/agent',
    handler(async (r, s, user) => {
      gate()
      const c = await scoped(user, r.body?.connectionId),
        row = await store.getRow(c.id)
      if (!row) throw new HttpError(404, 'Connection not found')
      // Dedicated fresh address only. Never reuse an expired/revoked signer or replace a named/unnamed slot.
      if (c.agentAddress)
        throw new HttpError(409, 'Agent already prepared; do not replace or reuse its grant')
      const window = tradingDay(Date.now(), c.policy.timezone),
        snap = await provider.read(c.account, window.start, Date.now()),
        grantExpiresAt = Math.min(c.policy.consentExpiresAt, Date.now() + 3600000),
        agentName = `AT-${c.id.slice(0, 8)} valid_until ${grantExpiresAt}`
      if (
        snap.grants.some((g) => agentNameBase(g.name) === agentNameBase(agentName)) ||
        snap.grants.filter((g) => g.name).length >= 3
      )
        throw new HttpError(
          409,
          'Dedicated named-agent slot conflict or capacity; owner decision required'
        )
      const secret = generatePrivateKey(),
        agentAddress = privateKeyToAccount(secret).address.toLowerCase(),
        cipher = store.encryptAgent(secret, c.id, deps?.encryptionKey)
      await withDatabaseTransaction(async (tx) => {
        const locked = await store.getRow(c.id, tx, true)
        if (!locked || locked.data.agentAddress)
          throw new HttpError(409, 'Agent was already prepared')
        await queryDatabase(
          'UPDATE hl_connections SET signer_ciphertext=$2 WHERE id=$1',
          [c.id, cipher],
          tx
        )
        await store.updateConnection(
          {
            ...locked.data,
            agentAddress,
            agentName,
            grantExpiresAt,
            status: 'AWAITING_GRANT',
            reason:
              'Owner must approve this dedicated agent in native Hyperliquid UI; no grant was submitted'
          },
          tx
        )
      })
      s.json({ agentAddress, agentName, grantExpiresAt })
    })
  )
  router.put(
    '/policy',
    handler(async (r, s, user) => {
      const body = z
        .object({
          connectionId: z.string().uuid(),
          dailyEntryLimit: z.number().int().min(1).max(100),
          timezone: z.string(),
          slippageBps: z.number().int().min(1).max(100),
          maxCloseNotionalUsd: z.string().regex(/^\d+(\.\d+)?$/),
          consentExpiresAt: z.number().int().positive()
        })
        .parse(r.body) as HlPolicyInput
      try {
        tradingDay(Date.now(), body.timezone)
      } catch {
        throw new HttpError(400, 'Invalid IANA timezone')
      }
      if (
        new Decimal(body.maxCloseNotionalUsd).lte(0) ||
        new Decimal(body.maxCloseNotionalUsd).gt(10000) ||
        body.consentExpiresAt <= Date.now() ||
        body.consentExpiresAt > Date.now() + 24 * 3600000
      )
        throw new HttpError(400, 'Invalid close ceiling or consent deadline (maximum 24 hours)')
      const c = await scoped(user, body.connectionId),
        beforeVersion = c.policy.version,
        prospective = { ...c, policy: { ...c.policy, ...body, version: beforeVersion + 1 } },
        result = await fresh(prospective)
      requireSnapshot(result.snap, result.snap.historyComplete && result.ledger.historyComplete)
      if (!new Decimal(result.snap.position).isZero())
        throw new HttpError(409, 'Policy changes require flat BTC')
      await withDatabaseTransaction(async (tx) => {
        const locked = await store.getRow(c.id, tx, true)
        if (
          !locked ||
          locked.data.policy.version !== beforeVersion ||
          locked.claim_until > Date.now() ||
          (await store.unresolved(c.id, tx)).length
        )
          throw new HttpError(
            409,
            'Worker claim, changed policy or unresolved action prevents policy update'
          )
        const { connectionId, ...policy } = body
        void connectionId
        await queryDatabase(
          'UPDATE hl_connections SET consent_version=NULL WHERE id=$1',
          [c.id],
          tx
        )
        await store.updateConnection(
          {
            ...locked.data,
            policy: { ...policy, version: beforeVersion + 1 },
            enabled: false,
            status: 'LINKED_READ_ONLY',
            reason: `Policy v${beforeVersion + 1} preview: ${result.ledger.entryCount} current-day entries; consent must be renewed`,
            day: result.window.day,
            entryCount: result.ledger.entryCount,
            remainingSize: '0',
            historyComplete: true,
            mode: result.snap.mode,
            lastCheckedAt: result.snap.checkedAt
          },
          tx
        )
      })
      s.json(await store.status(user))
    })
  )
  router.post(
    '/arm',
    handler(async (r, s, user) => {
      gate()
      const body = z
          .object({
            connectionId: z.string().uuid(),
            policyVersion: z.number().int(),
            consent: z.literal(HL_CONSENT)
          })
          .parse(r.body),
        c = await scoped(user, body.connectionId)
      if (c.policy.version !== body.policyVersion)
        throw new HttpError(409, 'Policy version changed')
      await health()
      const result = await fresh(c)
      requireSnapshot(result.snap, result.snap.historyComplete && result.ledger.historyComplete)
      if (!new Decimal(result.snap.position).isZero())
        throw new HttpError(409, 'Primary arm requires flat BTC')
      const grant = result.snap.grants.find(
        (g) =>
          g.address.toLowerCase() === c.agentAddress &&
          agentNameBase(g.name) === agentNameBase(c.agentName ?? '')
      )
      if (
        !grant ||
        !grant.validUntil ||
        grant.validUntil <= Date.now() ||
        !c.grantExpiresAt ||
        grant.validUntil > c.grantExpiresAt
      )
        throw new HttpError(409, 'Dedicated agent grant missing, expired, or unverifiable')
      if (c.policy.consentExpiresAt <= Date.now()) throw new HttpError(409, 'Consent expired')
      if (!c.workerLastSeenAt || Date.now() - c.workerLastSeenAt > 15000)
        throw new HttpError(409, 'Worker heartbeat is stale or missing')
      await withDatabaseTransaction(async (tx) => {
        const locked = await store.getRow(c.id, tx, true)
        if (
          !locked ||
          locked.data.policy.version !== body.policyVersion ||
          locked.claim_until > Date.now() ||
          (await store.unresolved(c.id, tx)).length
        )
          throw new HttpError(409, 'Claim, policy change or unresolved action prevents arming')
        await queryDatabase(
          'UPDATE hl_connections SET consent_version=$2 WHERE id=$1',
          [c.id, body.policyVersion],
          tx
        )
        await store.updateConnection(
          {
            ...locked.data,
            enabled: true,
            status: 'ARMED',
            reason: 'Ready for bounded BTC post-fill protection; pending orders are not canceled',
            historyComplete: true,
            day: result.window.day,
            entryCount: result.ledger.entryCount,
            remainingSize: '0',
            mode: result.snap.mode,
            grantExpiresAt: grant.validUntil,
            lastCheckedAt: result.snap.checkedAt
          },
          tx
        )
      })
      s.json(await store.status(user))
    })
  )
  router.post(
    '/disable',
    handler(async (r, s, user) => {
      const c = await scoped(user, r.body?.connectionId)
      await withDatabaseTransaction(async (tx) => {
        const row = await store.getRow(c.id, tx, true)
        if (row) {
          await queryDatabase(
            'UPDATE hl_connections SET consent_version=NULL WHERE id=$1',
            [c.id],
            tx
          )
          await store.updateConnection(
            {
              ...row.data,
              enabled: false,
              status: 'DISABLED',
              reason:
                'New sends disabled; previously submitted actions remain subject to reconciliation'
            },
            tx
          )
          await store.audit(
            c.id,
            `disable:${Date.now()}`,
            'INFO',
            'Explicit disable does not cancel previously submitted actions',
            {},
            tx
          )
        }
      })
      s.json(await store.status(user))
    })
  )
  return router
}
