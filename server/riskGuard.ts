export type RiskDirection = 'LONG' | 'SHORT'

export type RiskValueRule = {
  enabled: boolean
  value: number
}

export type DailyLossRule = RiskValueRule & {
  unit?: 'PERCENT' | 'USDT'
}

export type RiskGuardProfile = {
  active: boolean
  timezone?: string
  maxTradesPerDay?: RiskValueRule
  maxLeverage?: RiskValueRule
  maxOpenPositions?: RiskValueRule
  maxExposurePercent?: RiskValueRule
  fixedStopLoss?: RiskValueRule
  riskPerTrade?: RiskValueRule
  dailyLossLimit?: DailyLossRule
}

export type RiskSnapshotPosition = {
  symbol: string
  positionSide?: RiskDirection | 'BOTH'
  positionAmt: number | string
  positionValue?: number | string
  markPrice?: number | string
  avgPrice?: number | string
}

export type RiskSnapshotBalance = {
  asset: string
  equity: number | string
}

export type RiskAccountSnapshot = {
  positions: RiskSnapshotPosition[]
  balances: RiskSnapshotBalance[]
}

export type PreparedOrderCandidate = {
  symbol: string
  direction: RiskDirection
  leverage: number
  quantity: number
  entryPrice: number
  notional?: number
  reduceOnly?: boolean
  stopLossPrice?: number
  settlementAsset?: string
}

export type RiskDailyState = {
  usedTrades: number
  reservedTrades: number
  openingEquity?: number
  currentEquity?: number
}

export type EntryClassification = 'NEW_ENTRY' | 'SCALE_IN' | 'REDUCE_ONLY'

export type RiskRuleName =
  | 'maxTradesPerDay'
  | 'maxLeverage'
  | 'maxOpenPositions'
  | 'maxExposurePercent'
  | 'fixedStopLoss'
  | 'riskPerTrade'
  | 'dailyLossLimit'
  | 'maxConsecutiveLosses'
  | 'cooldownMinutes'

export type RiskDecisionCode =
  | 'ALLOW'
  | 'MAX_TRADES_PER_DAY'
  | 'MAX_LEVERAGE'
  | 'MAX_OPEN_POSITIONS'
  | 'MAX_EXPOSURE_PERCENT'
  | 'STOP_LOSS_REQUIRED'
  | 'INVALID_STOP_LOSS'
  | 'FIXED_STOP_LOSS_EXCEEDED'
  | 'RISK_PER_TRADE'
  | 'DAILY_LOSS_LIMIT'
  | 'MAX_CONSECUTIVE_LOSSES'
  | 'COOLDOWN_ACTIVE'
  | 'RISK_DATA_UNAVAILABLE'

export type RiskDecisionDetails = Record<string, string | number | boolean | null>

export type RiskDecision = {
  allowed: true
  code: 'ALLOW'
  rule: null
  message: string
  details: RiskDecisionDetails
} | {
  allowed: false
  code: Exclude<RiskDecisionCode, 'ALLOW'>
  rule: RiskRuleName
  message: string
  details: RiskDecisionDetails
}

export type RiskEvaluationInput = {
  profile: RiskGuardProfile
  snapshot: RiskAccountSnapshot
  candidate: PreparedOrderCandidate
  daily: RiskDailyState
  now?: number | Date
}

const dateFormatterCache = new Map<string, Intl.DateTimeFormat>()

function epochMilliseconds(value: number | Date) {
  const timestamp = value instanceof Date ? value.getTime() : value
  if (!Number.isFinite(timestamp)) throw new RangeError('A finite date is required')
  return Math.trunc(timestamp)
}

function dateFormatter(timeZone: string) {
  const cached = dateFormatterCache.get(timeZone)
  if (cached) return cached
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  // Force invalid IANA zones to fail at the boundary instead of much later.
  formatter.format(0)
  dateFormatterCache.set(timeZone, formatter)
  return formatter
}

export function computeTradingDay(now: number | Date, timeZone: string) {
  const parts = dateFormatter(timeZone).formatToParts(epochMilliseconds(now))
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value
  const year = value('year')
  const month = value('month')
  const day = value('day')
  if (!year || !month || !day) throw new Error(`Could not compute the trading day for ${timeZone}`)
  return `${year}-${month}-${day}`
}

export function nextTradingDayAt(now: number | Date, timeZone: string) {
  const start = epochMilliseconds(now)
  const currentDay = computeTradingDay(start, timeZone)
  let upper = start + 36 * 60 * 60 * 1_000
  const maximum = start + 72 * 60 * 60 * 1_000

  while (computeTradingDay(upper, timeZone) === currentDay && upper < maximum) {
    upper += 12 * 60 * 60 * 1_000
  }
  if (computeTradingDay(upper, timeZone) === currentDay) {
    throw new Error(`Could not find the next trading day boundary for ${timeZone}`)
  }

  let lower = start
  while (upper - lower > 1) {
    const middle = lower + Math.floor((upper - lower) / 2)
    if (computeTradingDay(middle, timeZone) === currentDay) lower = middle
    else upper = middle
  }
  return upper
}

function finiteNumber(value: number | string | undefined, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function normalizedDirection(position: RiskSnapshotPosition): RiskDirection {
  if (position.positionSide === 'LONG' || position.positionSide === 'SHORT') return position.positionSide
  return finiteNumber(position.positionAmt) < 0 ? 'SHORT' : 'LONG'
}

export function positionKey(symbol: string, direction: RiskDirection): string
export function positionKey(position: RiskSnapshotPosition): string
export function positionKey(symbolOrPosition: string | RiskSnapshotPosition, direction?: RiskDirection) {
  if (typeof symbolOrPosition === 'string') {
    if (!direction) throw new Error('Position direction is required')
    return `${symbolOrPosition.trim().toUpperCase()}:${direction}`
  }
  return `${symbolOrPosition.symbol.trim().toUpperCase()}:${normalizedDirection(symbolOrPosition)}`
}

function openPositions(positions: RiskSnapshotPosition[]) {
  return positions.filter((position) => Math.abs(finiteNumber(position.positionAmt)) > 0)
}

export function classifyEntry(
  candidate: Pick<PreparedOrderCandidate, 'symbol' | 'direction' | 'reduceOnly'>,
  positions: RiskSnapshotPosition[],
): EntryClassification {
  if (candidate.reduceOnly) return 'REDUCE_ONLY'
  const candidateKey = positionKey(candidate.symbol, candidate.direction)
  return openPositions(positions).some((position) => positionKey(position) === candidateKey)
    ? 'SCALE_IN'
    : 'NEW_ENTRY'
}

function accountEquity(snapshot: RiskAccountSnapshot, asset: string) {
  const preferred = snapshot.balances.find((balance) => balance.asset.toUpperCase() === asset.toUpperCase())
  const fallback = snapshot.balances.length === 1 ? snapshot.balances[0] : undefined
  const equity = finiteNumber(preferred?.equity ?? fallback?.equity)
  return equity > 0 ? equity : 0
}

function positionExposure(position: RiskSnapshotPosition) {
  const explicit = Math.abs(finiteNumber(position.positionValue))
  if (explicit > 0) return explicit
  const price = finiteNumber(position.markPrice) || finiteNumber(position.avgPrice)
  return Math.abs(finiteNumber(position.positionAmt)) * Math.abs(price)
}

function candidateNotional(candidate: PreparedOrderCandidate) {
  const explicit = finiteNumber(candidate.notional)
  return explicit > 0 ? explicit : Math.abs(candidate.quantity * candidate.entryPrice)
}

function block(
  code: Exclude<RiskDecisionCode, 'ALLOW'>,
  rule: RiskRuleName,
  message: string,
  details: RiskDecisionDetails,
): RiskDecision {
  return { allowed: false, code, rule, message, details }
}

function allow(classification: EntryClassification, details: RiskDecisionDetails = {}): RiskDecision {
  return {
    allowed: true,
    code: 'ALLOW',
    rule: null,
    message: classification === 'REDUCE_ONLY'
      ? 'Risk Guard allows position-reducing orders.'
      : 'Risk Guard checks passed.',
    details: { classification, ...details },
  }
}

function validRule(rule: RiskValueRule | undefined) {
  return Boolean(rule?.enabled && Number.isFinite(rule.value) && rule.value > 0)
}

export function evaluateRisk(input: RiskEvaluationInput): RiskDecision {
  const { profile, snapshot, candidate, daily } = input
  const classification = classifyEntry(candidate, snapshot.positions)
  if (classification === 'REDUCE_ONLY') return allow(classification)
  if (!profile.active) return allow(classification, { profileActive: false })

  const timeZone = profile.timezone || 'UTC'
  const now = input.now ?? Date.now()
  const resetAt = nextTradingDayAt(now, timeZone)
  const equity = daily.currentEquity && daily.currentEquity > 0
    ? daily.currentEquity
    : accountEquity(snapshot, candidate.settlementAsset || 'USDT')

  if (classification === 'NEW_ENTRY' && validRule(profile.maxTradesPerDay)) {
    const limit = Math.floor(profile.maxTradesPerDay!.value)
    const used = Math.max(0, Math.floor(daily.usedTrades))
    const reserved = Math.max(0, Math.floor(daily.reservedTrades))
    if (used + reserved >= limit) {
      return block(
        'MAX_TRADES_PER_DAY',
        'maxTradesPerDay',
        `RM system blocked the order: the daily limit of ${limit} trades has been reached.`,
        { classification, used, reserved, limit, timeZone, resetAt },
      )
    }
  }

  if (validRule(profile.dailyLossLimit)) {
    const openingEquity = finiteNumber(daily.openingEquity)
    if (!(openingEquity > 0) || !(equity > 0)) {
      return block(
        'RISK_DATA_UNAVAILABLE',
        'dailyLossLimit',
        'RM system could not verify the daily loss because equity data is unavailable.',
        { classification, openingEquity, currentEquity: equity },
      )
    }
    const lossUsdt = Math.max(0, openingEquity - equity)
    const lossPercent = lossUsdt / openingEquity * 100
    const unit = profile.dailyLossLimit!.unit ?? 'PERCENT'
    const observed = unit === 'USDT' ? lossUsdt : lossPercent
    if (observed >= profile.dailyLossLimit!.value) {
      return block(
        'DAILY_LOSS_LIMIT',
        'dailyLossLimit',
        `RM system blocked the order: the daily loss limit of ${profile.dailyLossLimit!.value}${unit === 'USDT' ? ' USDT' : '%'} has been reached.`,
        {
          classification,
          unit,
          limit: profile.dailyLossLimit!.value,
          openingEquity,
          currentEquity: equity,
          lossUsdt,
          lossPercent,
          timeZone,
          resetAt,
        },
      )
    }
  }

  if (validRule(profile.maxLeverage) && candidate.leverage > profile.maxLeverage!.value) {
    return block(
      'MAX_LEVERAGE',
      'maxLeverage',
      `RM system blocked the order: ${candidate.leverage}x exceeds the ${profile.maxLeverage!.value}x leverage limit.`,
      { classification, requested: candidate.leverage, limit: profile.maxLeverage!.value },
    )
  }

  const activePositions = openPositions(snapshot.positions)
  const uniquePositions = new Set(activePositions.map(positionKey))
  if (
    classification === 'NEW_ENTRY'
    && validRule(profile.maxOpenPositions)
    && uniquePositions.size >= Math.floor(profile.maxOpenPositions!.value)
  ) {
    return block(
      'MAX_OPEN_POSITIONS',
      'maxOpenPositions',
      `RM system blocked the order: the limit of ${Math.floor(profile.maxOpenPositions!.value)} open positions has been reached.`,
      {
        classification,
        openPositions: uniquePositions.size,
        limit: Math.floor(profile.maxOpenPositions!.value),
      },
    )
  }

  if (validRule(profile.maxExposurePercent)) {
    if (!(equity > 0)) {
      return block(
        'RISK_DATA_UNAVAILABLE',
        'maxExposurePercent',
        'RM system could not verify exposure because account equity is unavailable.',
        { classification, equity },
      )
    }
    const currentExposure = activePositions.reduce((total, position) => total + positionExposure(position), 0)
    const orderNotional = candidateNotional(candidate)
    const projectedExposure = currentExposure + orderNotional
    const projectedExposurePercent = projectedExposure / equity * 100
    if (projectedExposurePercent > profile.maxExposurePercent!.value) {
      return block(
        'MAX_EXPOSURE_PERCENT',
        'maxExposurePercent',
        `RM system blocked the order: projected exposure ${projectedExposurePercent.toFixed(2)}% exceeds the ${profile.maxExposurePercent!.value}% limit.`,
        {
          classification,
          currentExposure,
          orderNotional,
          projectedExposure,
          projectedExposurePercent,
          equity,
          limit: profile.maxExposurePercent!.value,
        },
      )
    }
  }

  const stopRequired = validRule(profile.fixedStopLoss) || validRule(profile.riskPerTrade)
  const stopPrice = finiteNumber(candidate.stopLossPrice)
  if (stopRequired && !(stopPrice > 0)) {
    return block(
      'STOP_LOSS_REQUIRED',
      validRule(profile.fixedStopLoss) ? 'fixedStopLoss' : 'riskPerTrade',
      'RM system blocked the order: an active risk rule requires a Stop Loss.',
      { classification },
    )
  }

  if (stopPrice > 0) {
    const stopDirectionValid = candidate.direction === 'LONG'
      ? stopPrice < candidate.entryPrice
      : stopPrice > candidate.entryPrice
    if (!stopDirectionValid) {
      return block(
        'INVALID_STOP_LOSS',
        validRule(profile.fixedStopLoss) ? 'fixedStopLoss' : 'riskPerTrade',
        `RM system blocked the order: the Stop Loss is on the wrong side of the ${candidate.direction} entry.`,
        { classification, direction: candidate.direction, entryPrice: candidate.entryPrice, stopPrice },
      )
    }
  }

  const stopDistance = stopPrice > 0 ? Math.abs(candidate.entryPrice - stopPrice) : 0
  const stopDistancePercent = candidate.entryPrice > 0 ? stopDistance / candidate.entryPrice * 100 : 0
  if (validRule(profile.fixedStopLoss) && stopDistancePercent > profile.fixedStopLoss!.value) {
    return block(
      'FIXED_STOP_LOSS_EXCEEDED',
      'fixedStopLoss',
      `RM system blocked the order: the Stop Loss distance ${stopDistancePercent.toFixed(2)}% exceeds the ${profile.fixedStopLoss!.value}% limit.`,
      {
        classification,
        entryPrice: candidate.entryPrice,
        stopPrice,
        stopDistancePercent,
        limit: profile.fixedStopLoss!.value,
      },
    )
  }

  if (validRule(profile.riskPerTrade)) {
    if (!(equity > 0)) {
      return block(
        'RISK_DATA_UNAVAILABLE',
        'riskPerTrade',
        'RM system could not verify risk per trade because account equity is unavailable.',
        { classification, equity },
      )
    }
    const riskUsdt = stopDistance * Math.abs(candidate.quantity)
    const riskPercent = riskUsdt / equity * 100
    if (riskPercent > profile.riskPerTrade!.value) {
      return block(
        'RISK_PER_TRADE',
        'riskPerTrade',
        `RM system blocked the order: estimated risk ${riskPercent.toFixed(2)}% exceeds the ${profile.riskPerTrade!.value}% limit.`,
        {
          classification,
          entryPrice: candidate.entryPrice,
          stopPrice,
          quantity: Math.abs(candidate.quantity),
          riskUsdt,
          riskPercent,
          equity,
          limit: profile.riskPerTrade!.value,
        },
      )
    }
  }

  return allow(classification, {
    equity,
    tradingDay: computeTradingDay(now, timeZone),
    resetAt,
  })
}

export class KeyedAsyncMutex {
  private readonly tails = new Map<string, Promise<void>>()

  async runExclusive<T>(key: string, operation: () => T | Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const lock = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => lock)
    this.tails.set(key, tail)

    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }

  get size() {
    return this.tails.size
  }
}
