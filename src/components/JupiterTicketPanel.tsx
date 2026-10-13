import { useEffect, useState } from 'react'
import { useJupiterTicket } from '../hooks/useJupiterTicket'
import { capability, phantom } from '../jupiterWallet/provider'
const short = (s: string) => s.slice(0, 8) + '…' + s.slice(-6)
const sol = (lamports: string) => `${(Number(lamports) / 1e9).toFixed(9)} SOL`
const usd = (units: string) =>
  `$${(Number(units) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 })}`
const descriptions: Record<string, string> = {
  PREPARED: 'Review this exact ticket, then sign without sending.',
  ARMED: 'Encrypted ticket saved. No close request has been sent.',
  SUBMITTING: 'Send intent saved. Check confirmation; do not submit again.',
  UNKNOWN:
    'The send outcome is uncertain. Reconcile only; resending is blocked.',
  REQUEST_PENDING:
    'Close request submitted. Waiting for the Jupiter keeper to execute it.',
  CLOSED: 'Finalized keeper reduction and positive owner payout confirmed.',
  DISABLED:
    'Local submission disabled. The signature is not cryptographically revoked.',
  REVOKED:
    'Finalized nonce advance observed. This unused ticket cannot execute.',
  INVALIDATED: 'A bound account changed. This ticket cannot be submitted.',
  FAILED_CONSUMED:
    'Execution failed and consumed the nonce. This ticket cannot be replayed.',
}
export function JupiterTicketPanel() {
  const j = useJupiterTicket(),
    [position, setPosition] = useState(''),
    [floor, setFloor] = useState(''),
    [fee, setFee] = useState(''),
    [rent, setRent] = useState(''),
    [expiry, setExpiry] = useState('30')
  const [reviewed, setReviewed] = useState(false),
    [triggerReviewed, setTriggerReviewed] = useState(false),
    [actionReviewed, setActionReviewed] = useState(false)
  useEffect(() => {
    if (j.budget) {
      setFee(j.budget.feeSol)
      setRent(j.budget.rentSol)
    }
  }, [j.budget?.quotedAt])
  useEffect(() => {
    setReviewed(false)
    setTriggerReviewed(false)
  }, [j.ticket?.id, j.ticket?.status])
  useEffect(() => {
    setActionReviewed(false)
  }, [j.action?.id, j.action?.status])
  useEffect(() => {
    setPosition(j.positions[0]?.position ?? '')
  }, [j.positions.map((p) => p.position).join(',')])
  const native = j.session?.mode === 'native-rehearsal',
    available = capability(phantom()).available,
    owner = j.session?.owner,
    t = j.ticket
  const active =
      t &&
      [
        'PREPARED',
        'ARMED',
        'SUBMITTING',
        'UNKNOWN',
        'REQUEST_PENDING',
      ].includes(t.status),
    unused = t && ['PREPARED', 'ARMED', 'DISABLED'].includes(t.status),
    connected = owner && j.connected === owner
  return (
    <section
      className="jupiter-ticket-panel"
      aria-label="Jupiter wallet protection"
    >
      <header>
        <div>
          <strong>Jupiter · SOL Long</strong>
          <small>{j.session?.network ?? 'Wallet integration'}</small>
        </div>
        <span className="jupiter-mode">
          {native ? 'NATIVE REHEARSAL' : 'OWNER WALLET'}
        </span>
      </header>
      {native && (
        <p className="jupiter-notice">
          Disposable wallet and a synthetic position on an isolated validator.
          Real SOL spent: 0. There is no keeper here.
        </p>
      )}
      <div className="jupiter-wallet-row">
        <span>
          <small>{owner ? 'Verified wallet' : 'Wallet ownership'}</small>
          <strong>
            {owner
              ? short(owner)
              : native
                ? 'Native rehearsal wallet'
                : available
                  ? 'Phantom sign-only available'
                  : 'Phantom sign-only unavailable'}
          </strong>
        </span>
        <div>
          {!connected && (
            <button
              type="button"
              disabled={j.busy || (!native && !available) || !j.session}
              onClick={j.connect}
            >
              {native
                ? 'Connect Native rehearsal wallet'
                : owner
                  ? 'Reconnect & verify Phantom'
                  : 'Connect & verify Phantom'}
            </button>
          )}
          {owner && (
            <button type="button" disabled={j.busy} onClick={j.disconnect}>
              Disconnect
            </button>
          )}
        </div>
      </div>
      {owner && (
        <p className="jupiter-note">
          Disconnect removes app verification. It does not disable, revoke or
          cancel an existing ticket.
        </p>
      )}
      {j.error && (
        <p className="exchange-error" role="alert">
          {j.error}
        </p>
      )}
      {j.busy && (
        <p className="jupiter-note" role="status">
          Checking the wallet and on-chain state…
        </p>
      )}
      {owner && (
        <>
          <div className="jupiter-section-heading">
            <strong>Existing position</strong>
            <button type="button" disabled={j.busy} onClick={j.refresh}>
              Refresh wallet state
            </button>
          </div>
          {!j.positions.length ? (
            <p className="jupiter-notice">
              {j.loading || j.busy
                ? 'Discovering finalized SOL Long positions…'
                : j.error
                  ? 'Position discovery is unavailable. Refresh wallet state to verify eligibility.'
                  : 'No eligible existing SOL Long with wSOL collateral was found for this wallet. A position is never opened automatically.'}
            </p>
          ) : (
            <label className="jupiter-field">
              <span>Dedicated SOL Long</span>
              <select
                value={position}
                onChange={(e) => setPosition(e.target.value)}
                disabled={!!active || j.busy}
              >
                {j.positions.map((p) => (
                  <option key={p.position} value={p.position}>
                    {short(p.position)} · size {usd(p.sizeUsd)} · collateral{' '}
                    {usd(p.collateralUsd)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {j.setup && (
            <div className="jupiter-setup">
              <span>
                <strong>Dedicated nonce & wSOL recipient</strong>
                <small>
                  {j.setup.nonceReady && j.setup.recipientReady
                    ? 'Ready on finalized state'
                    : 'Owner setup transaction required'}
                </small>
              </span>
              {(!j.setup.nonceReady || !j.setup.recipientReady) && (
                <button
                  type="button"
                  disabled={j.busy || !connected || !position}
                  onClick={() => j.prepareAction('SETUP')}
                >
                  Review setup
                </button>
              )}
            </div>
          )}
          {j.action && (
            <div
              className="jupiter-action-review"
              aria-label="Owner setup review"
            >
              <strong>
                {j.action.preview?.kind === 'REVOKE'
                  ? 'Nonce revocation'
                  : 'Nonce & recipient setup'}{' '}
                · {j.action.status}
              </strong>
              {j.action.preview && (
                <>
                  <dl className="jupiter-details">
                    <dt>Owner</dt>
                    <dd>{j.action.preview.owner}</dd>
                    <dt>Nonce</dt>
                    <dd>{j.action.preview.nonce}</dd>
                    <dt>Recipient · wSOL</dt>
                    <dd>{j.action.preview.recipient}</dd>
                    <dt>Fee cap</dt>
                    <dd>{sol(j.action.preview.feeLamports)}</dd>
                    <dt>Rent cap</dt>
                    <dd>{sol(j.action.preview.rentLamports)}</dd>
                  </dl>
                  <p className="jupiter-note">
                    This is a separate transaction. It is sent after the owner
                    signs and approves this action.
                  </p>
                </>
              )}
              {j.action.status === 'PREPARED' ? (
                <>
                  <label className="jupiter-check">
                    <input
                      type="checkbox"
                      checked={actionReviewed}
                      onChange={(e) => setActionReviewed(e.target.checked)}
                    />
                    I reviewed the network, owner, recipient and exact costs.
                  </label>
                  <button
                    className="jupiter-primary"
                    type="button"
                    disabled={j.busy || !connected || !actionReviewed}
                    onClick={j.submitAction}
                  >
                    Sign & send{' '}
                    {j.action.preview?.kind === 'REVOKE'
                      ? 'nonce revocation'
                      : 'setup'}
                  </button>
                </>
              ) : (
                j.action.id && (
                  <button
                    type="button"
                    disabled={j.busy}
                    onClick={j.refreshAction}
                  >
                    Check action confirmation
                  </button>
                )
              )}
              {j.action.signature && (
                <details>
                  <summary>Action receipt</summary>
                  <code>{j.action.signature}</code>
                </details>
              )}
              {j.action.status === 'FINALIZED' &&
                j.action.preview?.kind === 'REVOKE' &&
                unused && (
                  <button
                    type="button"
                    disabled={j.busy}
                    onClick={() => j.ticketAction('confirm-revoke')}
                  >
                    Confirm unused ticket revoked
                  </button>
                )}
            </div>
          )}
          {!active && j.positions.length > 0 && (
            <form
              className="jupiter-limit-form"
              onSubmit={(e) => {
                e.preventDefault()
                void j.prepare({
                  position,
                  floorUsd: floor,
                  maxFeeSol: fee,
                  maxRentSol: rent,
                  expiresMinutes: Number(expiry),
                })
              }}
            >
              <strong>Review one close ticket</strong>
              <p className="jupiter-note">
                A finite minimum closing price for this Long. It is not a
                market-price guarantee. Current price and payout estimates are
                unavailable.
              </p>
              <label className="jupiter-field">
                <span>Minimum closing price · USD</span>
                <input
                  value={floor}
                  onChange={(e) => setFloor(e.target.value)}
                  inputMode="decimal"
                  placeholder="Enter your price floor"
                  required
                  pattern="[0-9]+(\.[0-9]{1,6})?"
                />
              </label>
              <div className="jupiter-fields">
                <label className="jupiter-field">
                  <span>Maximum network fee · SOL</span>
                  <input
                    value={fee}
                    onChange={(e) => setFee(e.target.value)}
                    inputMode="decimal"
                    required
                  />
                </label>
                <label className="jupiter-field">
                  <span>Maximum request rent · SOL</span>
                  <input
                    value={rent}
                    onChange={(e) => setRent(e.target.value)}
                    inputMode="decimal"
                    required
                  />
                </label>
              </div>
              <label className="jupiter-field">
                <span>Manual trigger expires in</span>
                <select
                  value={expiry}
                  onChange={(e) => setExpiry(e.target.value)}
                >
                  <option value="5">5 minutes</option>
                  <option value="15">15 minutes</option>
                  <option value="30">30 minutes</option>
                  <option value="60">60 minutes</option>
                </select>
              </label>
              <small className="jupiter-note">
                Fee/rent quotes refreshed{' '}
                {j.budget
                  ? new Date(j.budget.quotedAt).toLocaleTimeString()
                  : '—'}
                . Setup costs are separate.
              </small>
              <button
                className="jupiter-primary"
                disabled={
                  j.busy ||
                  !connected ||
                  !j.setup?.nonceReady ||
                  !j.setup?.recipientReady
                }
              >
                Prepare reviewed ticket
              </button>
            </form>
          )}
          {j.tickets.length > 1 && (
            <label className="jupiter-field">
              <span>Saved tickets</span>
              <select
                value={t?.id ?? ''}
                onChange={(e) =>
                  j.selectTicket(
                    j.tickets.find((v) => v.id === e.target.value)!,
                  )
                }
              >
                {j.tickets.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.status} · {short(v.position)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {t && (
            <div
              className="jupiter-saved-ticket"
              aria-label="Saved Jupiter ticket"
            >
              <div className="jupiter-section-heading">
                <strong>Close ticket</strong>
                <span className={'jupiter-status ' + t.status.toLowerCase()}>
                  {t.status}
                </span>
              </div>
              <p role="status">{descriptions[t.status] ?? t.status}</p>
              <dl className="jupiter-review">
                <dt>Closing-price floor</dt>
                <dd>${t.floorUsd}</dd>
                <dt>Network fee cap</dt>
                <dd>{t.maxFeeSol} SOL</dd>
                <dt>Request rent cap</dt>
                <dd>{t.maxRentSol} SOL</dd>
                <dt>Trigger</dt>
                <dd>One manual request, no second wallet signature</dd>
                <dt>Expires</dt>
                <dd>{new Date(t.expiresAt).toLocaleString()}</dd>
              </dl>
              <details>
                <summary>Exact wallet, recipient and message</summary>
                <dl className="jupiter-details">
                  <dt>Owner</dt>
                  <dd>{t.owner}</dd>
                  <dt>Network genesis</dt>
                  <dd>{t.genesis}</dd>
                  <dt>Position</dt>
                  <dd>{t.position}</dd>
                  <dt>Recipient · wSOL</dt>
                  <dd>{t.recipient}</dd>
                  <dt>Dedicated nonce</dt>
                  <dd>{t.nonce}</dd>
                  <dt>Message SHA256</dt>
                  <dd>{t.messageHash}</dd>
                  <dt>Request address</dt>
                  <dd>{t.request}</dd>
                  {t.signature && (
                    <>
                      <dt>Transaction signature</dt>
                      <dd>{t.signature}</dd>
                    </>
                  )}
                </dl>
              </details>
              {t.status === 'PREPARED' && (
                <>
                  <label className="jupiter-check">
                    <input
                      type="checkbox"
                      checked={reviewed}
                      onChange={(e) => setReviewed(e.target.checked)}
                    />
                    I reviewed the floor, costs, expiry and owner wSOL
                    recipient. I will not manually close or reopen this
                    dedicated position while ARMED or PENDING.
                  </label>
                  <p className="jupiter-note">
                    Other detected position changes invalidate the ticket. These
                    checks cannot exclude external trading races.
                  </p>
                  <button
                    type="button"
                    className="jupiter-primary"
                    disabled={j.busy || !connected || !reviewed}
                    onClick={j.arm}
                  >
                    Sign close ticket without sending
                  </button>
                </>
              )}
              {t.status === 'ARMED' && (
                <>
                  <label className="jupiter-check">
                    <input
                      type="checkbox"
                      checked={triggerReviewed}
                      onChange={(e) => setTriggerReviewed(e.target.checked)}
                    />
                    I approve sending this exact reviewed close request once
                    now.
                  </label>
                  <button
                    type="button"
                    className="jupiter-primary"
                    disabled={
                      j.busy ||
                      !connected ||
                      !triggerReviewed ||
                      Date.parse(t.expiresAt) <= Date.now()
                    }
                    onClick={() => j.ticketAction('trigger')}
                  >
                    Send close request once
                  </button>
                </>
              )}
              {['SUBMITTING', 'UNKNOWN', 'REQUEST_PENDING'].includes(
                t.status,
              ) && (
                <button
                  type="button"
                  disabled={j.busy}
                  onClick={() => j.ticketAction('reconcile')}
                >
                  Reconcile finalized status
                </button>
              )}
              {unused && (
                <div className="jupiter-recovery-actions">
                  {t.status !== 'DISABLED' && (
                    <button
                      type="button"
                      disabled={j.busy}
                      onClick={() => j.ticketAction('disable')}
                    >
                      Disable locally
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={j.busy || !connected}
                    onClick={() => j.prepareAction('REVOKE')}
                  >
                    Review nonce revocation
                  </button>
                  {t.status === 'DISABLED' && (
                    <button
                      type="button"
                      disabled={j.busy}
                      onClick={() => j.ticketAction('confirm-revoke')}
                    >
                      Check nonce revocation
                    </button>
                  )}
                </div>
              )}
              {['SUBMITTING', 'UNKNOWN', 'REQUEST_PENDING'].includes(
                t.status,
              ) && (
                <p className="jupiter-note">
                  Nonce revocation cannot cancel an already-created Jupiter
                  request. Pending request cancellation requires a separate
                  owner action; this UI does not reset or re-enable it.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}
