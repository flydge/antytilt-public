import './environment'
import express, { type NextFunction, type Request, type Response } from 'express'
import helmet from 'helmet'
import { createSessionCookie } from './authCookie'
import path from 'node:path'
import { ZodError, z } from 'zod'
import {
  amendOpenOrder,
  cancelOpenOrder,
  closePosition,
  executePreparedOrder,
  getAccountSnapshot,
  getOrderHistory,
  getTradeFillHistory,
  getTradingSettings,
  listTradableContracts,
  placeMarketOrder,
  prepareAdvancedOrder,
  updateLeverage,
  updateMarginType,
  updatePositionProtection,
  type AdvancedOrderInput,
  type BingxEnvironment,
} from './bingxClient'
import {
  connectSession,
  consumePreparedOrder,
  consumeWriteCapacity,
  disconnectSession,
  getSession,
  storePreparedOrder,
  type ExchangeSession,
} from './sessionStore'
import {
  authenticateUser,
  createAuthSession,
  createUser,
  deleteAuthSession,
  deleteExchangeConnection,
  getAuthenticatedUser,
  listOrderHistory,
  listExchangeAccounts,
  listRiskEvents,
  listTradeHistory,
  loadExchangeConnection,
  loadRiskProfile,
  recordAuditEvent,
  saveRiskProfile,
  saveExchangeConnection,
  selectExchangeAccount,
  type StoredRiskProfile,
  upsertOrderHistory,
  upsertTradeHistory,
  type AuthUser,
} from './database'
import {
  RiskGuardError,
  assertLeverageAllowed,
  checkRisk,
  confirmTerminalOrder,
  getRiskStatus,
  preparedOrderCandidate,
  releaseTerminalReservation,
  releaseTerminalReservationForOrder,
  reserveTerminalEntry,
  riskAccountMutex,
  shouldReleaseReservationAfter,
} from './riskService'
import type { PreparedOrderCandidate } from './riskGuard'
import { databaseHealth } from './postgres'
import { executeDurableTradingMutation } from './mutationService'
import { getLatestWorkerHeartbeat, redisHealth, withAccountLock } from './redis'
import { createProtectionRouter } from './hyperliquid/protection'
import { createTerminalRouter } from './hyperliquid/terminalRouter'
import { HL_TERMINAL_API } from '../shared/hyperliquidTerminal'
import { walletUiRouter } from './jupiterWalletUi/routes.js'
import { hash } from './jupiterCloseTicket/builder.js'

const app = express()
const liveTradingEnabled = process.env.ALLOW_LIVE_TRADING === 'true'
const liveTriggerOrdersEnabled = process.env.ALLOW_LIVE_TRIGGER_ORDERS === 'true'
const liveRiskAutomationEnabled = liveTradingEnabled && (
  process.env.ALLOW_LIVE_RM_AUTOMATION === 'true'
  || process.env.ALLOW_LIVE_RM_AUTOCLOSE === 'true'
)
const sessionMaxAge = 30 * 24 * 60 * 60 * 1_000
const { read: readSessionCookie, set: setSessionCookie, clear: clearSessionCookie } = createSessionCookie(
  process.env.AUTH_COOKIE_NAME, { secure: process.env.NODE_ENV === 'production', maxAge: sessionMaxAge },
)
const allowedOrigins = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  ...String(process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
])

const connectSchema = z.object({
  apiKey: z.string().trim().min(8).max(256),
  secretKey: z.string().trim().min(8).max(256),
  environment: z.enum(['prod-vst', 'prod-live']),
  label: z.string().trim().min(1).max(80).optional(),
}).strict()

const emailSchema = z.string().trim().toLowerCase().email().max(254)
const passwordSchema = z.string().min(10).max(128)
const registerSchema = z.object({ email: emailSchema, password: passwordSchema }).strict()
const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(128) }).strict()

const orderSchema = z.object({
  symbol: z.string().regex(/^[A-Z0-9]{2,20}-USDT$/),
  direction: z.enum(['LONG', 'SHORT']),
  quoteOrderQty: z.number().finite().positive().max(1_000_000),
  leverage: z.number().int().min(1).max(125),
  marginType: z.enum(['CROSSED', 'ISOLATED']),
  clientRequestId: z.string().uuid(),
  confirmation: z.string().max(32).optional(),
}).strict()

const closeSchema = z.object({
  quantity: z.number().finite().positive().optional(),
  clientRequestId: z.string().uuid(),
  confirmation: z.string().max(32).optional(),
}).strict()

const symbolSchema = z.string().regex(/^[A-Z0-9]{2,20}-USDT$/)
const confirmationFields = {
  clientRequestId: z.string().uuid(),
  confirmation: z.string().max(32).optional(),
}
const protectionSchema = z.object({
  stopPrice: z.number().finite().positive(),
  execution: z.enum(['MARKET', 'LIMIT']),
  price: z.number().finite().positive().optional(),
  workingType: z.enum(['MARK_PRICE', 'CONTRACT_PRICE']),
}).strict().superRefine((value, context) => {
  if (value.execution === 'LIMIT' && value.price === undefined) {
    context.addIssue({ code: 'custom', path: ['price'], message: 'Limit execution requires a limit price' })
  }
})
const advancedOrderSchema = z.object({
  symbol: symbolSchema,
  direction: z.enum(['LONG', 'SHORT']),
  orderKind: z.enum(['MARKET', 'LIMIT', 'TRIGGER']),
  amountMode: z.enum(['QUANTITY', 'VALUE', 'COST']),
  amount: z.number().finite().positive().max(1_000_000),
  leverage: z.number().int().min(1).max(250),
  marginType: z.enum(['CROSSED', 'ISOLATED']),
  price: z.number().finite().positive().optional(),
  timeInForce: z.enum(['GTC', 'IOC', 'FOK', 'PostOnly']).optional(),
  triggerPrice: z.number().finite().positive().optional(),
  triggerExecution: z.enum(['MARKET', 'LIMIT']).optional(),
  workingType: z.enum(['MARK_PRICE', 'CONTRACT_PRICE', 'INDEX_PRICE']).optional(),
  reduceOnly: z.boolean().optional(),
  maxSlippagePercent: z.number().finite().min(0.01).max(20).optional(),
  takeProfit: protectionSchema.optional(),
  stopLoss: protectionSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.orderKind === 'LIMIT' && value.price === undefined) {
    context.addIssue({ code: 'custom', path: ['price'], message: 'Limit orders require an order price' })
  }
  if (value.orderKind === 'TRIGGER') {
    if (value.triggerPrice === undefined) context.addIssue({ code: 'custom', path: ['triggerPrice'], message: 'Trigger orders require a trigger price' })
    if (value.triggerExecution === undefined) context.addIssue({ code: 'custom', path: ['triggerExecution'], message: 'Choose Market or Limit trigger execution' })
    if (value.triggerExecution === 'LIMIT' && value.price === undefined) {
      context.addIssue({ code: 'custom', path: ['price'], message: 'Limit trigger execution requires a limit price' })
    }
  }
})
const executeOrderSchema = z.object({
  previewId: z.string().min(20).max(128),
  ...confirmationFields,
}).strict()
const marginTypeSchema = z.object({
  marginType: z.enum(['CROSSED', 'ISOLATED']),
  ...confirmationFields,
}).strict()
const leverageSchema = z.object({
  direction: z.enum(['LONG', 'SHORT']),
  leverage: z.number().int().min(1).max(250),
  ...confirmationFields,
}).strict()
const cancelOrderSchema = z.object({
  symbol: symbolSchema,
  clientOrderId: z.string().max(64).optional(),
  ...confirmationFields,
}).strict()
const amendOrderSchema = z.object({
  symbol: symbolSchema,
  clientOrderId: z.string().max(64).optional(),
  quantity: z.number().finite().positive().max(1_000_000_000),
  ...confirmationFields,
}).strict()
const positionProtectionSchema = z.object({
  orderId: z.string().regex(/^\d{1,64}$/).optional(),
  kind: z.enum(['TAKE_PROFIT', 'STOP_LOSS']),
  stopPrice: z.number().finite().positive(),
  workingType: z.enum(['MARK_PRICE', 'CONTRACT_PRICE']),
  ...confirmationFields,
}).strict()

const riskValueRuleSchema = (minimum: number, maximum: number) => z.object({
  enabled: z.boolean(),
  value: z.number().finite().min(minimum).max(maximum),
}).strict()
const timezoneSchema = z.string().trim().min(1).max(100).refine((value) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0)
    return true
  } catch {
    return false
  }
}, 'Choose a valid IANA timezone')
const riskProfileSchema = z.object({
  active: z.boolean(),
  timezone: timezoneSchema.default('UTC'),
  externalViolationPolicy: z.enum(['BLOCK_NEW_ENTRIES', 'BLOCK_AND_CLOSE_EXTERNAL']).default('BLOCK_NEW_ENTRIES'),
  breachAction: z.enum(['BLOCK_NEW_ENTRIES', 'CANCEL_PENDING_ORDERS', 'CLOSE_VIOLATING_POSITION', 'CLOSE_ALL']).default('BLOCK_NEW_ENTRIES'),
  closeExternalEntriesOnBreach: z.boolean().default(false),
  automationConsent: z.boolean().default(false),
  fixedStopLoss: z.object({
    enabled: z.boolean(),
    value: z.number().finite().min(0.1).max(25),
    workingType: z.enum(['MARK_PRICE', 'CONTRACT_PRICE']).default('MARK_PRICE'),
  }).strict(),
  breakEven: z.object({
    enabled: z.boolean(),
    triggerMode: z.enum(['PERCENT', 'R_MULTIPLE']),
    triggerValue: z.number().finite().min(0.1).max(50),
    offsetPercent: z.number().finite().min(0).max(5),
  }).strict(),
  riskPerTrade: riskValueRuleSchema(0.1, 10),
  dailyLossLimit: z.object({
    enabled: z.boolean(),
    value: z.number().finite().positive().max(1_000_000),
    unit: z.enum(['PERCENT', 'USDT']).default('PERCENT'),
  }).strict(),
  maxLeverage: riskValueRuleSchema(1, 250),
  maxTradesPerDay: riskValueRuleSchema(1, 100),
  maxConsecutiveLosses: riskValueRuleSchema(1, 20),
  cooldownMinutes: riskValueRuleSchema(1, 1_440),
  maxExposurePercent: riskValueRuleSchema(1, 1_000),
  maxOpenPositions: riskValueRuleSchema(1, 50),
}).strict()

const defaultRiskProfile: StoredRiskProfile = {
  active: false,
  timezone: 'UTC',
  externalViolationPolicy: 'BLOCK_NEW_ENTRIES',
  breachAction: 'BLOCK_NEW_ENTRIES',
  closeExternalEntriesOnBreach: true,
  automationConsent: false,
  fixedStopLoss: { enabled: false, value: 2, workingType: 'MARK_PRICE' },
  breakEven: { enabled: false, triggerMode: 'PERCENT', triggerValue: 2, offsetPercent: 0.05 },
  riskPerTrade: { enabled: true, value: 1 },
  dailyLossLimit: { enabled: true, value: 3, unit: 'PERCENT' },
  maxLeverage: { enabled: true, value: 10 },
  maxTradesPerDay: { enabled: true, value: 6 },
  maxConsecutiveLosses: { enabled: false, value: 3 },
  cooldownMinutes: { enabled: false, value: 30 },
  maxExposurePercent: { enabled: false, value: 100 },
  maxOpenPositions: { enabled: false, value: 3 },
}

const publicMarketSymbolSchema = z.string().regex(/^[A-Z0-9]{2,20}-USDT$/)
const publicMarketIntervalSchema = z.enum(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M'])
const bingxMarketResourceSchema = z.enum(['klines', 'ticker', 'funding', 'depth', 'trades'])

app.disable('x-powered-by')
app.set('trust proxy', 1)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      connectSrc: [
        "'self'",
        'https://api.coingecko.com',
        'https://fapi.binance.com',
        'https://api.bybit.com',
        'https://www.okx.com',
        'https://api.hyperliquid-testnet.xyz',
        'https://api.hyperliquid.xyz',
        'wss://fstream.binance.com',
        'wss://stream.bybit.com',
        'wss://open-api-swap.bingx.com',
        'wss://ws.okx.com:8443',
        'wss://api.hyperliquid-testnet.xyz/ws',
        'wss://api.hyperliquid.xyz/ws',
      ],
      imgSrc: ["'self'", 'data:', 'https:'],
    },
  },
}))
app.use(express.json({ limit: '20kb' }))

const authAttempts = new Map<string, number[]>()

function consumeAuthCapacity(request: Request) {
  const key = request.ip || request.socket.remoteAddress || 'unknown'
  const cutoff = Date.now() - 15 * 60_000
  const recent = (authAttempts.get(key) ?? []).filter((timestamp) => timestamp > cutoff)
  if (recent.length >= 20) throw Object.assign(new Error('Too many authentication attempts. Try again later.'), { status: 429 })
  recent.push(Date.now())
  authAttempts.set(key, recent)
}

app.use((request, response, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return next()
  const origin = request.get('origin')
  const sameOrigin = (() => {
    if (!origin) return true
    try {
      return new URL(origin).host === request.get('host')
    } catch {
      return false
    }
  })()
  if (origin && !sameOrigin && !allowedOrigins.has(origin)) {
    response.status(403).json({ error: 'This request origin is not allowed' })
    return
  }
  next()
})

async function requireUser(request: Request): Promise<AuthUser> {
  const user = await getAuthenticatedUser(readSessionCookie(request))
  if (!user) throw Object.assign(new Error('Sign in to continue'), { status: 401 })
  return user
}

app.use('/api/hyperliquid-protection', createProtectionRouter({ requireUser }))
app.use(HL_TERMINAL_API, createTerminalRouter({ requireUser, allowedOrigins }))
app.use('/api/jupiter', walletUiRouter(async (request, origin) => {
  const user = await requireUser(request)
  const suppliedOrigin = request.get('origin')
  const referer = request.get('referer')
  if (suppliedOrigin ? suppliedOrigin !== origin : !referer || new URL(referer).origin !== origin)
    throw Object.assign(new Error('Trusted application origin required'), { status: 403 })
  return { userId: user.id, sessionId: hash(readSessionCookie(request)!), origin }
}))

function publicSession(session: ExchangeSession) {
  return {
    connected: true as const,
    accountId: session.accountId,
    exchange: session.exchange,
    environment: session.environment,
    label: session.label,
    apiKeyMask: session.apiKeyMask,
    connectedAt: session.connectedAt,
    liveTradingEnabled,
    liveTriggerOrdersEnabled,
  }
}

async function requireSession(request: Request) {
  const user = await requireUser(request)
  let session = getSession(user.id)
  if (!session) {
    const persisted = await loadExchangeConnection(user.id)
    if (persisted) {
      session = connectSession(user.id, persisted.environment, persisted.credentials, {
        accountId: persisted.accountId,
        label: persisted.account.label,
        apiKeyMask: persisted.apiKeyMask,
        connectedAt: persisted.connectedAt,
      })
    }
  }
  if (!session) {
    const error = new Error('Connect your BingX account first') as Error & { status?: number }
    error.status = 401
    throw error
  }
  return session
}

function assertWriteAllowed(session: ExchangeSession, confirmation?: string) {
  if (session.environment !== 'prod-live') return
  if (!liveTradingEnabled) {
    const error = new Error('Live trading is disabled on this server') as Error & { status?: number }
    error.status = 403
    throw error
  }
  if (confirmation !== 'CONFIRM') {
    const error = new Error('Confirm this live trading action in the terminal') as Error & { status?: number }
    error.status = 409
    throw error
  }
}

function durableRequestPayload(input: Record<string, unknown>) {
  const { confirmation: _confirmation, ...payload } = input
  return payload
}

async function executeSessionMutation<T>(input: {
  session: ExchangeSession
  operation: string
  requestId: string
  requestPayload: unknown
  execute: () => Promise<T>
  exchangeOrderId?: (result: T) => string | undefined
}) {
  const memoryKey = `${input.operation}:${input.requestId}`
  const previous = input.session.idempotency.get(memoryKey) as Promise<{ result: T; replayed: boolean }>
    | { result: T; replayed: boolean }
    | undefined
  if (previous) {
    const cached = await Promise.resolve(previous)
    return { result: cached.result, replayed: true }
  }

  const execution = (async () => {
    const locked = await withAccountLock(input.session.accountId, () => executeDurableTradingMutation({
      userId: input.session.id,
      exchangeAccountId: input.session.accountId,
      operation: input.operation,
      requestId: input.requestId,
      requestPayload: input.requestPayload,
      exchangeOrderId: input.exchangeOrderId,
      execute: input.execute,
    }))
    if (!locked.acquired) {
      throw Object.assign(new Error('This exchange account is busy with another trading or RM action. Try again shortly.'), {
        status: 409,
        code: 'EXCHANGE_ACCOUNT_LOCKED',
      })
    }
    return locked.value as { result: T; replayed: boolean }
  })()
  input.session.idempotency.set(memoryKey, execution)
  try {
    const outcome = await execution
    input.session.idempotency.set(memoryKey, outcome)
    return outcome
  } catch (error) {
    input.session.idempotency.delete(memoryKey)
    throw error
  }
}

async function accountPayload(session: ExchangeSession) {
  const snapshot = await getAccountSnapshot(session.environment, session.credentials)
  return { ...publicSession(session), snapshot }
}

const fullHistorySynced = new Set<string>()

async function syncHistory(userId: string, session: ExchangeSession) {
  const syncKey = `${userId}:${session.accountId}`
  const tradeHistoryRequest = async () => {
    const end = Date.now()
    const windows = fullHistorySynced.has(syncKey) ? 1 : 5
    const rows: Array<Record<string, unknown>> = []
    for (let index = 0; index < windows; index += 1) {
      const endTime = end - index * 7 * 24 * 60 * 60 * 1_000
      rows.push(...await getTradeFillHistory(session.environment, session.credentials, {
        startTime: endTime - 7 * 24 * 60 * 60 * 1_000,
        endTime,
      }))
    }
    fullHistorySynced.add(syncKey)
    return rows
  }
  const [ordersResult, tradesResult] = await Promise.allSettled([
    getOrderHistory(session.environment, session.credentials, 500),
    tradeHistoryRequest(),
  ])
  if (ordersResult.status === 'fulfilled') await upsertOrderHistory(userId, session.environment, ordersResult.value, session.accountId)
  if (tradesResult.status === 'fulfilled') await upsertTradeHistory(userId, session.environment, tradesResult.value, session.accountId)
  return {
    orderHistory: await listOrderHistory(userId, session.environment, 500, session.accountId),
    tradeHistory: await listTradeHistory(userId, session.environment, 500, session.accountId),
    synchronizedAt: Date.now(),
    warnings: [
      ...(ordersResult.status === 'rejected' ? ['BingX order history could not be refreshed'] : []),
      ...(tradesResult.status === 'rejected' ? ['BingX trade history could not be refreshed'] : []),
    ],
  }
}

app.post('/api/auth/register', async (request, response) => {
  consumeAuthCapacity(request)
  const input = registerSchema.parse(request.body)
  const user = await createUser(input.email, input.password)
  const session = await createAuthSession(user.id)
  setSessionCookie(response, session.token)
  await recordAuditEvent(user.id, 'auth.register', 'user', user.id)
  response.status(201).json({ authenticated: true, user })
})

app.post('/api/auth/login', async (request, response) => {
  consumeAuthCapacity(request)
  const input = loginSchema.parse(request.body)
  const user = await authenticateUser(input.email, input.password)
  const session = await createAuthSession(user.id)
  setSessionCookie(response, session.token)
  await recordAuditEvent(user.id, 'auth.login', 'session')
  response.json({ authenticated: true, user })
})

app.get('/api/auth/session', async (request, response) => {
  const user = await getAuthenticatedUser(readSessionCookie(request))
  response.json(user ? { authenticated: true, user } : { authenticated: false })
})

app.delete('/api/auth/logout', async (request, response) => {
  const token = readSessionCookie(request)
  const user = await getAuthenticatedUser(token)
  if (user) {
    disconnectSession(user.id)
    await recordAuditEvent(user.id, 'auth.logout', 'session')
  }
  await deleteAuthSession(token)
  clearSessionCookie(response)
  response.status(204).end()
})

app.get('/api/health', async (_request, response) => {
  const [database, redis, worker] = await Promise.all([
    databaseHealth(), redisHealth(), getLatestWorkerHeartbeat(),
  ])
  const checkedAt = typeof worker?.checkedAt === 'number' ? worker.checkedAt : 0
  const workerHealthy = worker?.status === 'RUNNING'
    && Date.now() - checkedAt <= Number(process.env.WORKER_STALE_AFTER_MS || 30_000)
  response.json({
    ok: true,
    database,
    redis,
    worker,
    workerHealthy,
    liveTradingEnabled,
    liveTriggerOrdersEnabled,
    liveRiskAutomationEnabled,
  })
})

app.get('/api/health/live', (_request, response) => {
  response.json({ ok: true, process: 'api', uptimeSeconds: Math.floor(process.uptime()) })
})

app.get('/api/health/ready', async (_request, response) => {
  try {
    const [database, redis] = await Promise.all([databaseHealth(), redisHealth()])
    const ready = database.ok && redis.ok && redis.enabled
    response.status(ready ? 200 : 503).json({ ok: ready, database, redis })
  } catch (error) {
    response.status(503).json({ ok: false, error: error instanceof Error ? error.message : 'Readiness check failed' })
  }
})

app.get('/api/health/worker', async (_request, response) => {
  try {
    const worker = await getLatestWorkerHeartbeat()
    const checkedAt = typeof worker?.checkedAt === 'number' ? worker.checkedAt : 0
    const staleAfterMs = Number(process.env.WORKER_STALE_AFTER_MS || 30_000)
    const healthy = worker?.status === 'RUNNING' && Date.now() - checkedAt <= staleAfterMs
    response.status(healthy ? 200 : 503).json({ ok: healthy, staleAfterMs, worker })
  } catch (error) {
    response.status(503).json({ ok: false, error: error instanceof Error ? error.message : 'Worker health check failed' })
  }
})

app.get('/api/risk/profile', async (request, response) => {
  const user = await requireUser(request)
  const accountId = getSession(user.id)?.accountId ?? (await loadExchangeConnection(user.id))?.accountId
  response.json(await loadRiskProfile(user.id, accountId) ?? { ...defaultRiskProfile, updatedAt: 0 })
})

app.put('/api/risk/profile', async (request, response) => {
  const user = await requireUser(request)
  const raw = request.body && typeof request.body === 'object'
    ? request.body as Record<string, unknown>
    : {}
  const compatibleInput = raw.breachAction === undefined && raw.externalViolationPolicy === 'BLOCK_AND_CLOSE_EXTERNAL'
    ? { ...raw, breachAction: 'CLOSE_VIOLATING_POSITION' }
    : raw
  const input = riskProfileSchema.parse(compatibleInput) as StoredRiskProfile
  const accountId = getSession(user.id)?.accountId ?? (await loadExchangeConnection(user.id))?.accountId
  const profile = await saveRiskProfile(user.id, input, accountId)
  await recordAuditEvent(user.id, 'risk.profile.update', 'risk_profile', accountId, {
    exchangeAccountId: accountId,
    active: profile.active,
    enabledRules: Object.entries(profile).filter(([, value]) => (
      value && typeof value === 'object' && 'enabled' in value && value.enabled
    )).map(([key]) => key),
  }, accountId)
  response.json(profile)
})

app.get('/api/risk/status', async (request, response) => {
  const user = await requireUser(request)
  const connection = getSession(user.id) ?? await loadExchangeConnection(user.id)
  response.json(await getRiskStatus(user.id, connection?.environment, liveRiskAutomationEnabled, connection?.accountId))
})

app.get('/api/risk/events', async (request, response) => {
  const user = await requireUser(request)
  const connection = getSession(user.id) ?? await loadExchangeConnection(user.id)
  if (!connection) {
    response.json({ events: [] })
    return
  }
  const events = (await listRiskEvents(user.id, connection.environment, { limit: 50, exchangeAccountId: connection.accountId })).map((event) => ({
    id: event.id,
    type: event.action,
    message: typeof event.metadata.message === 'string'
      ? event.metadata.message
      : `${event.action.replaceAll('_', ' ').toLowerCase()}: ${event.result.toLowerCase()}`,
    createdAt: event.createdAt,
    rule: event.rule,
    action: event.action,
    outcome: event.result,
    severity: event.result === 'FAILED' || event.result === 'BLOCKED' ? 'WARNING' : 'INFO',
    source: event.source,
    symbol: typeof event.metadata.symbol === 'string' ? event.metadata.symbol : undefined,
  }))
  response.json({ events })
})

app.get('/api/market/bingx/:resource', async (request, response) => {
  const resource = bingxMarketResourceSchema.parse(request.params.resource)
  const symbol = publicMarketSymbolSchema.parse(request.query.symbol)
  const limit = z.coerce.number().int().min(1).max(500).default(resource === 'depth' ? 20 : 24).parse(request.query.limit)
  const interval = resource === 'klines' ? publicMarketIntervalSchema.parse(request.query.interval) : undefined
  const paths = {
    klines: `/openApi/swap/v3/quote/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
    ticker: `/openApi/swap/v2/quote/ticker?symbol=${symbol}`,
    funding: `/openApi/swap/v2/quote/premiumIndex?symbol=${symbol}`,
    depth: `/openApi/swap/v2/quote/depth?symbol=${symbol}&limit=${Math.min(limit, 100)}`,
    trades: `/openApi/swap/v2/quote/trades?symbol=${symbol}&limit=${Math.min(limit, 100)}`,
  }
  const upstream = await fetch(`https://open-api.bingx.com${paths[resource]}`, {
    headers: { 'X-SOURCE-KEY': 'BX-AI-SKILL' },
    signal: AbortSignal.timeout(8_000),
  })
  if (!upstream.ok) throw Object.assign(new Error(`BingX public market data failed (${upstream.status})`), { status: 502 })
  response.set('Cache-Control', resource === 'klines' ? 'public, max-age=2' : 'no-store')
  response.type('application/json').send(await upstream.text())
})

app.get('/api/exchange/session', async (request, response) => {
  const user = await requireUser(request)
  let session = getSession(user.id)
  if (!session) {
    const persisted = await loadExchangeConnection(user.id)
    if (persisted) session = connectSession(user.id, persisted.environment, persisted.credentials, {
      accountId: persisted.accountId,
      label: persisted.account.label,
      apiKeyMask: persisted.apiKeyMask,
      connectedAt: persisted.connectedAt,
    })
  }
  if (!session) {
    response.json({ connected: false, liveTradingEnabled, liveTriggerOrdersEnabled })
    return
  }
  response.json(await accountPayload(session))
})

app.post('/api/exchange/bingx/connect', async (request, response) => {
  const user = await requireUser(request)
  const input = connectSchema.parse(request.body)
  const environment = input.environment as BingxEnvironment
  const credentials = { apiKey: input.apiKey, secretKey: input.secretKey }

  // Authentication is verified before credentials are admitted to the session store.
  const snapshot = await getAccountSnapshot(environment, credentials)
  disconnectSession(user.id)
  const connectionChange = await riskAccountMutex.runExclusive(`${user.id}:exchange-accounts`, async () => (
    await saveExchangeConnection(user.id, environment, credentials, { label: input.label })
  ))
  const session = connectSession(user.id, environment, credentials, {
    accountId: connectionChange.account.id,
    label: connectionChange.account.label,
    apiKeyMask: connectionChange.account.apiKeyMask,
    connectedAt: connectionChange.account.connectedAt,
  })
  await recordAuditEvent(user.id, 'exchange.connect', 'exchange_connection', 'bingx', {
    environment,
    apiKeyMask: session.apiKeyMask,
    accountChanged: connectionChange.accountChanged,
    stateReset: connectionChange.stateReset,
  }, session.accountId)
  void syncHistory(user.id, session).catch(() => undefined)
  response.status(201).json({ ...publicSession(session), snapshot })
})

app.delete('/api/exchange/disconnect', async (request, response) => {
  const user = await requireUser(request)
  const session = getSession(user.id)
  disconnectSession(user.id)
  const archived = await riskAccountMutex.runExclusive(`${user.id}:exchange-accounts`, async () => (
    deleteExchangeConnection(user.id, session?.accountId)
  ))
  await recordAuditEvent(user.id, 'exchange.disconnect', 'exchange_account', archived?.id ?? session?.accountId, {
    archived: Boolean(archived),
  }, archived?.id ?? session?.accountId)
  response.status(204).end()
})

app.get('/api/exchange/accounts', async (request, response) => {
  const user = await requireUser(request)
  response.json({ accounts: await listExchangeAccounts(user.id) })
})

app.post('/api/exchange/accounts/:accountId/select', async (request, response) => {
  const user = await requireUser(request)
  const accountId = z.string().uuid().parse(request.params.accountId)
  const { persisted, selected, snapshot } = await riskAccountMutex.runExclusive(`${user.id}:exchange-accounts`, async () => {
    const persisted = await loadExchangeConnection(user.id, accountId)
    if (!persisted) throw Object.assign(new Error('Exchange account is unavailable'), { status: 409 })
    const snapshot = await getAccountSnapshot(persisted.environment, persisted.credentials)
    const selected = await selectExchangeAccount(user.id, accountId)
    return { persisted, selected, snapshot }
  })
  disconnectSession(user.id)
  const session = connectSession(user.id, persisted.environment, persisted.credentials, {
    accountId: persisted.accountId,
    label: persisted.account.label,
    apiKeyMask: persisted.apiKeyMask,
    connectedAt: persisted.connectedAt,
  })
  await recordAuditEvent(user.id, 'exchange.account.select', 'exchange_account', selected.id, {
    environment: selected.environment,
  }, selected.id)
  response.json({ ...publicSession(session), snapshot })
})

app.get('/api/account/history', async (request, response) => {
  const user = await requireUser(request)
  const session = await requireSession(request)
  response.json(await syncHistory(user.id, session))
})

app.get('/api/exchange/account', async (request, response) => {
  response.json(await accountPayload(await requireSession(request)))
})

app.get('/api/exchange/contracts', async (request, response) => {
  const session = await requireSession(request)
  const contracts = await listTradableContracts(session.environment, session.credentials)
  response.json({ exchange: 'bingx', contracts, updatedAt: Date.now() })
})

app.get('/api/exchange/contracts/:symbol/settings', async (request, response) => {
  const symbol = symbolSchema.parse(request.params.symbol)
  const session = await requireSession(request)
  response.json(await getTradingSettings(session.environment, session.credentials, symbol))
})

app.post('/api/exchange/contracts/:symbol/margin', async (request, response) => {
  const symbol = symbolSchema.parse(request.params.symbol)
  const input = marginTypeSchema.parse(request.body)
  const session = await requireSession(request)
  assertWriteAllowed(session, input.confirmation)
  const { result } = await executeSessionMutation({
    session,
    operation: 'margin.update',
    requestId: input.clientRequestId,
    requestPayload: { symbol, ...durableRequestPayload(input) },
    execute: async () => {
      consumeWriteCapacity(session)
      return updateMarginType(session.environment, session.credentials, symbol, input.marginType)
    },
  })
  response.json(result)
})

app.post('/api/exchange/contracts/:symbol/leverage', async (request, response) => {
  const symbol = symbolSchema.parse(request.params.symbol)
  const input = leverageSchema.parse(request.body)
  const session = await requireSession(request)
  assertWriteAllowed(session, input.confirmation)
  await assertLeverageAllowed(session.id, input.leverage, session.accountId)
  const { result } = await executeSessionMutation({
    session,
    operation: 'leverage.update',
    requestId: input.clientRequestId,
    requestPayload: { symbol, ...durableRequestPayload(input) },
    execute: async () => {
      consumeWriteCapacity(session)
      return updateLeverage(session.environment, session.credentials, {
        symbol,
        direction: input.direction,
        leverage: input.leverage,
      })
    },
  })
  response.json(result)
})

app.post('/api/exchange/orders/preview', async (request, response) => {
  const input = advancedOrderSchema.parse(request.body) as AdvancedOrderInput
  const session = await requireSession(request)
  const prepared = await prepareAdvancedOrder(session.environment, session.credentials, input)
  const snapshot = await getAccountSnapshot(session.environment, session.credentials)
  await checkRisk(
    session.id,
    session.environment,
    snapshot,
    preparedOrderCandidate(prepared),
    'TERMINAL',
    `preview-${crypto.randomUUID()}`,
    session.accountId,
  )
  const stored = storePreparedOrder(session, prepared)
  response.json({ previewId: stored.id, preview: prepared.preview, expiresAt: stored.expiresAt })
})

app.post('/api/exchange/orders', async (request, response) => {
  const input = executeOrderSchema.parse(request.body)
  const session = await requireSession(request)
  assertWriteAllowed(session, input.confirmation)
  let submittedPrepared: Awaited<ReturnType<typeof prepareAdvancedOrder>> | undefined
  const { result, replayed } = await executeSessionMutation({
    session,
    operation: 'order.advanced.place',
    requestId: input.clientRequestId,
    requestPayload: durableRequestPayload(input),
    exchangeOrderId: ({ order }) => String((order as Record<string, unknown>).orderId ?? (order as Record<string, unknown>).orderID ?? '') || undefined,
    execute: async () => {
      const prepared = consumePreparedOrder(session, input.previewId)
      submittedPrepared = prepared
      if (session.environment === 'prod-live' && prepared.input.orderKind === 'TRIGGER' && !liveTriggerOrdersEnabled) {
        throw Object.assign(new Error('Trigger orders are locked in Live until their BingX mapping is verified on VST'), { status: 403 })
      }
      const candidate = preparedOrderCandidate(prepared)
      return riskAccountMutex.runExclusive(`${session.id}:${session.accountId}`, async () => {
      const before = await getAccountSnapshot(session.environment, session.credentials)
      const gate = await reserveTerminalEntry({
        userId: session.id,
        exchangeAccountId: session.accountId,
        environment: session.environment,
        snapshot: before,
        candidate,
        requestId: input.clientRequestId,
      })
      let submitted = false
      try {
        consumeWriteCapacity(session)
        const order = await executePreparedOrder(
          session.environment,
          session.credentials,
          prepared,
          `antytilt-${input.clientRequestId.replaceAll('-', '').slice(0, 24)}`,
        )
        submitted = true
        const snapshot = await getAccountSnapshot(session.environment, session.credentials)
        const orderId = String((order as Record<string, unknown>).orderId ?? (order as Record<string, unknown>).orderID ?? input.clientRequestId)
        await confirmTerminalOrder({ userId: session.id, exchangeAccountId: session.accountId, environment: session.environment, reservation: gate.reservation, orderId, candidate, snapshot })
        return { order, snapshot }
      } catch (error) {
        if (!submitted && shouldReleaseReservationAfter(error)) {
          await releaseTerminalReservation(session.id, session.environment, gate.reservation, session.accountId)
        }
        throw error
      }
      })
    },
  })
  if (!replayed && submittedPrepared) {
    await recordAuditEvent(session.id, 'order.place', 'order', String((result.order as Record<string, unknown>).orderId ?? (result.order as Record<string, unknown>).orderID ?? ''), {
      symbol: submittedPrepared.input.symbol,
      direction: submittedPrepared.input.direction,
      orderKind: submittedPrepared.input.orderKind,
      environment: session.environment,
    }, session.accountId)
    void syncHistory(session.id, session).catch(() => undefined)
  }
  response.status(replayed ? 200 : 201).json(result)
})

app.delete('/api/exchange/orders/:orderId', async (request, response) => {
  const orderId = z.string().regex(/^\d{1,64}$/).parse(request.params.orderId)
  const input = cancelOrderSchema.parse(request.body)
  const session = await requireSession(request)
  assertWriteAllowed(session, input.confirmation)
  const { result, replayed } = await executeSessionMutation({
    session,
    operation: 'order.cancel',
    requestId: input.clientRequestId,
    requestPayload: { orderId, ...durableRequestPayload(input) },
    exchangeOrderId: () => orderId,
    execute: async () => {
      consumeWriteCapacity(session)
      const order = await cancelOpenOrder(session.environment, session.credentials, {
        symbol: input.symbol,
        orderId,
        clientOrderId: input.clientOrderId,
      })
      return { order, snapshot: await getAccountSnapshot(session.environment, session.credentials) }
    },
  })
  if (!replayed) {
    await releaseTerminalReservationForOrder(session.id, session.environment, orderId, session.accountId)
    await recordAuditEvent(session.id, 'order.cancel', 'order', orderId, { symbol: input.symbol, environment: session.environment }, session.accountId)
    void syncHistory(session.id, session).catch(() => undefined)
  }
  response.json(result)
})

app.post('/api/exchange/orders/:orderId/amend', async (request, response) => {
  const orderId = z.string().regex(/^\d{1,64}$/).parse(request.params.orderId)
  const input = amendOrderSchema.parse(request.body)
  const session = await requireSession(request)
  assertWriteAllowed(session, input.confirmation)
  const { result, replayed } = await executeSessionMutation({
    session,
    operation: 'order.amend',
    requestId: input.clientRequestId,
    requestPayload: { orderId, ...durableRequestPayload(input) },
    exchangeOrderId: () => orderId,
    execute: async () => riskAccountMutex.runExclusive(`${session.id}:${session.accountId}`, async () => {
      const [before, settings] = await Promise.all([
        getAccountSnapshot(session.environment, session.credentials),
        getTradingSettings(session.environment, session.credentials, input.symbol),
      ])
      const existing = before.openOrders.find((item) => String(item.orderId ?? item.orderID) === orderId)
      if (existing) {
        const direction = existing.positionSide === 'LONG' || existing.positionSide === 'SHORT'
          ? existing.positionSide
          : existing.side === 'SELL' ? 'SHORT' : 'LONG'
        const existingQuantity = Number(existing.quantity ?? existing.origQty ?? 0)
        const entryPrice = Number(existing.price ?? existing.stopPrice ?? 0)
          || (direction === 'LONG' ? settings.prices.askPrice : settings.prices.bidPrice)
        const candidate: PreparedOrderCandidate = {
          symbol: input.symbol,
          direction,
          leverage: direction === 'LONG' ? settings.longLeverage : settings.shortLeverage,
          quantity: input.quantity,
          entryPrice,
          notional: input.quantity * entryPrice,
          reduceOnly: Boolean(existing.reduceOnly || existing.closePosition || (existingQuantity > 0 && input.quantity <= existingQuantity)),
        }
        await checkRisk(session.id, session.environment, before, candidate, 'TERMINAL', input.clientRequestId, session.accountId)
      }
      consumeWriteCapacity(session)
      const order = await amendOpenOrder(session.environment, session.credentials, {
        symbol: input.symbol,
        orderId,
        clientOrderId: input.clientOrderId,
        quantity: input.quantity,
      })
      return { order, snapshot: await getAccountSnapshot(session.environment, session.credentials) }
    }),
  })
  if (!replayed) {
    await recordAuditEvent(session.id, 'order.amend', 'order', orderId, { symbol: input.symbol, quantity: input.quantity, environment: session.environment }, session.accountId)
  }
  response.json(result)
})

app.post('/api/exchange/orders/market', async (request, response) => {
  const input = orderSchema.parse(request.body)
  const session = await requireSession(request)
  assertWriteAllowed(session, input.confirmation)
  const { result, replayed } = await executeSessionMutation({
    session,
    operation: 'order.market.place',
    requestId: input.clientRequestId,
    requestPayload: durableRequestPayload(input),
    exchangeOrderId: ({ order }) => String((order as Record<string, unknown>).orderId ?? (order as Record<string, unknown>).orderID ?? '') || undefined,
    execute: async () => riskAccountMutex.runExclusive(`${session.id}:${session.accountId}`, async () => {
      const [before, settings] = await Promise.all([
        getAccountSnapshot(session.environment, session.credentials),
        getTradingSettings(session.environment, session.credentials, input.symbol),
      ])
      const entryPrice = input.direction === 'LONG' ? settings.prices.askPrice : settings.prices.bidPrice
      const candidate: PreparedOrderCandidate = {
        symbol: input.symbol,
        direction: input.direction,
        leverage: input.leverage,
        quantity: entryPrice > 0 ? input.quoteOrderQty / entryPrice : 0,
        entryPrice,
        notional: input.quoteOrderQty,
      }
      const gate = await reserveTerminalEntry({
        userId: session.id,
        exchangeAccountId: session.accountId,
        environment: session.environment,
        snapshot: before,
        candidate,
        requestId: input.clientRequestId,
      })
      let submitted = false
      try {
        consumeWriteCapacity(session)
        const order = await placeMarketOrder(session.environment, session.credentials, {
          symbol: input.symbol,
          direction: input.direction,
          quoteOrderQty: input.quoteOrderQty,
          leverage: input.leverage,
          marginType: input.marginType,
          clientOrderId: `antytilt-${input.clientRequestId.replaceAll('-', '').slice(0, 24)}`,
        })
        submitted = true
        const snapshot = await getAccountSnapshot(session.environment, session.credentials)
        const orderId = String((order as Record<string, unknown>).orderId ?? (order as Record<string, unknown>).orderID ?? input.clientRequestId)
        await confirmTerminalOrder({ userId: session.id, exchangeAccountId: session.accountId, environment: session.environment, reservation: gate.reservation, orderId, candidate, snapshot })
        return { order, snapshot }
      } catch (error) {
        if (!submitted && shouldReleaseReservationAfter(error)) {
          await releaseTerminalReservation(session.id, session.environment, gate.reservation, session.accountId)
        }
        throw error
      }
    }),
  })
  if (!replayed) {
    await recordAuditEvent(session.id, 'order.place', 'order', String((result.order as Record<string, unknown>).orderId ?? (result.order as Record<string, unknown>).orderID ?? ''), {
      symbol: input.symbol, direction: input.direction, orderKind: 'MARKET', environment: session.environment,
    }, session.accountId)
    void syncHistory(session.id, session).catch(() => undefined)
  }
  response.status(replayed ? 200 : 201).json(result)
})

app.post('/api/exchange/positions/:positionId/close', async (request, response) => {
  const input = closeSchema.parse(request.body)
  const positionId = z.string().regex(/^\d{1,64}$/).parse(request.params.positionId)
  const session = await requireSession(request)
  assertWriteAllowed(session, input.confirmation)
  const { result, replayed } = await executeSessionMutation({
    session,
    operation: 'position.close',
    requestId: input.clientRequestId,
    requestPayload: { positionId, ...durableRequestPayload(input) },
    exchangeOrderId: ({ order }) => String((order as Record<string, unknown>).orderId ?? (order as Record<string, unknown>).orderID ?? '') || undefined,
    execute: async () => {
      consumeWriteCapacity(session)
      const order = await closePosition(session.environment, session.credentials, {
        positionId,
        quantity: input.quantity,
        clientOrderId: `antytilt-close-${input.clientRequestId.replaceAll('-', '').slice(0, 18)}`,
      })
      return { order, snapshot: await getAccountSnapshot(session.environment, session.credentials) }
    },
  })
  if (!replayed) {
    await recordAuditEvent(session.id, 'position.close', 'position', positionId, { quantity: input.quantity ?? 'all', environment: session.environment }, session.accountId)
    void syncHistory(session.id, session).catch(() => undefined)
  }
  response.status(replayed ? 200 : 201).json(result)
})

app.post('/api/exchange/positions/:positionId/protection', async (request, response) => {
  const input = positionProtectionSchema.parse(request.body)
  const positionId = z.string().regex(/^\d{1,64}$/).parse(request.params.positionId)
  const session = await requireSession(request)
  assertWriteAllowed(session, input.confirmation)
  const { result, replayed } = await executeSessionMutation({
    session,
    operation: 'position.protection.update',
    requestId: input.clientRequestId,
    requestPayload: { positionId, ...durableRequestPayload(input) },
    exchangeOrderId: ({ order }) => String((order as Record<string, unknown>).orderId ?? (order as Record<string, unknown>).orderID ?? '') || undefined,
    execute: async () => {
      consumeWriteCapacity(session)
      const order = await updatePositionProtection(session.environment, session.credentials, {
        positionId,
        orderId: input.orderId,
        kind: input.kind,
        stopPrice: input.stopPrice,
        workingType: input.workingType,
        clientOrderId: `antytilt-protect-${input.clientRequestId.replaceAll('-', '').slice(0, 18)}`,
      })
      return { order, snapshot: await getAccountSnapshot(session.environment, session.credentials) }
    },
  })
  if (!replayed) {
    await recordAuditEvent(session.id, 'position.protection.update', 'position', positionId, {
      kind: input.kind,
      orderId: input.orderId ?? 'new',
      stopPrice: input.stopPrice,
      workingType: input.workingType,
      environment: session.environment,
    }, session.accountId)
    void syncHistory(session.id, session).catch(() => undefined)
  }
  response.json(result)
})

if (process.env.NODE_ENV === 'production') {
  const staticDirectory = path.resolve(process.cwd(), 'dist')
  app.use(express.static(staticDirectory, { index: false, maxAge: '1h' }))
  app.use((request, response, next) => {
    if (request.method !== 'GET' || request.path.startsWith('/api/')) return next()
    response.sendFile(path.join(staticDirectory, 'index.html'))
  })
}

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  if (error instanceof ZodError) {
    response.status(400).json({ error: 'Invalid request', issues: error.issues.map((issue) => issue.message) })
    return
  }

  if (error instanceof RiskGuardError) {
    response.status(error.status).json({
      error: error.message,
      code: error.code,
      rule: error.rule,
      details: error.details,
    })
    return
  }

  const typedError = error as Error & { status?: number }
  const message = typedError instanceof Error ? typedError.message : 'Unexpected server error'
  const status = typedError.status
    ?? (message.includes('BingX error') ? 502 : message.startsWith('Too many') ? 429 : 500)

  if (status >= 500) console.error('[exchange-api]', message)
  response.status(status).json({ error: message })
})

export { app }
