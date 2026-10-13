import {
  attachRiskEntryReservation,
  consumeRiskEntryReservation,
  getOrCreateRiskDailyState,
  getRiskRuntimeStatus,
  getRiskProtectionState,
  getRiskStreakState,
  hasRiskEvent,
  incrementRiskTradeCount,
  listRiskEntryReservations,
  listRiskMonitoringTargets,
  listRiskPositionStates,
  listRiskProtectionStates,
  loadRiskProfile,
  reconcileRiskPositionState,
  recordRiskEvent,
  reconcileRiskProtectionState,
  releaseRiskEntryReservation,
  reserveRiskEntry,
  processRiskTradeOutcomes,
  updateRiskDailyEquity,
  type RiskEntryReservation,
  type StoredRiskProfile,
} from './database'
import {
  cancelOpenOrder,
  closePosition,
  getAccountSnapshot,
  getOrderHistory,
  listTradableContracts,
  placeOrReplaceProtectiveStop,
  responseOrderIdentifier,
  updateLeverage,
  type BingxEnvironment,
  type BingxPosition,
  type PreparedOrder,
} from './bingxClient'
import { deriveMarkPrice, evaluatePositionRisk, evaluateProtection, protectiveStopOrders } from './riskAutomation'
import {
  getRmAccountWorkerState,
  setRmAccountWorkerState,
  withAccountLock,
  workerInstanceId,
  type RmAccountWorkerState,
} from './redis'
import {
  KeyedAsyncMutex,
  classifyEntry,
  computeTradingDay,
  evaluateRisk,
  nextTradingDayAt,
  positionKey,
  type PreparedOrderCandidate,
  type RiskAccountSnapshot,
  type RiskDecision,
} from './riskGuard'

type AccountSnapshot = Awaited<ReturnType<typeof getAccountSnapshot>>

export class RiskGuardError extends Error {
  readonly status = 409
  readonly code: string
  readonly rule: string | null
  readonly details: Record<string, string | number | boolean | null>

  constructor(decision: Extract<RiskDecision, { allowed: false }>) {
    super(decision.message)
    this.name = 'RiskGuardError'
    this.code = decision.code
    this.rule = decision.rule
    this.details = decision.details
  }
}

export const riskAccountMutex = new KeyedAsyncMutex()

const workerState = new Map<string, RmAccountWorkerState>()

function monitorKey(userId: string, exchangeAccountId: string) {
  return `${userId}:${exchangeAccountId}`
}

async function updateWorkerState(userId: string, exchangeAccountId: string, patch: Partial<RmAccountWorkerState>) {
  const state: RmAccountWorkerState = {
    ...workerState.get(monitorKey(userId, exchangeAccountId)),
    status: patch.status ?? workerState.get(monitorKey(userId, exchangeAccountId))?.status ?? 'IDLE',
    ...patch,
    workerInstanceId,
    updatedAt: Date.now(),
  }
  workerState.set(monitorKey(userId, exchangeAccountId), state)
  await setRmAccountWorkerState(exchangeAccountId, state)
  return state
}

function numeric(value: string | number | undefined) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function equityMicros(snapshot: AccountSnapshot) {
  const balance = snapshot.balances.find((item) => item.asset.toUpperCase() === 'USDT') ?? snapshot.balances[0]
  return Math.max(0, Math.round(numeric(balance?.equity) * 1_000_000))
}

function riskSnapshot(snapshot: AccountSnapshot): RiskAccountSnapshot {
  return {
    balances: snapshot.balances.map((item) => ({ asset: item.asset, equity: item.equity })),
    positions: snapshot.positions.map((item) => ({
      symbol: item.symbol,
      positionSide: item.positionSide,
      positionAmt: item.positionAmt,
      positionValue: item.positionValue,
      avgPrice: item.avgPrice,
    })),
  }
}

async function activeProfile(userId: string, exchangeAccountId?: string) {
  return await loadRiskProfile(userId, exchangeAccountId) as (StoredRiskProfile & { updatedAt: number }) | undefined
}

async function existingExternalRiskViolation(
  userId: string,
  environment: BingxEnvironment,
  exchangeAccountId: string | undefined,
  profile: StoredRiskProfile,
  snapshot: AccountSnapshot,
) {
  if (!profile.riskPerTrade.enabled) return undefined
  const externalKeys = new Set((await listRiskPositionStates(userId, environment, exchangeAccountId))
    .filter((state) => state.status === 'OPEN' && state.origin === 'EXTERNAL')
    .map((state) => state.positionKey))
  if (externalKeys.size === 0) return undefined
  const equity = equityMicros(snapshot) / 1_000_000

  for (const position of snapshot.positions.filter(openPosition)) {
    const keyForPosition = positionKey(position.symbol, position.positionSide)
    if (!externalKeys.has(keyForPosition)) continue
    const protection = await getRiskProtectionState(userId, environment, keyForPosition, exchangeAccountId)
    const assessment = evaluatePositionRisk({
      position,
      openOrders: snapshot.openOrders,
      equity,
      limitPercent: profile.riskPerTrade.value,
      managedStopPrice: protection?.active ? numeric(protection.managedStopPrice) : undefined,
      managedQuantity: protection?.active ? numeric(protection.managedQuantity) : undefined,
    })
    if (assessment.status === 'COMPLIANT') continue
    return { position, assessment }
  }
  return undefined
}

async function dailyContext(userId: string, environment: BingxEnvironment, exchangeAccountId: string | undefined, profile: StoredRiskProfile, snapshot: AccountSnapshot) {
  const tradingDay = computeTradingDay(Date.now(), profile.timezone || 'UTC')
  const micros = equityMicros(snapshot)
  const daily = await getOrCreateRiskDailyState({
    userId,
    exchangeAccountId,
    environment,
    tradingDay,
    timezone: profile.timezone || 'UTC',
    openingEquityMicros: micros,
    lastEquityMicros: micros,
    initialized: micros > 0,
  })
  if (micros > 0 && daily.lastEquityMicros !== micros) {
    await updateRiskDailyEquity({
      userId,
      exchangeAccountId,
      environment,
      tradingDay,
      timezone: profile.timezone || 'UTC',
      lastEquityMicros: micros,
    })
  }
  return { tradingDay, daily, equity: micros / 1_000_000 }
}

async function recordDecision(
  userId: string,
  environment: BingxEnvironment,
  exchangeAccountId: string | undefined,
  tradingDay: string,
  decision: Extract<RiskDecision, { allowed: false }>,
  source: 'TERMINAL' | 'EXTERNAL',
  requestId: string,
) {
  await recordRiskEvent({
    userId,
    exchangeAccountId,
    environment,
    tradingDay,
    eventKey: `blocked:${source}:${requestId}:${decision.code}`,
    rule: decision.rule,
    action: source === 'TERMINAL' ? 'BLOCK_ORDER' : 'DETECT_EXTERNAL_POSITION',
    source,
    result: 'BLOCKED',
    metadata: { message: decision.message, code: decision.code, ...decision.details },
  })
}

export function preparedOrderCandidate(prepared: PreparedOrder): PreparedOrderCandidate {
  return {
    symbol: prepared.input.symbol,
    direction: prepared.input.direction,
    leverage: prepared.preview.leverage,
    quantity: prepared.preview.quantity,
    entryPrice: prepared.preview.estimatedAveragePrice,
    notional: prepared.preview.notional,
    reduceOnly: prepared.input.reduceOnly,
    stopLossPrice: prepared.preview.stopLoss?.stopPrice,
  }
}

export async function assertLeverageAllowed(userId: string, leverage: number, exchangeAccountId?: string) {
  const profile = await activeProfile(userId, exchangeAccountId)
  if (!profile?.active || !profile.maxLeverage.enabled) return
  if (leverage <= profile.maxLeverage.value) return
  throw new RiskGuardError({
    allowed: false,
    code: 'MAX_LEVERAGE',
    rule: 'maxLeverage',
    message: `RM system blocked the change: ${leverage}x exceeds your ${profile.maxLeverage.value}x leverage limit.`,
    details: { requested: leverage, limit: profile.maxLeverage.value },
  })
}

export async function checkRisk(
  userId: string,
  environment: BingxEnvironment,
  snapshot: AccountSnapshot,
  candidate: PreparedOrderCandidate,
  source: 'TERMINAL' | 'EXTERNAL',
  requestId: string,
  exchangeAccountId?: string,
) {
  const profile = await activeProfile(userId, exchangeAccountId)
  if (!profile?.active) return { decision: { allowed: true } as const, profile, tradingDay: undefined, daily: undefined }
  const { tradingDay, daily, equity } = await dailyContext(userId, environment, exchangeAccountId, profile, snapshot)
  const classification = classifyEntry(candidate, riskSnapshot(snapshot).positions)
  const runtime = await getRiskRuntimeStatus(userId, environment, tradingDay, exchangeAccountId)
  const streak = await getRiskStreakState(userId, environment, tradingDay, exchangeAccountId)
  if (
    profile.maxConsecutiveLosses.enabled
    && streak
    && streak.consecutiveLosses >= Math.floor(profile.maxConsecutiveLosses.value)
    && streak.cooldownUntil > Date.now()
  ) {
    const decision = {
      allowed: false,
      code: profile.cooldownMinutes.enabled ? 'COOLDOWN_ACTIVE' : 'MAX_CONSECUTIVE_LOSSES',
      rule: profile.cooldownMinutes.enabled ? 'cooldownMinutes' : 'maxConsecutiveLosses',
      message: `RM system blocked the order after ${streak.consecutiveLosses} consecutive losses. Trading resumes at ${new Date(streak.cooldownUntil).toISOString()}.`,
      details: {
        consecutiveLosses: streak.consecutiveLosses,
        limit: Math.floor(profile.maxConsecutiveLosses.value),
        cooldownUntil: streak.cooldownUntil,
        timeZone: profile.timezone,
      },
    } as const
    await recordDecision(userId, environment, exchangeAccountId, tradingDay, decision, source, requestId)
    throw new RiskGuardError(decision)
  }
  const existingViolation = classification !== 'REDUCE_ONLY'
    ? await existingExternalRiskViolation(userId, environment, exchangeAccountId, profile, snapshot)
    : undefined
  if (existingViolation) {
    const { position, assessment } = existingViolation
    const unavailable = assessment.status === 'UNAVAILABLE'
    const unprotected = assessment.status === 'UNPROTECTED'
    const decision = {
      allowed: false,
      code: unavailable ? 'RISK_DATA_UNAVAILABLE' : unprotected ? 'STOP_LOSS_REQUIRED' : 'RISK_PER_TRADE',
      rule: 'riskPerTrade',
      message: unavailable
        ? `RM system blocked the order: risk data for the external ${position.symbol} ${position.positionSide} position is unavailable.`
        : unprotected
          ? `RM system blocked the order: the external ${position.symbol} ${position.positionSide} position has no full-size Stop Loss.`
          : `RM system blocked the order: the external ${position.symbol} ${position.positionSide} position risks ${assessment.riskPercent!.toFixed(2)}%, above the ${profile.riskPerTrade.value}% limit.`,
      details: {
        classification,
        externalPosition: true,
        symbol: position.symbol,
        side: position.positionSide,
        entryPrice: assessment.entryPrice,
        stopPrice: assessment.stopPrice ?? null,
        quantity: assessment.quantity,
        equity: assessment.equity,
        riskUsdt: assessment.riskUsdt ?? null,
        riskPercent: assessment.riskPercent ?? null,
        limit: profile.riskPerTrade.value,
      },
    } as const
    await recordDecision(userId, environment, exchangeAccountId, tradingDay, decision, source, requestId)
    throw new RiskGuardError(decision)
  }
  const decision = evaluateRisk({
    profile,
    snapshot: riskSnapshot(snapshot),
    candidate,
    daily: {
      usedTrades: daily.tradeCount,
      reservedTrades: runtime.activeReservations,
      openingEquity: daily.openingEquityMicros / 1_000_000,
      currentEquity: equity,
    },
  })
  if (!decision.allowed) {
    await recordDecision(userId, environment, exchangeAccountId, tradingDay, decision, source, requestId)
    throw new RiskGuardError(decision)
  }
  return { decision, profile, tradingDay, daily }
}

export async function reserveTerminalEntry(input: {
  userId: string
  exchangeAccountId?: string
  environment: BingxEnvironment
  snapshot: AccountSnapshot
  candidate: PreparedOrderCandidate
  requestId: string
}) {
  const result = await checkRisk(input.userId, input.environment, input.snapshot, input.candidate, 'TERMINAL', input.requestId, input.exchangeAccountId)
  const classification = classifyEntry(input.candidate, riskSnapshot(input.snapshot).positions)
  if (
    classification !== 'NEW_ENTRY'
    || !result.profile?.active
    || !result.profile.maxTradesPerDay.enabled
    || !result.tradingDay
  ) return { ...result, classification, reservation: undefined }

  const reserved = await reserveRiskEntry({
    userId: input.userId,
    exchangeAccountId: input.exchangeAccountId,
    environment: input.environment,
    tradingDay: result.tradingDay,
    timezone: result.profile.timezone,
    openingEquityMicros: result.daily?.openingEquityMicros,
    lastEquityMicros: result.daily?.lastEquityMicros,
    initialized: result.daily?.initialized,
    requestId: input.requestId,
    symbol: input.candidate.symbol,
    side: input.candidate.direction,
    maxTradesPerDay: Math.floor(result.profile.maxTradesPerDay.value),
  })
  if (!reserved.allowed) {
    const decision = {
      allowed: false,
      code: 'MAX_TRADES_PER_DAY',
      rule: 'maxTradesPerDay',
      message: `RM system blocked the order: the daily limit of ${reserved.maxTradesPerDay} trades has been reached.`,
      details: {
        used: reserved.dailyState.tradeCount,
        reserved: reserved.activeReservations,
        limit: reserved.maxTradesPerDay,
        timeZone: result.profile.timezone,
        resetAt: nextTradingDayAt(Date.now(), result.profile.timezone),
      },
    } as const
    await recordDecision(input.userId, input.environment, input.exchangeAccountId, result.tradingDay, decision, 'TERMINAL', input.requestId)
    throw new RiskGuardError(decision)
  }
  return { ...result, classification, reservation: reserved.reservation }
}

export async function attachTerminalReservation(userId: string, environment: BingxEnvironment, reservation: RiskEntryReservation | undefined, orderId: string, exchangeAccountId?: string) {
  if (!reservation) return
  await attachRiskEntryReservation({ userId, exchangeAccountId, environment, reservationId: reservation.id, orderId })
}

export async function consumeTerminalReservation(userId: string, environment: BingxEnvironment, reservation: RiskEntryReservation | undefined, exchangeAccountId?: string) {
  if (!reservation) return
  await consumeRiskEntryReservation({ userId, exchangeAccountId, environment, reservationId: reservation.id })
}

export async function confirmTerminalOrder(input: {
  userId: string
  exchangeAccountId?: string
  environment: BingxEnvironment
  reservation: RiskEntryReservation | undefined
  orderId: string
  candidate: PreparedOrderCandidate
  snapshot: AccountSnapshot
}) {
  if (!input.reservation) return
  await attachTerminalReservation(input.userId, input.environment, input.reservation, input.orderId, input.exchangeAccountId)
  const opened = input.snapshot.positions.find((position) => (
    openPosition(position)
    && position.symbol === input.candidate.symbol
    && position.positionSide === input.candidate.direction
  ))
  if (!opened) return
  await consumeTerminalReservation(input.userId, input.environment, input.reservation, input.exchangeAccountId)
  await reconcileRiskPositionState({
    userId: input.userId,
    exchangeAccountId: input.exchangeAccountId,
    environment: input.environment,
    positionKey: positionKey(opened.symbol, opened.positionSide),
    positionId: opened.positionId,
    symbol: opened.symbol,
    side: opened.positionSide,
    quantity: opened.positionAmt,
    status: 'OPEN',
    origin: 'TERMINAL',
    missedSnapshots: 0,
    enforcementStatus: 'NONE',
  })
}

export async function releaseTerminalReservation(userId: string, environment: BingxEnvironment, reservation: RiskEntryReservation | undefined, exchangeAccountId?: string) {
  if (!reservation) return
  await releaseRiskEntryReservation({ userId, exchangeAccountId, environment, reservationId: reservation.id })
}

export async function releaseTerminalReservationForOrder(userId: string, environment: BingxEnvironment, orderId: string, exchangeAccountId?: string) {
  const profile = await activeProfile(userId, exchangeAccountId)
  if (!profile) return
  const tradingDay = computeTradingDay(Date.now(), profile.timezone || 'UTC')
  const reservation = (await listRiskEntryReservations(userId, environment, tradingDay, exchangeAccountId))
    .find((item) => item.orderId === orderId && ['ACTIVE', 'ATTACHED'].includes(item.status))
  await releaseTerminalReservation(userId, environment, reservation, exchangeAccountId)
}

function isNetworkFailure(error: unknown) {
  return error instanceof TypeError || (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))
}

export function shouldReleaseReservationAfter(error: unknown) {
  return !isNetworkFailure(error)
}

function openPosition(position: BingxPosition) {
  return Math.abs(numeric(position.positionAmt)) > 0
}

function matchingReservation(reservations: RiskEntryReservation[], position: BingxPosition) {
  return reservations
    .filter((item) => ['ACTIVE', 'ATTACHED'].includes(item.status))
    .filter((item) => item.symbol === position.symbol && item.side === position.positionSide)
    .sort((left, right) => left.createdAt - right.createdAt)[0]
}

type MonitoringTarget = Awaited<ReturnType<typeof listRiskMonitoringTargets>>[number]

function mayAutomate(target: MonitoringTarget, allowLiveAutomation: boolean) {
  return target.environment !== 'prod-live' || allowLiveAutomation
}

function mayEnforceBreach(target: MonitoringTarget, allowLiveAutomation: boolean) {
  return mayAutomate(target, allowLiveAutomation) && target.profile.automationConsent
}

function isPendingEntryOrder(order: Record<string, unknown>) {
  const type = String(order.type ?? '').toUpperCase()
  return !type.includes('STOP')
    && !type.includes('TAKE_PROFIT')
    && order.reduceOnly !== true
    && order.reduceOnly !== 'true'
    && order.closePosition !== true
    && order.closePosition !== 'true'
}

async function syncLossStreak(target: MonitoringTarget, tradingDay: string) {
  if (!target.profile.maxConsecutiveLosses.enabled) return getRiskStreakState(target.userId, target.environment, tradingDay, target.accountId)
  const rows = await getOrderHistory(target.environment, target.credentials, 500)
  const outcomes = rows.flatMap((order) => {
    const row = order as Record<string, unknown>
    const realized = numeric(row.realizedPnl as string | number | undefined) || numeric(row.realisedPnl as string | number | undefined)
    const side = String(row.side ?? '').toUpperCase()
    const positionSide = String(row.positionSide ?? '').toUpperCase()
    const closingOrder = row.reduceOnly === true
      || row.reduceOnly === 'true'
      || row.closePosition === true
      || row.closePosition === 'true'
      || (positionSide === 'LONG' && side === 'SELL')
      || (positionSide === 'SHORT' && side === 'BUY')
      || Math.abs(realized) >= 1e-12
    if (!closingOrder) return []
    const timestamp = numeric(row.updateTime as string | number | undefined)
      || numeric(row.time as string | number | undefined)
      || numeric(row.createTime as string | number | undefined)
    if (!(timestamp > 0) || computeTradingDay(timestamp, target.profile.timezone) !== tradingDay) return []
    const orderId = String(row.orderId ?? row.orderID ?? '')
    if (!orderId) return []
    const fee = numeric(row.fee as string | number | undefined) || numeric(row.commission as string | number | undefined)
    return [{
      outcomeKey: `order:${orderId}`,
      orderId,
      netPnlMicros: Math.round((realized + fee) * 1_000_000),
      closedAt: Math.trunc(timestamp),
    }]
  })
  const result = await processRiskTradeOutcomes({
    userId: target.userId,
    exchangeAccountId: target.accountId,
    environment: target.environment,
    tradingDay,
    timezone: target.profile.timezone,
    outcomes,
    maxConsecutiveLosses: Math.floor(target.profile.maxConsecutiveLosses.value),
    cooldownMinutes: target.profile.cooldownMinutes.enabled ? target.profile.cooldownMinutes.value : undefined,
    blockUntil: nextTradingDayAt(Date.now(), target.profile.timezone),
  })
  if (
    result.inserted > 0
    && result.state.consecutiveLosses >= Math.floor(target.profile.maxConsecutiveLosses.value)
  ) {
    await recordRiskEvent({
      userId: target.userId,
      exchangeAccountId: target.accountId,
      environment: target.environment,
      tradingDay,
      eventKey: `loss-streak:${tradingDay}:${result.state.lastOutcomeAt ?? Date.now()}`,
      rule: 'maxConsecutiveLosses',
      action: 'START_COOLDOWN',
      source: 'SYSTEM',
      result: 'BLOCKED',
      metadata: {
        message: `New entries paused after ${result.state.consecutiveLosses} consecutive losses.`,
        consecutiveLosses: result.state.consecutiveLosses,
        cooldownUntil: result.state.cooldownUntil,
      },
    })
  }
  return result.state
}

async function reconcileEntryReservations(
  target: MonitoringTarget,
  snapshot: AccountSnapshot,
  tradingDay: string,
) {
  const unresolved = (await listRiskEntryReservations(target.userId, target.environment, tradingDay, target.accountId))
    .filter((reservation) => ['ACTIVE', 'ATTACHED'].includes(reservation.status))
  if (!unresolved.length) return
  const openOrderIds = new Set(snapshot.openOrders
    .map((order) => String(order.orderId ?? order.orderID ?? ''))
    .filter(Boolean))
  const now = Date.now()
  const attachedMissing = unresolved.filter((reservation) => (
    reservation.status === 'ATTACHED'
    && reservation.orderId
    && !openOrderIds.has(reservation.orderId)
    && now - reservation.createdAt >= 30_000
  ))
  const history = attachedMissing.length
    ? await getOrderHistory(target.environment, target.credentials, 500)
    : []
  const historyById = new Map(history.map((order) => [String(order.orderId ?? order.orderID ?? ''), order]))

  for (const reservation of unresolved) {
    if (reservation.status === 'ACTIVE') {
      if (now - reservation.createdAt < 5 * 60_000) continue
      await releaseRiskEntryReservation({ userId: target.userId, exchangeAccountId: target.accountId, environment: target.environment, reservationId: reservation.id })
      await recordRiskEvent({
        userId: target.userId, exchangeAccountId: target.accountId, environment: target.environment, tradingDay,
        eventKey: `reservation-timeout:${reservation.id}`, rule: 'maxTradesPerDay',
        action: 'RELEASE_UNCERTAIN_RESERVATION', source: 'SYSTEM', result: 'RELEASED',
        metadata: { requestId: reservation.requestId, symbol: reservation.symbol },
      })
      continue
    }
    if (!reservation.orderId || openOrderIds.has(reservation.orderId) || now - reservation.createdAt < 30_000) continue
    const order = historyById.get(reservation.orderId)
    const status = String(order?.status ?? '').toUpperCase()
    if (['FILLED', 'PARTIALLY_FILLED'].includes(status)) {
      await consumeRiskEntryReservation({ userId: target.userId, exchangeAccountId: target.accountId, environment: target.environment, reservationId: reservation.id })
    } else if (['CANCELED', 'CANCELLED', 'REJECTED', 'EXPIRED'].includes(status)) {
      await releaseRiskEntryReservation({ userId: target.userId, exchangeAccountId: target.accountId, environment: target.environment, reservationId: reservation.id })
    }
  }
}

async function dailyLossReached(target: MonitoringTarget, snapshot: AccountSnapshot, tradingDay: string) {
  if (!target.profile.dailyLossLimit.enabled) return false
  const runtime = await getRiskRuntimeStatus(target.userId, target.environment, tradingDay, target.accountId)
  const opening = (runtime.dailyState?.openingEquityMicros ?? 0) / 1_000_000
  const current = equityMicros(snapshot) / 1_000_000
  if (!(opening > 0) || !(current > 0)) return false
  const loss = Math.max(0, opening - current)
  return target.profile.dailyLossLimit.unit === 'USDT'
    ? loss >= target.profile.dailyLossLimit.value
    : loss / opening * 100 >= target.profile.dailyLossLimit.value
}

async function cancelPendingEntries(
  target: MonitoringTarget,
  snapshot: AccountSnapshot,
  tradingDay: string,
  allowLiveAutomation: boolean,
) {
  if (!mayEnforceBreach(target, allowLiveAutomation)) return false
  let changed = false
  for (const order of snapshot.openOrders.filter(isPendingEntryOrder)) {
    const id = String(order.orderId ?? order.orderID ?? '')
    const symbol = String(order.symbol ?? '')
    if (!id || !symbol) continue
    const eventKey = `cancel-entry:${tradingDay}:${id}`
    if (await hasRiskEvent(target.userId, target.environment, eventKey, target.accountId)) continue
    try {
      await cancelOpenOrder(target.environment, target.credentials, { symbol, orderId: id })
      await recordRiskEvent({
        userId: target.userId, exchangeAccountId: target.accountId, environment: target.environment, tradingDay, eventKey,
        rule: 'breachAction', action: 'CANCEL_PENDING_ORDER', source: 'SYSTEM', result: 'SUCCEEDED',
        metadata: { symbol, orderId: id },
      })
      changed = true
    } catch (error) {
      await recordRiskEvent({
        userId: target.userId, exchangeAccountId: target.accountId, environment: target.environment, tradingDay,
        eventKey: `${eventKey}:failed:${Math.floor(Date.now() / 30_000)}`,
        rule: 'breachAction', action: 'CANCEL_PENDING_ORDER', source: 'SYSTEM', result: 'FAILED',
        metadata: { symbol, orderId: id, message: error instanceof Error ? error.message : 'Unknown cancel error' },
      })
    }
  }
  return changed
}

async function closePositionsForBreach(
  target: MonitoringTarget,
  positions: BingxPosition[],
  tradingDay: string,
  rule: string,
  allowLiveAutomation: boolean,
) {
  if (!mayEnforceBreach(target, allowLiveAutomation)) return false
  let changed = false
  const breachEpoch = (await getRiskRuntimeStatus(target.userId, target.environment, tradingDay, target.accountId)).dailyState?.tradeCount ?? 0
  for (const position of positions.filter(openPosition)) {
    const eventKey = `close-all:${rule}:${tradingDay}:${position.positionId}:${breachEpoch}`
    if (await hasRiskEvent(target.userId, target.environment, eventKey, target.accountId)) continue
    try {
      await closePosition(target.environment, target.credentials, {
        positionId: position.positionId,
        clientOrderId: `rm-emergency-${crypto.randomUUID().replaceAll('-', '').slice(0, 18)}`,
      })
      await recordRiskEvent({
        userId: target.userId, exchangeAccountId: target.accountId, environment: target.environment, tradingDay, eventKey,
        rule, action: 'CLOSE_POSITION', source: 'SYSTEM', result: 'SUCCEEDED',
        metadata: { symbol: position.symbol, positionId: position.positionId },
      })
      changed = true
    } catch (error) {
      await recordRiskEvent({
        userId: target.userId, exchangeAccountId: target.accountId, environment: target.environment, tradingDay,
        eventKey: `${eventKey}:failed:${Math.floor(Date.now() / 30_000)}`,
        rule, action: 'CLOSE_POSITION', source: 'SYSTEM', result: 'FAILED',
        metadata: { symbol: position.symbol, positionId: position.positionId, message: error instanceof Error ? error.message : 'Unknown close error' },
      })
    }
  }
  return changed
}

async function applyAccountBreachPolicy(
  target: MonitoringTarget,
  snapshot: AccountSnapshot,
  tradingDay: string,
  rule: string,
  allowLiveAutomation: boolean,
) {
  const action = target.profile.breachAction
  if (action === 'BLOCK_NEW_ENTRIES') return false
  let changed = await cancelPendingEntries(target, snapshot, tradingDay, allowLiveAutomation)
  if (action === 'CLOSE_ALL') {
    changed = await closePositionsForBreach(target, snapshot.positions, tradingDay, rule, allowLiveAutomation) || changed
  }
  return changed
}

async function enforceLeverage(
  target: MonitoringTarget,
  position: BingxPosition,
  tradingDay: string,
  allowLiveAutomation: boolean,
) {
  if (!target.profile.maxLeverage.enabled || position.leverage <= target.profile.maxLeverage.value) return false
  if (target.profile.breachAction === 'BLOCK_NEW_ENTRIES' || !mayEnforceBreach(target, allowLiveAutomation)) return false
  const leverage = Math.max(1, Math.floor(target.profile.maxLeverage.value))
  const eventKey = `reduce-leverage:${position.positionId}:${position.leverage}:${leverage}:${Math.floor(Date.now() / 60_000)}`
  if (await hasRiskEvent(target.userId, target.environment, eventKey, target.accountId)) return false
  try {
    await updateLeverage(target.environment, target.credentials, {
      symbol: position.symbol,
      direction: position.positionSide,
      leverage,
    })
    await recordRiskEvent({
      userId: target.userId, exchangeAccountId: target.accountId, environment: target.environment, tradingDay, eventKey,
      rule: 'maxLeverage', action: 'REDUCE_LEVERAGE', source: 'SYSTEM', result: 'SUCCEEDED',
      metadata: { symbol: position.symbol, previous: position.leverage, leverage },
    })
    return true
  } catch (error) {
    await recordRiskEvent({
      userId: target.userId, exchangeAccountId: target.accountId, environment: target.environment, tradingDay,
      eventKey: `${eventKey}:failed:${Math.floor(Date.now() / 30_000)}`,
      rule: 'maxLeverage', action: 'REDUCE_LEVERAGE', source: 'SYSTEM', result: 'FAILED',
      metadata: { symbol: position.symbol, message: error instanceof Error ? error.message : 'Unknown leverage error' },
    })
    return false
  }
}

async function enforceExposure(
  target: MonitoringTarget,
  snapshot: AccountSnapshot,
  tradingDay: string,
  allowLiveAutomation: boolean,
) {
  if (!target.profile.maxExposurePercent.enabled) return false
  const equity = equityMicros(snapshot) / 1_000_000
  if (!(equity > 0)) return false
  const maximum = equity * target.profile.maxExposurePercent.value / 100
  const valued = snapshot.positions.filter(openPosition).map((position) => ({
    position,
    markPrice: deriveMarkPrice(position),
    notional: Math.abs(numeric(position.positionValue))
      || Math.abs(numeric(position.positionAmt)) * deriveMarkPrice(position),
  })).sort((left, right) => right.notional - left.notional)
  let excess = valued.reduce((sum, item) => sum + item.notional, 0) - maximum
  if (!(excess > 0)) return false
  await applyAccountBreachPolicy(target, snapshot, tradingDay, 'maxExposurePercent', allowLiveAutomation)
  if (target.profile.breachAction !== 'CLOSE_VIOLATING_POSITION' || !mayEnforceBreach(target, allowLiveAutomation)) return false

  let changed = false
  for (const item of valued) {
    if (!(excess > 0) || !(item.markPrice > 0)) break
    const available = Math.abs(numeric(item.position.availableAmt || item.position.positionAmt))
    const quantity = Math.min(available, excess / item.markPrice)
    if (!(quantity > 0)) continue
    const eventKey = `trim-exposure:${tradingDay}:${item.position.positionId}:${item.position.positionAmt}:${Math.round(maximum * 1_000_000)}`
    if (await hasRiskEvent(target.userId, target.environment, eventKey, target.accountId)) continue
    try {
      await closePosition(target.environment, target.credentials, {
        positionId: item.position.positionId,
        quantity,
        clientOrderId: `rm-trim-${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`,
      })
      await recordRiskEvent({
        userId: target.userId, exchangeAccountId: target.accountId, environment: target.environment, tradingDay, eventKey,
        rule: 'maxExposurePercent', action: 'TRIM_POSITION', source: 'SYSTEM', result: 'SUCCEEDED',
        metadata: { symbol: item.position.symbol, quantity, excess, maximum },
      })
      excess -= quantity * item.markPrice
      changed = true
    } catch (error) {
      await recordRiskEvent({
        userId: target.userId, exchangeAccountId: target.accountId, environment: target.environment, tradingDay,
        eventKey: `${eventKey}:failed:${Math.floor(Date.now() / 30_000)}`,
        rule: 'maxExposurePercent', action: 'TRIM_POSITION', source: 'SYSTEM', result: 'FAILED',
        metadata: { symbol: item.position.symbol, message: error instanceof Error ? error.message : 'Unknown trim error' },
      })
    }
  }
  return changed
}

async function enforceExternalRiskPerTrade(
  target: MonitoringTarget,
  snapshot: AccountSnapshot,
  position: BingxPosition,
  contract: Awaited<ReturnType<typeof listTradableContracts>>[number],
  tradingDay: string,
  allowLiveAutomation: boolean,
) {
  if (!target.profile.riskPerTrade.enabled) return false
  const keyForPosition = positionKey(position.symbol, position.positionSide)
  const tracked = (await listRiskPositionStates(target.userId, target.environment, target.accountId))
    .find((state) => state.positionKey === keyForPosition && state.status === 'OPEN')
  if (tracked?.origin !== 'EXTERNAL') return false
  if (tracked.enforcementStatus === 'PENDING' || tracked.enforcementStatus === 'SUCCEEDED') return false
  const protection = await getRiskProtectionState(target.userId, target.environment, keyForPosition, target.accountId)
  const assessment = evaluatePositionRisk({
    position,
    openOrders: snapshot.openOrders,
    equity: equityMicros(snapshot) / 1_000_000,
    limitPercent: target.profile.riskPerTrade.value,
    quantityPrecision: contract.quantityPrecision,
    managedStopPrice: protection?.active ? numeric(protection.managedStopPrice) : undefined,
    managedQuantity: protection?.active ? numeric(protection.managedQuantity) : undefined,
  })
  if (assessment.status === 'COMPLIANT') return false
  if (assessment.status === 'UNAVAILABLE') {
    await recordRiskEvent({
      userId: target.userId, exchangeAccountId: target.accountId, environment: target.environment, tradingDay,
      eventKey: `external-risk-unavailable:${position.positionId}:${Math.floor(Date.now() / 60_000)}`,
      rule: 'riskPerTrade', action: 'EVALUATE_EXTERNAL_POSITION', source: 'EXTERNAL', result: 'FAILED',
      metadata: { symbol: position.symbol, side: position.positionSide, message: assessment.reason },
    })
    return false
  }

  const missingStopKey = `external-risk-await-stop:${position.positionId}`
  if (assessment.status === 'UNPROTECTED' && !await hasRiskEvent(target.userId, target.environment, missingStopKey, target.accountId)) {
    await recordRiskEvent({
      userId: target.userId, exchangeAccountId: target.accountId, environment: target.environment, tradingDay, eventKey: missingStopKey,
      rule: 'riskPerTrade', action: 'WAIT_FOR_PROTECTIVE_STOP', source: 'EXTERNAL', result: 'PENDING',
      metadata: {
        symbol: position.symbol,
        side: position.positionSide,
        quantity: assessment.quantity,
        limit: assessment.limitPercent,
        message: 'Waiting one RM cycle for a full-size Stop Loss to appear on BingX.',
      },
    })
    return false
  }

  const violationKey = `external-risk-violation:${position.positionId}:${assessment.stopPrice ?? 'missing'}:${assessment.limitPercent}`
  await recordRiskEvent({
    userId: target.userId, exchangeAccountId: target.accountId, environment: target.environment, tradingDay, eventKey: violationKey,
    rule: 'riskPerTrade', action: 'DETECT_EXTERNAL_RISK', source: 'EXTERNAL', result: 'BLOCKED',
    metadata: {
      symbol: position.symbol,
      side: position.positionSide,
      entryPrice: assessment.entryPrice,
      stopPrice: assessment.stopPrice ?? null,
      quantity: assessment.quantity,
      equity: assessment.equity,
      riskUsdt: assessment.riskUsdt ?? null,
      riskPercent: assessment.riskPercent ?? null,
      limit: assessment.limitPercent,
      message: assessment.reason,
    },
  })

  if (target.profile.breachAction !== 'CLOSE_VIOLATING_POSITION') {
    return applyAccountBreachPolicy(target, snapshot, tradingDay, 'riskPerTrade', allowLiveAutomation)
  }
  const closeEventKey = `external-risk-close:${position.positionId}:${assessment.stopPrice ?? 'missing'}:${assessment.limitPercent}`
  if (await hasRiskEvent(target.userId, target.environment, closeEventKey, target.accountId)) return false
  const canClose = mayEnforceBreach(target, allowLiveAutomation)
  await reconcileRiskPositionState({
    userId: target.userId,
    exchangeAccountId: target.accountId,
    environment: target.environment,
    positionKey: keyForPosition,
    positionId: position.positionId,
    symbol: position.symbol,
    side: position.positionSide,
    quantity: position.positionAmt,
    origin: 'EXTERNAL',
    enforcementStatus: canClose ? 'PENDING' : 'FAILED',
  })
  if (!canClose) {
    await recordRiskEvent({
      userId: target.userId, exchangeAccountId: target.accountId, environment: target.environment, tradingDay,
      eventKey: `${closeEventKey}:unauthorized:${Math.floor(Date.now() / 300_000)}`,
      rule: 'riskPerTrade', action: 'CLOSE_EXTERNAL_POSITION', source: 'EXTERNAL', result: 'AUTOMATION_NOT_AUTHORIZED',
      metadata: {
        symbol: position.symbol,
        side: position.positionSide,
        userConsent: target.profile.automationConsent,
        liveAutomationEnabled: target.environment !== 'prod-live' || allowLiveAutomation,
      },
    })
    return false
  }
  try {
    await closePosition(target.environment, target.credentials, {
      positionId: position.positionId,
      clientOrderId: `rm-risk-${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`,
    })
    await reconcileRiskPositionState({
      userId: target.userId,
      exchangeAccountId: target.accountId,
      environment: target.environment,
      positionKey: keyForPosition,
      positionId: position.positionId,
      symbol: position.symbol,
      side: position.positionSide,
      quantity: position.positionAmt,
      status: 'OPEN',
      origin: 'EXTERNAL',
      enforcementStatus: 'SUCCEEDED',
    })
    await recordRiskEvent({
      userId: target.userId, exchangeAccountId: target.accountId, environment: target.environment, tradingDay, eventKey: closeEventKey,
      rule: 'riskPerTrade', action: 'CLOSE_EXTERNAL_POSITION', source: 'EXTERNAL', result: 'SUCCEEDED',
      metadata: {
        symbol: position.symbol,
        side: position.positionSide,
        riskPercent: assessment.riskPercent ?? null,
        limit: assessment.limitPercent,
      },
    })
    return true
  } catch (error) {
    await reconcileRiskPositionState({
      userId: target.userId,
      exchangeAccountId: target.accountId,
      environment: target.environment,
      positionKey: keyForPosition,
      positionId: position.positionId,
      symbol: position.symbol,
      side: position.positionSide,
      quantity: position.positionAmt,
      status: 'OPEN',
      origin: 'EXTERNAL',
      enforcementStatus: 'FAILED',
    })
    await recordRiskEvent({
      userId: target.userId, exchangeAccountId: target.accountId, environment: target.environment, tradingDay,
      eventKey: `${closeEventKey}:failed:${Math.floor(Date.now() / 30_000)}`,
      rule: 'riskPerTrade', action: 'CLOSE_EXTERNAL_POSITION', source: 'EXTERNAL', result: 'FAILED',
      metadata: { symbol: position.symbol, message: error instanceof Error ? error.message : 'Unknown close error' },
    })
    return false
  }
}

async function enforceProtection(
  target: MonitoringTarget,
  snapshot: AccountSnapshot,
  position: BingxPosition,
  contract: Awaited<ReturnType<typeof listTradableContracts>>[number],
  tradingDay: string,
  allowLiveAutomation: boolean,
) {
  if (!target.profile.fixedStopLoss.enabled && !target.profile.breakEven.enabled) return false
  const keyForPosition = positionKey(position.symbol, position.positionSide)
  const previous = await getRiskProtectionState(target.userId, target.environment, keyForPosition, target.accountId)
  const decision = evaluateProtection({
    position,
    openOrders: snapshot.openOrders,
    contract,
    profile: target.profile,
    markPrice: deriveMarkPrice(position),
    state: previous?.active ? {
      entryPrice: numeric(previous.entryPrice),
      bestPrice: numeric(previous.bestPrice),
      triggered: previous.triggered,
      managedOrderId: previous.managedOrderId,
      managedStopPrice: numeric(previous.managedStopPrice),
      managedQuantity: numeric(previous.managedQuantity),
      managedPlacedAt: previous.managedPlacedAt,
      retryAt: previous.retryAt,
    } : undefined,
  })
  const visibleStops = protectiveStopOrders(position, snapshot.openOrders)
  const visibleManaged = previous?.active && previous.managedOrderId
    ? visibleStops.find((order) => String(order.orderId ?? order.orderID ?? '') === previous.managedOrderId)
    : undefined
  const base = {
    userId: target.userId,
    exchangeAccountId: target.accountId,
    environment: target.environment,
    positionKey: keyForPosition,
    positionId: position.positionId,
    symbol: position.symbol,
    direction: position.positionSide,
    entryPrice: position.avgPrice,
    bestPrice: String(decision.bestPrice),
    triggered: decision.triggered,
    active: true,
    missingCount: 0,
    managedOrderId: visibleManaged ? previous!.managedOrderId : previous?.active ? previous.managedOrderId : '',
    managedStopPrice: visibleManaged ? String(visibleManaged.stopPrice ?? previous?.managedStopPrice ?? '') : previous?.active ? previous.managedStopPrice : undefined,
    managedQuantity: previous?.active ? previous.managedQuantity : '0',
    managedPlacedAt: previous?.active ? previous.managedPlacedAt : undefined,
    failureCount: previous?.active ? previous.failureCount : 0,
    retryAt: previous?.active ? previous.retryAt : 0,
    lastActionAt: previous?.active ? previous.lastActionAt : undefined,
  }

  if (decision.kind === 'NONE' || decision.kind === 'WAIT') {
    await reconcileRiskProtectionState(base)
    return false
  }
  if (!mayAutomate(target, allowLiveAutomation)) {
    await reconcileRiskProtectionState(base)
    await recordRiskEvent({
      userId: target.userId, exchangeAccountId: target.accountId, environment: target.environment, tradingDay,
      eventKey: `automation-disabled:${keyForPosition}:${decision.kind}:${Math.floor(Date.now() / 300_000)}`,
      rule: decision.triggered ? 'breakEven' : 'fixedStopLoss', action: decision.kind,
      source: 'SYSTEM', result: 'LIVE_AUTOMATION_DISABLED',
      metadata: { symbol: position.symbol, message: decision.reason },
    })
    return false
  }

  try {
    if (decision.kind === 'CLOSE_POSITION') {
      await closePosition(target.environment, target.credentials, {
        positionId: position.positionId,
        clientOrderId: `rm-stop-close-${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`,
      })
      await reconcileRiskProtectionState({ ...base, active: false, lastActionAt: Date.now(), failureCount: 0, retryAt: 0 })
    } else {
      const response = await placeOrReplaceProtectiveStop(target.environment, target.credentials, {
        position,
        stopPrice: decision.targetStop!,
        workingType: target.profile.fixedStopLoss.workingType,
        cancelOrderId: decision.cancelOrderIds[0],
        clientOrderId: `rm-stop-${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`,
      })
      const managedOrderId = responseOrderIdentifier(response)
      await reconcileRiskProtectionState({
        ...base,
        managedOrderId,
        managedStopPrice: String(decision.targetStop),
        managedQuantity: String(Math.abs(numeric(position.positionAmt))),
        managedPlacedAt: Date.now(),
        lastActionAt: Date.now(),
        failureCount: 0,
        retryAt: 0,
      })
      for (const oldOrderId of decision.cancelOrderIds.slice(1)) {
        try {
          await cancelOpenOrder(target.environment, target.credentials, { symbol: position.symbol, orderId: oldOrderId })
        } catch {
          // The new full-size stop is already active; stale duplicate cleanup is retried by reconciliation.
        }
      }
    }
    await recordRiskEvent({
      userId: target.userId, exchangeAccountId: target.accountId, environment: target.environment, tradingDay,
      eventKey: `protection:${keyForPosition}:${decision.kind}:${decision.targetStop ?? 'market'}`,
      rule: decision.triggered ? 'breakEven' : 'fixedStopLoss', action: decision.kind,
      source: 'SYSTEM', result: 'SUCCEEDED',
      metadata: { symbol: position.symbol, stopPrice: decision.targetStop ?? null, message: decision.reason },
    })
    return true
  } catch (error) {
    const failures = (previous?.failureCount ?? 0) + 1
    const retryAt = Date.now() + Math.min(60_000, 5_000 * 2 ** Math.min(failures - 1, 4))
    await reconcileRiskProtectionState({ ...base, failureCount: failures, retryAt })
    await recordRiskEvent({
      userId: target.userId, exchangeAccountId: target.accountId, environment: target.environment, tradingDay,
      eventKey: `protection-failed:${keyForPosition}:${decision.kind}:${failures}:${Math.floor(Date.now() / 5_000)}`,
      rule: decision.triggered ? 'breakEven' : 'fixedStopLoss', action: decision.kind,
      source: 'SYSTEM', result: 'FAILED',
      metadata: { symbol: position.symbol, retryAt, message: error instanceof Error ? error.message : 'Unknown protection error' },
    })
    return false
  }
}

async function reconcileTarget(target: MonitoringTarget, allowLiveAutomation: boolean) {
  const key = monitorKey(target.userId, target.accountId)
  await updateWorkerState(target.userId, target.accountId, { status: 'RUNNING' })
  await riskAccountMutex.runExclusive(key, async () => {
    const snapshot = await getAccountSnapshot(target.environment, target.credentials)
    const { tradingDay } = await dailyContext(target.userId, target.environment, target.accountId, target.profile, snapshot)
    const dailyLossBlockedAtSnapshot = await dailyLossReached(target, snapshot, tradingDay)
    let streak = await getRiskStreakState(target.userId, target.environment, tradingDay, target.accountId)
    try {
      streak = await syncLossStreak(target, tradingDay)
    } catch (error) {
      await recordRiskEvent({
        userId: target.userId, exchangeAccountId: target.accountId, environment: target.environment, tradingDay,
        eventKey: `streak-sync-failed:${tradingDay}:${Math.floor(Date.now() / 60_000)}`,
        rule: 'maxConsecutiveLosses', action: 'SYNC_TRADE_OUTCOMES', source: 'SYSTEM', result: 'FAILED',
        metadata: { message: error instanceof Error ? error.message : 'Unknown history synchronization error' },
      })
    }
    const openSnapshotPositions = snapshot.positions.filter(openPosition)
    const needsContracts = openSnapshotPositions.length > 0
      && (target.profile.fixedStopLoss.enabled || target.profile.breakEven.enabled || target.profile.riskPerTrade.enabled)
    const contracts = needsContracts
      ? await listTradableContracts(target.environment, target.credentials)
      : []
    const contractsBySymbol = new Map(contracts.map((contract) => [contract.symbol, contract]))
    const tracked = await listRiskPositionStates(target.userId, target.environment, target.accountId)
    const trackedByKey = new Map(tracked.map((position) => [position.positionKey, position]))
    const reservations = await listRiskEntryReservations(target.userId, target.environment, tradingDay, target.accountId)
    const baselineKey = `monitor-baseline:${target.accountId}`
    const initialized = await hasRiskEvent(target.userId, target.environment, baselineKey, target.accountId)
    const seen = new Set<string>()
    const attemptedViolatingPositionIds = new Set<string>()
    const positionLimit = target.profile.maxOpenPositions.enabled
      ? Math.floor(target.profile.maxOpenPositions.value)
      : undefined
    let remainingExcessExternalPositions = positionLimit === undefined
      ? 0
      : Math.max(0, openSnapshotPositions.length - positionLimit)

    for (const position of openSnapshotPositions) {
      const keyForPosition = positionKey(position.symbol, position.positionSide)
      seen.add(keyForPosition)
      const previous = trackedByKey.get(keyForPosition)
      const reopened = previous?.status === 'CLOSED'
      const newlyObserved = !previous || reopened
      let origin = previous?.origin ?? 'UNKNOWN'

      if (newlyObserved && initialized) {
        const reservation = matchingReservation(reservations, position)
        if (reservation) {
          await consumeRiskEntryReservation({ userId: target.userId, exchangeAccountId: target.accountId, environment: target.environment, reservationId: reservation.id })
          origin = 'TERMINAL'
        } else {
          const daily = await incrementRiskTradeCount({
            userId: target.userId,
            exchangeAccountId: target.accountId,
            environment: target.environment,
            tradingDay,
            timezone: target.profile.timezone,
            openingEquityMicros: equityMicros(snapshot),
            lastEquityMicros: equityMicros(snapshot),
            initialized: equityMicros(snapshot) > 0,
          })
          origin = 'EXTERNAL'
          await recordRiskEvent({
            userId: target.userId,
            exchangeAccountId: target.accountId,
            environment: target.environment,
            tradingDay,
            eventKey: `external-entry:${keyForPosition}:${position.positionId}:${daily.tradeCount}`,
            rule: 'maxTradesPerDay',
            action: 'DETECT_EXTERNAL_POSITION',
            source: 'EXTERNAL',
            result: 'DETECTED',
            metadata: { symbol: position.symbol, side: position.positionSide, tradeCount: daily.tradeCount },
          })

          const tradeLimitEnabled = target.profile.maxTradesPerDay.enabled
          const violatesTradeLimit = tradeLimitEnabled && daily.tradeCount > Math.floor(target.profile.maxTradesPerDay.value)
          const violatesDailyLossLimit = dailyLossBlockedAtSnapshot
          const violatesPositionLimit = remainingExcessExternalPositions > 0
          const violationRule = violatesTradeLimit
            ? 'maxTradesPerDay'
            : violatesDailyLossLimit
              ? 'dailyLossLimit'
              : violatesPositionLimit
                ? 'maxOpenPositions'
                : undefined
          const bypassProtectionRequested = target.profile.closeExternalEntriesOnBreach
            && (violatesTradeLimit || violatesDailyLossLimit)
          const breachPolicyRequestsClose = target.profile.breachAction === 'CLOSE_VIOLATING_POSITION'
            || target.profile.breachAction === 'CLOSE_ALL'
          const shouldTrackForEnforcement = Boolean(
            violationRule && (bypassProtectionRequested || breachPolicyRequestsClose)
          )
          const shouldCloseThisPositionNow = target.profile.breachAction !== 'CLOSE_ALL'
            && (bypassProtectionRequested || target.profile.breachAction === 'CLOSE_VIOLATING_POSITION')
          if (violatesPositionLimit) remainingExcessExternalPositions -= 1
          if (violationRule && shouldTrackForEnforcement) {
            attemptedViolatingPositionIds.add(position.positionId)
            const canClose = mayEnforceBreach(target, allowLiveAutomation)
            await reconcileRiskPositionState({
              userId: target.userId,
              exchangeAccountId: target.accountId,
              environment: target.environment,
              positionKey: keyForPosition,
              positionId: position.positionId,
              symbol: position.symbol,
              side: position.positionSide,
              quantity: position.positionAmt,
              origin,
              enforcementStatus: canClose ? 'PENDING' : 'FAILED',
            })
            if (canClose && shouldCloseThisPositionNow) {
              try {
                await closePosition(target.environment, target.credentials, {
                  positionId: position.positionId,
                  clientOrderId: `rm-close-${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`,
                })
                await reconcileRiskPositionState({
                  userId: target.userId,
                  exchangeAccountId: target.accountId,
                  environment: target.environment,
                  positionKey: keyForPosition,
                  positionId: position.positionId,
                  symbol: position.symbol,
                  side: position.positionSide,
                  quantity: position.positionAmt,
                  status: 'OPEN',
                  origin,
                  enforcementStatus: 'SUCCEEDED',
                })
                await recordRiskEvent({
                  userId: target.userId,
                  exchangeAccountId: target.accountId,
                  environment: target.environment,
                  tradingDay,
                  eventKey: `external-close:${violationRule}:${keyForPosition}:${position.positionId}:${daily.tradeCount}`,
                  rule: violationRule,
                  action: 'CLOSE_EXTERNAL_POSITION',
                  source: 'EXTERNAL',
                  result: 'SUCCEEDED',
                  metadata: {
                    symbol: position.symbol,
                    side: position.positionSide,
                    message: violationRule === 'maxTradesPerDay'
                      ? `Direct BingX entry closed: the daily trade limit of ${target.profile.maxTradesPerDay.value} was exceeded.`
                      : violationRule === 'dailyLossLimit'
                        ? `Direct BingX entry closed: the daily loss limit of ${target.profile.dailyLossLimit.value}${target.profile.dailyLossLimit.unit === 'PERCENT' ? '%' : ' USDT'} had already been reached.`
                        : `Direct BingX entry closed: the open-position limit of ${target.profile.maxOpenPositions.value} was exceeded.`,
                    limit: violationRule === 'maxTradesPerDay'
                      ? target.profile.maxTradesPerDay.value
                      : violationRule === 'dailyLossLimit'
                        ? target.profile.dailyLossLimit.value
                        : target.profile.maxOpenPositions.value,
                    limitUnit: violationRule === 'dailyLossLimit'
                      ? target.profile.dailyLossLimit.unit
                      : undefined,
                    bypassProtection: bypassProtectionRequested,
                  },
                })
                await updateWorkerState(target.userId, target.accountId, {
                  status: 'RUNNING', lastCheckedAt: Date.now(), lastActionAt: Date.now(),
                })
                continue
              } catch (error) {
                await reconcileRiskPositionState({
                  userId: target.userId,
                  exchangeAccountId: target.accountId,
                  environment: target.environment,
                  positionKey: keyForPosition,
                  positionId: position.positionId,
                  symbol: position.symbol,
                  side: position.positionSide,
                  quantity: position.positionAmt,
                  origin,
                  enforcementStatus: 'FAILED',
                })
                await recordRiskEvent({
                  userId: target.userId,
                  exchangeAccountId: target.accountId,
                  environment: target.environment,
                  tradingDay,
                  eventKey: `external-close-failed:${violationRule}:${keyForPosition}:${position.positionId}:${daily.tradeCount}`,
                  rule: violationRule,
                  action: 'CLOSE_EXTERNAL_POSITION',
                  source: 'EXTERNAL',
                  result: 'FAILED',
                  metadata: { message: error instanceof Error ? error.message : 'Unknown close error' },
                })
              }
            } else if (!canClose) {
              await recordRiskEvent({
                userId: target.userId,
                exchangeAccountId: target.accountId,
                environment: target.environment,
                tradingDay,
                eventKey: `external-close-disabled:${violationRule}:${keyForPosition}:${position.positionId}:${daily.tradeCount}`,
                rule: violationRule,
                action: 'CLOSE_EXTERNAL_POSITION',
                source: 'EXTERNAL',
                result: 'AUTOMATION_NOT_AUTHORIZED',
                metadata: {
                  symbol: position.symbol,
                  side: position.positionSide,
                  userConsent: target.profile.automationConsent,
                  liveAutomationEnabled: target.environment !== 'prod-live' || allowLiveAutomation,
                },
              })
            }
            continue
          }
        }
      }

      await reconcileRiskPositionState({
        userId: target.userId,
        exchangeAccountId: target.accountId,
        environment: target.environment,
        positionKey: keyForPosition,
        positionId: position.positionId,
        symbol: position.symbol,
        side: position.positionSide,
        quantity: position.positionAmt,
        status: 'OPEN',
        origin,
        missedSnapshots: 0,
        enforcementStatus: reopened ? 'NONE' : previous?.enforcementStatus ?? 'NONE',
      })
    }

    for (const previous of tracked.filter((position) => ['OPEN', 'MISSING'].includes(position.status))) {
      if (seen.has(previous.positionKey)) continue
      const misses = previous.missedSnapshots + 1
      await reconcileRiskPositionState({
        userId: target.userId,
        exchangeAccountId: target.accountId,
        environment: target.environment,
        positionKey: previous.positionKey,
        positionId: previous.positionId,
        symbol: previous.symbol,
        side: previous.side,
        quantity: previous.quantity,
        status: misses >= 2 ? 'CLOSED' : 'MISSING',
        origin: previous.origin,
        missedSnapshots: misses,
        enforcementStatus: previous.enforcementStatus,
        openedAt: previous.openedAt,
      })
    }

    await reconcileEntryReservations(target, snapshot, tradingDay)

    const runtimeAfterReconcile = await getRiskRuntimeStatus(target.userId, target.environment, tradingDay, target.accountId)
    const tradesExceeded = target.profile.maxTradesPerDay.enabled
      && (runtimeAfterReconcile.dailyState?.tradeCount ?? 0) > Math.floor(target.profile.maxTradesPerDay.value)
    const openPositionsExceeded = target.profile.maxOpenPositions.enabled
      && openSnapshotPositions.length > Math.floor(target.profile.maxOpenPositions.value)
    const dailyLossExceeded = dailyLossBlockedAtSnapshot
    const lossStreakBlocked = Boolean(
      target.profile.maxConsecutiveLosses.enabled
      && streak
      && streak.consecutiveLosses >= Math.floor(target.profile.maxConsecutiveLosses.value)
      && streak.cooldownUntil > Date.now()
    )
    const shouldRetryExternalBypassClose = target.profile.closeExternalEntriesOnBreach
      && (tradesExceeded || dailyLossExceeded)
    const shouldRetryPolicyClose = openPositionsExceeded
      && target.profile.breachAction === 'CLOSE_VIOLATING_POSITION'
    if (shouldRetryExternalBypassClose || shouldRetryPolicyClose) {
      const violatingPositionIds = new Set((await listRiskPositionStates(target.userId, target.environment, target.accountId))
        .filter((state) => state.origin === 'EXTERNAL' && ['PENDING', 'FAILED'].includes(state.enforcementStatus))
        .filter((state) => !attemptedViolatingPositionIds.has(state.positionId))
        .map((state) => state.positionId))
      const violatingPositions = snapshot.positions.filter((position) => violatingPositionIds.has(position.positionId))
      await closePositionsForBreach(
        target,
        violatingPositions,
        tradingDay,
        tradesExceeded
          ? 'maxTradesPerDay'
          : dailyLossExceeded
            ? 'dailyLossLimit'
            : 'maxOpenPositions',
        allowLiveAutomation,
      )
    }
    if (tradesExceeded || openPositionsExceeded || dailyLossExceeded || lossStreakBlocked) {
      const rule = tradesExceeded
        ? 'maxTradesPerDay'
        : openPositionsExceeded
          ? 'maxOpenPositions'
          : dailyLossExceeded
            ? 'dailyLossLimit'
            : 'maxConsecutiveLosses'
      await applyAccountBreachPolicy(target, snapshot, tradingDay, rule, allowLiveAutomation)
    }

    await enforceExposure(target, snapshot, tradingDay, allowLiveAutomation)
    for (const position of openSnapshotPositions) {
      await enforceLeverage(target, position, tradingDay, allowLiveAutomation)
      const contract = contractsBySymbol.get(position.symbol)
      if (contract) {
        await enforceProtection(target, snapshot, position, contract, tradingDay, allowLiveAutomation)
        await enforceExternalRiskPerTrade(target, snapshot, position, contract, tradingDay, allowLiveAutomation)
      }
    }

    const currentProtectionKeys = new Set(openSnapshotPositions.map((position) => positionKey(position.symbol, position.positionSide)))
    for (const protection of (await listRiskProtectionStates(target.userId, target.environment, target.accountId)).filter((state) => state.active)) {
      if (currentProtectionKeys.has(protection.positionKey)) continue
      const misses = protection.missingCount + 1
      await reconcileRiskProtectionState({
        userId: protection.userId,
        exchangeAccountId: target.accountId,
        environment: protection.environment,
        positionKey: protection.positionKey,
        positionId: protection.positionId,
        symbol: protection.symbol,
        direction: protection.direction,
        entryPrice: protection.entryPrice,
        bestPrice: protection.bestPrice,
        triggered: protection.triggered,
        active: misses < 3,
        missingCount: misses,
        managedOrderId: protection.managedOrderId,
        managedStopPrice: protection.managedStopPrice,
        managedQuantity: protection.managedQuantity,
        managedPlacedAt: protection.managedPlacedAt,
        failureCount: protection.failureCount,
        retryAt: protection.retryAt,
        lastActionAt: protection.lastActionAt,
      })
    }

    if (!initialized) {
      await recordRiskEvent({
        userId: target.userId,
        exchangeAccountId: target.accountId,
        environment: target.environment,
        tradingDay,
        eventKey: baselineKey,
        rule: 'monitor',
        action: 'INITIALIZE_BASELINE',
        source: 'SYSTEM',
        result: 'SUCCEEDED',
        metadata: { positions: snapshot.positions.filter(openPosition).length },
      })
    }
    await updateWorkerState(target.userId, target.accountId, {
      status: 'IDLE',
      lastCheckedAt: Date.now(),
      lastError: undefined,
      failureCount: 0,
      retryAt: 0,
    })
  })
}

export async function runRiskMonitorAccount(exchangeAccountId: string, allowLiveAutomation: boolean) {
  const target = (await listRiskMonitoringTargets()).find((candidate) => candidate.accountId === exchangeAccountId)
  if (!target) return { monitored: false, reason: 'INACTIVE_ACCOUNT' as const }
  const previous = workerState.get(monitorKey(target.userId, target.accountId))
  try {
    const locked = await withAccountLock(target.accountId, () => reconcileTarget(target, allowLiveAutomation))
    if (!locked.acquired) {
      await updateWorkerState(target.userId, target.accountId, {
        ...previous,
        status: 'STALE',
        lastError: 'Another RM worker owns the account lock.',
      })
      return { monitored: false, reason: 'LOCKED' as const }
    }
    return { monitored: true as const }
  } catch (error) {
    const failures = (previous?.failureCount ?? 0) + 1
    const retryAt = Date.now() + Math.min(300_000, 5_000 * 2 ** Math.min(failures - 1, 6))
    await updateWorkerState(target.userId, target.accountId, {
      status: 'ERROR',
      lastCheckedAt: Date.now(),
      lastError: error instanceof Error ? error.message : 'Unknown RM worker error',
      failureCount: failures,
      retryAt,
    })
    throw error
  }
}

let workerTimer: ReturnType<typeof setInterval> | undefined
let workerRunning = false

export async function runRiskMonitorOnce(allowLiveAutomation: boolean) {
  if (workerRunning) return
  workerRunning = true
  try {
    for (const target of await listRiskMonitoringTargets()) {
      const key = monitorKey(target.userId, target.accountId)
      const previous = workerState.get(key)
      if ((previous?.retryAt ?? 0) > Date.now()) {
        await updateWorkerState(target.userId, target.accountId, { ...previous!, status: 'STALE' })
        continue
      }
      try {
        await runRiskMonitorAccount(target.accountId, allowLiveAutomation)
      } catch (error) {
        // Account state is persisted by runRiskMonitorAccount; continue with the next user.
      }
    }
  } finally {
    workerRunning = false
  }
}

export function startRiskMonitor(allowLiveAutomation: boolean, intervalMs = 5_000) {
  if (workerTimer) return
  void runRiskMonitorOnce(allowLiveAutomation)
  workerTimer = setInterval(() => void runRiskMonitorOnce(allowLiveAutomation), Math.max(1_000, intervalMs))
  workerTimer.unref()
}

export async function getRiskStatus(userId: string, environment: BingxEnvironment | undefined, liveAutomationEnabled = false, exchangeAccountId?: string) {
  const profile = await activeProfile(userId, exchangeAccountId)
  const timezone = profile?.timezone || 'UTC'
  const tradingDay = computeTradingDay(Date.now(), timezone)
  const runtime = environment ? await getRiskRuntimeStatus(userId, environment, tradingDay, exchangeAccountId) : undefined
  const limit = profile?.active && profile.maxTradesPerDay.enabled ? Math.floor(profile.maxTradesPerDay.value) : undefined
  const positionLimit = profile?.active && profile.maxOpenPositions.enabled
    ? Math.floor(profile.maxOpenPositions.value)
    : undefined
  const tradesUsed = runtime?.dailyState?.tradeCount ?? 0
  const slotsUsed = runtime?.slotsUsed ?? tradesUsed
  const state = environment && exchangeAccountId
    ? await getRmAccountWorkerState(exchangeAccountId) ?? workerState.get(monitorKey(userId, exchangeAccountId))
    : undefined
  const dailyOpening = (runtime?.dailyState?.openingEquityMicros ?? 0) / 1_000_000
  const dailyCurrent = (runtime?.dailyState?.lastEquityMicros ?? 0) / 1_000_000
  const dailyInitialized = Boolean(runtime?.dailyState?.initialized && dailyOpening > 0)
  const dailyPnl = dailyInitialized ? dailyCurrent - dailyOpening : undefined
  const dailyLoss = dailyOpening > 0 && dailyCurrent > 0 ? Math.max(0, dailyOpening - dailyCurrent) : 0
  const dailyLossBlocked = Boolean(profile?.active && profile.dailyLossLimit.enabled && dailyOpening > 0 && (
    profile.dailyLossLimit.unit === 'USDT'
      ? dailyLoss >= profile.dailyLossLimit.value
      : dailyLoss / dailyOpening * 100 >= profile.dailyLossLimit.value
  ))
  const cooldownBlocked = Boolean(
    profile?.active
    && profile.maxConsecutiveLosses.enabled
    && runtime?.streakState
    && runtime.streakState.consecutiveLosses >= Math.floor(profile.maxConsecutiveLosses.value)
    && runtime.streakState.cooldownUntil > Date.now()
  )
  const resetAt = nextTradingDayAt(Date.now(), timezone)
  const block = cooldownBlocked && profile && runtime?.streakState
    ? {
        code: profile.cooldownMinutes.enabled ? 'COOLDOWN_ACTIVE' : 'MAX_CONSECUTIVE_LOSSES',
        rule: profile.cooldownMinutes.enabled ? 'cooldownMinutes' : 'maxConsecutiveLosses',
        reason: `RM system blocked new entries after ${runtime.streakState.consecutiveLosses} consecutive losses.`,
        details: {
          consecutiveLosses: runtime.streakState.consecutiveLosses,
          limit: Math.floor(profile.maxConsecutiveLosses.value),
          cooldownUntil: runtime.streakState.cooldownUntil,
          timeZone: timezone,
        },
      }
    : limit !== undefined && slotsUsed >= limit
      ? {
          code: 'MAX_TRADES_PER_DAY',
          rule: 'maxTradesPerDay',
          reason: `RM system blocked new entries: the daily limit of ${limit} trades has been reached.`,
          details: { used: tradesUsed, reserved: Math.max(0, slotsUsed - tradesUsed), limit, timeZone: timezone, resetAt },
        }
      : positionLimit !== undefined && (runtime?.openPositions ?? 0) >= positionLimit
        ? {
            code: 'MAX_OPEN_POSITIONS',
            rule: 'maxOpenPositions',
            reason: `RM system blocked new entries: the limit of ${positionLimit} open positions has been reached.`,
            details: { openPositions: runtime?.openPositions ?? 0, limit: positionLimit },
          }
      : dailyLossBlocked && profile
        ? {
            code: 'DAILY_LOSS_LIMIT',
            rule: 'dailyLossLimit',
            reason: `RM system blocked new entries: the daily loss limit of ${profile.dailyLossLimit.value}${profile.dailyLossLimit.unit === 'USDT' ? ' USDT' : '%'} has been reached.`,
            details: {
              unit: profile.dailyLossLimit.unit,
              limit: profile.dailyLossLimit.value,
              openingEquity: dailyOpening,
              currentEquity: dailyCurrent,
              lossUsdt: dailyLoss,
              lossPercent: dailyOpening > 0 ? dailyLoss / dailyOpening * 100 : 0,
              timeZone: timezone,
              resetAt,
            },
          }
        : undefined
  return {
    active: Boolean(profile?.active),
    enforcing: Boolean(profile?.active && environment),
    liveAutomationEnabled,
    timezone,
    tradingDay,
    tradesUsed,
    tradeLimit: limit,
    tradesRemaining: limit === undefined ? undefined : Math.max(0, limit - slotsUsed),
    dailyPnl,
    dailyOpeningEquity: dailyInitialized ? dailyOpening : undefined,
    currentEquity: dailyInitialized ? dailyCurrent : undefined,
    openPositions: environment && runtime ? runtime.openPositions : undefined,
    blocked: Boolean(block),
    blockCode: block?.code,
    blockRule: block?.rule,
    blockReason: block?.reason,
    blockDetails: block?.details,
    nextResetAt: resetAt,
    workerStatus: environment ? state?.status ?? 'STALE' : 'DISCONNECTED',
    lastCheckedAt: state?.lastCheckedAt,
    lastActionAt: state?.lastActionAt,
    lastError: state?.lastError,
    retryAt: state?.retryAt,
    consecutiveLosses: runtime?.streakState?.consecutiveLosses ?? 0,
    cooldownUntil: runtime?.streakState?.cooldownUntil || undefined,
    trackedProtections: runtime?.trackedProtections ?? 0,
    managedProtections: runtime?.managedProtections ?? 0,
    breakevenLatched: runtime?.breakevenLatched ?? 0,
  }
}
