import Decimal from 'decimal.js'
export type HlManualNetwork = 'testnet' | 'mainnet'
export type HlManualAction = 'open-long' | 'open-short' | 'close'
export interface HlManualInput { action: HlManualAction; notionalUsd?: string }
export interface HlManualSnapshot {
  network: HlManualNetwork; coin: 'BTC'; account: string; mode: string; masterRole: string
  position: string; entryPrice: string | null; unrealizedPnl: string | null
  mid: string; asset: number; szDecimals: number
  perpsAccountValue: string; withdrawable: string; spotUsdc: string | null; checkedAt: number
  openOrders?: { oid: string; side: 'A' | 'B'; price: string; size: string; reduceOnly: boolean; orderType: string }[]
}
export interface HlManualStatus { network: HlManualNetwork; realActionsEnabled: boolean; snapshot: HlManualSnapshot | null }
export interface HlManualPreview {
  network: HlManualNetwork; coin: 'BTC'; account: string; mode: string; action: HlManualAction
  positionBefore: string; requestedNotionalUsd: string | null; limitNotionalUsd: string
  referenceMid: string; szDecimals: number; checkedAt: number; createdAt: number; expiresAfter: number
  order: { a: number; b: boolean; p: string; s: string; r: boolean; t: { limit: { tif: 'Ioc' } }; c: `0x${string}` }
}
export interface HlManualOrderStatus { network: HlManualNetwork; status: string; oid?: string; snapshot: HlManualSnapshot }
export function validateManualAuthorization(p: HlManualPreview, status: HlManualStatus, now: number) {
  const s = status.snapshot
  if (!status.realActionsEnabled || status.network !== p.network || !s || s.network !== p.network || s.coin !== 'BTC' || s.account.toLowerCase() !== p.account.toLowerCase()) throw Error('Owner action gate, network or linked master changed')
  if (s.masterRole !== 'user' || s.mode !== p.mode || !['disabled', 'unifiedAccount'].includes(s.mode) || s.asset !== p.order.a || s.szDecimals !== p.szDecimals) throw Error('Account mode or native metadata changed; discard preview')
  if (!Number.isFinite(s.checkedAt) || now - s.checkedAt > 3000 || s.checkedAt > now + 5000) throw Error('Fresh authorization snapshot unavailable')
  if (!new Decimal(s.position).eq(p.positionBefore)) throw Error('BTC position changed during review; discard preview')
  if (new Decimal(s.position).abs().mul(s.mid).gt(20)) throw Error('Current residual exceeds approved $20 cap')
}
/** Browser defence in depth for the narrow payload displayed before owner signing. */
export function validateManualPreview(p: HlManualPreview, now: number) {
  if (!p || !['testnet', 'mainnet'].includes(p.network) || p.coin !== 'BTC' || !/^0x[0-9a-fA-F]{40}$/.test(p.account) || !['disabled', 'unifiedAccount'].includes(p.mode)) throw Error('Unsupported owner/network/mode')
  if (!Number.isFinite(p.createdAt) || !Number.isFinite(p.checkedAt) || !Number.isFinite(p.expiresAfter) || p.expiresAfter <= now || p.createdAt > now + 5000 || p.checkedAt > now + 5000 || p.createdAt - p.checkedAt > 3000 || now - p.createdAt > 60000 || p.expiresAfter > p.createdAt + 60000) throw Error('Preview expired or stale; request a new preview')
  const o = p.order
  if (!Number.isInteger(o.a) || o.a < 0 || !Number.isInteger(p.szDecimals) || p.szDecimals < 0 || p.szDecimals > 6 || !/^0x[0-9a-f]{32}$/.test(o.c) || o.t?.limit?.tif !== 'Ioc') throw Error('Invalid native order bounds')
  const price = new Decimal(o.p), size = new Decimal(o.s), mid = new Decimal(p.referenceMid), before = new Decimal(p.positionBefore)
  if (!price.isFinite() || !size.isFinite() || !mid.isFinite() || !before.isFinite() || price.lte(0) || size.lte(0) || mid.lte(0) || size.decimalPlaces() > p.szDecimals || price.decimalPlaces() > 6 - p.szDecimals || (!price.isInteger() && price.precision() > 5)) throw Error('Invalid order precision/bounds')
  const notional = size.mul(price)
  if (notional.gt(20) || size.mul(mid).gt(20) || !notional.eq(p.limitNotionalUsd)) throw Error('Order notional exceeds approved bounds')
  if (o.b ? price.lt(mid) || price.gt(mid.mul('1.0025')) : price.gt(mid) || price.lt(mid.mul('0.9975'))) throw Error('Price exceeds 25bps slippage bound')
  if (p.action === 'close') {
    if (!o.r || before.isZero() || o.b !== before.isNegative() || !size.eq(before.abs())) throw Error('Close must reduce the exact full BTC residual')
  } else if (p.action === 'open-long' || p.action === 'open-short') {
    if (o.r || !before.isZero() || o.b !== (p.action === 'open-long') || notional.lt(10) || !p.requestedNotionalUsd || !/^\d+(\.\d+)?$/.test(p.requestedNotionalUsd) || notional.gt(p.requestedNotionalUsd) || new Decimal(p.requestedNotionalUsd).gt(20)) throw Error('Open must be flat and within $10–$20 bounds')
  } else throw Error('Unsupported manual action')
}
