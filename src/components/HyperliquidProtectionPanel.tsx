import React, { useEffect, useState } from 'react'
import { HL_API, HL_CONSENT, type HlAgentResponse, type HlChallengeResponse, type HlPolicyInput, type HlStatusResponse } from '../../shared/hyperliquid'

const unresolved = new Set(['BREACH_DETECTED', 'CLOSING', 'PARTIAL', 'UNCERTAIN', 'ACTION_FAILED'])
const supportedModes = new Set(['disabled', 'unifiedAccount'])
export function projectHlReadiness(data: HlStatusResponse | null, now: number, online: boolean): string {
  if (!online) return 'OFFLINE'
  if (!data) return 'UNKNOWN'
  if (!data.realActionsEnabled) return 'PREAPPROVAL'
  const c = data.connection
  if (!c) return 'NOT_CONNECTED'
  if (c.status !== 'ARMED') return c.status
  if (!c.enabled || !c.historyComplete || c.network !== 'testnet') return 'UNKNOWN'
  if (!c.mode || !supportedModes.has(c.mode)) return 'UNSUPPORTED_MODE'
  if (!c.lastCheckedAt || !c.workerLastSeenAt || now - c.lastCheckedAt > 15000 || now - c.workerLastSeenAt > 15000 || c.lastCheckedAt > now + 5000 || c.workerLastSeenAt > now + 5000) return 'STALE'
  if (!c.grantExpiresAt || c.grantExpiresAt <= now || c.policy.consentExpiresAt <= now) return 'EXPIRED'
  return 'ARMED'
}

const statusMeaning: Record<string, string> = {
  PREAPPROVAL: 'Real wallet actions are disabled pending owner approval.', UNKNOWN: 'Readiness is unknown. No current protection claim.', OFFLINE: 'Browser is offline. Current protection readiness cannot be confirmed.', STALE: 'Worker or account check is over 15 seconds old. Current readiness cannot be confirmed.',
  NOT_CONNECTED: 'No wallet linked, no rights granted, no orders sent.', LINKED_READ_ONLY: 'Wallet linked for reads. No authorized background protection.', AWAITING_GRANT: 'Approve the dedicated agent manually in Hyperliquid native UI.', SYNCING: 'History, grant and account mode are being checked. Not armed yet.',
  ARMED: 'Ready for a bounded BTC post-fill close. This does not block entries or certify absence of pending orders.', BREACH_DETECTED: 'An excessive entry already filled. Its close is not confirmed.', CLOSING: 'A close attempt is in progress. Provider acknowledgement is not a confirmed close.',
  DATA_GAP: 'History is incomplete or inconsistent. New sends are paused.', DEGRADED: 'Worker or dependencies are not healthy. Readiness is not confirmed.', UNSUPPORTED_MODE: 'Account mode is unsupported or unknown. Do not change it automatically.', REVOKED: 'Grant revoked. New sends are stopped; submitted attempts are reconciled separately.', EXPIRED: 'Grant or consent expired. New sends are stopped.', DISABLED: 'Locally disabled. Revoking the grant is a separate native UI action.', UNCERTAIN: 'The action result is unknown. No retry or autonomous success is claimed.', ACTION_FAILED: 'A close failed or reached its bound. Inspect the remaining BTC position in native UI.',
}
function Timestamp({ value }: { value: number | null }) {
  return value && Number.isFinite(value) ? <time dateTime={new Date(value).toISOString()}>{new Date(value).toLocaleString()}</time> : <>Unknown</>
}

type Actions = {
  busy?: string; error?: string; consent?: boolean; onConsent?: (value: boolean) => void
  onLink?: () => void; onAgent?: () => void; onArm?: () => void; onDisable?: () => void
  onSave?: (input: Omit<HlPolicyInput, 'connectionId'>) => void; onRefresh?: () => void
}
export function HyperliquidProtectionView({ data, now, online, busy, error, consent = false, onConsent, onLink, onAgent, onArm, onDisable, onSave, onRefresh }: { data: HlStatusResponse | null; now: number; online: boolean } & Actions) {
  const [copyError, setCopyError] = useState('')
  const copy = async (value: string) => { try { await navigator.clipboard.writeText(value); setCopyError('') } catch { setCopyError('Clipboard unavailable. Select and copy the displayed agent details manually.') } }
  const c = data?.connection
  const fresh = Boolean(c?.lastCheckedAt && c.workerLastSeenAt && now - c.lastCheckedAt <= 15000 && now - c.workerLastSeenAt <= 15000 && c.lastCheckedAt <= now + 5000 && c.workerLastSeenAt <= now + 5000)
  const readiness = projectHlReadiness(data, now, online)
  const safeToAct = Boolean(data?.realActionsEnabled && online && !busy && data)
  const hasUnresolved = Boolean(c && (unresolved.has(c.status)))
  const canEdit = Boolean(safeToAct && c && /^[-+]?0+(\.0+)?$/.test(c.remainingSize) && !hasUnresolved)
  const nativeUrl = data?.nativeUrl?.startsWith('https://app.hyperliquid-testnet.xyz') ? 'https://app.hyperliquid-testnet.xyz' : undefined
  return <section className="hl-protection" aria-labelledby="hl-title" aria-busy={Boolean(busy)}>
    <header className="hl-header"><div><span className="hl-kicker">Independent connection · Testnet only</span><h2 id="hl-title">Hyperliquid BTC Protection</h2><p>Daily entry episodes · native BTC perpetual · master EOA</p></div><button type="button" onClick={onRefresh} disabled={Boolean(busy)}>Refresh Status</button></header>
    <div className={`hl-readiness ${readiness === 'ARMED' ? 'hl-ready' : ''}`} role="status"><strong>Readiness: {readiness}</strong><p>{statusMeaning[readiness] ?? 'Readiness is not confirmed.'}</p></div>
    {(!c && data) && <p>No wallet linked, no rights granted, no orders sent.</p>}
    {error && <p className="hl-error" role="alert">{error}</p>}{copyError && <p className="hl-error" role="alert">{copyError}</p>}
    {busy && <p role="status">{busy}…</p>}
    {c && <><dl className="hl-facts">
      <div><dt>Network / market</dt><dd>{c.network} / {c.coin}</dd></div><div><dt>Account</dt><dd className="hl-address">{c.account}</dd></div><div><dt>Account mode</dt><dd>{c.mode === 'disabled' ? 'Standard (disabled)' : c.mode === 'unifiedAccount' ? 'Unified (unifiedAccount)' : c.mode ?? 'Unknown'}</dd></div>
      <div><dt>Entries / daily limit</dt><dd>{c.entryCount} / {c.policy.dailyEntryLimit}</dd></div><div><dt>Day / timezone</dt><dd>{c.day} / {c.policy.timezone}</dd></div><div><dt>Policy version</dt><dd>{c.policy.version}</dd></div>
      <div><dt>Current BTC residual</dt><dd>{c.remainingSize}</dd></div><div><dt>History complete</dt><dd>{c.historyComplete ? 'Yes' : 'No'}</dd></div><div><dt>Grant expiry</dt><dd><Timestamp value={c.grantExpiresAt} /></dd></div>
      <div><dt>Account last checked</dt><dd><Timestamp value={c.lastCheckedAt} /></dd></div><div><dt>Worker last seen</dt><dd><Timestamp value={c.workerLastSeenAt} /></dd></div><div><dt>Consent expiry</dt><dd><Timestamp value={c.policy.consentExpiresAt} /></dd></div>
      </dl><p>Server state: {c.status} · {c.reason}</p></>}
    <div className="hl-actions"><button type="button" disabled={!safeToAct || Boolean(c)} onClick={onLink}>Link Wallet</button><button type="button" disabled={!safeToAct || !c || Boolean(c.agentAddress)} onClick={onAgent}>Prepare Named Agent</button></div>
    {c?.agentAddress && <div className="hl-grant"><h3>Manual Agent Approval</h3><p>In Hyperliquid testnet native UI, approve this dedicated named agent. Review broader protocol trading rights before granting access. AntyTILT does not sign or submit your grant.</p><dl><dt>Agent address</dt><dd className="hl-address">{c.agentAddress}</dd><dt>Agent name</dt><dd>{c.agentName}</dd><dt>Grant expiry</dt><dd><Timestamp value={c.grantExpiresAt} /></dd></dl><button type="button" disabled={!navigatorClipboardAvailable()} onClick={() => void copy(c.agentAddress!)}>Copy Agent Address</button><button type="button" disabled={!navigatorClipboardAvailable()} onClick={() => void copy(c.agentName ?? '')}>Copy Agent Name</button><button type="button" disabled={!navigatorClipboardAvailable() || !c.grantExpiresAt} onClick={() => void copy(new Date(c.grantExpiresAt!).toISOString())}>Copy Grant Expiry</button><p>Refresh status after approval. No existing agent is replaced automatically.</p></div>}
    <form className="hl-policy" key={`${c?.id ?? 'proposal'}-${c?.policy.version ?? 0}`} onSubmit={event => {
      event.preventDefault(); if (!canEdit) return
      const fields = new FormData(event.currentTarget)
      onSave?.({ dailyEntryLimit: Number(fields.get('dailyEntryLimit')), timezone: String(fields.get('timezone')), slippageBps: Number(fields.get('slippageBps')), maxCloseNotionalUsd: String(fields.get('maxCloseNotionalUsd')), consentExpiresAt: now + Number(fields.get('deadlineMinutes')) * 60000 })
    }}><h3>{c ? 'Policy' : 'Proposed Policy'}</h3><div className="hl-policy-fields">
      <label>Daily Entry Limit<input name="dailyEntryLimit" type="number" min="1" max="100" step="1" required defaultValue={c?.policy.dailyEntryLimit ?? 1} disabled={!canEdit} /></label>
      <label>IANA Timezone<input name="timezone" required defaultValue={c?.policy.timezone ?? 'Europe/Warsaw'} disabled={!canEdit} /></label>
      <label>Slippage Ceiling (bps)<input name="slippageBps" type="number" min="1" max="100" step="1" required defaultValue={c?.policy.slippageBps ?? 25} disabled={!canEdit} /></label>
      <label>Maximum Close Notional (USD)<input name="maxCloseNotionalUsd" type="text" inputMode="decimal" pattern="[0-9]+([.][0-9]+)?" required defaultValue={c?.policy.maxCloseNotionalUsd ?? '20'} disabled={!canEdit} /></label>
      <label>Consent Duration (minutes)<input name="deadlineMinutes" type="number" min="1" max="60" step="1" required defaultValue="60" disabled={!canEdit} /></label>
      </div><p>Policy changes require a flat BTC position and no unresolved action. A new version does not reset today's entry count.</p><button type="submit" disabled={!canEdit}>Save Policy</button></form>
    <div className="hl-consent"><h3>Understand the Automation</h3><ul>
      <li>This daily entry count does not limit position size or risk. Scale-ins in the same episode do not count as another entry.</li>
      <li>The agent has broader protocol trading rights; the venue does not enforce a close-only grant. AntyTILT's server limits itself to bounded reduce-only BTC closes.</li>
      <li>The worker closes the current BTC residual after an excessive entry fills. Replacing the position between read and execution can cause the replacement position to be reduced.</li>
      <li>Pending orders and algorithms are not cancelled. Future fills are not prevented; a checked flat position is a timestamped observation.</li>
      <li>Closing this tab or logging out does not disable the server worker. Local disable and native grant revocation are separate actions; an already submitted attempt may still execute until expiry.</li>
    </ul><label className="hl-check"><input type="checkbox" checked={consent} disabled={!safeToAct || !c} onChange={e => onConsent?.(e.target.checked)} />I consent to this testnet BTC policy and the stated broad rights and replacement race.</label></div>
    <div className="hl-actions"><button type="button" disabled={!canEdit || !fresh || !c?.grantExpiresAt || c.grantExpiresAt <= now || c.policy.consentExpiresAt <= now || !c?.agentAddress || !consent || !c.historyComplete || !c.mode || !supportedModes.has(c.mode) || readiness === 'STALE' || readiness === 'UNKNOWN'} onClick={onArm}>Arm BTC Protection</button><button type="button" disabled={!c || Boolean(busy) || !online || !c.enabled} onClick={onDisable}>Disable Locally</button>{nativeUrl && <a href={nativeUrl} target="_blank" rel="noreferrer">Open Hyperliquid Testnet / Revoke Grant</a>}</div>
    <h3>Event Outcomes</h3><p>Readiness and event outcome are separate. ACK, partial, unknown, mixed or external closes are not autonomous success.</p>
    {!data?.events.length ? <p>No recorded events.</p> : <ol className="hl-events">{data.events.map(event => <li key={event.id}>
      <div><strong>{event.outcome}</strong> · <Timestamp value={event.occurredAt} /></div><p>{event.reason}</p><dl className="hl-facts"><div><dt>Remaining BTC</dt><dd>{event.remainingSize}</dd></div><div><dt>Agent closed</dt><dd>{event.agentClosedSize}</dd></div><div><dt>External closed</dt><dd>{event.externalClosedSize}</dd></div></dl>
      <p>Event: {event.id} · Episode: {event.episodeId ?? 'Unknown'} · Intent: {event.intentId ?? 'None'}</p><p>Order IDs: {event.providerOrderIds.join(', ') || 'None'} · Fill IDs: {event.fillIds.join(', ') || 'None'}</p>
      {event.outcome === 'CONFIRMED_CLOSED' && <p>Closure attribution is recorded for this event only. Current position and readiness are shown above.</p>}
      {event.outcome === 'MIXED_RESOLUTION' && <p>Agent and external actions contributed. Autonomous demo success is not established.</p>}
      {event.outcome === 'RESOLVED_EXTERNALLY' && <p>Closed externally. This is not an AntyTILT autonomous close.</p>}
    </li>)}</ol>}
  </section>
}
function navigatorClipboardAvailable() { return typeof navigator !== 'undefined' && Boolean(navigator.clipboard) }
type InjectedWallet = { request: (input: { method: string; params?: unknown[] }) => Promise<unknown> }
async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${HL_API}${path}`, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
  if (response.status === 401) throw new Error('Your session expired. Sign in again to view or change protection.')
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error(typeof payload?.error === 'string' ? payload.error : `Request failed (${response.status}). Refresh status before retrying.`)
  if (!payload) throw new Error('Status response unavailable. Refresh before any action.')
  return payload as T
}
export function HyperliquidProtectionPanel() {
  const [data, setData] = useState<HlStatusResponse | null>(null)
  const [now, setNow] = useState(Date.now)
  const [online, setOnline] = useState(() => navigator.onLine)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [consent, setConsent] = useState(false)
  useEffect(() => setConsent(false), [data?.connection?.id, data?.connection?.policy.version, data?.realActionsEnabled])
  const refresh = async () => { try { setData(await api<HlStatusResponse>('/status')); setError('') } catch (e) { setError(e instanceof Error ? e.message : 'Status unavailable.'); setData(null) } }
  useEffect(() => {
    let disposed = false
    const poll = async () => { try { const response = await api<HlStatusResponse>('/status'); if (!disposed) { setData(response); setError('') } } catch (e) { if (!disposed) { setError(e instanceof Error ? e.message : 'Status unavailable.'); setData(null) } } }
    void poll(); const polling = setInterval(() => void poll(), 5000); const clock = setInterval(() => setNow(Date.now()), 1000)
    const connectivity = () => setOnline(navigator.onLine); window.addEventListener('online', connectivity); window.addEventListener('offline', connectivity)
    return () => { disposed = true; clearInterval(polling); clearInterval(clock); window.removeEventListener('online', connectivity); window.removeEventListener('offline', connectivity) }
  }, [])
  const act = async (label: string, action: () => Promise<void>, requiresReal = true) => {
    if (busy || !online || (requiresReal && !data?.realActionsEnabled)) return
    setBusy(label); setError('')
    try { await action(); setConsent(false); await refresh() } catch (e) { setError(e instanceof Error ? e.message : 'Action failed. Refresh status before retrying.') } finally { setBusy('') }
  }
  return <HyperliquidProtectionView data={data} now={now} online={online} busy={busy} error={error} consent={consent} onConsent={setConsent} onRefresh={() => void refresh()}
    onLink={() => void act('Linking Wallet', async () => {
      const wallet = (window as Window & { ethereum?: InjectedWallet }).ethereum
      if (!wallet) throw new Error('Install an injected EOA wallet. Wallet connection requires your explicit confirmation.')
      const accounts = await wallet.request({ method: 'eth_requestAccounts' })
      if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(accounts[0])) throw new Error('A master EOA address is required.')
      const account = accounts[0]
      const challenge = await api<HlChallengeResponse>('/challenge', 'POST', { account, network: 'testnet' })
      if (challenge.expiresAt <= Date.now()) throw new Error('Wallet challenge expired. Start linking again.')
      const messageHex = `0x${Array.from(new TextEncoder().encode(challenge.message), byte => byte.toString(16).padStart(2, '0')).join('')}`
      const signature = await wallet.request({ method: 'personal_sign', params: [messageHex, account] })
      if (typeof signature !== 'string') throw new Error('Wallet signature was not provided.')
      await api('/link', 'POST', { challengeId: challenge.id, signature })
    })}
    onAgent={() => void act('Preparing Named Agent', async () => { if (data?.connection) await api<HlAgentResponse>('/agent', 'POST', { connectionId: data.connection.id }) })}
    onSave={input => void act('Saving Policy', async () => { if (!data?.connection) return; try { new Intl.DateTimeFormat('en', { timeZone: input.timezone }) } catch { throw new Error('Use a valid IANA timezone, such as Europe/Warsaw.') } if (!(Number(input.maxCloseNotionalUsd) > 0)) throw new Error('Maximum close notional must be positive.'); await api('/policy', 'PUT', { ...input, connectionId: data.connection.id }) })}
    onArm={() => void act('Arming BTC Protection', async () => { if (data?.connection && consent) await api('/arm', 'POST', { connectionId: data.connection.id, policyVersion: data.connection.policy.version, consent: HL_CONSENT }) })}
    onDisable={() => void act('Disabling Locally', async () => { if (data?.connection) await api('/disable', 'POST', { connectionId: data.connection.id }) }, false)} />
}
