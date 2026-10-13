import React, { useEffect, useState, type CSSProperties, type FormEvent } from 'react'
import { AlertTriangle, BookOpen, Gauge, Info, LockKeyhole, Pencil, RefreshCw, Settings, WalletCards, X } from 'lucide-react'
import type { AccountHistory, DemoOrder, ExchangeBalance, ExchangeContract, ExchangeOrder, ExchangePosition, ExchangeSessionState } from '../types'
import { selectSettlementBalance, settlementAsset } from '../exchangeBalance'
const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value))
const formatPrice = (value: number) => {
  if (!Number.isFinite(value)) return '--'
  const absolute = Math.abs(value)
  const maximumFractionDigits = absolute >= 1_000 ? 2 : absolute >= 1 ? 4 : absolute >= 0.01 ? 6 : 8
  const minimumFractionDigits = absolute >= 1 ? 2 : maximumFractionDigits
  return value.toLocaleString('en-US', { minimumFractionDigits, maximumFractionDigits })
}

const formatQuantity = (value: number) => value >= 1_000
  ? Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(value)
  : value.toLocaleString('en-US', { maximumFractionDigits: value >= 1 ? 3 : 6 })


export type BottomPanelProps = {
  venue?: string
  quoteAsset?: string
  settlementCurrency?: string
  actionsEnabled?: boolean
  checkedAt?: number
  statusMessage?: string
  onOpenRiskManagement?: () => void
  onRefreshAccount?: () => Promise<unknown>
  onReconcilePending?: () => Promise<unknown>
  demoOrders: DemoOrder[]
  exchangeOrders: ExchangeOrder[]
  contracts: ExchangeContract[]
  connected: boolean
  positions: ExchangePosition[]
  balances: ExchangeBalance[]
  history: AccountHistory
  historyLoading: boolean
  environment?: ExchangeSessionState['environment']
  liveTradingEnabled: boolean
  executing: boolean
  onRemoveDemo: (id: string) => void
  onCancelOrder: (orderId: string, input: { symbol: string; clientOrderId?: string; confirmation?: string }) => Promise<unknown>
  onAmendOrder: (orderId: string, input: { symbol: string; clientOrderId?: string; quantity: number; confirmation?: string }) => Promise<unknown>
  onClosePosition: (positionId: string, input: { quantity?: number; confirmation?: string }) => Promise<unknown>
  onRefreshHistory: () => Promise<unknown>
}

function PositionCloseDialog({ position, quantityPrecision, environment, liveTradingEnabled, executing, onCancel, onConfirm, venue = 'BingX', quoteAsset = 'USDT', actionsEnabled = true }: {
  position: ExchangePosition | null
  quantityPrecision: number
  environment?: ExchangeSessionState['environment']
  liveTradingEnabled: boolean
  executing: boolean
  venue?: string
  quoteAsset?: string
  actionsEnabled?: boolean
  onCancel: () => void
  onConfirm: BottomPanelProps['onClosePosition']
}) {
  const [quantity, setQuantity] = useState('')
  const [closePercentage, setClosePercentage] = useState(100)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!position) return
    setQuantity(String(Math.abs(Number(position.availableAmt || position.positionAmt))))
    setClosePercentage(100)
    setError(null)
  }, [position])

  if (!position) return null
  const available = Math.abs(Number(position.availableAmt || position.positionAmt))
  const parsedQuantity = Number(quantity)
  const fullClose = parsedQuantity >= available
  const live = environment === 'prod-live'
  const liveBlocked = (live && !liveTradingEnabled) || !actionsEnabled
  const quantityFactor = 10 ** quantityPrecision
  const percentageLabel = Number.isInteger(closePercentage) ? closePercentage.toFixed(0) : closePercentage.toFixed(1)
  const formatCloseQuantity = (value: number) => {
    const fixed = value.toFixed(quantityPrecision)
    return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed
  }

  const setFromClosePercentage = (rawPercentage: number) => {
    const nextPercentage = clamp(Math.round(rawPercentage), 0, 100)
    const rawQuantity = available * nextPercentage / 100
    const nextQuantity = nextPercentage === 100
      ? available
      : Math.floor((rawQuantity + Number.EPSILON) * quantityFactor) / quantityFactor
    setClosePercentage(nextPercentage)
    setQuantity(nextQuantity > 0 ? formatCloseQuantity(nextQuantity) : '')
  }

  const changeCloseQuantity = (value: string) => {
    setQuantity(value)
    const numeric = Number(value)
    const nextPercentage = available > 0 && Number.isFinite(numeric)
      ? clamp(numeric / available * 100, 0, 100)
      : 0
    setClosePercentage(Number(nextPercentage.toFixed(1)))
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!Number.isFinite(parsedQuantity) || parsedQuantity <= 0 || parsedQuantity > available) {
      setError(`Enter a quantity from 0 to ${formatQuantity(available)}.`)
      return
    }
    setError(null)
    try {
      await onConfirm(position.positionId, {
        quantity: fullClose ? undefined : parsedQuantity,
        confirmation: live ? 'CONFIRM' : undefined,
      })
      onCancel()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not close the position')
    }
  }

  return (
    <div className="exchange-modal-layer" role="dialog" aria-modal="true" aria-label={`Close ${venue} position`}>
      <button className="exchange-modal-scrim" onClick={onCancel} aria-label="Cancel position close" />
      <form className="position-close-modal" onSubmit={submit}>
        <header>
          <div><strong>Close {position.symbol}</strong><small>{position.positionSide} · {position.leverage}x · {position.isolated ? 'Isolated' : 'Cross'}</small></div>
          <button type="button" onClick={onCancel}><X size={16} /></button>
        </header>
        <div className="close-position-body">
          <div className="close-position-summary">
            <span>Available to close<strong>{formatQuantity(available)}</strong></span>
            <span>Entry price<strong>{formatPrice(Number(position.avgPrice))}</strong></span>
            <span>Unrealized PnL<strong className={Number(position.unrealizedProfit) >= 0 ? 'up' : 'down'}>{formatPrice(Number(position.unrealizedProfit))} {quoteAsset}</strong></span>
          </div>
          <div className="close-size-heading"><span>Close amount</span><strong>{percentageLabel}%</strong></div>
          <label className="close-quantity-field">
            <input className="number-clean" aria-label={`Close quantity ${position.symbol.split('-')[0]}`} type="number" min="0" max={available} step={1 / quantityFactor} value={quantity} onChange={(event) => changeCloseQuantity(event.target.value)} autoFocus />
            <span>{position.symbol.split('-')[0]}</span>
          </label>
          <div className="close-percentage-control">
            <input
              aria-label="Position percentage to close"
              type="range"
              min="0"
              max="100"
              step="1"
              value={closePercentage}
              onChange={(event) => setFromClosePercentage(Number(event.target.value))}
              style={{ '--range-progress': `${closePercentage}%` } as CSSProperties}
            />
            <div className="close-range-points">
              {[0, 25, 50, 75, 100].map((percent) => <button type="button" className={closePercentage >= percent ? 'active' : ''} style={{ left: `${percent}%` }} key={percent} onClick={() => setFromClosePercentage(percent)} aria-label={`Close ${percent}%`} />)}
            </div>
            <div className="close-range-labels">{[0, 25, 50, 75, 100].map((percent) => <button type="button" key={percent} onClick={() => setFromClosePercentage(percent)}>{percent}%</button>)}</div>
          </div>
          <div className="close-execution-row"><span>Market</span><strong>{quantity || '0'} {position.symbol.split('-')[0]}</strong></div>
          {liveBlocked && <div className="live-warning"><LockKeyhole size={15} />Live execution is disabled on this server.</div>}
          {error && <div className="exchange-error">{error}</div>}
          <button className="confirm-close-position" disabled={executing || liveBlocked || !Number.isFinite(parsedQuantity) || parsedQuantity <= 0 || parsedQuantity > available}>
            {executing ? 'Closing…' : liveBlocked ? 'Live execution disabled' : fullClose ? 'Close position' : `Close ${percentageLabel}%`}
          </button>
        </div>
      </form>
    </div>
  )
}

function CancelOrderDialog({ order, environment, liveTradingEnabled, executing, onCancel, onConfirm, venue = 'BingX', actionsEnabled = true }: {
  order: ExchangeOrder | null
  environment?: ExchangeSessionState['environment']
  liveTradingEnabled: boolean
  executing: boolean
  venue?: string
  quoteAsset?: string
  actionsEnabled?: boolean
  onCancel: () => void
  onConfirm: BottomPanelProps['onCancelOrder']
}) {
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setError(null)
  }, [order])
  if (!order) return null
  const orderId = String(order.orderId ?? order.orderID ?? '')
  const live = environment === 'prod-live'
  const blocked = (live && !liveTradingEnabled) || !actionsEnabled
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!orderId || !order.symbol) return
    setError(null)
    try {
      await onConfirm(orderId, {
        symbol: order.symbol,
        clientOrderId: order.clientOrderId,
        confirmation: live ? 'CONFIRM' : undefined,
      })
      onCancel()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not cancel the order')
    }
  }
  return (
    <div className="exchange-modal-layer" role="dialog" aria-modal="true" aria-label={`Cancel ${venue} order`}>
      <button className="exchange-modal-scrim" type="button" onClick={onCancel} />
      <form className="position-close-modal cancel-order-modal" onSubmit={submit}>
        <header><div><strong>Cancel order</strong><small>{order.symbol} · {String(order.type ?? 'Order')} · #{orderId}</small></div><button type="button" onClick={onCancel}><X size={16} /></button></header>
        <div className="close-position-body">
          <div className="close-position-summary"><span>Side<strong>{String(order.positionSide ?? order.side ?? '--')}</strong></span><span>Price<strong>{Number(order.price) > 0 ? formatPrice(Number(order.price)) : 'Market'}</strong></span><span>Quantity<strong>{formatQuantity(Number(order.origQty ?? order.quantity ?? 0))}</strong></span></div>
          <div className="live-warning neutral"><AlertTriangle size={15} />The order is cancelled only after {venue} confirms the request.</div>
          {live && <div className="live-warning"><LockKeyhole size={15} />LIVE action — this order will be cancelled after one confirmation.</div>}
          {blocked && <div className="live-warning"><LockKeyhole size={15} />Live execution is disabled on this server.</div>}
          {error && <div className="exchange-error">{error}</div>}
          <button className="confirm-close-position danger-button" disabled={executing || blocked || !orderId}>{executing ? `Cancelling on ${venue}…` : 'Cancel order'}</button>
        </div>
      </form>
    </div>
  )
}

function AmendOrderDialog({ order, environment, liveTradingEnabled, executing, onCancel, onConfirm, venue = 'BingX', actionsEnabled = true }: {
  order: ExchangeOrder | null
  environment?: ExchangeSessionState['environment']
  liveTradingEnabled: boolean
  executing: boolean
  venue?: string
  quoteAsset?: string
  actionsEnabled?: boolean
  onCancel: () => void
  onConfirm: BottomPanelProps['onAmendOrder']
}) {
  const [quantity, setQuantity] = useState('')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setQuantity(String(order?.origQty ?? order?.quantity ?? ''))
    setError(null)
  }, [order])
  if (!order) return null
  const orderId = String(order.orderId ?? order.orderID ?? '')
  const parsedQuantity = Number(quantity)
  const live = environment === 'prod-live'
  const blocked = (live && !liveTradingEnabled) || !actionsEnabled
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!orderId || !order.symbol || !(parsedQuantity > 0)) return
    setError(null)
    try {
      await onConfirm(orderId, {
        symbol: order.symbol,
        clientOrderId: order.clientOrderId,
        quantity: parsedQuantity,
        confirmation: live ? 'CONFIRM' : undefined,
      })
      onCancel()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not change the order')
    }
  }
  return (
    <div className="exchange-modal-layer" role="dialog" aria-modal="true" aria-label={`Change ${venue} order quantity`}>
      <button className="exchange-modal-scrim" type="button" onClick={onCancel} />
      <form className="position-close-modal amend-order-modal" onSubmit={submit}>
        <header><div><strong>Edit order quantity</strong><small>{order.symbol} · {String(order.type ?? 'Order')} · #{orderId}</small></div><button type="button" onClick={onCancel}><X size={16} /></button></header>
        <div className="close-position-body">
          <label className="exchange-field"><span>New total quantity ({order.symbol?.split('-')[0]})</span><input className="number-clean" type="number" min="0" step="any" value={quantity} onChange={(event) => setQuantity(event.target.value)} autoFocus /></label>
          <div className="live-warning neutral"><Info size={15} />{venue} quantity changes preserve the reviewed order price. Trigger replacement requires explicit cancellation and a new protected-order review.</div>
          {live && <div className="live-warning"><LockKeyhole size={15} />LIVE action — review the new quantity, then confirm once.</div>}
          {blocked && <div className="live-warning"><LockKeyhole size={15} />Live execution is disabled on this server.</div>}
          {error && <div className="exchange-error">{error}</div>}
          <button className="confirm-close-position amend-button" disabled={executing || blocked || !(parsedQuantity > 0)}>{executing ? `Updating on ${venue}…` : 'Confirm new quantity'}</button>
        </div>
      </form>
    </div>
  )
}

function HistoryToolbar({ synchronizedAt, loading, onRefresh }: { synchronizedAt: number; loading: boolean; onRefresh: () => Promise<unknown> }) {
  return (
    <div className="history-toolbar">
      <span>{synchronizedAt > 0 ? `Synced ${new Date(synchronizedAt).toLocaleTimeString('en-GB')}` : 'Waiting for first synchronization'}</span>
      <button type="button" disabled={loading} onClick={() => onRefresh().catch(() => undefined)}><RefreshCw size={12} className={loading ? 'spin' : ''} />{loading ? 'Syncing…' : 'Refresh'}</button>
    </div>
  )
}

function OrderHistoryView({ connected, history, loading, onRefresh, venue = 'BingX' }: { connected: boolean; history: AccountHistory; loading: boolean; onRefresh: () => Promise<unknown>; venue?: string }) {
  if (!connected || (!loading && history.orderHistory.length === 0)) {
    return <div className="empty-state"><div className="empty-icon"><BookOpen size={19} /></div><span>{connected ? 'No historical orders found' : `Connect ${venue} to synchronize order history`}</span><small>{venue === 'BingX' ? 'Orders are isolated to this signed-in account and retained in the terminal database.' : 'Orders are read from the selected Hyperliquid account and network.'}</small></div>
  }
  return (
    <div className="history-view">
      <HistoryToolbar synchronizedAt={history.synchronizedAt} loading={loading} onRefresh={onRefresh} />
      {history.warnings.map((warning) => <div className="history-warning" key={warning}>{warning}</div>)}
      <div className="history-table order-history-table history-head"><span>Contract</span><span>Side</span><span>Type</span><span>Order / Avg price</span><span>Filled / Quantity</span><span>Status</span><span>PnL / Fee</span><span>Time</span></div>
      {history.orderHistory.map((order) => {
        const pnl = Number(order.realizedPnl || 0)
        return <div className="history-table order-history-table" key={order.orderId}>
          <strong>{order.symbol}<small>#{order.orderId}</small></strong>
          <span className={String(order.positionSide || order.side).toUpperCase().includes('LONG') || String(order.side).toUpperCase() === 'BUY' ? 'up' : 'down'}>{order.positionSide || order.side}</span>
          <span>{order.type || '--'}</span>
          <span>{Number(order.price) > 0 ? formatPrice(Number(order.price)) : 'Market'}<small>{Number(order.avgPrice) > 0 ? `Avg ${formatPrice(Number(order.avgPrice))}` : 'Not filled'}</small></span>
          <span>{formatQuantity(Number(order.executedQty || 0))}<small>of {formatQuantity(Number(order.quantity || 0))}</small></span>
          <span className="history-status">{order.status || '--'}</span>
          <span className={pnl >= 0 ? 'up' : 'down'}>{pnl >= 0 ? '+' : ''}{formatPrice(pnl)}<small>Fee {formatPrice(Number(order.fee || 0))}</small></span>
          <span>{new Date(Number(order.time)).toLocaleDateString('en-GB')}<small>{new Date(Number(order.time)).toLocaleTimeString('en-GB')}</small></span>
        </div>
      })}
    </div>
  )
}

function TradeHistoryView({ connected, history, loading, onRefresh, venue = 'BingX', quoteAsset = 'USDT' }: { connected: boolean; history: AccountHistory; loading: boolean; onRefresh: () => Promise<unknown>; venue?: string; quoteAsset?: string }) {
  if (!connected || (!loading && history.tradeHistory.length === 0)) {
    return <div className="empty-state"><div className="empty-icon"><BookOpen size={19} /></div><span>{connected ? 'No fills found in the synchronized period' : `Connect ${venue} to synchronize trade fills`}</span><small>Every partial execution is shown as a separate fill with its fee and realized PnL.</small></div>
  }
  return (
    <div className="history-view">
      <HistoryToolbar synchronizedAt={history.synchronizedAt} loading={loading} onRefresh={onRefresh} />
      {history.warnings.map((warning) => <div className="history-warning" key={warning}>{warning}</div>)}
      <div className="history-table trade-history-table history-head"><span>Contract</span><span>Side</span><span>Fill price</span><span>Quantity</span><span>Realized PnL</span><span>Fee</span><span>Time</span></div>
      {history.tradeHistory.map((trade) => {
        const pnl = Number(trade.realizedPnl || 0)
        return <div className="history-table trade-history-table" key={trade.tradeId}>
          <strong>{trade.symbol}<small>Fill #{trade.tradeId} · Order #{trade.orderId}</small></strong>
          <span className={String(trade.positionSide || trade.side).toUpperCase().includes('LONG') || String(trade.side).toUpperCase() === 'BUY' ? 'up' : 'down'}>{trade.positionSide || trade.side}</span>
          <span>{formatPrice(Number(trade.price))}</span>
          <span>{formatQuantity(Number(trade.quantity))}</span>
          <span className={pnl >= 0 ? 'up' : 'down'}>{pnl >= 0 ? '+' : ''}{formatPrice(pnl)} {quoteAsset}</span>
          <span>{formatPrice(Number(trade.fee || 0))} {quoteAsset}</span>
          <span>{new Date(Number(trade.time)).toLocaleDateString('en-GB')}<small>{new Date(Number(trade.time)).toLocaleTimeString('en-GB')}</small></span>
        </div>
      })}
    </div>
  )
}

function AssetsView({ connected, balances, positions, environment, venue = 'BingX', settlementCurrency }: { connected: boolean; balances: ExchangeBalance[]; positions: ExchangePosition[]; environment?: ExchangeSessionState['environment']; venue?: string; settlementCurrency?: string }) {
  if (!connected) return <div className="empty-state"><div className="empty-icon"><WalletCards size={19} /></div><span>Connect {venue} to view account assets</span><small>Only balances belonging to this signed-in user are returned.</small></div>
  const preferredBalance = settlementCurrency ? balances.find(b => b.asset === settlementCurrency) : selectSettlementBalance(environment, balances)
  const summaryBalances = preferredBalance ? [preferredBalance] : balances
  const summaryAsset = preferredBalance?.asset || settlementCurrency || settlementAsset(environment)
  const totals = summaryBalances.reduce((result, balance) => ({
    balance: result.balance + Number(balance.balance || 0),
    equity: result.equity + Number(balance.equity || 0),
    available: result.available + Number(balance.availableMargin || 0),
    used: result.used + Number(balance.usedMargin || 0),
    unrealized: result.unrealized + Number(balance.unrealizedProfit || 0),
  }), { balance: 0, equity: 0, available: 0, used: 0, unrealized: 0 })
  return (
    <div className="assets-view">
      <div className="asset-summary-grid">
        <span>Wallet balance<strong>{formatPrice(totals.balance)} {summaryAsset}</strong></span>
        <span>Equity<strong>{formatPrice(totals.equity)} {summaryAsset}</strong></span>
        <span>Available margin<strong>{formatPrice(totals.available)} {summaryAsset}</strong></span>
        <span>Used margin<strong>{formatPrice(totals.used)} {summaryAsset}</strong></span>
        <span>Unrealized PnL<strong className={totals.unrealized >= 0 ? 'up' : 'down'}>{totals.unrealized >= 0 ? '+' : ''}{formatPrice(totals.unrealized)} {summaryAsset}</strong></span>
        <span>Open positions<strong>{positions.length}</strong></span>
      </div>
      <div className="asset-table asset-head"><span>Asset</span><span>Balance</span><span>Equity</span><span>Available margin</span><span>Used margin</span><span>Unrealized PnL</span></div>
      {balances.map((balance) => <div className="asset-table" key={balance.asset}><strong>{balance.asset}</strong><span>{formatPrice(Number(balance.balance))}</span><span>{formatPrice(Number(balance.equity))}</span><span>{formatPrice(Number(balance.availableMargin))}</span><span>{formatPrice(Number(balance.usedMargin))}</span><span className={Number(balance.unrealizedProfit) >= 0 ? 'up' : 'down'}>{formatPrice(Number(balance.unrealizedProfit))}</span></div>)}
    </div>
  )
}

export function TerminalBottomPanel({ demoOrders, exchangeOrders, contracts, connected, positions, balances, history, historyLoading, environment, liveTradingEnabled, executing, onRemoveDemo, onCancelOrder, onAmendOrder, onClosePosition, onRefreshHistory, venue = 'BingX', quoteAsset = 'USDT', settlementCurrency, actionsEnabled = true, checkedAt, statusMessage, onOpenRiskManagement, onRefreshAccount, onReconcilePending }: BottomPanelProps) {
  const [tab, setTab] = useState<'positions' | 'orders' | 'order-history' | 'trade-history' | 'assets'>('positions')
  const [positionToClose, setPositionToClose] = useState<ExchangePosition | null>(null)
  const [orderToCancel, setOrderToCancel] = useState<ExchangeOrder | null>(null)
  const [orderToAmend, setOrderToAmend] = useState<ExchangeOrder | null>(null)
  const visibleOrderCount = connected ? exchangeOrders.length : demoOrders.length
  const marginAsset = settlementCurrency || settlementAsset(environment)
  const tabs = [
    { id: 'positions' as const, label: `Positions (${positions.length})` },
    { id: 'orders' as const, label: `Open Orders (${visibleOrderCount})` },
    { id: 'order-history' as const, label: `Order History (${history.orderHistory.length})` },
    { id: 'trade-history' as const, label: `Trade History (${history.tradeHistory.length})` },
    { id: 'assets' as const, label: `Assets (${balances.length})` },
  ]

  const isPositionsTab = tab === 'positions'
  const isOrdersTab = tab === 'orders'
  const isOrderHistoryTab = tab === 'order-history'
  const isTradeHistoryTab = tab === 'trade-history'
  const isAssetsTab = tab === 'assets'
  return (
    <section className="bottom-panel panel">
      <div className="bottom-tabs">
        {tabs.map((item) => (
          <button key={item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>{item.label}</button>
        ))}
        <div className="bottom-actions"><button onClick={onOpenRiskManagement}><Gauge size={13} /> Trading rules</button><button><Settings size={14} /></button></div>
      </div>
      {(statusMessage || checkedAt || onRefreshAccount) && <div className="history-toolbar"><span>{venue}{checkedAt ? ` · Checked ${new Date(checkedAt).toLocaleTimeString()}` : ''}</span><span role="status">{statusMessage}</span>{onRefreshAccount && <button type="button" disabled={executing} onClick={() => { void onRefreshAccount().catch(() => undefined) }}>Refresh Account</button>}{onReconcilePending && <button type="button" disabled={executing} onClick={() => { void onReconcilePending().catch(() => undefined) }}>Reconcile Pending Action</button>}</div>}
      {isPositionsTab && positions.length > 0 ? (
        <div className="positions-table-wrap">
          <div className="positions-table positions-head">
            <span>Contract</span><span>Side / leverage</span><span>Size</span><span>Entry price</span><span>Position value</span><span>Unrealized PnL</span><span>Liq. price</span><span />
          </div>
          {positions.map((position) => {
            const pnl = Number(position.unrealizedProfit)
            return (
              <div className="positions-table" key={position.positionId}>
                <strong>{position.symbol}<small>{position.isolated ? 'Isolated' : 'Cross'} · {venue}</small></strong>
                <span className={position.positionSide === 'LONG' ? 'up' : 'down'}>{position.positionSide} <small>{position.leverage}x</small></span>
                <span>{formatQuantity(Math.abs(Number(position.positionAmt)))}</span>
                <span>{formatPrice(Number(position.avgPrice))}</span>
                <span>{formatPrice(Math.abs(Number(position.positionValue || 0)))} {quoteAsset}</span>
                <span className={pnl >= 0 ? 'up' : 'down'}>{pnl >= 0 ? '+' : ''}{formatPrice(pnl)} {marginAsset}</span>
                <span>{Number(position.liquidationPrice) > 0 ? formatPrice(Number(position.liquidationPrice)) : '--'}</span>
                <button disabled={executing || !actionsEnabled} onClick={() => setPositionToClose(position)}>Close</button>
              </div>
            )
          })}
        </div>
      ) : isOrderHistoryTab ? (
        <OrderHistoryView connected={connected} history={history} loading={historyLoading} onRefresh={onRefreshHistory} venue={venue} />
      ) : isTradeHistoryTab ? (
        <TradeHistoryView connected={connected} history={history} loading={historyLoading} onRefresh={onRefreshHistory} venue={venue} quoteAsset={marginAsset} />
      ) : isAssetsTab ? (
        <AssetsView connected={connected} balances={balances} positions={positions} environment={environment} venue={venue} settlementCurrency={settlementCurrency} />
      ) : (isPositionsTab || (isOrdersTab && visibleOrderCount === 0)) ? (
        <div className="empty-state">
          <div className="empty-icon"><BookOpen size={19} /></div>
          <span>{isPositionsTab ? `No open ${venue} positions` : isOrdersTab ? 'No open orders' : 'No records in this view yet'}</span>
          <small>{isPositionsTab || isOrdersTab ? `${venue} positions and orders will appear here after exchange confirmation` : 'History synchronization is the next data stage'}</small>
        </div>
      ) : connected ? (
        <div className="orders-table-wrap">
          <div className="orders-table orders-head"><span>Symbol</span><span>Side</span><span>Type</span><span>Price</span><span>Qty</span><span>Status</span><span>Time</span><span /></div>
          {exchangeOrders.map((order, index) => {
            const orderId = String(order.orderId ?? order.orderID ?? `${index}`)
            const timestamp = Number(order.time)
            return (
              <div className="orders-table" key={orderId}>
                <strong>{String(order.symbol ?? '--')}<small>{venue}</small></strong>
                <span className={String(order.side).toUpperCase() === 'BUY' ? 'up' : 'down'}>{String(order.positionSide ?? order.side ?? '--')}</span>
                <span>{String(order.type ?? '--')}</span>
                <span>{Number(order.price) > 0 ? formatPrice(Number(order.price)) : Number(order.stopPrice) > 0 ? `Trigger ${formatPrice(Number(order.stopPrice))}` : 'Market'}</span>
                <span>{formatQuantity(Number(order.executedQty ?? 0))} / {formatQuantity(Number(order.origQty ?? order.quantity ?? 0))}</span>
                <span className="demo-status live-status">{String(order.status ?? 'NEW')}</span>
                <span>{timestamp > 0 ? new Date(timestamp).toLocaleTimeString('en-GB') : '--'}</span>
                <div className="order-row-actions"><button disabled={executing || !actionsEnabled || !order.orderId && !order.orderID} onClick={() => setOrderToAmend(order)}><Pencil size={11} /> Edit</button><button disabled={executing || !actionsEnabled || !order.orderId && !order.orderID} onClick={() => setOrderToCancel(order)}><X size={13} /> Cancel</button></div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="orders-table-wrap">
          <div className="orders-table orders-head"><span>Symbol</span><span>Side</span><span>Type</span><span>Price</span><span>Qty</span><span>Status</span><span>Time</span><span /></div>
          {demoOrders.map((order) => (
            <div className="orders-table" key={order.id}>
              <strong>{order.symbol}<small>Demo</small></strong><span className={order.side === 'Buy' ? 'up' : 'down'}>{order.side}</span><span>{order.type}</span><span>{formatPrice(order.price)}</span><span>{formatQuantity(order.quantity)}</span><span className="demo-status">{order.status}</span><span>{order.createdAt}</span><button onClick={() => onRemoveDemo(order.id)}><X size={13} /> Cancel</button>
            </div>
          ))}
        </div>
      )}
      <PositionCloseDialog
        venue={venue}
        quoteAsset={quoteAsset}
        actionsEnabled={actionsEnabled}
        position={positionToClose}
        quantityPrecision={contracts.find((contract) => contract.symbol === positionToClose?.symbol)?.quantityPrecision ?? 8}
        environment={environment}
        liveTradingEnabled={liveTradingEnabled}
        executing={executing}
        onCancel={() => setPositionToClose(null)}
        onConfirm={onClosePosition}
      />
      <CancelOrderDialog venue={venue} actionsEnabled={actionsEnabled} order={orderToCancel} environment={environment} liveTradingEnabled={liveTradingEnabled} executing={executing} onCancel={() => setOrderToCancel(null)} onConfirm={onCancelOrder} />
      <AmendOrderDialog venue={venue} actionsEnabled={actionsEnabled} order={orderToAmend} environment={environment} liveTradingEnabled={liveTradingEnabled} executing={executing} onCancel={() => setOrderToAmend(null)} onConfirm={onAmendOrder} />
    </section>
  )
}

