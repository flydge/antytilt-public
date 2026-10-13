import React, { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import type { ExecutionProvider, HyperliquidNetwork } from '../executionSelection'
type Props = { provider: ExecutionProvider; network: HyperliquidNetwork; connectionContent?: ReactNode; onProvider: (value: ExecutionProvider) => void; onNetwork: (value: HyperliquidNetwork) => void; onManage: () => void; onClose: () => void }
export function ExecutionAccountChooser({ provider, network, connectionContent, onProvider, onNetwork, onManage, onClose }: Props) {
  const section = useRef<HTMLElement>(null)
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    section.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key !== 'Tab') return
      const controls = section.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled)')
      if (!controls?.length) return
      const first = controls[0]; const last = controls[controls.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', keyboard)
    return () => { document.removeEventListener('keydown', keyboard); previous?.focus() }
  }, [onClose])
  return <div className="exchange-modal-layer" role="dialog" aria-modal="true" aria-label="Choose Execution Account">
    <button className="exchange-modal-scrim" type="button" tabIndex={-1} aria-label="Close execution chooser" onClick={onClose} />
    <section ref={section} className="execution-chooser"><header><h2>Execution Account</h2><button type="button" aria-label="Close execution chooser" onClick={onClose}><X size={16} /></button></header>
      <p>Choose the trading venue independently of chart source. Chart changes leave this account and its order draft intact.</p>
      <div className="execution-provider-options" role="group" aria-label="Execution venue">
        <button type="button" aria-pressed={provider === 'bingx'} onClick={() => onProvider('bingx')}><strong>BingX</strong><span>Existing VST / Live account</span></button>
        <button type="button" aria-pressed={provider === 'hyperliquid'} onClick={() => onProvider('hyperliquid')}><strong>Hyperliquid</strong><span>Master EOA · Testnet API wallet</span></button>
      </div>
      {provider === 'hyperliquid' && <><label className="execution-network">Execution Network<select aria-label="Hyperliquid execution network" value={network} onChange={event => onNetwork(event.target.value as HyperliquidNetwork)}><option value="testnet">Testnet · test USDC</option><option value="mainnet">Mainnet · read only</option></select></label><p>Account reads use this network. The linked master EOA identifies the same owner across networks; the ownership proof is linked in testnet BTC Protection. Agent grants and automatic BTC protection remain a separate testnet connection. Mainnet selection does not extend the testnet grant or authorize an order.</p></>}
      {provider === 'hyperliquid' && network === 'testnet' && connectionContent}
      <button type="button" className="connect-button" onClick={onManage}>{provider === 'hyperliquid' ? 'Manage Hyperliquid Master EOA' : 'Manage BingX Connection'}</button>
    </section>
  </div>
}
