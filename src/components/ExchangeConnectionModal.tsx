import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Check, ClipboardPaste, Eye, EyeOff, KeyRound, LockKeyhole, Plus, ShieldCheck, X } from 'lucide-react'
import type { ExchangeAccountSummary, ExchangeEnvironment, ExchangeSessionState } from '../types'
import { selectSettlementBalance, settlementAsset } from '../exchangeBalance'
const JupiterTicketPanel = lazy(() => import('./JupiterTicketPanel').then(module => ({ default: module.JupiterTicketPanel })))

const formatAccountAmount = (value: string | number | undefined) => {
  const amount = Number(value)
  return Number.isFinite(amount)
    ? amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '—'
}

const formatSyncTime = (timestamp: number | undefined) => timestamp
  ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  : '—'

type Props = {
  open: boolean
  session: ExchangeSessionState
  accounts: ExchangeAccountSummary[]
  connecting: boolean
  error: string | null
  onClose: () => void
  onConnect: (input: { apiKey: string; secretKey: string; environment: ExchangeEnvironment; label?: string }) => Promise<unknown>
  onSelectAccount: (accountId: string) => Promise<unknown>
  onDisconnect: () => Promise<void>
}

export function ExchangeConnectionModal({ open, session, accounts, connecting, error, onClose, onConnect, onSelectAccount, onDisconnect }: Props) {
  const [venue, setVenue] = useState<'bingx' | 'jupiter'>('bingx')
  const [apiKey, setApiKey] = useState('')
  const [secretKey, setSecretKey] = useState('')
  const [label, setLabel] = useState('')
  const [environment, setEnvironment] = useState<ExchangeEnvironment>('prod-vst')
  const [showConnectForm, setShowConnectForm] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [secretVisible, setSecretVisible] = useState(false)
  const [pastedField, setPastedField] = useState<'apiKey' | 'secretKey' | null>(null)
  const [archiveConfirming, setArchiveConfirming] = useState(false)
  const apiKeyInput = useRef<HTMLInputElement>(null)
  const secretKeyInput = useRef<HTMLInputElement>(null)
  const activeBalance = selectSettlementBalance(session.environment, session.snapshot?.balances)
  const activeBalanceAsset = activeBalance?.asset || settlementAsset(session.environment)
  const activeAccount = accounts.find((account) => account.id === session.accountId)
  const activeAccountLabel = session.label || activeAccount?.label || 'Active account'

  const clearCredentials = useCallback(() => {
    setApiKey('')
    setSecretKey('')
    setLabel('')
    setSecretVisible(false)
    setPastedField(null)
    setArchiveConfirming(false)
  }, [])

  const closeModal = useCallback(() => {
    clearCredentials()
    setLocalError(null)
    onClose()
  }, [clearCredentials, onClose])

  useEffect(() => {
    if (!open) return
    setLocalError(null)
    setShowConnectForm(accounts.length === 0)
    const focusTimer = window.setTimeout(() => {
      if (accounts.length === 0) apiKeyInput.current?.focus({ preventScroll: true })
    }, 0)
    return () => window.clearTimeout(focusTimer)
  }, [accounts.length, open])

  useEffect(() => {
    if (!open) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !connecting) closeModal()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [closeModal, connecting, open])

  if (!open) return null

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setLocalError(null)
    try {
      await onConnect({ apiKey: apiKey.trim(), secretKey: secretKey.trim(), environment, label: label.trim() || undefined })
      clearCredentials()
      onClose()
    } catch (requestError) {
      setLocalError(requestError instanceof Error ? requestError.message : 'Connection failed')
    }
  }

  const pasteCredential = async (field: 'apiKey' | 'secretKey') => {
    setLocalError(null)
    try {
      const value = (await navigator.clipboard.readText()).trim()
      if (!value) throw new Error('Clipboard is empty')
      if (field === 'apiKey') setApiKey(value)
      else setSecretKey(value)
      setPastedField(field)
      window.setTimeout(() => {
        const input = field === 'apiKey' ? apiKeyInput.current : secretKeyInput.current
        input?.focus({ preventScroll: true })
        input?.setSelectionRange(value.length, value.length)
      }, 0)
      window.setTimeout(() => setPastedField((current) => current === field ? null : current), 1_500)
    } catch {
      setLocalError('Clipboard access was blocked. Click inside the field and use ⌘V or Ctrl+V.')
    }
  }

  const disconnect = async () => {
    setLocalError(null)
    try {
      await onDisconnect()
      onClose()
    } catch (requestError) {
      setLocalError(requestError instanceof Error ? requestError.message : 'Could not disconnect')
    }
  }

  const selectAccount = async (accountId: string) => {
    setLocalError(null)
    setArchiveConfirming(false)
    try {
      await onSelectAccount(accountId)
    } catch (requestError) {
      setLocalError(requestError instanceof Error ? requestError.message : 'Could not select account')
    }
  }

  return (
    <div className="exchange-modal-layer" role="dialog" aria-modal="true" aria-label={venue === 'jupiter' ? 'Jupiter wallet protection' : 'Connect BingX'}>
      <button className="exchange-modal-scrim" onClick={closeModal} aria-label="Close exchange connection" />
      <section className="exchange-modal">
        <header>
          <div className="exchange-modal-title">
            <span><KeyRound size={19} /></span>
            <div><strong>Trading accounts</strong><small>Wallet & exchange connections</small></div>
          </div>
          <button onClick={closeModal} aria-label="Close"><X size={17} /></button>
        </header>

        <nav className="jupiter-venue-tabs" aria-label="Account connection venue"><button type="button" className={venue === 'bingx' ? 'active' : ''} onClick={() => setVenue('bingx')}>BingX</button><button type="button" className={venue === 'jupiter' ? 'active' : ''} onClick={() => setVenue('jupiter')}>Jupiter wallet</button></nav>
        {venue === 'jupiter' ? <Suspense fallback={<p className="jupiter-note">Loading wallet connection…</p>}><JupiterTicketPanel /></Suspense> : !showConnectForm && accounts.length > 0 ? (
          <div className="connected-account">
            <div className="exchange-account-list" aria-label="Connected exchange accounts">
              {accounts.map((account) => (
                <button
                  type="button"
                  key={account.id}
                  className={`exchange-account-option ${account.id === session.accountId ? 'active' : ''} ${account.environment === 'prod-live' ? 'live' : ''}`}
                  disabled={connecting || account.id === session.accountId}
                  onClick={() => selectAccount(account.id)}
                >
                  <span className="exchange-account-avatar" aria-hidden="true">{account.label.trim().charAt(0).toUpperCase() || 'B'}</span>
                  <span className="exchange-account-copy">
                    <span className="exchange-account-name"><strong>{account.label}</strong><b className={account.environment === 'prod-live' ? 'live' : ''}>{account.environment === 'prod-live' ? 'LIVE FUNDS' : 'DEMO FUNDS'}</b></span>
                    <small>BingX {account.environment === 'prod-live' ? 'Live' : 'VST'} · {account.apiKeyMask}</small>
                  </span>
                  <em>{account.id === session.accountId ? <><i />Connected</> : 'Select'}</em>
                </button>
              ))}
            </div>
            {session.connected && <div className="exchange-account-metrics" aria-label={`${activeAccountLabel} account status`}>
              <span><small>Available</small><strong>{formatAccountAmount(activeBalance?.availableMargin)} {activeBalanceAsset}</strong></span>
              <span><small>Equity</small><strong>{formatAccountAmount(activeBalance?.equity)} {activeBalanceAsset}</strong></span>
              <span><small>Last sync</small><strong>{formatSyncTime(session.snapshot?.updatedAt)}</strong></span>
            </div>}
            {session.connected && session.environment === 'prod-live' && !session.liveTradingEnabled && (
              <div className="connection-policy blocked"><LockKeyhole size={16} /><span><strong>Live execution unavailable</strong><small>Account monitoring remains active.</small></span></div>
            )}
            {session.connected && session.environment === 'prod-live' && session.liveTradingEnabled && (
              <div className="connection-policy"><ShieldCheck size={16} /><span><strong>Live execution enabled</strong><small>Every terminal order requires review confirmation.</small></span></div>
            )}
            {session.connected && session.environment === 'prod-vst' && (
              <div className="connection-policy"><ShieldCheck size={16} /><span><strong>VST execution enabled</strong><small>Orders use BingX demo funds, not real funds.</small></span></div>
            )}
            {(localError || error) && <div className="exchange-error">{localError || error}</div>}
            {archiveConfirming && session.connected ? (
              <div className="archive-confirmation">
                <span><strong>Archive {activeAccountLabel}?</strong><small>Trading and RM monitoring stop for this connection.</small></span>
                <div><button type="button" onClick={() => setArchiveConfirming(false)}>Cancel</button><button type="button" disabled={connecting} onClick={disconnect}>Archive</button></div>
              </div>
            ) : (
              <div className="exchange-account-actions">
                <button className="add-exchange-account" type="button" onClick={() => setShowConnectForm(true)}><Plus size={14} /> Add account</button>
                {session.connected && <button className="disconnect-exchange" type="button" onClick={() => setArchiveConfirming(true)}>Archive connection</button>}
              </div>
            )}
          </div>
        ) : (
          <form onSubmit={submit} autoComplete="off">
            <div className="environment-switch">
              <button type="button" className={environment === 'prod-vst' ? 'active' : ''} onClick={() => setEnvironment('prod-vst')}>
                VST demo <small>Recommended first</small>
              </button>
              <button type="button" className={environment === 'prod-live' ? 'active live' : ''} onClick={() => setEnvironment('prod-live')}>
                Live account <small>Real funds</small>
              </button>
            </div>
            {environment === 'prod-live' && (
              <div className="live-warning"><LockKeyhole size={15} />Live trading uses real funds. On the key, enable futures trading only; never enable withdrawals.</div>
            )}
            <label className="exchange-field">
              <span>Account label</span>
              <div className="exchange-key-input">
                <input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={80} placeholder={environment === 'prod-live' ? 'BingX Live' : 'BingX VST'} />
              </div>
            </label>
            <label className="exchange-field">
              <span>API Key</span>
              <div className="exchange-key-input">
                <input
                  ref={apiKeyInput}
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  required
                  minLength={8}
                  spellCheck={false}
                  autoCapitalize="none"
                  autoCorrect="off"
                  aria-label="BingX API Key"
                />
                <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => pasteCredential('apiKey')} title="Paste API Key" aria-label="Paste API Key">
                  {pastedField === 'apiKey' ? <Check size={14} /> : <ClipboardPaste size={14} />}
                </button>
              </div>
            </label>
            <label className="exchange-field">
              <span>Secret Key</span>
              <div className="exchange-key-input secret">
                <input
                  ref={secretKeyInput}
                  type={secretVisible ? 'text' : 'password'}
                  value={secretKey}
                  onChange={(event) => setSecretKey(event.target.value)}
                  required
                  minLength={8}
                  spellCheck={false}
                  autoCapitalize="none"
                  autoCorrect="off"
                  aria-label="BingX Secret Key"
                />
                <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => pasteCredential('secretKey')} title="Paste Secret Key" aria-label="Paste Secret Key">
                  {pastedField === 'secretKey' ? <Check size={14} /> : <ClipboardPaste size={14} />}
                </button>
                <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => setSecretVisible((current) => !current)} title={secretVisible ? 'Hide Secret Key' : 'Show Secret Key'} aria-label={secretVisible ? 'Hide Secret Key' : 'Show Secret Key'}>
                  {secretVisible ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </label>
            <div className="credential-safety"><ShieldCheck size={15} /><span>Use an IP whitelist. Disable withdrawals. Keys are not saved to localStorage or sent back to the UI.</span></div>
            {(localError || error) && <div className="exchange-error">{localError || error}</div>}
            <button className="submit-connection" disabled={connecting || !apiKey.trim() || !secretKey.trim()}>
              {connecting ? 'Verifying with BingX…' : `Connect BingX ${environment === 'prod-vst' ? 'VST' : 'Live'}`}
            </button>
            {accounts.length > 0 && <button type="button" className="back-to-accounts" onClick={() => setShowConnectForm(false)}>Back to accounts</button>}
          </form>
        )}
      </section>
    </div>
  )
}
