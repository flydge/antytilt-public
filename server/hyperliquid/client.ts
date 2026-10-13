import { HttpTransport, InfoClient, ExchangeClient } from '@nktkas/hyperliquid'
import { ApiRequestError } from '@nktkas/hyperliquid/api/exchange'
import { privateKeyToAccount } from 'viem/accounts'
import Decimal from 'decimal.js'
import type { HlOutcome } from '../../shared/hyperliquid'

export const NATIVE_URL = 'https://app.hyperliquid-testnet.xyz/'
export const agentNameBase = (name: string) => name.replace(/ valid_until \d+$/, '')
export const realActionsEnabled = () => process.env.HL_REAL_ACTIONS_CONFIRMED === 'true'
export type Fill = {
  id: string
  time: number
  coin: string
  startPosition: string
  sz: string
  side: 'B' | 'A'
  oid: string
  px: string
  cloid?: string
}
export type Grant = { address: string; name: string; validUntil: number | null }
export type Snapshot = {
  mode: string
  position: string
  mid: string
  asset: number
  szDecimals: number
  fills: Fill[]
  historyComplete: boolean
  grants: Grant[]
  checkedAt: number
}
export type ClosePlan = {
  order: {
    a: number
    b: boolean
    p: string
    s: string
    r: true
    t: { limit: { tif: 'Ioc' } }
    c: `0x${string}`
  }
  expiresAfter: number
}
export class ProviderRejected extends Error {}
export class UnsupportedMasterRole extends Error {
  readonly status = 409
}
export interface Provider {
  read(account: string, start: number, end: number): Promise<Snapshot>
  orders(account: string, cloid: string): Promise<{ status: string; oid?: string }>
  submit(plan: ClosePlan, secret: `0x${string}`, nonce: number): Promise<{ oid?: string }>
}
export function canonicalAccount(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value))
    throw new Error('Invalid master EOA address')
  return value.toLowerCase()
}
export function tradingDay(now: number, timezone: string) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })
  const dayAt = (t: number) => formatter.format(t)
  const day = dayAt(now)
  // Find actual civil boundaries; binary search handles 23/25-hour DST days.
  const boundary = (lo: number, hi: number, target: string) => {
    while (hi - lo > 1) {
      const m = Math.floor((lo + hi) / 2)
      if (dayAt(m) < target) lo = m
      else hi = m
    }
    return hi
  }
  const start = boundary(now - 48 * 3600000, now, day)
  let lo = now,
    hi = now + 48 * 3600000
  while (hi - lo > 1) {
    const m = Math.floor((lo + hi) / 2)
    if (dayAt(m) === day) lo = m
    else hi = m
  }
  return { day, start, end: hi }
}
export function sameEconomicFill(a: Fill, b: Fill) {
  const canonical = (f: Fill) =>
    JSON.stringify([
      f.id,
      f.time,
      f.coin,
      new Decimal(f.startPosition).toFixed(),
      new Decimal(f.sz).toFixed(),
      f.side,
      f.oid,
      new Decimal(f.px).toFixed(),
      f.cloid ?? null
    ])
  try {
    return canonical(a) === canonical(b)
  } catch {
    return false
  }
}
export function reconstructEntries(fills: Fill[], snapshot: string) {
  const dedup = new Map<string, Fill>()
  let consistent = true
  for (const f of fills.filter((f) => f.coin === 'BTC')) {
    const old = dedup.get(f.id)
    if (old && !sameEconomicFill(old, f)) consistent = false
    dedup.set(f.id, f)
  }
  const sorted = [...dedup.values()].sort(
    (a, b) => a.time - b.time || Number(a.id) - Number(b.id) || a.id.localeCompare(b.id)
  )
  let position: Decimal | undefined,
    entryCount = 0,
    episodeId: string | null = null
  const episodes: { id: string; ordinal: number; openedAt: number }[] = []
  try {
    for (const f of sorted) {
      const start = new Decimal(f.startPosition),
        size = new Decimal(f.sz)
      if (!size.isFinite() || size.lte(0) || !start.isFinite()) throw Error('fill precision')
      if (position && !position.eq(start)) consistent = false
      const next = start.plus(f.side === 'B' ? size : size.neg())
      if (
        (start.isZero() && !next.isZero()) ||
        (!start.isZero() && !next.isZero() && start.isPositive() !== next.isPositive())
      ) {
        entryCount++
        episodeId = f.id
        episodes.push({ id: f.id, ordinal: entryCount, openedAt: f.time })
      } else if (!start.isZero() && !episodeId) episodeId = `carry:${f.id}`
      if (next.isZero()) episodeId = null
      position = next
    }
    const current = new Decimal(snapshot)
    if (!current.isFinite() || (position && !position.eq(current))) consistent = false
    return {
      entryCount,
      episodeId,
      episodes,
      remainingSize: current.toFixed(),
      historyComplete: consistent,
      fills: sorted
    }
  } catch {
    return {
      entryCount,
      episodeId: null,
      episodes,
      remainingSize: snapshot,
      historyComplete: false,
      fills: sorted
    }
  }
}
export function planClose(input: {
  position: string
  mid: string
  asset: number
  szDecimals: number
  slippageBps: number
  maxCloseNotionalUsd: string
  now: number
  dayEnd: number
  consentExpiry: number
  grantExpiry: number
  cloid: string
}): ClosePlan {
  const p = new Decimal(input.position),
    mid = new Decimal(input.mid),
    ceiling = new Decimal(input.maxCloseNotionalUsd)
  if (!p.isFinite() || !mid.isFinite() || mid.lte(0) || !ceiling.isFinite() || ceiling.lte(0))
    throw Error('Invalid decimal')
  if (
    !Number.isInteger(input.asset) ||
    input.asset < 0 ||
    !Number.isInteger(input.szDecimals) ||
    input.szDecimals < 0 ||
    input.szDecimals > 6
  )
    throw Error('Invalid native metadata')
  if (!Number.isInteger(input.slippageBps) || input.slippageBps < 1 || input.slippageBps > 100)
    throw Error('Slippage must be 1–100 bps')
  const buy = p.isNegative(),
    bound = mid.mul(
      new Decimal(1).plus(new Decimal(input.slippageBps).div(10000).mul(buy ? 1 : -1))
    )
  if (p.abs().mul(mid).gt(ceiling) || p.abs().mul(bound).gt(ceiling))
    throw Error('Close notional exceeds ceiling; no partial action')
  const qty = p.abs().toDecimalPlaces(input.szDecimals, Decimal.ROUND_DOWN)
  if (qty.isZero()) throw Error('Position is dust at native size precision')
  const rounding = buy ? Decimal.ROUND_DOWN : Decimal.ROUND_UP
  // Native perp price: <=5 significant digits and <=6-szDecimals decimals; round inside slippage cap.
  const price = bound
    .toSignificantDigits(5, rounding)
    .toDecimalPlaces(6 - input.szDecimals, rounding)
  const expiresAfter = Math.min(
    input.now + 5000,
    input.dayEnd,
    input.consentExpiry,
    input.grantExpiry
  )
  if (expiresAfter <= input.now) throw Error('Action window expired')
  if (!/^0x[0-9a-f]{32}$/.test(input.cloid) || price.lte(0)) throw Error('Invalid close payload')
  return {
    order: {
      a: input.asset,
      b: buy,
      p: price.toFixed(),
      s: qty.toFixed(),
      r: true,
      t: { limit: { tif: 'Ioc' } },
      c: input.cloid as `0x${string}`
    },
    expiresAfter
  }
}
export const terminalOrderStatus = (status: string) =>
  status === 'filled' ||
  status === 'canceled' ||
  status === 'rejected' ||
  status.endsWith('Canceled') ||
  status.endsWith('Rejected')
export function resolveOutcome(target: string, residual: string, agent: string): HlOutcome {
  const t = new Decimal(target),
    r = new Decimal(residual).abs(),
    a = new Decimal(agent)
  if (!r.isZero()) return 'PARTIAL'
  if (a.isZero()) return 'RESOLVED_EXTERNALLY'
  return a.eq(t) ? 'CONFIRMED_CLOSED' : 'MIXED_RESOLUTION'
}
export function createProvider(): Provider {
  const transport = new HttpTransport({ isTestnet: true, timeout: 8000 }),
    info = new InfoClient({ transport })
  return {
    async read(account, start, end) {
      const user = canonicalAccount(account) as `0x${string}`
      const fills: Fill[] = [],
        ids = new Set<string>()
      let cursor = 0,
        complete = false,
        oldest = Infinity
      // Fetch the retained window, including pre-day overlap: a truncated retained window
      // wholly inside today cannot certify the beginning of the day.
      for (let page = 0; page < 8; page++) {
        const batch = await info.userFillsByTime({
          user,
          startTime: cursor,
          endTime: end,
          aggregateByTime: false,
          reversed: false
        })
        let maxTime = cursor
        for (const f of batch) {
          const id = String(f.tid)
          maxTime = Math.max(maxTime, f.time)
          oldest = Math.min(oldest, f.time)
          if (!ids.has(id)) {
            ids.add(id)
            if (f.time >= start)
              fills.push({
                id,
                time: f.time,
                coin: f.coin,
                startPosition: f.startPosition,
                sz: f.sz,
                side: f.side,
                oid: String(f.oid),
                px: f.px,
                ...(f.cloid ? { cloid: f.cloid } : {})
              })
          }
        }
        if (ids.size >= 10000) {
          complete = oldest < start
          break
        }
        if (batch.length < 2000) {
          complete = true
          break
        }
        if (maxTime <= cursor) break
        cursor = maxTime
      }
      // Fresh authorization and quote reads follow history; checkedAt is earliest component read.
      const checkedAt = Date.now()
      const [mode, meta, mids, grants, role] = await Promise.all([
        info.userAbstraction({ user }),
        info.meta(),
        info.allMids(),
        info.extraAgents({ user }),
        info.userRole({ user })
      ])
      if (role.role !== 'user')
        throw new UnsupportedMasterRole(
          `Unsupported master account role: ${role.role}; only direct master EOA user is supported`
        )
      const state = await info.clearinghouseState({ user }),
        asset = meta.universe.findIndex((x) => x.name === 'BTC')
      if (asset < 0 || meta.universe[asset].isDelisted)
        throw Error('Native BTC metadata unavailable')
      const position =
        state.assetPositions.find((x) => x.position.coin === 'BTC')?.position.szi ?? '0'
      return {
        mode,
        position,
        mid: mids.BTC,
        asset,
        szDecimals: meta.universe[asset].szDecimals,
        fills,
        historyComplete: complete,
        grants,
        checkedAt
      }
    },
    async orders(account, cloid) {
      const r = await info.orderStatus({
        user: canonicalAccount(account) as `0x${string}`,
        oid: cloid as `0x${string}`
      })
      return r.status === 'order'
        ? { status: r.order.status, oid: String(r.order.order.oid) }
        : { status: 'unknownOid' }
    },
    async submit(plan, secret, nonce) {
      if (!realActionsEnabled()) throw Error('Real Hyperliquid actions are not confirmed')
      // Only this narrow close action reaches the exchange SDK. No owner or arbitrary action API.
      if (
        plan.order.r !== true ||
        plan.order.t.limit.tif !== 'Ioc' ||
        plan.expiresAfter <= Date.now()
      )
        throw Error('Invalid or expired close action')
      const client = new ExchangeClient({
        transport,
        wallet: privateKeyToAccount(secret),
        nonceManager: () => nonce
      })
      let result
      try {
        result = await client.order(
          { orders: [plan.order], grouping: 'na' },
          { expiresAfter: plan.expiresAfter, signal: AbortSignal.timeout(7000) }
        )
      } catch (error) {
        if (error instanceof ApiRequestError) {
          const statuses = (error.response as { response?: { data?: { statuses?: unknown[] } } })
            .response?.data?.statuses
          if (
            statuses?.length === 1 &&
            statuses[0] &&
            typeof statuses[0] === 'object' &&
            'error' in statuses[0]
          )
            throw new ProviderRejected('Provider returned an explicit per-order rejection')
        }
        throw error
      }
      const status = result.response.data.statuses[0]
      return status && typeof status === 'object' && 'filled' in status
        ? { oid: String(status.filled.oid) }
        : status && typeof status === 'object' && 'resting' in status
          ? { oid: String(status.resting.oid) }
          : {}
    }
  }
}
