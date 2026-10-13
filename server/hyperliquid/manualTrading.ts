import { HttpTransport, InfoClient } from '@nktkas/hyperliquid'
import Decimal from 'decimal.js'
import type { HlManualInput, HlManualPreview, HlManualSnapshot, HlManualNetwork } from '../../shared/hyperliquidManualTrading'
import { validateManualPreview } from '../../shared/hyperliquidManualTrading'
import { canonicalAccount } from './client'
export interface ManualTradingProvider {
  read(account: string): Promise<HlManualSnapshot>
  order(account: string, cloid: `0x${string}`): Promise<{ status: string; oid?: string }>
}
export function previewManualOrder(s: HlManualSnapshot, input: HlManualInput, now: number, cloid: string): HlManualPreview {
  if (s.masterRole !== 'user' || !['disabled', 'unifiedAccount'].includes(s.mode) || !['testnet', 'mainnet'].includes(s.network) || s.coin !== 'BTC') throw Error('Unsupported direct master EOA or account mode')
  if (!Number.isFinite(s.checkedAt) || now - s.checkedAt > 3000 || s.checkedAt > now + 5000) throw Error('Provider snapshot stale')
  if (!Number.isInteger(s.asset) || s.asset < 0 || !Number.isInteger(s.szDecimals) || s.szDecimals < 0 || s.szDecimals > 6) throw Error('Invalid native BTC metadata')
  const position = new Decimal(s.position), mid = new Decimal(s.mid)
  if (!position.isFinite() || !mid.isFinite() || mid.lte(0)) throw Error('Provider decimals unavailable')
  const close = input.action === 'close', buy = close ? position.isNegative() : input.action === 'open-long'
  if (!close && !position.isZero()) throw Error('Open requires a fresh flat BTC position')
  if (close && position.isZero()) throw Error('No BTC position to close')
  if (!['close', 'open-long', 'open-short'].includes(input.action)) throw Error('Unsupported action')
  if (!close && (!input.notionalUsd || !/^\d+(\.\d+)?$/.test(input.notionalUsd) || new Decimal(input.notionalUsd).lt(10) || new Decimal(input.notionalUsd).gt(20))) throw Error('Opening amount must be $10–$20')
  const rounding = buy ? Decimal.ROUND_DOWN : Decimal.ROUND_UP
  const price = mid.mul(buy ? '1.0025' : '0.9975').toSignificantDigits(5, rounding).toDecimalPlaces(6 - s.szDecimals, rounding)
  const size = close ? position.abs() : new Decimal(input.notionalUsd!).div(Decimal.max(price, mid)).toDecimalPlaces(s.szDecimals, Decimal.ROUND_DOWN)
  if (close && size.decimalPlaces() > s.szDecimals) throw Error('Full residual is not representable at native precision')
  if (!close && size.mul(price).lt(10)) throw Error('Rounded order below provider minimum $10; increase amount within $20')
  const p: HlManualPreview = { network: s.network, coin: 'BTC', account: canonicalAccount(s.account), mode: s.mode, action: input.action, positionBefore: s.position, requestedNotionalUsd: close ? null : input.notionalUsd!, limitNotionalUsd: size.mul(price).toFixed(), referenceMid: mid.toFixed(), szDecimals: s.szDecimals, checkedAt: s.checkedAt, createdAt: now, expiresAfter: now + 60000, order: { a: s.asset, b: buy, p: price.toFixed(), s: size.toFixed(), r: close, t: { limit: { tif: 'Ioc' } }, c: cloid as `0x${string}` } }
  validateManualPreview(p, now)
  return p
}
/** Only public info calls; this module never obtains a signer or submits to /exchange. */
export function createManualTradingProvider(network: HlManualNetwork = 'testnet'): ManualTradingProvider {
  if (!['testnet', 'mainnet'].includes(network)) throw Error('Unsupported Hyperliquid network')
  const info = new InfoClient({ transport: new HttpTransport({ isTestnet: network === 'testnet', timeout: 8000 }) })
  return {
    async read(account) {
      const user = canonicalAccount(account) as `0x${string}`, checkedAt = Date.now()
      const [mode, role, meta, mids, state, spot, orders] = await Promise.all([info.userAbstraction({ user }), info.userRole({ user }), info.meta(), info.allMids(), info.clearinghouseState({ user }), info.spotClearinghouseState({ user }), info.frontendOpenOrders({ user })])
      const asset = meta.universe.findIndex(x => x.name === 'BTC'), position = state.assetPositions.find(x => x.position.coin === 'BTC')?.position
      if (asset < 0 || meta.universe[asset].isDelisted || !mids.BTC) throw Error('Native BTC metadata/quote unavailable')
      if (!Array.isArray(orders)) throw Error('Provider open-order data unavailable')
      return { network, coin: 'BTC', account: user, mode, masterRole: role.role, position: position?.szi ?? '0', entryPrice: position?.entryPx ?? null, unrealizedPnl: position?.unrealizedPnl ?? null, mid: mids.BTC, asset, szDecimals: meta.universe[asset].szDecimals, perpsAccountValue: state.marginSummary.accountValue, withdrawable: state.withdrawable, spotUsdc: spot.balances.find(x => x.coin === 'USDC')?.total ?? null, checkedAt, openOrders: orders.filter(x => x.coin === 'BTC').map(x => ({ oid: String(x.oid), side: x.side, price: x.limitPx, size: x.sz, reduceOnly: x.reduceOnly, orderType: x.orderType })) }
    },
    async order(account, cloid) {
      const result = await info.orderStatus({ user: canonicalAccount(account) as `0x${string}`, oid: cloid })
      return result.status === 'order' ? { status: result.order.status, oid: String(result.order.order.oid) } : { status: 'unknownOid' }
    }
  }
}
