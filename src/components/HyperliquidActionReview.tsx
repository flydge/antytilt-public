import React, { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import type { HlTerminalPacket } from '../../shared/hyperliquidTerminal'

export type TerminalReview = { signingMode?: 'owner'|'agent'; packet: HlTerminalPacket; confirm: () => Promise<void>; cancel: () => void }
export function HyperliquidActionReview({ review, busy = false }: { review: TerminalReview | null; busy?: boolean }) {
  const [now, setNow] = useState(Date.now())
  const [signing, setSigning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setError(null); setSigning(false); setNow(Date.now()) }, [review?.packet.id])
  useEffect(() => { if (!review) return; const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer) }, [review])
  if (!review) return null
  const p = review.packet, action = p.action
  const orders = action.type === 'order' ? action.orders : action.type === 'batchModify' ? action.modifies.map(m => m.order) : []
  const expired = now >= p.expiresAfter
  const disabled = signing || busy
  const confirm = async () => {
    setSigning(true); setError(null)
    try { await review.confirm() } catch (e) { setError(e instanceof Error ? e.message : 'Wallet action failed') } finally { setSigning(false) }
  }
  return <div className="exchange-modal-layer hl-action-review" role="dialog" aria-modal="true" aria-label={`Review Hyperliquid ${p.kind}`}>
    <button className="exchange-modal-scrim" disabled={disabled} onClick={review.cancel} aria-label="Discard Hyperliquid review" />
    <section className="trade-modal confirmation-modal">
      <header className="trade-modal-header"><div><strong>Hyperliquid Testnet · {p.kind === 'settings' ? 'Leverage / margin' : p.kind}</strong><small>BTC / USD · Test USDC</small></div><button type="button" disabled={disabled} onClick={review.cancel}><X size={16} /></button></header>
      <div className="trade-modal-body">
        <div className="modal-info" style={{overflowWrap:'anywhere'}}>Master wallet: {p.account}</div>
        {action.type === 'updateLeverage' && <div className="confirmation-grid"><span>Current<strong>{p.settingBefore.leverage}× · {p.settingBefore.marginType}</strong></span><span>New<strong>{action.leverage}× · {action.isCross ? 'Cross' : 'Isolated'}</strong></span></div>}
        {p.summary.quantity && <div className="confirmation-grid"><span>Size<strong>{p.summary.quantity} BTC</strong></span><span>Position value<strong>{p.summary.notionalUsd} USD</strong></span><span>Margin<strong>{p.summary.marginUsdc} test USDC</strong></span></div>}
        {orders.map(o => <div className="close-execution-row" key={o.c}><span>{o.b ? 'Buy' : 'Sell'} · {o.r ? 'Reduce only' : 'Entry'}{'trigger' in o.t ? ` · ${o.t.trigger.tpsl.toUpperCase()}` : ''}</span><strong>{o.s} BTC · {'trigger' in o.t ? `Trigger ${o.t.trigger.triggerPx}` : `Limit ${o.p}`} USD</strong></div>)}
        {action.type === 'cancel' && action.cancels.map(c => <div className="close-execution-row" key={c.o}><span>Cancel native order</span><strong>#{c.o}</strong></div>)}
        <p>{review.signingMode === 'agent' ? 'Your confirmation sends this exact action through the approved API wallet to Hyperliquid Testnet. Results and positions are refreshed from the exchange.' : 'One wallet signature sends this action to Hyperliquid Testnet. Results and positions are refreshed from the exchange.'}</p>
        <p>{expired ? 'Review expired. Discard and prepare again.' : `Review expires in ${Math.ceil((p.expiresAfter - now)/1000)}s`}</p>
        {error && <div className="exchange-error">{error}</div>}
      </div>
      <footer className="trade-modal-actions">
        <button type="button" disabled={disabled} onClick={review.cancel}>Discard review</button>
        <button className="primary" disabled={disabled || expired || p.network !== 'testnet'} onClick={confirm}>{signing ? review.signingMode === 'agent' ? 'Submitting Testnet action…' : 'Waiting for wallet…' : review.signingMode === 'agent' ? 'Confirm Testnet action' : 'Confirm in wallet'}</button>
      </footer>
    </section>
  </div>
}
