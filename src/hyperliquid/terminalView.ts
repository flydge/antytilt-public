import type { HlTerminalHistory, HlTerminalNetwork, HlTerminalOrderInput, HlTerminalPacket, HlTerminalSnapshot } from '../../shared/hyperliquidTerminal'
import type { AccountHistory, AdvancedOrderInput, ExchangeBalance, ExchangeContract, ExchangeOrder, ExchangePosition, ExchangeSnapshot, OrderPreviewResponse, TradingSettings } from '../types'

export const emptyHyperliquidHistory: AccountHistory = { orderHistory: [], tradeHistory: [], synchronizedAt: 0, warnings: [] }
export function accountResponseCurrent(requested: HlTerminalNetwork, requestGeneration: number, selected: HlTerminalNetwork, currentGeneration: number) { return requested === selected && requestGeneration === currentGeneration }
const finite = (value: string | number) => { const n = Number(value); if (!Number.isFinite(n)) throw Error('Hyperliquid provider number unavailable'); return n }
const symbol = (coin: string) => `${coin}-USD`
export function mapHyperliquidSnapshot(s: HlTerminalSnapshot) {
  const positions: ExchangePosition[] = s.clearinghouseState.assetPositions.filter(row => row.position.coin === s.coin && finite(row.position.szi) !== 0).map(({ position: p }) => ({
    symbol: symbol(p.coin), positionId: `${s.network}:${p.coin}`, positionSide: finite(p.szi) > 0 ? 'LONG' : 'SHORT',
    positionAmt: p.szi, availableAmt: String(Math.abs(finite(p.szi))), isolated: p.leverage.type === 'isolated', unrealizedProfit: p.unrealizedPnl,
    initialMargin: p.marginUsed, liquidationPrice: p.liquidationPx ?? '0', avgPrice: p.entryPx, leverage: p.leverage.value, positionValue: p.positionValue, currency: 'USDC',
  }))
  const openOrders: ExchangeOrder[] = s.openOrders.filter(o => o.coin === s.coin).map(o => ({
    orderId: String(o.oid), symbol: symbol(o.coin), side: o.side === 'B' ? 'BUY' : 'SELL',
    positionSide: o.reduceOnly ? (o.side === 'A' ? 'LONG' : 'SHORT') : (o.side === 'B' ? 'LONG' : 'SHORT'),
    type: o.orderType.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/\s+/g, '_').toUpperCase(), price: o.limitPx, stopPrice: o.isTrigger ? o.triggerPx : undefined,
    origQty: o.origSz, quantity: o.sz, executedQty: String(Math.max(0, finite(o.origSz) - finite(o.sz))), status: 'OPEN', clientOrderId: o.cloid ?? undefined, time: o.timestamp,
    reduceOnly: o.reduceOnly, isPositionTpsl: o.isPositionTpsl,
  }))
  const allPositions = s.clearinghouseState.assetPositions.map(row => row.position)
  const unrealized = allPositions.reduce((total, p) => total + finite(p.unrealizedPnl), 0)
  const used = allPositions.reduce((total, p) => total + finite(p.marginUsed), 0)
  const usdc = s.spotClearinghouseState.balances.find(b => b.coin === 'USDC')
  const availableMargin = Math.min(...s.activeAssetData.availableToTrade.map(finite))
  const balance = s.mode === 'unifiedAccount' ? finite(usdc?.total ?? '0') : finite(s.clearinghouseState.marginSummary.totalRawUsd)
  // Unified spot total is the provider's USDC balance. Do not add native-DEX PnL
  // to it and present a partial cross-DEX calculation as account equity.
  const equity = s.mode === 'unifiedAccount' ? balance : finite(s.clearinghouseState.marginSummary.accountValue)
  const balances: ExchangeBalance[] = [{ asset: 'USDC', balance: String(balance), equity: String(equity), unrealizedProfit: String(unrealized), availableMargin: String(availableMargin), usedMargin: String(used) }]
  const contract: ExchangeContract = { symbol: symbol(s.coin), quantityPrecision: s.szDecimals, pricePrecision: Math.max(0, 6 - s.szDecimals), makerFeeRate: finite(s.makerFeeRate), takerFeeRate: finite(s.takerFeeRate), tradeMinQuantity: 10 ** -s.szDecimals, tradeMinUSDT: 10, maxLongLeverage: s.maxLeverage, maxShortLeverage: s.maxLeverage, status: 1, apiStateOpen: 'true', apiStateClose: 'true', asset: s.coin, currency: 'USDC' }
  const settings: TradingSettings = { symbol: symbol(s.coin), marginType: s.marginType === 'cross' ? 'CROSSED' : 'ISOLATED', longLeverage: s.leverage, shortLeverage: s.leverage, maxLongLeverage: s.maxLeverage, maxShortLeverage: s.maxLeverage, dualSidePosition: false, contract, prices: { markPrice: finite(s.markPx), indexPrice: finite(s.markPx), bidPrice: finite(s.bid ?? s.markPx), askPrice: finite(s.ask ?? s.markPx) }, updatedAt: s.checkedAt }
  const snapshot: ExchangeSnapshot = { balances, positions, openOrders, dualSidePosition: false, updatedAt: s.checkedAt }
  return { snapshot, settings, contract, availableMargin, equity }
}

export function toHyperliquidOrderInput(input: AdvancedOrderInput): HlTerminalOrderInput {
  if (input.symbol !== 'BTC-USD' || input.orderKind === 'TRIGGER') throw Error('Unsupported Hyperliquid execution instrument or entry trigger')
  if (input.timeInForce === 'FOK') throw Error('Hyperliquid does not support FOK in this terminal')
  for (const protection of [input.stopLoss, input.takeProfit]) if (protection && (protection.workingType !== 'MARK_PRICE')) throw Error('Hyperliquid protection requires native mark-price trigger')
  const value: HlTerminalOrderInput = { side: input.direction === 'LONG' ? 'BUY' : 'SELL', orderType: input.orderKind, sizeMode: input.amountMode, amount: String(input.amount), leverage: input.leverage, marginType: input.marginType === 'CROSSED' ? 'cross' : 'isolated', maxSlippageBps: Math.round((input.maxSlippagePercent ?? 0.5) * 100) }
  if (input.reduceOnly) value.reduceOnly = true
  if (input.orderKind === 'LIMIT') { value.limitPrice = String(input.price); value.tif = input.timeInForce === 'PostOnly' ? 'Alo' : input.timeInForce === 'IOC' ? 'Ioc' : 'Gtc' }
  if (input.stopLoss) value.stopLoss = input.stopLoss.execution === 'LIMIT' ? {triggerPrice:String(input.stopLoss.stopPrice),execution:'LIMIT',price:String(input.stopLoss.price)} : String(input.stopLoss.stopPrice)
  if (input.takeProfit) value.takeProfit = input.takeProfit.execution === 'LIMIT' ? {triggerPrice:String(input.takeProfit.stopPrice),execution:'LIMIT',price:String(input.takeProfit.price)} : String(input.takeProfit.stopPrice)
  if (input.stopLoss || input.takeProfit) value.triggerSource = 'MARK_PRICE'
  return value
}

export function mapHyperliquidPreview(packet: HlTerminalPacket, input: AdvancedOrderInput, settings: TradingSettings): OrderPreviewResponse {
  const p = packet.summary, entry = finite(p.referencePrice), quantity = finite(p.quantity ?? '0'), notional = finite(p.notionalUsd ?? '0'), margin = finite(p.marginUsdc ?? '0')
  const maker = input.orderKind === 'LIMIT' && input.timeInForce === 'PostOnly'
  const fee = notional * (maker ? settings.contract.makerFeeRate : settings.contract.takerFeeRate)
  const closeFee = notional * settings.contract.takerFeeRate
  const directionFactor = input.direction === 'LONG' ? 1 : -1
  const protection = (value: AdvancedOrderInput['stopLoss']) => value ? { ...value, expectedPnl: Math.abs((value.stopPrice - entry) * quantity * directionFactor) } : undefined
  return { previewId: packet.id, expiresAt: packet.expiresAfter, preview: { symbol: input.symbol, direction: input.direction, orderKind: input.orderKind, exchangeOrderType: input.orderKind === 'MARKET' ? 'Market IOC' : `Limit ${input.timeInForce ?? 'GTC'}`, amountMode: input.amountMode, quantity, notional, estimatedMargin: margin, estimatedOpenFee: fee, estimatedCloseFee: closeFee, estimatedOrderCost: margin + fee, estimatedAveragePrice: entry, estimatedSlippagePercent: input.maxSlippagePercent ?? 0.5, indicativeLiquidationPrice: NaN, marginType: input.marginType, leverage: p.leverage, maker, triggerLiveVerified: false, stopLoss: protection(input.stopLoss), takeProfit: protection(input.takeProfit) } }
}

export function mapHyperliquidHistory(h: HlTerminalHistory): AccountHistory {
  const fills = h.fills.filter(f => f.coin === 'BTC')
  return { synchronizedAt: h.checkedAt, warnings: ['Hyperliquid returns a bounded recent history; this is not a complete lifetime ledger.'],
    tradeHistory: fills.map(f => ({ tradeId: String(f.tid), orderId: String(f.oid), symbol: symbol(f.coin), side: f.side === 'B' ? 'BUY' : 'SELL', positionSide: f.dir.includes('Long') ? 'LONG' : f.dir.includes('Short') ? 'SHORT' : '', price: f.px, quantity: f.sz, realizedPnl: f.closedPnl, fee: f.fee, time: f.time })),
    orderHistory: h.orders.filter(o => o.order.coin === 'BTC').map(o => { const related = fills.filter(f => f.oid === o.order.oid); const size = related.reduce((n, f) => n + finite(f.sz), 0); return { orderId: String(o.order.oid), symbol: symbol(o.order.coin), side: o.order.side === 'B' ? 'BUY' : 'SELL', positionSide: '', type: o.order.orderType, price: o.order.limitPx, avgPrice: size ? String(related.reduce((n, f) => n + finite(f.px) * finite(f.sz), 0) / size) : '0', quantity: o.order.origSz, executedQty: String(size), status: o.status, realizedPnl: String(related.reduce((n, f) => n + finite(f.closedPnl), 0)), fee: String(related.reduce((n, f) => n + finite(f.fee), 0)), time: o.order.timestamp, updateTime: o.statusTimestamp } }),
  }
}
