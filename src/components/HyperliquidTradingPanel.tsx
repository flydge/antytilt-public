import React, { useEffect, useRef, useState } from 'react'
import { ExchangeClient, HttpTransport, type IRequestTransport } from '@nktkas/hyperliquid'
import { ApiRequestError } from '@nktkas/hyperliquid/api/exchange'
import { createWalletClient, custom, recoverTypedDataAddress } from 'viem'
import { HL_API } from '../../shared/hyperliquid'
import { validateManualAuthorization, validateManualPreview, type HlManualAction, type HlManualPreview, type HlManualStatus, type HlManualOrderStatus, type HlManualNetwork } from '../../shared/hyperliquidManualTrading'
export type OwnerWallet = { request: (input: { method: string; params?: unknown[] }) => Promise<unknown> }
export function bindOwnerWalletNetwork(provider: OwnerWallet, network: HlManualNetwork, currentSelection: () => HlManualNetwork | null): OwnerWallet {
  return { request: async input => {
    if (currentSelection() !== network) throw Error('Execution network selection changed; discard the old preview')
    return provider.request(input)
  } }
}
export type ManualPending = { cloid: string; message: string; unknown: boolean }
export class ManualSubmissionError extends Error { constructor(message: string, public readonly uncertain: boolean, cause?: unknown) { super(message, { cause }) } }
export type OwnerOrderResult = { kind: 'FILLED' | 'ACKNOWLEDGED' | 'REJECTED'; oid?: string; filledSize?: string; averagePrice?: string; reason?: string }
/** The SDK signs the owner order in the injected wallet. No owner key or agent entry is used. */
export async function submitOwnerManualOrder(preview: HlManualPreview, provider: OwnerWallet, authorize?: () => Promise<void>): Promise<OwnerOrderResult> {
  validateManualPreview(preview, Date.now())
  if (preview.network === 'mainnet' && !authorize) throw Error('Mainnet requires explicit authenticated runtime authorization')
  let submitted = false
  const verifyMaster = async (method = 'eth_accounts') => {
    const accounts = await provider.request({ method })
    if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || accounts[0].toLowerCase() !== preview.account.toLowerCase()) throw Error('Select the linked master EOA in your wallet before signing')
  }
  try {
    await verifyMaster('eth_requestAccounts')
    const guardedProvider = { request: async (input: { method: string; params?: unknown[] }) => {
      if (input.method === 'eth_signTypedData_v4') {
        validateManualPreview(preview, Date.now()); await verifyMaster()
        const typed = JSON.parse(String(input.params?.[1]))
        if (typed.domain?.name !== 'Exchange' || Number(typed.domain?.chainId) !== 1337 || typed.primaryType !== 'Agent' || typed.message?.source !== (preview.network === 'testnet' ? 'b' : 'a')) throw Error('Unexpected Hyperliquid network signing domain')
        const signature = await provider.request(input)
        if (typeof signature !== 'string') throw Error('Owner signature unavailable')
        const recovered = await recoverTypedDataAddress({ ...typed, signature: signature as `0x${string}` })
        if (recovered.toLowerCase() !== preview.account.toLowerCase()) throw Error('Signature is not from the linked master EOA')
        return signature
      }
      return provider.request(input)
    } }
    const wallet = createWalletClient({ account: preview.account as `0x${string}`, transport: custom(guardedProvider, { retryCount: 0 }) })
    const http = new HttpTransport({ isTestnet: preview.network === 'testnet', timeout: 8000 })
    const transport: IRequestTransport = { isTestnet: preview.network === 'testnet', async request<T>(endpoint: 'info' | 'exchange', payload: unknown, signal?: AbortSignal): Promise<T> {
      validateManualPreview(preview, Date.now()); await verifyMaster()
      if (endpoint !== 'exchange') throw Error('Unexpected order transport')
      await authorize?.()
      validateManualPreview(preview, Date.now()); await verifyMaster()
      submitted = true
      return http.request<T>(endpoint, payload, signal)
    } }
    const exchange = new ExchangeClient({ transport, wallet })
    const result = await exchange.order({ orders: [preview.order], grouping: 'na' }, { expiresAfter: preview.expiresAfter })
    const status = result.response.data.statuses[0]
    if (status && typeof status === 'object' && 'filled' in status) return { kind: 'FILLED', oid: String(status.filled.oid), filledSize: status.filled.totalSz, averagePrice: status.filled.avgPx }
    return { kind: 'ACKNOWLEDGED', oid: status && typeof status === 'object' && 'resting' in status ? String(status.resting.oid) : undefined }
  } catch (error) {
    if (submitted && error instanceof ApiRequestError) {
      const response = error.response as { status?: string; response?: { type?: string; data?: { statuses?: unknown[] } } }
      const statuses = response.response?.data?.statuses
      const status = Array.isArray(statuses) && statuses.length === 1 ? statuses[0] : null
      // Only the provider's one explicit order-error status proves this one-order batch rejected.
      // HTTP errors, top-level strings, mixed arrays and malformed response shapes stay uncertain.
      if (response.status === 'ok' && response.response?.type === 'order' && status && typeof status === 'object' && Object.keys(status).length === 1 && 'error' in status && typeof status.error === 'string' && status.error.length > 0) return { kind: 'REJECTED', reason: status.error }
    }
    throw new ManualSubmissionError(submitted ? 'Order result is unknown; reconcile this client order ID before another submission' : error instanceof Error ? error.message : 'Wallet signing did not complete', submitted, error)
  }
}

type ViewProps = { network?: HlManualNetwork; data: HlManualStatus | null; now: number; busy?: string; error?: string; pending?: ManualPending | null; preview?: HlManualPreview | null; amount?: string; onAmount?: (value: string) => void; onPreview?: (action: HlManualAction) => void; onSubmit?: () => void; onDismiss?: () => void; onRefresh?: () => void; onReconcile?: () => void; onOpenProtection?: () => void }
const networkLabel = (network: HlManualNetwork) => network === 'testnet' ? 'Testnet' : 'Mainnet'
const nativeAccountUrl = (network: HlManualNetwork) => network === 'testnet' ? 'https://app.hyperliquid-testnet.xyz' : 'https://app.hyperliquid.xyz'
const format = (value: string | null | undefined, digits = 2) => value != null && Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-US', { maximumFractionDigits: digits }) : '—'
export function HyperliquidTradingView({ network = 'testnet', data, now, busy, error, pending, preview, amount = '15', onAmount, onPreview, onSubmit, onDismiss, onRefresh, onReconcile, onOpenProtection }: ViewProps) {
  const s = data?.network === network && data.snapshot?.network === network ? data.snapshot : null
  const fresh = Boolean(s && now - s.checkedAt <= 15000 && s.checkedAt <= now + 5000)
  const supported = Boolean(s && s.masterRole === 'user' && ['disabled', 'unifiedAccount'].includes(s.mode))
  const canAct = Boolean(data?.network === network && data.realActionsEnabled && s && fresh && supported && !busy && !pending && !preview)
  const flat = Boolean(s && Number(s.position) === 0)
  const review = preview?.network === network ? preview : null
  return <section className="order-panel advanced-order-panel hl-manual-trading" aria-label={`Hyperliquid ${networkLabel(network)} BTC owner trading`} aria-busy={Boolean(busy)}>
    <div className="order-topline"><strong>BTC / USD</strong><span>{networkLabel(network)}</span><button type="button" disabled={Boolean(busy)} onClick={onRefresh}>Refresh Account</button></div>
    <div className="order-balance"><span>Hyperliquid · {network === 'testnet' ? 'Test funds' : 'Real funds'}</span><strong>{s?.mode === 'unifiedAccount' ? 'Unified' : s?.mode === 'disabled' ? 'Standard' : s?.mode ?? 'Not linked'}</strong></div>
    {s ? <div className="order-size-note"><span title={s.account}>{s.account.slice(0, 8)}…{s.account.slice(-6)}</span><time dateTime={new Date(s.checkedAt).toISOString()}>{new Date(s.checkedAt).toLocaleTimeString()}</time></div> : <p className="order-size-note">Link your master wallet in BTC Protection to load this account.</p>}
    {data && !data.realActionsEnabled && <p className="exchange-error" role="status">{network === 'mainnet' ? 'Mainnet trading disabled · account reads only' : 'Owner trading disabled pending approval'}</p>}
    {s && !fresh && <p className="exchange-error" role="status">Account stale · refresh before order review</p>}
    {s && !supported && <p className="exchange-error" role="alert">Unsupported account role or mode</p>}
    {s && <div className="order-size-summary"><span>Perps equity<strong>{format(s.perpsAccountValue)} USD</strong></span><span>Spot balance<strong>{format(s.spotUsdc)} {network === 'testnet' ? 'test USDC' : 'USDC'}</strong></span><span>BTC mark<strong>{format(s.mid)} USD</strong></span></div>}
    {error && <p className="exchange-error" role="alert">{error}</p>}{busy && <p role="status">{busy}…</p>}
    <div className="order-types"><span>Market · IOC</span><span>25 bps price ceiling</span></div>
    <label className="input-shell amount-input"><span>Position value</span><input className="number-clean" inputMode="decimal" value={amount} disabled={Boolean(busy || pending || preview)} onChange={e => onAmount?.(e.target.value)} /><strong>USD</strong></label>
    <p className="order-size-note">$10–$20 entry · one wallet signature · no retry</p>
    <div className="side-switch"><button className="buy active" type="button" disabled={!canAct || !flat} onClick={() => onPreview?.('open-long')}>Open Long</button><button className="sell active" type="button" disabled={!canAct || !flat} onClick={() => onPreview?.('open-short')}>Open Short</button></div>
    <div className="order-size-summary"><span>BTC position<strong>{s ? `${format(s.position, 8)} BTC` : '—'}</strong></span><span>Entry price<strong>{format(s?.entryPrice)}</strong></span><span>Unrealized PnL<strong>{format(s?.unrealizedPnl)} USD</strong></span></div>
    <button className="place-order sell" type="button" disabled={!canAct || flat} onClick={() => onPreview?.('close')}>Close Full BTC Position</button>
    {review && <div className="hl-grant"><h3>Review {review.action} · {networkLabel(network)}</h3><dl className="hl-facts"><div><dt>Owner</dt><dd className="hl-address">{review.account}</dd></div><div><dt>Size / limit</dt><dd>{review.order.s} BTC / {review.order.p} USD</dd></div><div><dt>Signed notional cap</dt><dd>{review.limitNotionalUsd} USD</dd></div><div><dt>Order</dt><dd>IOC · {review.order.r ? 'reduce-only close' : 'entry'}</dd></div><div><dt>Review deadline</dt><dd><time dateTime={new Date(review.expiresAfter).toISOString()}>{new Date(review.expiresAfter).toLocaleTimeString()}</time> · {Math.max(0, Math.ceil((review.expiresAfter - now) / 1000))}s</dd></div></dl><p>Fixed price. Can reject or partially fill; do not trade this account elsewhere during review.</p><div className="hl-actions"><button type="button" disabled={Boolean(busy) || review.expiresAfter <= now || data?.network !== network || !data?.realActionsEnabled} onClick={onSubmit}>Sign and Submit Once</button><button type="button" disabled={Boolean(busy)} onClick={onDismiss}>Discard Preview</button></div></div>}
    {pending && <div className="exchange-error" role="status"><p>{pending.message}</p><small>Client order: {pending.cloid}</small><button type="button" disabled={Boolean(busy)} onClick={onReconcile}>Reconcile Order</button></div>}
    {s && <details><summary>BTC open orders {s.openOrders ? `(${s.openOrders.length})` : '· unavailable'}</summary>{s.openOrders?.length === 0 && <p>No BTC open orders in this snapshot.</p>}{s.openOrders?.map(order => <div className="order-size-note" key={order.oid}><span>{order.oid} · {order.side === 'B' ? 'Buy' : 'Sell'} {order.size} BTC</span><span>{order.price} USD{order.reduceOnly ? ' · reduce-only' : ''}</span></div>)}</details>}
    <div className="hl-actions"><button type="button" onClick={onOpenProtection}>Open BTC Protection</button><a href={nativeAccountUrl(network)} target="_blank" rel="noreferrer">Inspect {networkLabel(network)}</a></div>
    <p className="order-size-note">{network === 'testnet' ? 'Trading does not arm protection. Approve the separate agent and verify ARMED before protection test entries.' : 'Automatic protection is testnet-only. Mainnet uses real funds.'}</p>
    <details><summary>Account and order boundaries</summary><p>Spot balance does not certify available perpetual margin. Preview is not a position reservation; account changes abort before sending when detected. Pending algorithms are not cancelled. A remaining race after the last read is possible. Unknown results require reconciliation.</p></details>
  </section>
}
async function api<T>(network: HlManualNetwork, path: string, method = 'GET', body?: object): Promise<T> {
  if (!['testnet', 'mainnet'].includes(network)) throw Error('Unsupported Hyperliquid network')
  const response = await fetch(`${HL_API}/manual${path}${method === 'GET' ? `?network=${network}` : ''}`, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify({ ...body, network }) : undefined })
  const value = await response.json().catch(() => null)
  if (!response.ok || !value) throw Error(typeof value?.error === 'string' ? value.error : 'Hyperliquid account operation unavailable')
  if (value.network !== network || (value.snapshot && value.snapshot.network !== network)) throw Error('Hyperliquid response network mismatch')
  return value as T
}
export const manualPendingStorageKey = (account: string, network: HlManualNetwork) => `antytilt:hl:manual-pending:${network}:${account.toLowerCase()}`
const terminalStatus = (status: string) => status === 'filled' || status === 'canceled' || status === 'rejected' || status.endsWith('Canceled') || status.endsWith('Rejected')
export function HyperliquidTradingPanel({ onOpenProtection, network = 'testnet', referencePrice: _referencePrice }: { onOpenProtection: () => void; network?: HlManualNetwork; referencePrice?: number }) {
  const [data, setData] = useState<HlManualStatus | null>(null), [now, setNow] = useState(Date.now), [busy, setBusy] = useState(''), [error, setError] = useState(''), [amount, setAmount] = useState('15'), [preview, setPreview] = useState<HlManualPreview | null>(null), [pending, setPending] = useState<ManualPending | null>(null)
  const inflight = useRef(false), selection = useRef(network), alive = useRef(false), generation = useRef(0)
  selection.current = network
  const currentSelection = () => alive.current ? selection.current : null
  const assertSelection = (expected: HlManualNetwork) => { if (currentSelection() !== expected) throw Error('Execution network changed; discard the old preview') }
  const refresh = async () => {
    const requestedNetwork = network, version = generation.current
    const status = await api<HlManualStatus>(requestedNetwork, '/status')
    if (!alive.current || selection.current !== requestedNetwork || generation.current !== version) return
    setData(status)
    if (status.snapshot) {
      const raw = localStorage.getItem(manualPendingStorageKey(status.snapshot.account, requestedNetwork))
      if (raw) { const stored = JSON.parse(raw); if (typeof stored.cloid === 'string' && /^0x[0-9a-f]{32}$/.test(stored.cloid)) setPending(stored) }
      else setPending(null)
    }
  }
  useEffect(() => {
    alive.current = true; generation.current++
    setData(null); setPreview(null); setPending(null); setError('')
    void refresh().catch(e => { if (alive.current && selection.current === network) setError(e instanceof Error ? e.message : 'Account unavailable') })
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => { alive.current = false; generation.current++; clearInterval(timer) }
  }, [network])
  const run = async (label: string, action: () => Promise<void>) => {
    if (inflight.current) return
    inflight.current = true; const actionNetwork = network
    setBusy(label); setError('')
    try { await action() } catch (e) { if (alive.current && selection.current === actionNetwork) setError(e instanceof Error ? e.message : 'Operation failed') }
    finally { inflight.current = false; if (alive.current) setBusy('') }
  }
  const savePending = (account: string, actionNetwork: HlManualNetwork, next: ManualPending | null) => {
    const key = manualPendingStorageKey(account, actionNetwork)
    if (next) localStorage.setItem(key, JSON.stringify(next)); else localStorage.removeItem(key)
    if (alive.current && selection.current === actionNetwork) setPending(next)
  }
  const submit = async () => {
    if (!preview || pending) return
    const p = preview, actionGeneration = generation.current
    const orderSelection = () => generation.current === actionGeneration ? currentSelection() : null
    const assertOrderSelection = () => { if (orderSelection() !== p.network) throw Error('Execution network selection changed; discard the old preview') }
    assertOrderSelection()
    const current = await api<HlManualStatus>(p.network, '/status')
    assertOrderSelection(); validateManualAuthorization(p, current, Date.now()); validateManualPreview(p, Date.now())
    const injected = (window as Window & { ethereum?: OwnerWallet }).ethereum
    if (!injected) throw Error('An injected EOA wallet is required; owner must approve each order')
    const wallet = bindOwnerWalletNetwork(injected, p.network, orderSelection)
    if (localStorage.getItem(manualPendingStorageKey(p.account, p.network))) throw Error('An existing manual order requires reconciliation before another submission')
    const unknown = { cloid: p.order.c, unknown: true, message: 'Owner signing/submission in progress; do not submit another order' }
    savePending(p.account, p.network, unknown); setPreview(null)
    try {
      const result = await submitOwnerManualOrder(p, wallet, async () => {
        assertOrderSelection()
        const latest = await api<HlManualStatus>(p.network, '/status')
        assertOrderSelection(); validateManualAuthorization(p, latest, Date.now())
      })
      if (result.kind === 'REJECTED') { savePending(p.account, p.network, null); if (currentSelection() === p.network) setError(`REJECTED: ${result.reason}. Request a new preview for any next owner action.`) }
      else if (result.kind === 'FILLED') { savePending(p.account, p.network, null); if (currentSelection() === p.network) setError(`Provider fill: ${result.filledSize} BTC at ${result.averagePrice} USD. Inspect refreshed residual.`) }
      else savePending(p.account, p.network, { ...unknown, message: 'Acknowledged; fill unconfirmed. Reconcile before another submission.' })
    } catch (e) {
      if (e instanceof ManualSubmissionError && !e.uncertain) savePending(p.account, p.network, null)
      else savePending(p.account, p.network, { ...unknown, message: 'Unknown result; reconcile before another order. No automatic retry.' })
      throw e
    } finally { if (currentSelection() === p.network) await refresh().catch(() => undefined) }
  }
  const reconcile = async () => {
    if (!pending || !data?.snapshot || data.network !== network) return
    const master = data.snapshot.account, requestedNetwork = network
    const result = await api<HlManualOrderStatus>(requestedNetwork, `/order/${pending.cloid}`)
    assertSelection(requestedNetwork)
    if (result.snapshot.account !== master) throw Error('Reconciliation master changed')
    setData({ ...data, snapshot: result.snapshot })
    if (terminalStatus(result.status)) { savePending(master, requestedNetwork, null); setError(`Provider order state: ${result.status}${result.oid ? ` · order ${result.oid}` : ''}. Inspect BTC residual before the next action.`) }
    else savePending(master, requestedNetwork, { ...pending, message: `Provider state: ${result.status}. Unresolved; new submissions remain disabled.` })
  }
  return <HyperliquidTradingView network={network} data={data} now={now} busy={busy} error={error} amount={amount} onAmount={setAmount} preview={preview} pending={pending} onOpenProtection={onOpenProtection} onRefresh={() => void run('Refreshing Account', refresh)} onPreview={action => void run('Preparing Owner Order', async () => { if (pending) return; const requestedNetwork = network; const next = await api<HlManualPreview>(requestedNetwork, '/preview', 'POST', { action, ...(action === 'close' ? {} : { notionalUsd: amount }) }); assertSelection(requestedNetwork); setPreview(next) })} onSubmit={() => void run('Awaiting Owner Signature', submit)} onDismiss={() => setPreview(null)} onReconcile={() => void run('Reconciling Order', reconcile)} />
}
