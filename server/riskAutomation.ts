import type { BingxOrder, BingxPosition } from './bingxClient'

export type ProtectionContract = {
  pricePrecision: number
  quantityPrecision: number
  tradeMinQuantity: number
  tradeMinUSDT: number
}

export type ProtectionProfile = {
  fixedStopLoss: {
    enabled: boolean
    value: number
    workingType: 'MARK_PRICE' | 'CONTRACT_PRICE'
  }
  breakEven: {
    enabled: boolean
    triggerMode: 'PERCENT' | 'R_MULTIPLE'
    triggerValue: number
    offsetPercent: number
  }
}

export type ProtectionRuntimeState = {
  entryPrice: number
  bestPrice: number
  triggered: boolean
  managedOrderId?: string
  managedStopPrice?: number
  managedQuantity?: number
  managedPlacedAt?: number
  retryAt?: number
}

export type ProtectionDecision = {
  kind: 'NONE' | 'WAIT' | 'PLACE_STOP' | 'REPLACE_STOP' | 'CLOSE_POSITION'
  targetStop?: number
  cancelOrderIds: string[]
  triggered: boolean
  bestPrice: number
  reason: string
}

export type PositionRiskAssessment = {
  status: 'UNAVAILABLE' | 'UNPROTECTED' | 'COMPLIANT' | 'VIOLATION'
  entryPrice: number
  stopPrice?: number
  quantity: number
  equity: number
  riskUsdt?: number
  riskPercent?: number
  limitPercent: number
  reason: string
}

function finite(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function factor(precision: number) {
  return 10 ** Math.max(0, Math.floor(precision))
}

export function roundInitialStop(entryPrice: number, direction: 'LONG' | 'SHORT', percent: number, precision: number) {
  const raw = entryPrice * (direction === 'LONG' ? 1 - percent / 100 : 1 + percent / 100)
  const scale = factor(precision)
  return direction === 'LONG'
    ? Math.ceil((raw - Number.EPSILON) * scale) / scale
    : Math.floor((raw + Number.EPSILON) * scale) / scale
}

export function roundBreakEvenStop(entryPrice: number, direction: 'LONG' | 'SHORT', offsetPercent: number, precision: number) {
  const raw = entryPrice * (direction === 'LONG' ? 1 + offsetPercent / 100 : 1 - offsetPercent / 100)
  const scale = factor(precision)
  return direction === 'LONG'
    ? Math.ceil((raw - Number.EPSILON) * scale) / scale
    : Math.floor((raw + Number.EPSILON) * scale) / scale
}

export function deriveMarkPrice(position: BingxPosition) {
  const quantity = Math.abs(finite(position.positionAmt))
  const value = Math.abs(finite(position.positionValue))
  if (quantity > 0 && value > 0) return value / quantity
  const entry = finite(position.avgPrice)
  const pnl = finite(position.unrealizedProfit)
  if (quantity > 0 && entry > 0) {
    return position.positionSide === 'LONG' ? entry + pnl / quantity : entry - pnl / quantity
  }
  return entry
}

function orderId(order: BingxOrder) {
  return String(order.orderId ?? order.orderID ?? '')
}

function orderQuantity(order: BingxOrder) {
  return Math.abs(finite(order.origQty ?? order.quantity)) - Math.abs(finite(order.executedQty))
}

export function protectiveStopOrders(position: BingxPosition, openOrders: BingxOrder[]) {
  const closeSide = position.positionSide === 'LONG' ? 'SELL' : 'BUY'
  return openOrders.filter((order) => {
    const type = String(order.type ?? '').toUpperCase()
    const orderPositionId = String(order.positionID ?? order.positionId ?? '')
    return order.symbol === position.symbol
      && String(order.positionSide ?? position.positionSide).toUpperCase() === position.positionSide
      && String(order.side ?? '').toUpperCase() === closeSide
      && type.includes('STOP')
      && !type.includes('TAKE_PROFIT')
      && finite(order.stopPrice) > 0
      && (!orderPositionId || orderPositionId === position.positionId)
  })
}

export function evaluatePositionRisk(input: {
  position: BingxPosition
  openOrders: BingxOrder[]
  equity: number
  limitPercent: number
  quantityPrecision?: number
  managedStopPrice?: number
  managedQuantity?: number
}): PositionRiskAssessment {
  const { position } = input
  const entryPrice = finite(position.avgPrice)
  const quantity = Math.abs(finite(position.positionAmt))
  const equity = finite(input.equity)
  const limitPercent = finite(input.limitPercent)
  if (!(entryPrice > 0) || !(quantity > 0) || !(equity > 0) || !(limitPercent > 0)) {
    return {
      status: 'UNAVAILABLE', entryPrice, quantity, equity, limitPercent,
      reason: 'The external position risk could not be calculated from the available account data.',
    }
  }

  const tolerance = 0.5 / factor(input.quantityPrecision ?? 8)
  const fullSizeStops = protectiveStopOrders(position, input.openOrders)
    .filter((order) => {
      const remaining = orderQuantity(order)
      return !(remaining > 0) || remaining + tolerance >= quantity
    })
    .map((order) => finite(order.stopPrice))
    .filter((stopPrice) => stopPrice > 0)
  const managedStopPrice = finite(input.managedStopPrice)
  const managedQuantity = finite(input.managedQuantity)
  if (managedStopPrice > 0 && (!(managedQuantity > 0) || managedQuantity + tolerance >= quantity)) {
    fullSizeStops.push(managedStopPrice)
  }
  if (fullSizeStops.length === 0) {
    return {
      status: 'UNPROTECTED', entryPrice, quantity, equity, limitPercent,
      reason: 'No full-size protective Stop Loss is visible for the external position.',
    }
  }

  const stopPrice = position.positionSide === 'LONG'
    ? Math.max(...fullSizeStops)
    : Math.min(...fullSizeStops)
  const stopDistance = position.positionSide === 'LONG'
    ? Math.max(0, entryPrice - stopPrice)
    : Math.max(0, stopPrice - entryPrice)
  const riskUsdt = stopDistance * quantity
  const riskPercent = riskUsdt / equity * 100
  const status = riskPercent > limitPercent ? 'VIOLATION' : 'COMPLIANT'
  return {
    status,
    entryPrice,
    stopPrice,
    quantity,
    equity,
    riskUsdt,
    riskPercent,
    limitPercent,
    reason: status === 'VIOLATION'
      ? `External position risk ${riskPercent.toFixed(2)}% exceeds the ${limitPercent}% limit.`
      : `External position risk ${riskPercent.toFixed(2)}% is within the ${limitPercent}% limit.`,
  }
}

function tighter(direction: 'LONG' | 'SHORT', first: number, second: number) {
  return direction === 'LONG' ? Math.max(first, second) : Math.min(first, second)
}

function stopProtects(direction: 'LONG' | 'SHORT', actual: number, required: number, pricePrecision: number) {
  const tolerance = 0.5 / factor(pricePrecision)
  return direction === 'LONG' ? actual + tolerance >= required : actual - tolerance <= required
}

function coversPosition(position: BingxPosition, order: BingxOrder, quantityPrecision: number) {
  const required = Math.abs(finite(position.positionAmt))
  const quantity = orderQuantity(order)
  if (!(quantity > 0)) return true
  return quantity + 0.5 / factor(quantityPrecision) >= required
}

function favorablePercent(direction: 'LONG' | 'SHORT', entry: number, price: number) {
  if (!(entry > 0) || !(price > 0)) return 0
  return direction === 'LONG' ? (price / entry - 1) * 100 : (1 - price / entry) * 100
}

export function evaluateProtection(input: {
  position: BingxPosition
  openOrders: BingxOrder[]
  contract: ProtectionContract
  profile: ProtectionProfile
  state?: ProtectionRuntimeState
  markPrice?: number
  now?: number
}): ProtectionDecision {
  const { position, contract, profile } = input
  const direction = position.positionSide
  const entryPrice = finite(position.avgPrice)
  const markPrice = finite(input.markPrice) || deriveMarkPrice(position)
  const previousEntry = input.state?.entryPrice ?? entryPrice
  const entryChanged = Math.abs(previousEntry - entryPrice) > 0.5 / factor(contract.pricePrecision)
  let bestPrice = entryChanged || !(input.state?.bestPrice && input.state.bestPrice > 0)
    ? markPrice || entryPrice
    : input.state.bestPrice
  bestPrice = direction === 'LONG' ? Math.max(bestPrice, markPrice || entryPrice) : Math.min(bestPrice, markPrice || entryPrice)
  // Break-even is a latch, not a transient signal. Once triggered it must survive
  // retraces, restarts and scale-ins that change the exchange average entry.
  let triggered = Boolean(input.state?.triggered)

  if (!triggered && profile.breakEven.enabled && entryPrice > 0) {
    const favorableMove = favorablePercent(direction, entryPrice, bestPrice)
    const thresholdReached = profile.breakEven.triggerMode === 'PERCENT'
      ? favorableMove >= profile.breakEven.triggerValue
      : profile.fixedStopLoss.enabled
        && profile.fixedStopLoss.value > 0
        && favorableMove / profile.fixedStopLoss.value >= profile.breakEven.triggerValue
    if (thresholdReached) triggered = true
  }

  if (!(entryPrice > 0) || (!profile.fixedStopLoss.enabled && !profile.breakEven.enabled)) {
    return { kind: 'NONE', cancelOrderIds: [], triggered, bestPrice, reason: 'Position protection is disabled.' }
  }

  let target: number | undefined
  let reason = ''
  if (profile.fixedStopLoss.enabled) {
    target = roundInitialStop(entryPrice, direction, profile.fixedStopLoss.value, contract.pricePrecision)
    reason = `Initial Stop Loss ${profile.fixedStopLoss.value}% from entry.`
  }
  if (profile.breakEven.enabled && triggered) {
    const breakEven = roundBreakEvenStop(entryPrice, direction, profile.breakEven.offsetPercent, contract.pricePrecision)
    target = target === undefined ? breakEven : tighter(direction, target, breakEven)
    reason = `Break-even trigger latched with ${profile.breakEven.offsetPercent}% entry offset.`
  }
  if (target === undefined) {
    return { kind: 'NONE', cancelOrderIds: [], triggered, bestPrice, reason: 'Waiting for the break-even trigger.' }
  }

  const stops = protectiveStopOrders(position, input.openOrders)
  for (const stop of stops) target = tighter(direction, target, finite(stop.stopPrice))
  const protectedInFull = stops.some((stop) => (
    stopProtects(direction, finite(stop.stopPrice), target!, contract.pricePrecision)
    && coversPosition(position, stop, contract.quantityPrecision)
  ))
  if (protectedInFull) {
    return { kind: 'NONE', targetStop: target, cancelOrderIds: [], triggered, bestPrice, reason: 'A full-size stop already protects the position.' }
  }

  const crossed = markPrice > 0 && (direction === 'LONG' ? markPrice <= target : markPrice >= target)
  if (crossed) {
    return {
      kind: 'CLOSE_POSITION', targetStop: target, cancelOrderIds: stops.map(orderId).filter(Boolean),
      triggered, bestPrice, reason: `Mark price crossed the required ${target} stop while no full-size protection was active.`,
    }
  }

  const now = input.now ?? Date.now()
  const managedVisible = Boolean(input.state?.managedOrderId) && input.openOrders.some((order) => (
    orderId(order) === input.state!.managedOrderId
  ))
  const pendingUnverified = input.state?.managedPlacedAt
    && !managedVisible
    && now - input.state.managedPlacedAt < 60_000
  if (pendingUnverified) {
    return { kind: 'WAIT', targetStop: target, cancelOrderIds: [], triggered, bestPrice, reason: 'Waiting for the accepted stop to appear in open orders.' }
  }
  if ((input.state?.retryAt ?? 0) > now) {
    return { kind: 'WAIT', targetStop: target, cancelOrderIds: [], triggered, bestPrice, reason: 'Protection retry backoff is active.' }
  }

  return {
    kind: stops.length ? 'REPLACE_STOP' : 'PLACE_STOP',
    targetStop: target,
    cancelOrderIds: stops.map(orderId).filter(Boolean),
    triggered,
    bestPrice,
    reason,
  }
}
