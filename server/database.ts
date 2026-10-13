import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { BingxCredentials, BingxEnvironment, BingxOrder } from './bingxClient'
import { decryptCredential, encryptCredential } from './credentialVault'
import { queryDatabase, withDatabaseTransaction } from './postgres'

export type AuthUser = { id: string; email: string; createdAt: number }

export type ExchangeAccountStatus = 'ACTIVE' | 'REVOKED' | 'ARCHIVED'
export type ExchangeAccount = {
  id: string
  userId: string
  exchange: 'bingx'
  environment: BingxEnvironment
  label: string
  apiKeyMask: string
  status: ExchangeAccountStatus
  isDefault: boolean
  connectedAt: number
  lastVerifiedAt?: number
  createdAt: number
  updatedAt: number
}

export type StoredRiskProfile = {
  active: boolean
  timezone: string
  externalViolationPolicy: 'BLOCK_NEW_ENTRIES' | 'BLOCK_AND_CLOSE_EXTERNAL'
  breachAction: 'BLOCK_NEW_ENTRIES' | 'CANCEL_PENDING_ORDERS' | 'CLOSE_VIOLATING_POSITION' | 'CLOSE_ALL'
  closeExternalEntriesOnBreach: boolean
  automationConsent: boolean
  fixedStopLoss: { enabled: boolean; value: number; workingType: 'MARK_PRICE' | 'CONTRACT_PRICE' }
  breakEven: { enabled: boolean; triggerMode: 'PERCENT' | 'R_MULTIPLE'; triggerValue: number; offsetPercent: number }
  riskPerTrade: { enabled: boolean; value: number }
  dailyLossLimit: { enabled: boolean; value: number; unit: 'PERCENT' | 'USDT' }
  maxLeverage: { enabled: boolean; value: number }
  maxTradesPerDay: { enabled: boolean; value: number }
  maxConsecutiveLosses: { enabled: boolean; value: number }
  cooldownMinutes: { enabled: boolean; value: number }
  maxExposurePercent: { enabled: boolean; value: number }
  maxOpenPositions: { enabled: boolean; value: number }
}

export type RiskDailyState = {
  exchangeAccountId?: string
  userId: string
  environment: BingxEnvironment
  tradingDay: string
  timezone: string
  tradeCount: number
  openingEquityMicros: number
  lastEquityMicros: number
  initialized: boolean
  createdAt: number
  updatedAt: number
}

export type RiskPositionStatus = 'OPEN' | 'MISSING' | 'CLOSED'
export type RiskPositionOrigin = 'TERMINAL' | 'EXTERNAL' | 'UNKNOWN'
export type RiskPositionEnforcementStatus = 'NONE' | 'PENDING' | 'SUCCEEDED' | 'FAILED'

export type RiskPositionState = {
  exchangeAccountId?: string
  userId: string
  environment: BingxEnvironment
  positionKey: string
  positionId: string
  symbol: string
  side: string
  quantity: string
  status: RiskPositionStatus
  origin: RiskPositionOrigin
  missedSnapshots: number
  enforcementStatus: RiskPositionEnforcementStatus
  openedAt: number
  lastSeenAt: number
  createdAt: number
  updatedAt: number
}

export type RiskEntryReservationStatus = 'ACTIVE' | 'ATTACHED' | 'CONSUMED' | 'RELEASED' | 'BLOCKED'

export type RiskEntryReservation = {
  id: string
  exchangeAccountId?: string
  userId: string
  environment: BingxEnvironment
  tradingDay: string
  requestId: string
  symbol: string
  side: string
  status: RiskEntryReservationStatus
  orderId?: string
  createdAt: number
  updatedAt: number
  resolvedAt?: number
}

export type RiskEvent = {
  id: string
  exchangeAccountId?: string
  userId: string
  environment: BingxEnvironment
  tradingDay?: string
  eventKey: string
  rule: string
  action: string
  source: string
  result: string
  metadata: Record<string, unknown>
  createdAt: number
}

export type RiskProtectionState = {
  exchangeAccountId?: string
  userId: string
  environment: BingxEnvironment
  positionKey: string
  positionId: string
  symbol: string
  direction: 'LONG' | 'SHORT'
  entryPrice: string
  bestPrice: string
  triggered: boolean
  active: boolean
  missingCount: number
  managedOrderId: string
  managedStopPrice?: string
  managedQuantity: string
  managedPlacedAt?: number
  failureCount: number
  retryAt: number
  lastActionAt?: number
  createdAt: number
  updatedAt: number
}

export type RiskStreakState = {
  exchangeAccountId?: string
  userId: string
  environment: BingxEnvironment
  tradingDay: string
  timezone: string
  consecutiveLosses: number
  cooldownUntil: number
  lastOutcomeAt?: number
  createdAt: number
  updatedAt: number
}

export type RiskTradeOutcomeInput = {
  outcomeKey: string
  orderId: string
  netPnlMicros: number
  closedAt: number
}

export type TradingMutationStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'UNCERTAIN'
export type TradingMutation = {
  exchangeAccountId: string
  userId: string
  operation: string
  requestId: string
  requestHash: string
  status: TradingMutationStatus
  response?: unknown
  error?: Record<string, unknown>
  exchangeOrderId?: string
  createdAt: number
  updatedAt: number
  completedAt?: number
}

type UserRow = { id: string; email: string; password_hash: string; created_at: number }
type ExchangeAccountRow = {
  id: string
  user_id: string
  exchange: 'bingx'
  environment: BingxEnvironment
  label: string
  api_key_ciphertext: string
  secret_key_ciphertext: string
  api_key_mask: string
  status: ExchangeAccountStatus
  is_default: boolean
  connected_at: number
  last_verified_at: number | null
  created_at: number
  updated_at: number
}
type RiskDailyStateRow = {
  exchange_account_id: string | null
  user_id: string
  environment: BingxEnvironment
  trading_day: string
  timezone: string
  trade_count: number
  opening_equity_micros: number
  last_equity_micros: number
  initialized: boolean
  created_at: number
  updated_at: number
}
type RiskPositionStateRow = {
  exchange_account_id: string | null
  user_id: string
  environment: BingxEnvironment
  position_key: string
  position_id: string
  symbol: string
  side: string
  quantity: string
  status: RiskPositionStatus
  origin: RiskPositionOrigin
  missed_snapshots: number
  enforcement_status: RiskPositionEnforcementStatus
  opened_at: number
  last_seen_at: number
  created_at: number
  updated_at: number
}
type RiskEntryReservationRow = {
  id: string
  exchange_account_id: string | null
  user_id: string
  environment: BingxEnvironment
  trading_day: string
  request_id: string
  symbol: string
  side: string
  status: RiskEntryReservationStatus
  order_id: string | null
  created_at: number
  updated_at: number
  resolved_at: number | null
}
type RiskEventRow = {
  id: string
  exchange_account_id: string | null
  user_id: string
  environment: BingxEnvironment
  trading_day: string | null
  event_key: string
  rule_name: string
  action: string
  source: string
  result: string
  metadata_json: unknown
  created_at: number
}
type TradingMutationRow = {
  exchange_account_id: string
  user_id: string
  operation: string
  request_id: string
  request_hash: string
  status: TradingMutationStatus
  response_json: unknown | null
  error_json: unknown | null
  exchange_order_id: string | null
  created_at: number
  updated_at: number
  completed_at: number | null
}
type RiskProtectionStateRow = {
  exchange_account_id: string | null
  user_id: string
  environment: BingxEnvironment
  position_key: string
  position_id: string
  symbol: string
  direction: 'LONG' | 'SHORT'
  entry_price: string
  best_price: string
  triggered: boolean
  active: boolean
  missing_count: number
  managed_order_id: string
  managed_stop_price: string | null
  managed_quantity: string
  managed_placed_at: number | null
  failure_count: number
  retry_at: number
  last_action_at: number | null
  created_at: number
  updated_at: number
}
type RiskStreakStateRow = {
  exchange_account_id: string | null
  user_id: string
  environment: BingxEnvironment
  trading_day: string
  timezone: string
  consecutive_losses: number
  cooldown_until: number
  last_outcome_at: number | null
  created_at: number
  updated_at: number
}

const authSessionTtl = 30 * 24 * 60 * 60 * 1_000
const scryptOptions = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

function hashPassword(password: string) {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 64, scryptOptions)
  return `scrypt$${scryptOptions.N}$${scryptOptions.r}$${scryptOptions.p}$${salt.toString('base64url')}$${hash.toString('base64url')}`
}

function verifyPassword(password: string, stored: string) {
  const [algorithm, n, r, p, saltRaw, hashRaw] = stored.split('$')
  if (algorithm !== 'scrypt' || !n || !r || !p || !saltRaw || !hashRaw) return false
  const expected = Buffer.from(hashRaw, 'base64url')
  const actual = scryptSync(password, Buffer.from(saltRaw, 'base64url'), expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
  })
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function publicUser(row: Pick<UserRow, 'id' | 'email' | 'created_at'>): AuthUser {
  return { id: row.id, email: row.email, createdAt: Number(row.created_at) }
}

function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function assertNonEmpty(name: string, input: string) {
  if (!input.trim()) throw new Error(`${name} must not be empty`)
}

function assertEnvironment(environment: BingxEnvironment) {
  if (environment !== 'prod-vst' && environment !== 'prod-live') throw new Error('Unsupported risk environment')
}

async function requireExchangeAccountId(
  userId: string,
  environment: BingxEnvironment,
  exchangeAccountId?: string,
  client?: PoolClient,
) {
  const row = (await queryDatabase<{ id: string }>(`
    SELECT id FROM exchange_accounts
    WHERE user_id = $1 AND environment = $2 AND status = 'ACTIVE'
      AND ($3::uuid IS NULL OR id = $3::uuid)
    ORDER BY CASE WHEN id = $3::uuid THEN 0 WHEN is_default THEN 1 ELSE 2 END, updated_at DESC
    LIMIT 1
  `, [userId, environment, exchangeAccountId ?? null], client)).rows[0]
  if (!row) throw new Error('Active exchange account was not found for the requested risk scope')
  return row.id
}

function assertTradingDay(tradingDay: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradingDay)) throw new Error('Trading day must use YYYY-MM-DD')
}

function assertSafeInteger(name: string, input: number) {
  if (!Number.isSafeInteger(input)) throw new Error(`${name} must be a safe integer`)
}

function assertNonNegativeInteger(name: string, input: number) {
  assertSafeInteger(name, input)
  if (input < 0) throw new Error(`${name} must be non-negative`)
}

export async function createUser(email: string, password: string) {
  const normalizedEmail = email.trim().toLowerCase()
  const id = crypto.randomUUID()
  const createdAt = Date.now()
  try {
    await queryDatabase(
      'INSERT INTO users (id, email, password_hash, created_at) VALUES ($1, $2, $3, $4)',
      [id, normalizedEmail, hashPassword(password), createdAt],
    )
  } catch (error) {
    if ((error as { code?: string }).code === '23505' || String(error).toLowerCase().includes('unique')) {
      throw Object.assign(new Error('An account with this email already exists'), { status: 409 })
    }
    throw error
  }
  return { id, email: normalizedEmail, createdAt }
}

export async function authenticateUser(email: string, password: string) {
  const row = (await queryDatabase<UserRow>(
    'SELECT id, email, password_hash, created_at FROM users WHERE email = $1', [email.trim().toLowerCase()],
  )).rows[0]
  if (!row || !verifyPassword(password, row.password_hash)) {
    throw Object.assign(new Error('Invalid email or password'), { status: 401 })
  }
  return publicUser(row)
}

export async function createAuthSession(userId: string) {
  const token = randomBytes(32).toString('base64url')
  const now = Date.now()
  await queryDatabase(
    'INSERT INTO auth_sessions (token_hash, user_id, created_at, last_seen_at, expires_at) VALUES ($1, $2, $3, $4, $5)',
    [tokenHash(token), userId, now, now, now + authSessionTtl],
  )
  return { token, expiresAt: now + authSessionTtl }
}

export async function getAuthenticatedUser(token: string | undefined) {
  if (!token) return undefined
  const hash = tokenHash(token)
  const row = (await queryDatabase<Pick<UserRow, 'id' | 'email' | 'created_at'> & { expires_at: number }>(`
    SELECT users.id, users.email, users.created_at, auth_sessions.expires_at
    FROM auth_sessions JOIN users ON users.id = auth_sessions.user_id
    WHERE auth_sessions.token_hash = $1
  `, [hash])).rows[0]
  if (!row) return undefined
  if (Number(row.expires_at) <= Date.now()) {
    await queryDatabase('DELETE FROM auth_sessions WHERE token_hash = $1', [hash])
    return undefined
  }
  await queryDatabase('UPDATE auth_sessions SET last_seen_at = $1 WHERE token_hash = $2', [Date.now(), hash])
  return publicUser(row)
}

export async function deleteAuthSession(token: string | undefined) {
  if (token) await queryDatabase('DELETE FROM auth_sessions WHERE token_hash = $1', [tokenHash(token)])
}

const emptyExchangeAccountReset = () => ({
  orderHistory: 0,
  tradeHistory: 0,
  dailyStates: 0,
  positionStates: 0,
  riskEvents: 0,
  protectionStates: 0,
  streakStates: 0,
  tradeOutcomes: 0,
})

async function resetExchangeAccountStateWithClient(client: PoolClient, userId: string, exchangeAccountId: string) {
  const tableMap = [
    ['orderHistory', 'order_history'],
    ['tradeHistory', 'trade_history'],
    ['dailyStates', 'risk_daily_state'],
    ['positionStates', 'risk_position_state'],
    ['riskEvents', 'risk_events'],
    ['protectionStates', 'risk_protection_state'],
    ['streakStates', 'risk_streak_state'],
    ['tradeOutcomes', 'risk_trade_outcomes'],
  ] as const
  const counts = emptyExchangeAccountReset()
  for (const [key, table] of tableMap) {
    const result = await queryDatabase(`DELETE FROM ${table} WHERE user_id = $1 AND exchange_account_id = $2`, [userId, exchangeAccountId], client)
    counts[key] = result.rowCount ?? 0
  }
  return counts
}

export async function resetExchangeAccountState(userId: string, environment: BingxEnvironment, exchangeAccountId?: string) {
  assertNonEmpty('User ID', userId)
  assertEnvironment(environment)
  return withDatabaseTransaction(async (client) => {
    const accountId = await requireExchangeAccountId(userId, environment, exchangeAccountId, client)
    return resetExchangeAccountStateWithClient(client, userId, accountId)
  })
}

function sameApiKey(left: string, right: string) {
  const leftHash = createHash('sha256').update(left).digest()
  const rightHash = createHash('sha256').update(right).digest()
  return timingSafeEqual(leftHash, rightHash)
}

function exchangeAccountMetadata(row: ExchangeAccountRow): ExchangeAccount {
  return {
    id: row.id,
    userId: row.user_id,
    exchange: row.exchange,
    environment: row.environment,
    label: row.label,
    apiKeyMask: row.api_key_mask,
    status: row.status,
    isDefault: Boolean(row.is_default),
    connectedAt: Number(row.connected_at),
    lastVerifiedAt: row.last_verified_at === null ? undefined : Number(row.last_verified_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function exchangeCredentialContext(row: Pick<ExchangeAccountRow, 'user_id' | 'exchange' | 'environment'>) {
  // Legacy rows were encrypted with this context. Keep it stable while accounts are migrated.
  return `${row.user_id}:${row.exchange}:${row.environment}`
}

export async function listExchangeAccounts(userId: string, includeArchived = false) {
  const rows = (await queryDatabase<ExchangeAccountRow>(`
    SELECT * FROM exchange_accounts
    WHERE user_id = $1 AND ($2::boolean = TRUE OR status <> 'ARCHIVED')
    ORDER BY is_default DESC, updated_at DESC, id
  `, [userId, includeArchived])).rows
  return rows.map(exchangeAccountMetadata)
}

export async function saveExchangeConnection(
  userId: string,
  environment: BingxEnvironment,
  credentials: BingxCredentials,
  options: { label?: string } = {},
) {
  assertEnvironment(environment)
  return withDatabaseTransaction(async (client) => {
    const candidates = (await queryDatabase<ExchangeAccountRow>(`
      SELECT * FROM exchange_accounts
      WHERE user_id = $1 AND exchange = 'bingx' AND environment = $2
      FOR UPDATE
    `, [userId, environment], client)).rows
    const existing = candidates.find((candidate) => sameApiKey(
      decryptCredential(candidate.api_key_ciphertext, `${exchangeCredentialContext(candidate)}:apiKey`), credentials.apiKey,
    ))
    const reset = emptyExchangeAccountReset()
    const context = `${userId}:bingx:${environment}`
    const now = Date.now()
    const accountId = existing?.id ?? crypto.randomUUID()
    const label = options.label?.trim() || (environment === 'prod-live' ? 'BingX Live' : 'BingX VST')
    await queryDatabase('UPDATE exchange_accounts SET is_default = FALSE, updated_at = $1 WHERE user_id = $2', [now, userId], client)
    const row = (await queryDatabase<ExchangeAccountRow>(`
      INSERT INTO exchange_accounts (
        id, user_id, exchange, environment, label,
        api_key_ciphertext, secret_key_ciphertext, api_key_mask,
        status, is_default, connected_at, last_verified_at, created_at, updated_at, archived_at
      ) VALUES ($1, $2, 'bingx', $3, $4, $5, $6, $7, 'ACTIVE', TRUE, $8, $8, $8, $8, NULL)
      ON CONFLICT(id) DO UPDATE SET
        label = EXCLUDED.label,
        api_key_ciphertext = EXCLUDED.api_key_ciphertext,
        secret_key_ciphertext = EXCLUDED.secret_key_ciphertext,
        api_key_mask = EXCLUDED.api_key_mask,
        status = 'ACTIVE',
        is_default = TRUE,
        connected_at = EXCLUDED.connected_at,
        last_verified_at = EXCLUDED.last_verified_at,
        updated_at = EXCLUDED.updated_at,
        archived_at = NULL
      RETURNING *
    `, [
      accountId, userId, environment, label,
      encryptCredential(credentials.apiKey, `${context}:apiKey`),
      encryptCredential(credentials.secretKey, `${context}:secretKey`),
      `••••${credentials.apiKey.slice(-4)}`, now,
    ], client)).rows[0]
    await queryDatabase(`
      INSERT INTO account_risk_profiles (
        exchange_account_id, user_id, active, profile_json, created_at, updated_at
      )
      SELECT $1::uuid, user_id, active, profile_json, $2::bigint, $2::bigint
      FROM account_risk_profiles
      WHERE user_id = $3 AND exchange_account_id <> $1
      ORDER BY updated_at DESC
      LIMIT 1
      ON CONFLICT(exchange_account_id) DO NOTHING
    `, [row.id, now, userId], client)
    await queryDatabase(`
      INSERT INTO account_risk_profiles (
        exchange_account_id, user_id, active, profile_json, created_at, updated_at
      )
      SELECT $1::uuid, user_id, active, profile_json, $2::bigint, $2::bigint
      FROM risk_profiles
      WHERE user_id = $3
      ON CONFLICT(exchange_account_id) DO NOTHING
    `, [row.id, now, userId], client)
    return { accountChanged: false, stateReset: reset, account: exchangeAccountMetadata(row) }
  })
}

export async function loadExchangeConnection(userId: string, accountId?: string) {
  const row = (await queryDatabase<ExchangeAccountRow>(`
    SELECT * FROM exchange_accounts
    WHERE user_id = $1 AND status = 'ACTIVE' AND ($2::uuid IS NULL OR id = $2::uuid)
    ORDER BY CASE WHEN id = $2::uuid THEN 0 WHEN is_default THEN 1 ELSE 2 END, updated_at DESC
    LIMIT 1
  `, [userId, accountId ?? null])).rows[0]
  if (!row) return undefined
  const context = exchangeCredentialContext(row)
  return {
    account: exchangeAccountMetadata(row),
    accountId: row.id,
    exchange: row.exchange,
    environment: row.environment,
    credentials: {
      apiKey: decryptCredential(row.api_key_ciphertext, `${context}:apiKey`),
      secretKey: decryptCredential(row.secret_key_ciphertext, `${context}:secretKey`),
    },
    apiKeyMask: row.api_key_mask,
    connectedAt: Number(row.connected_at),
  }
}

export async function listRiskMonitoringTargets() {
  const result = await queryDatabase<{
    id: string
    user_id: string
    environment: BingxEnvironment
    api_key_ciphertext: string
    secret_key_ciphertext: string
    api_key_mask: string
    connected_at: number
    active: boolean
    profile_json: unknown
  }>(`
    SELECT exchange_accounts.id, exchange_accounts.user_id, exchange_accounts.environment,
      exchange_accounts.api_key_ciphertext, exchange_accounts.secret_key_ciphertext,
      exchange_accounts.api_key_mask, exchange_accounts.connected_at,
      account_risk_profiles.active, account_risk_profiles.profile_json
    FROM exchange_accounts
    JOIN account_risk_profiles ON account_risk_profiles.exchange_account_id = exchange_accounts.id
    WHERE exchange_accounts.exchange = 'bingx' AND exchange_accounts.status = 'ACTIVE'
      AND account_risk_profiles.active = TRUE
  `)
  return result.rows.map((row) => {
    const context = `${row.user_id}:bingx:${row.environment}`
    return {
      accountId: row.id,
      userId: row.user_id,
      environment: row.environment,
      credentials: {
        apiKey: decryptCredential(row.api_key_ciphertext, `${context}:apiKey`),
        secretKey: decryptCredential(row.secret_key_ciphertext, `${context}:secretKey`),
      },
      apiKeyMask: row.api_key_mask,
      connectedAt: Number(row.connected_at),
      profile: { ...normalizeStoredRiskProfile(row.profile_json), active: Boolean(row.active) },
    }
  })
}

export async function selectExchangeAccount(userId: string, accountId: string) {
  return withDatabaseTransaction(async (client) => {
    const account = (await queryDatabase<ExchangeAccountRow>(`
      SELECT * FROM exchange_accounts WHERE id = $1 AND user_id = $2 AND status = 'ACTIVE' FOR UPDATE
    `, [accountId, userId], client)).rows[0]
    if (!account) throw Object.assign(new Error('Exchange account was not found'), { status: 404 })
    const now = Date.now()
    await queryDatabase('UPDATE exchange_accounts SET is_default = FALSE, updated_at = $1 WHERE user_id = $2', [now, userId], client)
    const selected = (await queryDatabase<ExchangeAccountRow>(`
      UPDATE exchange_accounts SET is_default = TRUE, updated_at = $1 WHERE id = $2 RETURNING *
    `, [now, accountId], client)).rows[0]
    return exchangeAccountMetadata(selected)
  })
}

export async function deleteExchangeConnection(userId: string, accountId?: string) {
  return withDatabaseTransaction(async (client) => {
    const existing = (await queryDatabase<ExchangeAccountRow>(`
      SELECT * FROM exchange_accounts
      WHERE user_id = $1 AND status = 'ACTIVE' AND ($2::uuid IS NULL OR id = $2::uuid)
      ORDER BY CASE WHEN id = $2::uuid THEN 0 WHEN is_default THEN 1 ELSE 2 END, updated_at DESC
      LIMIT 1 FOR UPDATE
    `, [userId, accountId ?? null], client)).rows[0]
    if (!existing) return undefined
    const now = Date.now()
    await queryDatabase(`
      UPDATE exchange_accounts SET status = 'ARCHIVED', is_default = FALSE, archived_at = $1, updated_at = $1 WHERE id = $2
    `, [now, existing.id], client)
    const fallback = (await queryDatabase<ExchangeAccountRow>(`
      SELECT * FROM exchange_accounts WHERE user_id = $1 AND status = 'ACTIVE' ORDER BY updated_at DESC LIMIT 1
    `, [userId], client)).rows[0]
    if (fallback) await queryDatabase('UPDATE exchange_accounts SET is_default = TRUE, updated_at = $1 WHERE id = $2', [now, fallback.id], client)
    return exchangeAccountMetadata(existing)
  })
}

function normalizeStoredRiskProfile(value: unknown): StoredRiskProfile {
  const profile = jsonObject(value) as Partial<StoredRiskProfile>
  const timezone = typeof profile.timezone === 'string' && profile.timezone.trim() ? profile.timezone.trim() : 'UTC'
  const externalViolationPolicy = profile.externalViolationPolicy === 'BLOCK_AND_CLOSE_EXTERNAL'
    ? 'BLOCK_AND_CLOSE_EXTERNAL' : 'BLOCK_NEW_ENTRIES'
  const breachAction = profile.breachAction === 'CANCEL_PENDING_ORDERS'
    || profile.breachAction === 'CLOSE_VIOLATING_POSITION'
    || profile.breachAction === 'CLOSE_ALL'
    ? profile.breachAction
    : externalViolationPolicy === 'BLOCK_AND_CLOSE_EXTERNAL' ? 'CLOSE_VIOLATING_POSITION' : 'BLOCK_NEW_ENTRIES'
  const fixedStopLoss = profile.fixedStopLoss && typeof profile.fixedStopLoss === 'object'
    ? { ...profile.fixedStopLoss, workingType: profile.fixedStopLoss.workingType === 'CONTRACT_PRICE' ? 'CONTRACT_PRICE' as const : 'MARK_PRICE' as const }
    : { enabled: false, value: 2, workingType: 'MARK_PRICE' as const }
  const dailyLossLimit = profile.dailyLossLimit && typeof profile.dailyLossLimit === 'object'
    ? { ...profile.dailyLossLimit, unit: profile.dailyLossLimit.unit === 'USDT' ? 'USDT' as const : 'PERCENT' as const }
    : { enabled: false, value: 3, unit: 'PERCENT' as const }
  return {
    ...profile, timezone, externalViolationPolicy, breachAction,
    closeExternalEntriesOnBreach: profile.closeExternalEntriesOnBreach === true,
    automationConsent: profile.automationConsent === true, fixedStopLoss, dailyLossLimit,
  } as StoredRiskProfile
}

export async function loadRiskProfile(userId: string, exchangeAccountId?: string) {
  const row = (await queryDatabase<{ active: boolean; profile_json: unknown; updated_at: number }>(
    `SELECT profile.active, profile.profile_json, profile.updated_at
     FROM account_risk_profiles AS profile
     JOIN exchange_accounts AS account ON account.id = profile.exchange_account_id
     WHERE profile.user_id = $1 AND ($2::uuid IS NULL OR profile.exchange_account_id = $2::uuid)
       AND account.status = 'ACTIVE'
     ORDER BY CASE WHEN profile.exchange_account_id = $2::uuid THEN 0 WHEN account.is_default THEN 1 ELSE 2 END,
       profile.updated_at DESC
     LIMIT 1`, [userId, exchangeAccountId ?? null],
  )).rows[0]
  if (!row) {
    const template = (await queryDatabase<{ active: boolean; profile_json: unknown; updated_at: number }>(
      'SELECT active, profile_json, updated_at FROM risk_profiles WHERE user_id = $1', [userId],
    )).rows[0]
    if (!template) return undefined
    return { ...normalizeStoredRiskProfile(template.profile_json), active: Boolean(template.active), updatedAt: Number(template.updated_at) }
  }
  return { ...normalizeStoredRiskProfile(row.profile_json), active: Boolean(row.active), updatedAt: Number(row.updated_at) }
}

export async function saveRiskProfile(userId: string, profile: StoredRiskProfile, exchangeAccountId?: string) {
  const now = Date.now()
  const normalized = normalizeStoredRiskProfile(profile)
  const accountId = exchangeAccountId ?? (await loadExchangeConnection(userId))?.accountId
  if (!accountId) {
    await queryDatabase(`
      INSERT INTO risk_profiles (user_id, active, profile_json, created_at, updated_at)
      VALUES ($1, $2, $3::jsonb, $4, $5)
      ON CONFLICT(user_id) DO UPDATE SET active = EXCLUDED.active,
        profile_json = EXCLUDED.profile_json, updated_at = EXCLUDED.updated_at
    `, [userId, normalized.active, JSON.stringify(normalized), now, now])
    return { ...normalized, updatedAt: now }
  }
  await queryDatabase(`
    INSERT INTO account_risk_profiles (exchange_account_id, user_id, active, profile_json, created_at, updated_at)
    VALUES ($1, $2, $3, $4::jsonb, $5, $6)
    ON CONFLICT(exchange_account_id) DO UPDATE SET active = EXCLUDED.active,
      profile_json = EXCLUDED.profile_json, updated_at = EXCLUDED.updated_at
  `, [accountId, userId, normalized.active, JSON.stringify(normalized), now, now])
  return { ...normalized, updatedAt: now }
}

function value(row: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) if (row[key] !== undefined && row[key] !== null) return String(row[key])
  return ''
}

function numericTime(row: Record<string, unknown>, ...keys: string[]) {
  const parsed = Number(value(row, ...keys))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Date.now()
}

export async function upsertOrderHistory(userId: string, environment: BingxEnvironment, orders: BingxOrder[], exchangeAccountId?: string) {
  const accountId = exchangeAccountId ?? (await loadExchangeConnection(userId))?.accountId
  if (!accountId) throw new Error('Exchange account is required to store order history')
  await withDatabaseTransaction(async (client) => {
    for (const order of orders) {
      const row = order as Record<string, unknown>
      const orderId = value(row, 'orderId', 'orderID')
      if (!orderId) continue
      await queryDatabase(`
        INSERT INTO order_history (
          user_id, environment, exchange_account_id, order_id, symbol, side, position_side, type, price, avg_price,
          quantity, executed_qty, status, realized_pnl, fee, created_at, updated_at, raw_json
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb)
        ON CONFLICT(exchange_account_id, order_id) DO UPDATE SET
          status = EXCLUDED.status, avg_price = EXCLUDED.avg_price, executed_qty = EXCLUDED.executed_qty,
          realized_pnl = EXCLUDED.realized_pnl, fee = EXCLUDED.fee, updated_at = EXCLUDED.updated_at,
          raw_json = EXCLUDED.raw_json, exchange_account_id = EXCLUDED.exchange_account_id
      `, [
        userId, environment, accountId, orderId, value(row, 'symbol'), value(row, 'side'), value(row, 'positionSide'),
        value(row, 'type'), value(row, 'price'), value(row, 'avgPrice'), value(row, 'origQty', 'quantity'),
        value(row, 'executedQty'), value(row, 'status'), value(row, 'realizedPnl', 'realisedPnl'), value(row, 'fee', 'commission'),
        numericTime(row, 'time', 'createTime'), numericTime(row, 'updateTime', 'time'), JSON.stringify(row),
      ], client)
    }
  })
}

export async function upsertTradeHistory(userId: string, environment: BingxEnvironment, trades: Array<Record<string, unknown>>, exchangeAccountId?: string) {
  const accountId = exchangeAccountId ?? (await loadExchangeConnection(userId))?.accountId
  if (!accountId) throw new Error('Exchange account is required to store trade history')
  await withDatabaseTransaction(async (client) => {
    for (const row of trades) {
      const tradeId = value(row, 'tradeId', 'id', 'fillId')
      if (!tradeId) continue
      await queryDatabase(`
        INSERT INTO trade_history (
          user_id, environment, exchange_account_id, trade_id, order_id, symbol, side, position_side, price,
          quantity, realized_pnl, fee, created_at, raw_json
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
        ON CONFLICT(exchange_account_id, trade_id) DO UPDATE SET
          realized_pnl = EXCLUDED.realized_pnl, fee = EXCLUDED.fee, raw_json = EXCLUDED.raw_json,
          exchange_account_id = EXCLUDED.exchange_account_id
      `, [
        userId, environment, accountId, tradeId, value(row, 'orderId'), value(row, 'symbol'), value(row, 'side'), value(row, 'positionSide'),
        value(row, 'price', 'avgPrice'), value(row, 'qty', 'quantity'), value(row, 'realizedPnl', 'realisedPnl'),
        value(row, 'fee', 'commission'), numericTime(row, 'time', 'createdAt'), JSON.stringify(row),
      ], client)
    }
  })
}

export async function listOrderHistory(userId: string, environment: BingxEnvironment, limit = 500, exchangeAccountId?: string) {
  const accountId = exchangeAccountId ?? (await loadExchangeConnection(userId))?.accountId
  if (!accountId) return []
  return (await queryDatabase(`
    SELECT order_id AS "orderId", symbol, side, position_side AS "positionSide", type, price,
      avg_price AS "avgPrice", quantity, executed_qty AS "executedQty", status,
      realized_pnl AS "realizedPnl", fee, created_at AS time, updated_at AS "updateTime"
    FROM order_history WHERE user_id = $1 AND environment = $2 AND exchange_account_id = $3
    ORDER BY created_at DESC LIMIT $4
  `, [userId, environment, accountId, limit])).rows
}

export async function listTradeHistory(userId: string, environment: BingxEnvironment, limit = 500, exchangeAccountId?: string) {
  const accountId = exchangeAccountId ?? (await loadExchangeConnection(userId))?.accountId
  if (!accountId) return []
  return (await queryDatabase(`
    SELECT trade_id AS "tradeId", order_id AS "orderId", symbol, side, position_side AS "positionSide",
      price, quantity, realized_pnl AS "realizedPnl", fee, created_at AS time
    FROM trade_history WHERE user_id = $1 AND environment = $2 AND exchange_account_id = $3
    ORDER BY created_at DESC LIMIT $4
  `, [userId, environment, accountId, limit])).rows
}

export async function recordAuditEvent(
  userId: string,
  action: string,
  resourceType: string,
  resourceId?: string,
  metadata: Record<string, unknown> = {},
  exchangeAccountId?: string,
) {
  await queryDatabase(`
    INSERT INTO audit_events (id, user_id, exchange_account_id, action, resource_type, resource_id, metadata_json, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
  `, [crypto.randomUUID(), userId, exchangeAccountId ?? null, action, resourceType, resourceId ?? null, JSON.stringify(metadata), Date.now()])
}

const tradingMutationColumns = `exchange_account_id, user_id, operation, request_id, request_hash,
  status, response_json, error_json, exchange_order_id, created_at, updated_at, completed_at`

function tradingMutation(row: TradingMutationRow): TradingMutation {
  return {
    exchangeAccountId: row.exchange_account_id,
    userId: row.user_id,
    operation: row.operation,
    requestId: row.request_id,
    requestHash: row.request_hash,
    status: row.status,
    ...(row.response_json === null ? {} : { response: row.response_json }),
    ...(row.error_json === null ? {} : { error: jsonObject(row.error_json) }),
    ...(row.exchange_order_id === null ? {} : { exchangeOrderId: row.exchange_order_id }),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.completed_at === null ? {} : { completedAt: Number(row.completed_at) }),
  }
}

export async function beginTradingMutation(input: {
  userId: string
  exchangeAccountId: string
  operation: string
  requestId: string
  requestHash: string
}) {
  assertNonEmpty('User ID', input.userId)
  assertNonEmpty('Exchange account ID', input.exchangeAccountId)
  assertNonEmpty('Mutation operation', input.operation)
  assertNonEmpty('Mutation request ID', input.requestId)
  if (!/^[a-f0-9]{64}$/.test(input.requestHash)) throw new Error('Mutation request hash must be SHA-256')
  return withDatabaseTransaction(async (client) => {
    const ownership = (await queryDatabase<{ id: string }>(`
      SELECT id FROM exchange_accounts WHERE id = $1 AND user_id = $2 AND status = 'ACTIVE' FOR UPDATE
    `, [input.exchangeAccountId, input.userId], client)).rows[0]
    if (!ownership) throw Object.assign(new Error('Exchange account is unavailable'), { status: 409 })
    const existing = (await queryDatabase<TradingMutationRow>(`
      SELECT ${tradingMutationColumns} FROM trading_mutations
      WHERE exchange_account_id = $1 AND user_id = $2 AND operation = $3 AND request_id = $4
    `, [input.exchangeAccountId, input.userId, input.operation, input.requestId], client)).rows[0]
    if (existing) {
      if (existing.request_hash !== input.requestHash) {
        throw Object.assign(new Error('This request ID was already used with different trading parameters'), { status: 409 })
      }
      return { created: false, mutation: tradingMutation(existing) }
    }
    const now = Date.now()
    const row = (await queryDatabase<TradingMutationRow>(`
      INSERT INTO trading_mutations (
        exchange_account_id, user_id, operation, request_id, request_hash, status,
        response_json, error_json, exchange_order_id, created_at, updated_at, completed_at
      ) VALUES ($1, $2, $3, $4, $5, 'PENDING', NULL, NULL, NULL, $6, $6, NULL)
      RETURNING ${tradingMutationColumns}
    `, [input.exchangeAccountId, input.userId, input.operation, input.requestId, input.requestHash, now], client)).rows[0]
    if (!row) throw new Error('Trading mutation could not be initialized')
    return { created: true, mutation: tradingMutation(row) }
  })
}

export async function completeTradingMutation(input: {
  userId: string
  exchangeAccountId: string
  operation: string
  requestId: string
  response: unknown
  exchangeOrderId?: string
}) {
  const now = Date.now()
  const row = (await queryDatabase<TradingMutationRow>(`
    UPDATE trading_mutations SET status = 'SUCCEEDED', response_json = $1::jsonb,
      error_json = NULL, exchange_order_id = $2, updated_at = $3, completed_at = $3
    WHERE exchange_account_id = $4 AND user_id = $5 AND operation = $6 AND request_id = $7
      AND status = 'PENDING'
    RETURNING ${tradingMutationColumns}
  `, [JSON.stringify(input.response ?? null), input.exchangeOrderId ?? null, now,
    input.exchangeAccountId, input.userId, input.operation, input.requestId])).rows[0]
  if (!row) throw new Error('Pending trading mutation could not be completed')
  return tradingMutation(row)
}

export async function failTradingMutation(input: {
  userId: string
  exchangeAccountId: string
  operation: string
  requestId: string
  error: Record<string, unknown>
  uncertain?: boolean
  exchangeOrderId?: string
}) {
  const now = Date.now()
  const status: TradingMutationStatus = input.uncertain ? 'UNCERTAIN' : 'FAILED'
  const row = (await queryDatabase<TradingMutationRow>(`
    UPDATE trading_mutations SET status = $1, response_json = NULL, error_json = $2::jsonb,
      exchange_order_id = COALESCE($3, exchange_order_id), updated_at = $4, completed_at = $4
    WHERE exchange_account_id = $5 AND user_id = $6 AND operation = $7 AND request_id = $8
      AND status = 'PENDING'
    RETURNING ${tradingMutationColumns}
  `, [status, JSON.stringify(input.error), input.exchangeOrderId ?? null, now,
    input.exchangeAccountId, input.userId, input.operation, input.requestId])).rows[0]
  return row ? tradingMutation(row) : undefined
}

// Risk-state persistence continues below. Every mutating operation uses a
// PostgreSQL transaction; daily counters lock their owner row before changing it.

export type RiskDailyStateInput = {
  userId: string
  exchangeAccountId?: string
  environment: BingxEnvironment
  tradingDay: string
  timezone: string
  openingEquityMicros?: number
  lastEquityMicros?: number
  initialized?: boolean
}

function riskDailyState(row: RiskDailyStateRow): RiskDailyState {
  return {
    ...(row.exchange_account_id ? { exchangeAccountId: row.exchange_account_id } : {}),
    userId: row.user_id,
    environment: row.environment,
    tradingDay: row.trading_day,
    timezone: row.timezone,
    tradeCount: Number(row.trade_count),
    openingEquityMicros: Number(row.opening_equity_micros),
    lastEquityMicros: Number(row.last_equity_micros),
    initialized: Boolean(row.initialized),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

const dailyStateSelect = `
  SELECT exchange_account_id, user_id, environment, trading_day, timezone, trade_count,
    opening_equity_micros, last_equity_micros, initialized, created_at, updated_at
  FROM risk_daily_state WHERE user_id = $1 AND exchange_account_id = $2 AND trading_day = $3
`

async function selectRiskDailyState(
  userId: string,
  exchangeAccountId: string,
  tradingDay: string,
  client?: PoolClient,
  lock = false,
) {
  const result = await queryDatabase<RiskDailyStateRow>(`${dailyStateSelect}${lock ? ' FOR UPDATE' : ''}`, [userId, exchangeAccountId, tradingDay], client)
  return result.rows[0]
}

async function ensureRiskDailyState(input: RiskDailyStateInput, client: PoolClient, lock = true, now = Date.now()) {
  assertNonEmpty('User ID', input.userId)
  assertEnvironment(input.environment)
  assertTradingDay(input.tradingDay)
  assertNonEmpty('Timezone', input.timezone)
  if (input.openingEquityMicros !== undefined) assertSafeInteger('Opening equity micros', input.openingEquityMicros)
  if (input.lastEquityMicros !== undefined) assertSafeInteger('Last equity micros', input.lastEquityMicros)
  const initialize = input.initialized ?? input.openingEquityMicros !== undefined
  const openingEquityMicros = input.openingEquityMicros ?? 0
  const lastEquityMicros = input.lastEquityMicros ?? openingEquityMicros
  const accountId = await requireExchangeAccountId(input.userId, input.environment, input.exchangeAccountId, client)
  await queryDatabase(`
    INSERT INTO risk_daily_state (
      user_id, environment, exchange_account_id, trading_day, timezone, trade_count, opening_equity_micros,
      last_equity_micros, initialized, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8, $9, $10)
    ON CONFLICT(exchange_account_id, trading_day) DO NOTHING
  `, [input.userId, input.environment, accountId, input.tradingDay, input.timezone, openingEquityMicros, lastEquityMicros, initialize, now, now], client)
  let current = await selectRiskDailyState(input.userId, accountId, input.tradingDay, client, lock)
  if (!current) throw new Error('Risk daily state could not be loaded')
  if (!current.initialized && initialize) {
    await queryDatabase(`
      UPDATE risk_daily_state SET opening_equity_micros = $1, last_equity_micros = $2,
        initialized = TRUE, updated_at = $3
      WHERE user_id = $4 AND exchange_account_id = $5 AND trading_day = $6
    `, [openingEquityMicros, lastEquityMicros, now, input.userId, accountId, input.tradingDay], client)
  } else if (input.lastEquityMicros !== undefined && Number(current.last_equity_micros) !== input.lastEquityMicros) {
    await queryDatabase(`
      UPDATE risk_daily_state SET last_equity_micros = $1, updated_at = $2
      WHERE user_id = $3 AND exchange_account_id = $4 AND trading_day = $5
    `, [input.lastEquityMicros, now, input.userId, accountId, input.tradingDay], client)
  }
  current = await selectRiskDailyState(input.userId, accountId, input.tradingDay, client, lock)
  if (!current) throw new Error('Risk daily state could not be created')
  return current
}

export async function getRiskDailyState(userId: string, environment: BingxEnvironment, tradingDay: string, exchangeAccountId?: string) {
  assertEnvironment(environment)
  assertTradingDay(tradingDay)
  const accountId = await requireExchangeAccountId(userId, environment, exchangeAccountId)
  const row = await selectRiskDailyState(userId, accountId, tradingDay)
  return row ? riskDailyState(row) : undefined
}

export async function getOrCreateRiskDailyState(input: RiskDailyStateInput) {
  return withDatabaseTransaction(async (client) => riskDailyState(await ensureRiskDailyState(input, client)))
}

export async function updateRiskDailyEquity(input: RiskDailyStateInput & { lastEquityMicros: number }) {
  return withDatabaseTransaction(async (client) => riskDailyState(await ensureRiskDailyState(input, client)))
}

function riskEntryReservation(row: RiskEntryReservationRow): RiskEntryReservation {
  return {
    id: row.id,
    ...(row.exchange_account_id ? { exchangeAccountId: row.exchange_account_id } : {}),
    userId: row.user_id,
    environment: row.environment,
    tradingDay: row.trading_day,
    requestId: row.request_id,
    symbol: row.symbol,
    side: row.side,
    status: row.status,
    ...(row.order_id ? { orderId: row.order_id } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.resolved_at === null ? {} : { resolvedAt: Number(row.resolved_at) }),
  }
}

const reservationSelect = `
  SELECT id, exchange_account_id, user_id, environment, trading_day, request_id, symbol, side,
    status, order_id, created_at, updated_at, resolved_at
  FROM risk_entry_reservations
`

async function selectRiskEntryReservationByRequest(
  userId: string,
  exchangeAccountId: string,
  tradingDay: string,
  requestId: string,
  client?: PoolClient,
) {
  return (await queryDatabase<RiskEntryReservationRow>(`${reservationSelect}
    WHERE user_id = $1 AND exchange_account_id = $2 AND trading_day = $3 AND request_id = $4
  `, [userId, exchangeAccountId, tradingDay, requestId], client)).rows[0]
}

async function selectRiskEntryReservationById(
  userId: string,
  exchangeAccountId: string,
  reservationId: string,
  client?: PoolClient,
  lock = false,
) {
  return (await queryDatabase<RiskEntryReservationRow>(`${reservationSelect}
    WHERE user_id = $1 AND exchange_account_id = $2 AND id = $3${lock ? ' FOR UPDATE' : ''}
  `, [userId, exchangeAccountId, reservationId], client)).rows[0]
}

async function activeReservationCount(userId: string, exchangeAccountId: string, tradingDay: string, client: PoolClient) {
  const row = (await queryDatabase<{ count: number }>(`
    SELECT COUNT(*)::int AS count FROM risk_entry_reservations
    WHERE user_id = $1 AND exchange_account_id = $2 AND trading_day = $3 AND status IN ('ACTIVE', 'ATTACHED')
  `, [userId, exchangeAccountId, tradingDay], client)).rows[0]
  return Number(row?.count ?? 0)
}

export type ReserveRiskEntryInput = RiskDailyStateInput & {
  requestId: string
  symbol: string
  side: string
  maxTradesPerDay: number
}

export type ReserveRiskEntryResult = {
  allowed: boolean
  idempotent: boolean
  reservation: RiskEntryReservation
  dailyState: RiskDailyState
  activeReservations: number
  slotsUsed: number
  maxTradesPerDay: number
}

export async function reserveRiskEntry(input: ReserveRiskEntryInput): Promise<ReserveRiskEntryResult> {
  assertNonEmpty('Request ID', input.requestId)
  assertNonEmpty('Symbol', input.symbol)
  assertNonEmpty('Side', input.side)
  assertNonNegativeInteger('Maximum trades per day', input.maxTradesPerDay)
  if (input.maxTradesPerDay === 0) throw new Error('Maximum trades per day must be positive')
  return withDatabaseTransaction(async (client) => {
    const dailyRow = await ensureRiskDailyState(input, client, true)
    const accountId = dailyRow.exchange_account_id!
    const existing = await selectRiskEntryReservationByRequest(input.userId, accountId, input.tradingDay, input.requestId, client)
    const activeBefore = await activeReservationCount(input.userId, accountId, input.tradingDay, client)
    if (existing) {
      const allowed = existing.status !== 'BLOCKED' && existing.status !== 'RELEASED'
      return {
        allowed,
        idempotent: true,
        reservation: riskEntryReservation(existing),
        dailyState: riskDailyState(dailyRow),
        activeReservations: activeBefore,
        slotsUsed: Number(dailyRow.trade_count) + activeBefore,
        maxTradesPerDay: input.maxTradesPerDay,
      }
    }
    const allowed = Number(dailyRow.trade_count) + activeBefore < input.maxTradesPerDay
    const now = Date.now()
    const row = (await queryDatabase<RiskEntryReservationRow>(`
      INSERT INTO risk_entry_reservations (
        id, user_id, environment, exchange_account_id, trading_day, request_id, symbol, side, status,
        order_id, created_at, updated_at, resolved_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10, $11, $12)
      RETURNING id, exchange_account_id, user_id, environment, trading_day, request_id,
        symbol, side, status, order_id, created_at, updated_at, resolved_at
    `, [
      crypto.randomUUID(), input.userId, input.environment, dailyRow.exchange_account_id, input.tradingDay, input.requestId,
      input.symbol, input.side, allowed ? 'ACTIVE' : 'BLOCKED', now, now, allowed ? null : now,
    ], client)).rows[0]
    if (!row) throw new Error('Risk entry reservation could not be created')
    const activeReservations = activeBefore + (allowed ? 1 : 0)
    return {
      allowed,
      idempotent: false,
      reservation: riskEntryReservation(row),
      dailyState: riskDailyState(dailyRow),
      activeReservations,
      slotsUsed: Number(dailyRow.trade_count) + activeReservations,
      maxTradesPerDay: input.maxTradesPerDay,
    }
  })
}

export async function getRiskEntryReservation(userId: string, environment: BingxEnvironment, reservationId: string, exchangeAccountId?: string) {
  const accountId = await requireExchangeAccountId(userId, environment, exchangeAccountId)
  const row = await selectRiskEntryReservationById(userId, accountId, reservationId)
  return row ? riskEntryReservation(row) : undefined
}

export async function getRiskEntryReservationByRequest(
  userId: string,
  environment: BingxEnvironment,
  tradingDay: string,
  requestId: string,
  exchangeAccountId?: string,
) {
  const accountId = await requireExchangeAccountId(userId, environment, exchangeAccountId)
  const row = await selectRiskEntryReservationByRequest(userId, accountId, tradingDay, requestId)
  return row ? riskEntryReservation(row) : undefined
}

export async function listRiskEntryReservations(userId: string, environment: BingxEnvironment, tradingDay: string, exchangeAccountId?: string) {
  const accountId = await requireExchangeAccountId(userId, environment, exchangeAccountId)
  const result = await queryDatabase<RiskEntryReservationRow>(`${reservationSelect}
    WHERE user_id = $1 AND exchange_account_id = $2 AND trading_day = $3 ORDER BY created_at DESC, id DESC
  `, [userId, accountId, tradingDay])
  return result.rows.map(riskEntryReservation)
}

export async function attachRiskEntryReservation(input: {
  userId: string
  exchangeAccountId?: string
  environment: BingxEnvironment
  reservationId: string
  orderId: string
}) {
  assertNonEmpty('Order ID', input.orderId)
  return withDatabaseTransaction(async (client) => {
    const accountId = await requireExchangeAccountId(input.userId, input.environment, input.exchangeAccountId, client)
    const current = await selectRiskEntryReservationById(input.userId, accountId, input.reservationId, client, true)
    if (!current) return undefined
    if (current.status === 'ATTACHED' && current.order_id !== input.orderId) {
      throw new Error('Risk entry reservation is already attached to a different order')
    }
    if (current.status === 'ACTIVE') {
      await queryDatabase(`
        UPDATE risk_entry_reservations SET status = 'ATTACHED', order_id = $1, updated_at = $2
        WHERE user_id = $3 AND exchange_account_id = $4 AND id = $5 AND status = 'ACTIVE'
      `, [input.orderId, Date.now(), input.userId, accountId, input.reservationId], client)
    }
    const row = await selectRiskEntryReservationById(input.userId, accountId, input.reservationId, client)
    return row ? riskEntryReservation(row) : undefined
  })
}

export async function releaseRiskEntryReservation(input: {
  userId: string
  exchangeAccountId?: string
  environment: BingxEnvironment
  reservationId: string
}) {
  return withDatabaseTransaction(async (client) => {
    const accountId = await requireExchangeAccountId(input.userId, input.environment, input.exchangeAccountId, client)
    const now = Date.now()
    const update = await queryDatabase(`
      UPDATE risk_entry_reservations SET status = 'RELEASED', updated_at = $1, resolved_at = $2
      WHERE user_id = $3 AND exchange_account_id = $4 AND id = $5 AND status IN ('ACTIVE', 'ATTACHED')
    `, [now, now, input.userId, accountId, input.reservationId], client)
    const row = await selectRiskEntryReservationById(input.userId, accountId, input.reservationId, client)
    return { reservation: row ? riskEntryReservation(row) : undefined, changed: update.rowCount === 1 }
  })
}

export async function consumeRiskEntryReservation(input: {
  userId: string
  exchangeAccountId?: string
  environment: BingxEnvironment
  reservationId: string
}) {
  return withDatabaseTransaction(async (client) => {
    const accountId = await requireExchangeAccountId(input.userId, input.environment, input.exchangeAccountId, client)
    const current = await selectRiskEntryReservationById(input.userId, accountId, input.reservationId, client, true)
    if (!current) return { reservation: undefined, dailyState: undefined, incremented: false }
    let incremented = false
    if (current.status === 'ACTIVE' || current.status === 'ATTACHED') {
      const now = Date.now()
      const update = await queryDatabase(`
        UPDATE risk_entry_reservations SET status = 'CONSUMED', updated_at = $1, resolved_at = $2
        WHERE user_id = $3 AND exchange_account_id = $4 AND id = $5 AND status IN ('ACTIVE', 'ATTACHED')
      `, [now, now, input.userId, accountId, input.reservationId], client)
      if (update.rowCount === 1) {
        await queryDatabase(`
          UPDATE risk_daily_state SET trade_count = trade_count + 1, updated_at = $1
          WHERE user_id = $2 AND exchange_account_id = $3 AND trading_day = $4
        `, [now, current.user_id, accountId, current.trading_day], client)
        incremented = true
      }
    }
    const reservationRow = await selectRiskEntryReservationById(input.userId, accountId, input.reservationId, client)
    const dailyRow = await selectRiskDailyState(current.user_id, accountId, current.trading_day, client)
    return {
      reservation: reservationRow ? riskEntryReservation(reservationRow) : undefined,
      dailyState: dailyRow ? riskDailyState(dailyRow) : undefined,
      incremented,
    }
  })
}

export async function incrementRiskTradeCount(input: RiskDailyStateInput & { amount?: number }) {
  const amount = input.amount ?? 1
  assertNonNegativeInteger('Trade count increment', amount)
  if (amount === 0) throw new Error('Trade count increment must be positive')
  return withDatabaseTransaction(async (client) => {
    const current = await ensureRiskDailyState(input, client, true)
    const updated = (await queryDatabase<RiskDailyStateRow>(`
      UPDATE risk_daily_state SET trade_count = trade_count + $1, updated_at = $2
      WHERE user_id = $3 AND exchange_account_id = $4 AND trading_day = $5
      RETURNING exchange_account_id, user_id, environment, trading_day, timezone, trade_count,
        opening_equity_micros, last_equity_micros, initialized, created_at, updated_at
    `, [amount, Date.now(), input.userId, current.exchange_account_id, input.tradingDay], client)).rows[0]
    if (!updated) throw new Error('Risk daily state disappeared while incrementing trade count')
    return riskDailyState(updated)
  })
}

export type RiskPositionStateInput = {
  userId: string
  exchangeAccountId?: string
  environment: BingxEnvironment
  positionKey: string
  positionId?: string
  symbol: string
  side: string
  quantity: string
  status?: RiskPositionStatus
  origin?: RiskPositionOrigin
  missedSnapshots?: number
  enforcementStatus?: RiskPositionEnforcementStatus
  openedAt?: number
  lastSeenAt?: number
}

function normalizedRiskPositionInput(input: RiskPositionStateInput, now = Date.now()) {
  assertNonEmpty('Position key', input.positionKey)
  assertNonEmpty('Position symbol', input.symbol)
  assertNonEmpty('Position side', input.side)
  assertNonEmpty('Position quantity', input.quantity)
  assertEnvironment(input.environment)
  const missedSnapshots = input.missedSnapshots ?? 0
  assertNonNegativeInteger('Missed snapshots', missedSnapshots)
  const openedAt = input.openedAt ?? now
  const lastSeenAt = input.lastSeenAt ?? now
  assertSafeInteger('Position opened at', openedAt)
  assertSafeInteger('Position last seen at', lastSeenAt)
  return {
    ...input,
    positionId: input.positionId ?? '',
    status: input.status ?? 'OPEN' as RiskPositionStatus,
    origin: input.origin ?? 'UNKNOWN' as RiskPositionOrigin,
    missedSnapshots,
    enforcementStatus: input.enforcementStatus ?? 'NONE' as RiskPositionEnforcementStatus,
    openedAt,
    lastSeenAt,
    now,
  }
}

function riskPositionState(row: RiskPositionStateRow): RiskPositionState {
  return {
    ...(row.exchange_account_id ? { exchangeAccountId: row.exchange_account_id } : {}),
    userId: row.user_id,
    environment: row.environment,
    positionKey: row.position_key,
    positionId: row.position_id,
    symbol: row.symbol,
    side: row.side,
    quantity: row.quantity,
    status: row.status,
    origin: row.origin,
    missedSnapshots: Number(row.missed_snapshots),
    enforcementStatus: row.enforcement_status,
    openedAt: Number(row.opened_at),
    lastSeenAt: Number(row.last_seen_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

const positionStateColumns = `exchange_account_id, user_id, environment, position_key, position_id, symbol, side, quantity,
  status, origin, missed_snapshots, enforcement_status, opened_at, last_seen_at, created_at, updated_at`

async function selectRiskPositionState(userId: string, exchangeAccountId: string, positionKey: string, client?: PoolClient) {
  return (await queryDatabase<RiskPositionStateRow>(`
    SELECT ${positionStateColumns} FROM risk_position_state
    WHERE user_id = $1 AND exchange_account_id = $2 AND position_key = $3
  `, [userId, exchangeAccountId, positionKey], client)).rows[0]
}

export async function initializeRiskPositionState(input: RiskPositionStateInput) {
  const value = normalizedRiskPositionInput(input)
  return withDatabaseTransaction(async (client) => {
    const accountId = await requireExchangeAccountId(value.userId, value.environment, value.exchangeAccountId, client)
    await queryDatabase(`
      INSERT INTO risk_position_state (
        user_id, environment, exchange_account_id, position_key, position_id, symbol, side, quantity, status, origin,
        missed_snapshots, enforcement_status, opened_at, last_seen_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      ON CONFLICT(exchange_account_id, position_key) DO NOTHING
    `, [
      value.userId, value.environment, accountId, value.positionKey, value.positionId, value.symbol, value.side,
      value.quantity, value.status, value.origin, value.missedSnapshots, value.enforcementStatus,
      value.openedAt, value.lastSeenAt, value.now, value.now,
    ], client)
    const row = await selectRiskPositionState(value.userId, accountId, value.positionKey, client)
    if (!row) throw new Error('Risk position state could not be initialized')
    return riskPositionState(row)
  })
}

export async function reconcileRiskPositionState(input: RiskPositionStateInput) {
  const value = normalizedRiskPositionInput(input)
  const accountId = await requireExchangeAccountId(value.userId, value.environment, value.exchangeAccountId)
  const row = (await queryDatabase<RiskPositionStateRow>(`
    INSERT INTO risk_position_state (
      user_id, environment, exchange_account_id, position_key, position_id, symbol, side, quantity, status, origin,
      missed_snapshots, enforcement_status, opened_at, last_seen_at, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
    ON CONFLICT(exchange_account_id, position_key) DO UPDATE SET
      position_id = EXCLUDED.position_id, symbol = EXCLUDED.symbol, side = EXCLUDED.side,
      quantity = EXCLUDED.quantity, status = EXCLUDED.status, origin = EXCLUDED.origin,
      missed_snapshots = EXCLUDED.missed_snapshots,
      enforcement_status = EXCLUDED.enforcement_status,
      opened_at = CASE
        WHEN risk_position_state.status = 'CLOSED' AND EXCLUDED.status = 'OPEN' THEN EXCLUDED.opened_at
        ELSE risk_position_state.opened_at
      END,
      last_seen_at = EXCLUDED.last_seen_at, updated_at = EXCLUDED.updated_at
    RETURNING ${positionStateColumns}
  `, [
    value.userId, value.environment, accountId, value.positionKey, value.positionId, value.symbol, value.side,
    value.quantity, value.status, value.origin, value.missedSnapshots, value.enforcementStatus,
    value.openedAt, value.lastSeenAt, value.now, value.now,
  ])).rows[0]
  if (!row) throw new Error('Risk position state could not be reconciled')
  return riskPositionState(row)
}

export async function getRiskPositionState(userId: string, environment: BingxEnvironment, positionKey: string, exchangeAccountId?: string) {
  const accountId = await requireExchangeAccountId(userId, environment, exchangeAccountId)
  const row = await selectRiskPositionState(userId, accountId, positionKey)
  return row ? riskPositionState(row) : undefined
}

export async function listRiskPositionStates(userId: string, environment: BingxEnvironment, exchangeAccountId?: string) {
  const accountId = await requireExchangeAccountId(userId, environment, exchangeAccountId)
  const result = await queryDatabase<RiskPositionStateRow>(`
    SELECT ${positionStateColumns} FROM risk_position_state
    WHERE user_id = $1 AND exchange_account_id = $2 ORDER BY updated_at DESC, position_key
  `, [userId, accountId])
  return result.rows.map(riskPositionState)
}

export async function deleteRiskPositionState(userId: string, environment: BingxEnvironment, positionKey: string, exchangeAccountId?: string) {
  const accountId = await requireExchangeAccountId(userId, environment, exchangeAccountId)
  const result = await queryDatabase(
    'DELETE FROM risk_position_state WHERE user_id = $1 AND exchange_account_id = $2 AND position_key = $3',
    [userId, accountId, positionKey],
  )
  return result.rowCount === 1
}

export type RiskProtectionStateInput = {
  userId: string
  exchangeAccountId?: string
  environment: BingxEnvironment
  positionKey: string
  positionId: string
  symbol: string
  direction: 'LONG' | 'SHORT'
  entryPrice: string
  bestPrice: string
  triggered?: boolean
  active?: boolean
  missingCount?: number
  managedOrderId?: string
  managedStopPrice?: string
  managedQuantity?: string
  managedPlacedAt?: number
  failureCount?: number
  retryAt?: number
  lastActionAt?: number
}

function riskProtectionState(row: RiskProtectionStateRow): RiskProtectionState {
  return {
    ...(row.exchange_account_id ? { exchangeAccountId: row.exchange_account_id } : {}),
    userId: row.user_id,
    environment: row.environment,
    positionKey: row.position_key,
    positionId: row.position_id,
    symbol: row.symbol,
    direction: row.direction,
    entryPrice: row.entry_price,
    bestPrice: row.best_price,
    triggered: Boolean(row.triggered),
    active: Boolean(row.active),
    missingCount: Number(row.missing_count),
    managedOrderId: row.managed_order_id,
    ...(row.managed_stop_price === null ? {} : { managedStopPrice: row.managed_stop_price }),
    managedQuantity: row.managed_quantity,
    ...(row.managed_placed_at === null ? {} : { managedPlacedAt: Number(row.managed_placed_at) }),
    failureCount: Number(row.failure_count),
    retryAt: Number(row.retry_at),
    ...(row.last_action_at === null ? {} : { lastActionAt: Number(row.last_action_at) }),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

const protectionStateColumns = `exchange_account_id, user_id, environment, position_key, position_id, symbol, direction,
  entry_price, best_price, triggered, active, missing_count, managed_order_id, managed_stop_price,
  managed_quantity, managed_placed_at, failure_count, retry_at, last_action_at, created_at, updated_at`

async function selectRiskProtectionState(userId: string, exchangeAccountId: string, positionKey: string) {
  return (await queryDatabase<RiskProtectionStateRow>(`
    SELECT ${protectionStateColumns} FROM risk_protection_state
    WHERE user_id = $1 AND exchange_account_id = $2 AND position_key = $3
  `, [userId, exchangeAccountId, positionKey])).rows[0]
}

export async function getRiskProtectionState(userId: string, environment: BingxEnvironment, positionKey: string, exchangeAccountId?: string) {
  const accountId = await requireExchangeAccountId(userId, environment, exchangeAccountId)
  const row = await selectRiskProtectionState(userId, accountId, positionKey)
  return row ? riskProtectionState(row) : undefined
}

export async function listRiskProtectionStates(userId: string, environment: BingxEnvironment, exchangeAccountId?: string) {
  const accountId = await requireExchangeAccountId(userId, environment, exchangeAccountId)
  const result = await queryDatabase<RiskProtectionStateRow>(`
    SELECT ${protectionStateColumns} FROM risk_protection_state
    WHERE user_id = $1 AND exchange_account_id = $2 ORDER BY updated_at DESC, position_key
  `, [userId, accountId])
  return result.rows.map(riskProtectionState)
}

export async function reconcileRiskProtectionState(input: RiskProtectionStateInput) {
  assertEnvironment(input.environment)
  assertNonEmpty('Position key', input.positionKey)
  assertNonEmpty('Position ID', input.positionId)
  assertNonEmpty('Position symbol', input.symbol)
  assertNonEmpty('Entry price', input.entryPrice)
  assertNonEmpty('Best price', input.bestPrice)
  const missingCount = input.missingCount ?? 0
  const failureCount = input.failureCount ?? 0
  const retryAt = input.retryAt ?? 0
  assertNonNegativeInteger('Protection missing count', missingCount)
  assertNonNegativeInteger('Protection failure count', failureCount)
  assertSafeInteger('Protection retry time', retryAt)
  if (input.managedPlacedAt !== undefined) assertSafeInteger('Managed stop placement time', input.managedPlacedAt)
  if (input.lastActionAt !== undefined) assertSafeInteger('Protection action time', input.lastActionAt)
  const now = Date.now()
  const accountId = await requireExchangeAccountId(input.userId, input.environment, input.exchangeAccountId)
  const row = (await queryDatabase<RiskProtectionStateRow>(`
    INSERT INTO risk_protection_state (
      user_id, environment, exchange_account_id, position_key, position_id, symbol, direction, entry_price,
      best_price, triggered, active, missing_count, managed_order_id, managed_stop_price,
      managed_quantity, managed_placed_at, failure_count, retry_at, last_action_at,
      created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
    ON CONFLICT(exchange_account_id, position_key) DO UPDATE SET
      position_id = EXCLUDED.position_id, symbol = EXCLUDED.symbol,
      direction = EXCLUDED.direction, entry_price = EXCLUDED.entry_price,
      best_price = EXCLUDED.best_price, triggered = EXCLUDED.triggered,
      active = EXCLUDED.active, missing_count = EXCLUDED.missing_count,
      managed_order_id = EXCLUDED.managed_order_id, managed_stop_price = EXCLUDED.managed_stop_price,
      managed_quantity = EXCLUDED.managed_quantity, managed_placed_at = EXCLUDED.managed_placed_at,
      failure_count = EXCLUDED.failure_count, retry_at = EXCLUDED.retry_at,
      last_action_at = EXCLUDED.last_action_at, updated_at = EXCLUDED.updated_at
    RETURNING ${protectionStateColumns}
  `, [
    input.userId, input.environment, accountId, input.positionKey, input.positionId, input.symbol,
    input.direction, input.entryPrice, input.bestPrice, input.triggered ?? false,
    input.active !== false, missingCount, input.managedOrderId ?? '', input.managedStopPrice ?? null,
    input.managedQuantity ?? '0', input.managedPlacedAt ?? null, failureCount, retryAt,
    input.lastActionAt ?? null, now, now,
  ])).rows[0]
  if (!row) throw new Error('Risk protection state could not be reconciled')
  return riskProtectionState(row)
}

function riskStreakState(row: RiskStreakStateRow): RiskStreakState {
  return {
    ...(row.exchange_account_id ? { exchangeAccountId: row.exchange_account_id } : {}),
    userId: row.user_id,
    environment: row.environment,
    tradingDay: row.trading_day,
    timezone: row.timezone,
    consecutiveLosses: Number(row.consecutive_losses),
    cooldownUntil: Number(row.cooldown_until),
    ...(row.last_outcome_at === null ? {} : { lastOutcomeAt: Number(row.last_outcome_at) }),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

const streakStateSelect = `
  SELECT exchange_account_id, user_id, environment, trading_day, timezone, consecutive_losses,
    cooldown_until, last_outcome_at, created_at, updated_at FROM risk_streak_state
`

async function selectRiskStreakState(
  userId: string,
  exchangeAccountId: string,
  tradingDay: string,
  client?: PoolClient,
  lock = false,
) {
  return (await queryDatabase<RiskStreakStateRow>(`${streakStateSelect}
    WHERE user_id = $1 AND exchange_account_id = $2 AND trading_day = $3${lock ? ' FOR UPDATE' : ''}
  `, [userId, exchangeAccountId, tradingDay], client)).rows[0]
}

export async function getRiskStreakState(userId: string, environment: BingxEnvironment, tradingDay: string, exchangeAccountId?: string) {
  const accountId = await requireExchangeAccountId(userId, environment, exchangeAccountId)
  const row = await selectRiskStreakState(userId, accountId, tradingDay)
  return row ? riskStreakState(row) : undefined
}

async function ensureRiskStreakState(input: {
  userId: string
  exchangeAccountId?: string
  environment: BingxEnvironment
  tradingDay: string
  timezone: string
}, client: PoolClient, lock = false) {
  assertEnvironment(input.environment)
  assertTradingDay(input.tradingDay)
  assertNonEmpty('Timezone', input.timezone)
  const now = Date.now()
  const accountId = await requireExchangeAccountId(input.userId, input.environment, input.exchangeAccountId, client)
  await queryDatabase(`
    INSERT INTO risk_streak_state (
      user_id, environment, exchange_account_id, trading_day, timezone, consecutive_losses, cooldown_until,
      last_outcome_at, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, 0, 0, NULL, $6, $7)
    ON CONFLICT(exchange_account_id, trading_day) DO NOTHING
  `, [input.userId, input.environment, accountId, input.tradingDay, input.timezone, now, now], client)
  const row = await selectRiskStreakState(input.userId, accountId, input.tradingDay, client, lock)
  if (!row) throw new Error('Risk streak state could not be created')
  return row
}

export async function getOrCreateRiskStreakState(input: {
  userId: string
  exchangeAccountId?: string
  environment: BingxEnvironment
  tradingDay: string
  timezone: string
}) {
  return withDatabaseTransaction(async (client) => riskStreakState(await ensureRiskStreakState(input, client)))
}

export async function processRiskTradeOutcomes(input: {
  userId: string
  exchangeAccountId?: string
  environment: BingxEnvironment
  tradingDay: string
  timezone: string
  outcomes: RiskTradeOutcomeInput[]
  maxConsecutiveLosses?: number
  cooldownMinutes?: number
  blockUntil?: number
}) {
  return withDatabaseTransaction(async (client) => {
    let current = await ensureRiskStreakState(input, client, true)
    let inserted = 0
    for (const outcome of [...input.outcomes].sort((left, right) => left.closedAt - right.closedAt)) {
      assertNonEmpty('Outcome key', outcome.outcomeKey)
      assertSafeInteger('Outcome PnL', outcome.netPnlMicros)
      assertSafeInteger('Outcome close time', outcome.closedAt)
      const classification = outcome.netPnlMicros < 0 ? 'LOSS' : outcome.netPnlMicros > 0 ? 'WIN' : 'BREAKEVEN'
      const result = await queryDatabase<{ outcome_key: string }>(`
        INSERT INTO risk_trade_outcomes (
          user_id, environment, exchange_account_id, trading_day, outcome_key, order_id, net_pnl_micros,
          outcome, closed_at, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT(exchange_account_id, outcome_key) DO NOTHING
        RETURNING outcome_key
      `, [
        input.userId, input.environment, current.exchange_account_id, input.tradingDay, outcome.outcomeKey,
        outcome.orderId, outcome.netPnlMicros, classification, outcome.closedAt, Date.now(),
      ], client)
      if (result.rows.length !== 1) continue
      inserted += 1
      const consecutiveLosses = classification === 'LOSS'
        ? Number(current.consecutive_losses) + 1
        : classification === 'WIN' ? 0 : Number(current.consecutive_losses)
      let cooldownUntil = classification === 'WIN' ? 0 : Number(current.cooldown_until)
      if (classification === 'LOSS' && input.maxConsecutiveLosses !== undefined && consecutiveLosses >= input.maxConsecutiveLosses) {
        cooldownUntil = input.cooldownMinutes && input.cooldownMinutes > 0
          ? Math.max(cooldownUntil, outcome.closedAt + input.cooldownMinutes * 60_000)
          : Math.max(cooldownUntil, input.blockUntil ?? 0)
      }
      const updated = (await queryDatabase<RiskStreakStateRow>(`
        UPDATE risk_streak_state SET consecutive_losses = $1, cooldown_until = $2,
          last_outcome_at = $3, updated_at = $4
        WHERE user_id = $5 AND exchange_account_id = $6 AND trading_day = $7
        RETURNING exchange_account_id, user_id, environment, trading_day, timezone,
          consecutive_losses, cooldown_until, last_outcome_at, created_at, updated_at
      `, [
        consecutiveLosses, cooldownUntil, outcome.closedAt, Date.now(),
        input.userId, current.exchange_account_id, input.tradingDay,
      ], client)).rows[0]
      if (!updated) throw new Error('Risk streak state disappeared while applying outcomes')
      current = updated
    }
    return { state: riskStreakState(current), inserted }
  })
}

export type RecordRiskEventInput = {
  userId: string
  exchangeAccountId?: string
  environment: BingxEnvironment
  tradingDay?: string
  eventKey: string
  rule: string
  action: string
  source: string
  result: string
  metadata?: Record<string, unknown>
  createdAt?: number
}

function riskEvent(row: RiskEventRow): RiskEvent {
  return {
    id: row.id,
    ...(row.exchange_account_id ? { exchangeAccountId: row.exchange_account_id } : {}),
    userId: row.user_id,
    environment: row.environment,
    ...(row.trading_day ? { tradingDay: row.trading_day } : {}),
    eventKey: row.event_key,
    rule: row.rule_name,
    action: row.action,
    source: row.source,
    result: row.result,
    metadata: jsonObject(row.metadata_json),
    createdAt: Number(row.created_at),
  }
}

const riskEventColumns = `id, exchange_account_id, user_id, environment, trading_day, event_key,
  rule_name, action, source, result, metadata_json, created_at`

export async function recordRiskEvent(input: RecordRiskEventInput) {
  assertEnvironment(input.environment)
  if (input.tradingDay !== undefined) assertTradingDay(input.tradingDay)
  assertNonEmpty('Risk event key', input.eventKey)
  assertNonEmpty('Risk event rule', input.rule)
  assertNonEmpty('Risk event action', input.action)
  assertNonEmpty('Risk event source', input.source)
  assertNonEmpty('Risk event result', input.result)
  const createdAt = input.createdAt ?? Date.now()
  assertSafeInteger('Risk event created at', createdAt)
  return withDatabaseTransaction(async (client) => {
    const accountId = await requireExchangeAccountId(input.userId, input.environment, input.exchangeAccountId, client)
    const existing = (await queryDatabase<RiskEventRow>(`
      SELECT ${riskEventColumns} FROM risk_events
      WHERE user_id = $1 AND exchange_account_id = $2 AND event_key = $3
    `, [input.userId, accountId, input.eventKey], client)).rows[0]
    if (existing) return { event: riskEvent(existing), inserted: false }
    const insert = await queryDatabase<{ id: string }>(`
      INSERT INTO risk_events (
        id, user_id, environment, exchange_account_id, trading_day, event_key, rule_name, action, source,
        result, metadata_json, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
      ON CONFLICT(exchange_account_id, event_key) DO NOTHING
      RETURNING id
    `, [
      crypto.randomUUID(), input.userId, input.environment, accountId, input.tradingDay ?? null, input.eventKey,
      input.rule, input.action, input.source, input.result, JSON.stringify(input.metadata ?? {}), createdAt,
    ], client)
    const row = (await queryDatabase<RiskEventRow>(`
      SELECT ${riskEventColumns} FROM risk_events
      WHERE user_id = $1 AND exchange_account_id = $2 AND event_key = $3
    `, [input.userId, accountId, input.eventKey], client)).rows[0]
    if (!row) throw new Error('Risk event could not be recorded')
    return { event: riskEvent(row), inserted: insert.rows.some((inserted) => inserted.id === row.id) }
  })
}

export async function listRiskEvents(
  userId: string,
  environment: BingxEnvironment,
  options: { limit?: number; before?: number; exchangeAccountId?: string } = {},
) {
  const limit = options.limit ?? 100
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Risk event limit must be between 1 and 500')
  if (options.before !== undefined) assertSafeInteger('Risk event cursor', options.before)
  const accountId = await requireExchangeAccountId(userId, environment, options.exchangeAccountId)
  const result = options.before === undefined
    ? await queryDatabase<RiskEventRow>(`
        SELECT ${riskEventColumns} FROM risk_events WHERE user_id = $1 AND exchange_account_id = $2
        ORDER BY created_at DESC, id DESC LIMIT $3
      `, [userId, accountId, limit])
    : await queryDatabase<RiskEventRow>(`
        SELECT ${riskEventColumns} FROM risk_events
        WHERE user_id = $1 AND exchange_account_id = $2 AND created_at < $3
        ORDER BY created_at DESC, id DESC LIMIT $4
      `, [userId, accountId, options.before, limit])
  return result.rows.map(riskEvent)
}

export async function hasRiskEvent(userId: string, environment: BingxEnvironment, eventKey: string, exchangeAccountId?: string) {
  assertNonEmpty('Risk event key', eventKey)
  const accountId = await requireExchangeAccountId(userId, environment, exchangeAccountId)
  const result = await queryDatabase(
    'SELECT 1 AS found FROM risk_events WHERE user_id = $1 AND exchange_account_id = $2 AND event_key = $3 LIMIT 1',
    [userId, accountId, eventKey],
  )
  return result.rowCount === 1
}

export async function getRiskRuntimeStatus(userId: string, environment: BingxEnvironment, tradingDay: string, exchangeAccountId?: string) {
  const accountId = await requireExchangeAccountId(userId, environment, exchangeAccountId)
  const [dailyState, reservationResult, positionResult, events, streakState, protectionResult] = await Promise.all([
    getRiskDailyState(userId, environment, tradingDay, accountId),
    queryDatabase<{ active: number; attached: number; blocked: number }>(`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('ACTIVE', 'ATTACHED'))::int AS active,
        COUNT(*) FILTER (WHERE status = 'ATTACHED')::int AS attached,
        COUNT(*) FILTER (WHERE status = 'BLOCKED')::int AS blocked
      FROM risk_entry_reservations WHERE user_id = $1 AND exchange_account_id = $2 AND trading_day = $3
    `, [userId, accountId, tradingDay]),
    queryDatabase<{ open: number; external: number; pending_enforcement: number }>(`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('OPEN', 'MISSING'))::int AS open,
        COUNT(*) FILTER (WHERE status IN ('OPEN', 'MISSING') AND origin = 'EXTERNAL')::int AS external,
        COUNT(*) FILTER (WHERE enforcement_status = 'PENDING')::int AS pending_enforcement
      FROM risk_position_state WHERE user_id = $1 AND exchange_account_id = $2
    `, [userId, accountId]),
    listRiskEvents(userId, environment, { limit: 1, exchangeAccountId: accountId }),
    getRiskStreakState(userId, environment, tradingDay, accountId),
    queryDatabase<{ tracked: number; managed: number; breakeven: number }>(`
      SELECT
        COUNT(*) FILTER (WHERE active = TRUE)::int AS tracked,
        COUNT(*) FILTER (WHERE active = TRUE AND managed_stop_price IS NOT NULL)::int AS managed,
        COUNT(*) FILTER (WHERE active = TRUE AND triggered = TRUE)::int AS breakeven
      FROM risk_protection_state WHERE user_id = $1 AND exchange_account_id = $2
    `, [userId, accountId]),
  ])
  const reservationCounts = reservationResult.rows[0]
  const positionCounts = positionResult.rows[0]
  const protectionCounts = protectionResult.rows[0]
  const activeReservations = Number(reservationCounts?.active ?? 0)
  return {
    dailyState,
    activeReservations,
    attachedReservations: Number(reservationCounts?.attached ?? 0),
    blockedReservations: Number(reservationCounts?.blocked ?? 0),
    slotsUsed: (dailyState?.tradeCount ?? 0) + activeReservations,
    openPositions: Number(positionCounts?.open ?? 0),
    externalOpenPositions: Number(positionCounts?.external ?? 0),
    pendingEnforcements: Number(positionCounts?.pending_enforcement ?? 0),
    trackedProtections: Number(protectionCounts?.tracked ?? 0),
    managedProtections: Number(protectionCounts?.managed ?? 0),
    breakevenLatched: Number(protectionCounts?.breakeven ?? 0),
    streakState,
    lastEvent: events[0],
  }
}
