import React, { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  Info,
  LockKeyhole,
  Minus,
  Plus,
  Settings,
  ShieldCheck,
  X,
  Zap,
} from 'lucide-react'
import type {
  AdvancedOrderInput,
  AmountMode,
  DemoOrder,
  ExchangeMarginType,
  ExchangeOrder,
  ExchangePosition,
  ExchangeSessionState,
  MarketInstrument,
  OrderKind,
  OrderProtectionDraft,
  OrderPreviewResponse,
  PositionDirection,
  ProtectionWorkingType,
  TimeInForce,
  TradingSettings,
  TriggerExecution,
  WorkingType,
} from '../types'
import type { MarketDataExchange } from '../marketData'
import { MARKET_DATA_LABELS } from '../marketData'
import { useRiskProfile } from '../hooks/useRiskProfile'
import { selectSettlementBalance, settlementAsset } from '../exchangeBalance'

const n = (value: string | number | undefined) => Number(value || 0)
const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value))
const format = (value: number, digits = 4) => Number.isFinite(value)
  ? value.toLocaleString('en-US', { maximumFractionDigits: digits })
  : '--'

const formatRemaining = (timestamp: number | undefined) => {
  if (!timestamp) return undefined
  const minutes = Math.max(0, Math.ceil((timestamp - Date.now()) / 60_000))
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return hours > 0 ? `${hours}h ${remainder}m` : `${remainder}m`
}

function riskBlockDescription(runtime: import('../types').RiskRuntimeStatus) {
  const details = runtime.blockDetails ?? {}
  if (runtime.blockCode === 'MAX_TRADES_PER_DAY') {
    const used = Number(details.used ?? runtime.tradesUsed ?? 0)
    const reserved = Number(details.reserved ?? 0)
    const limit = Number(details.limit ?? runtime.tradeLimit ?? 0)
    const reset = formatRemaining(Number(details.resetAt ?? runtime.nextResetAt))
    return `Daily trade limit reached · ${used + reserved}/${limit}${reset ? ` · Resets in ${reset}` : ''}`
  }
  if (runtime.blockCode === 'DAILY_LOSS_LIMIT') {
    const unit = String(details.unit ?? 'PERCENT')
    const loss = unit === 'USDT' ? `${format(Number(details.lossUsdt ?? 0), 2)} USDT` : `${format(Number(details.lossPercent ?? 0), 2)}%`
    const limit = `${format(Number(details.limit ?? 0), 2)}${unit === 'USDT' ? ' USDT' : '%'}`
    const reset = formatRemaining(Number(details.resetAt ?? runtime.nextResetAt))
    return `Daily loss limit reached · ${loss} / ${limit}${reset ? ` · Resets in ${reset}` : ''}`
  }
  if (runtime.blockCode === 'COOLDOWN_ACTIVE' || runtime.blockCode === 'MAX_CONSECUTIVE_LOSSES') {
    const losses = Number(details.consecutiveLosses ?? runtime.consecutiveLosses ?? 0)
    const limit = Number(details.limit ?? 0)
    const resumes = formatRemaining(Number(details.cooldownUntil ?? runtime.cooldownUntil))
    return `Loss cooldown active · ${losses}/${limit} losses${resumes ? ` · Resumes in ${resumes}` : ''}`
  }
  return runtime.blockReason || 'New entries are currently blocked by the active policy.'
}

export type OrderEntryVenue = {
  name: 'BingX' | 'Hyperliquid'
  network?: 'testnet' | 'mainnet'
  quoteAsset: 'USDT' | 'USD'
  marginAsset: string
  executionSymbol?: string
  isLive: boolean
  actionsEnabled: boolean
  account?: string
  availableMargin?: number
  accountEquity?: number
  statusMessage?: string
  sharedLeverage?: boolean
  markPriceOnly?: boolean
  supportsTriggerOrders?: boolean
  supportedTimeInForce?: TimeInForce[]
}
export function estimateOrderNotional(mode: AmountMode, amount: number, price: number, leverage: number, openFee: number, closeFee: number, marginOnly = false) {
  return mode === 'QUANTITY' ? amount * price : mode === 'VALUE' ? amount : marginOnly ? amount * leverage : amount / ((1 / leverage) + openFee + closeFee)
}
export function venueWritesEnabled(venue?: OrderEntryVenue) { return !venue || (venue.actionsEnabled && (venue.name !== 'Hyperliquid' || venue.network === 'testnet')) }
export function validateVenueOrderInput(input: AdvancedOrderInput, venue?: OrderEntryVenue) {
  if (!venueWritesEnabled(venue)) throw new Error('Actions are disabled for this account or network')
  if (venue?.name !== 'Hyperliquid') return
  if (input.timeInForce === 'FOK') throw new Error('FOK is unavailable on Hyperliquid')
  const tif = venue.supportedTimeInForce ?? ['GTC', 'IOC', 'PostOnly']
  if (input.timeInForce && !tif.includes(input.timeInForce)) throw new Error(`${input.timeInForce} is unavailable on Hyperliquid`)
  if (input.orderKind === 'TRIGGER' && !venue.supportsTriggerOrders) throw new Error('Standalone trigger entries are unavailable on Hyperliquid')
  if ((input.workingType && input.workingType !== 'MARK_PRICE' || input.stopLoss && input.stopLoss.workingType !== 'MARK_PRICE' || input.takeProfit && input.takeProfit.workingType !== 'MARK_PRICE')) throw new Error('Hyperliquid native triggers require Mark price')
}

export type OrderEntryPanelProps = {
  venue?: OrderEntryVenue
  price: number
  marketDataExchange: MarketDataExchange
  market: MarketInstrument
  exchange: ExchangeSessionState
  status: 'checking' | 'idle' | 'connecting' | 'previewing' | 'executing' | 'updating'
  exchangeError: string | null
  settings: TradingSettings | null
  settingsLoading: boolean
  instrumentSupported: boolean
  positions: ExchangePosition[]
  openOrders: ExchangeOrder[]
  onCreateOrder: (order: DemoOrder) => void
  onChangeMarginType: (input: { marginType: ExchangeMarginType; confirmation?: string }) => Promise<TradingSettings>
  onChangeLeverage: (input: { direction: PositionDirection; leverage: number; confirmation?: string }) => Promise<TradingSettings>
  onPreviewOrder: (input: AdvancedOrderInput) => Promise<OrderPreviewResponse>
  onExecuteOrder: (input: { previewId: string; confirmation?: string }) => Promise<unknown>
  onOpenRiskManagement: () => void
  onProtectionDraftChange: (draft: OrderProtectionDraft | null) => void
}

type Props = OrderEntryPanelProps

type MarginModalProps = Pick<Props, 'venue' | 'exchange' | 'settings' | 'status' | 'positions' | 'openOrders' | 'onChangeMarginType'> & {
  symbol: string
  localMarginType: ExchangeMarginType
  onLocalChange: (value: ExchangeMarginType) => void
  onClose: () => void
}

export function MarginModeModal({ venue, exchange, settings, status, positions, openOrders, symbol, localMarginType, onLocalChange, onChangeMarginType, onClose }: MarginModalProps) {
  const current = settings?.marginType ?? localMarginType
  const [selected, setSelected] = useState<ExchangeMarginType>(current)
  const [error, setError] = useState<string | null>(null)
  const live = venue?.isLive ?? exchange.environment === 'prod-live'
  const busy = status === 'updating'
  const actionsEnabled = venueWritesEnabled(venue) && (venue?.name !== 'Hyperliquid' || exchange.connected)
  const venueName = venue?.name ?? 'BingX'
  const hasPosition = positions.some((position) => position.symbol === symbol)
  const hasOrder = openOrders.some((order) => order.symbol === symbol)
  const hasConflict = hasPosition || hasOrder

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!actionsEnabled) return setError('Actions are disabled for this account or network')
    if (selected === current) return onClose()
    if (!exchange.connected) {
      onLocalChange(selected)
      onClose()
      return
    }
    setError(null)
    try {
      await onChangeMarginType({ marginType: selected, confirmation: live ? 'CONFIRM' : undefined })
      onClose()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : `${venueName} rejected the margin mode change`)
    }
  }

  return (
    <div className="trade-modal-layer" role="dialog" aria-modal="true" aria-label="Margin Mode">
      <button className="trade-modal-scrim" type="button" onClick={onClose} aria-label="Close margin mode" />
      <form className="trade-modal margin-modal" onSubmit={submit}>
        <header className="trade-modal-header">
          <div><strong>Margin Mode</strong><small>{symbol} · configured on {venueName}</small></div>
          <button type="button" onClick={onClose} aria-label="Close"><X size={17} /></button>
        </header>
        <div className="trade-modal-body">
          <div className="mode-card-grid">
            <button type="button" className={`mode-card ${selected === 'CROSSED' ? 'selected' : ''}`} onClick={() => setSelected('CROSSED')}>
              <span><strong>Cross</strong>{current === 'CROSSED' && <small>Current</small>}</span>
              <p>All available margin can support the position. Losses may affect more of the futures balance.</p>
            </button>
            <button type="button" className={`mode-card ${selected === 'ISOLATED' ? 'selected' : ''}`} onClick={() => setSelected('ISOLATED')}>
              <span><strong>Isolated</strong>{current === 'ISOLATED' && <small>Current</small>}</span>
              <p>Only margin assigned to this position is at risk. Liquidation is isolated to the contract.</p>
            </button>
          </div>
          <div className="modal-info"><Info size={15} /><span>{venueName} stores margin mode per contract. Changing {symbol} does not change the other markets.</span></div>
          {hasConflict && (
            <div className="modal-warning"><AlertTriangle size={16} /><span>{hasPosition && hasOrder ? 'Open positions and orders' : hasPosition ? 'An open position' : 'Open orders'} exist for this contract. {venueName} may refuse the switch until they are closed or cancelled.</span></div>
          )}
          {live && (
            <div className="live-order-banner"><LockKeyhole size={16} /><span>LIVE setting — review the new mode, then confirm once.</span></div>
          )}
          {error && <div className="trade-inline-error">{error}</div>}
        </div>
        <footer className="trade-modal-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!actionsEnabled || busy || selected === current}>
            {busy ? <><i className="button-spinner" />Updating {venueName}…</> : 'Confirm'}
          </button>
        </footer>
      </form>
    </div>
  )
}

type LeverageModalProps = Pick<Props, 'venue' | 'exchange' | 'settings' | 'status' | 'onChangeLeverage'> & {
  direction: PositionDirection
  localLeverage: number
  onLocalChange: (value: number) => void
  onClose: () => void
}

export function LeverageModal({ venue, exchange, settings, status, direction, localLeverage, onLocalChange, onChangeLeverage, onClose }: LeverageModalProps) {
  const linked = venue?.sharedLeverage ?? (venue?.name === 'Hyperliquid' || Boolean(settings?.dualSidePosition && settings.marginType === 'CROSSED'))
  const maximum = settings
    ? linked
      ? Math.min(settings.maxLongLeverage, settings.maxShortLeverage)
      : direction === 'LONG' ? settings.maxLongLeverage : settings.maxShortLeverage
    : 125
  const current = settings ? (direction === 'LONG' ? settings.longLeverage : settings.shortLeverage) : localLeverage
  const [draft, setDraft] = useState(current)
  const [error, setError] = useState<string | null>(null)
  const live = venue?.isLive ?? exchange.environment === 'prod-live'
  const busy = status === 'updating'
  const actionsEnabled = venueWritesEnabled(venue) && (venue?.name !== 'Hyperliquid' || exchange.connected)
  const venueName = venue?.name ?? 'BingX'
  const markers = [...new Set([1, ...[0.2, 0.4, 0.6, 0.8, 1].map((ratio) => Math.max(1, Math.round(maximum * ratio)))])]
  const updateDraft = (value: number) => setDraft(clamp(Math.round(value || 1), 1, maximum))
  const progress = maximum <= 1 ? 100 : ((draft - 1) / (maximum - 1)) * 100

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!actionsEnabled) return setError('Actions are disabled for this account or network')
    if (draft === current) return onClose()
    if (!exchange.connected) {
      onLocalChange(draft)
      onClose()
      return
    }
    setError(null)
    try {
      await onChangeLeverage({ direction, leverage: draft, confirmation: live ? 'CONFIRM' : undefined })
      onClose()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : `${venueName} rejected the leverage change`)
    }
  }

  return (
    <div className="trade-modal-layer" role="dialog" aria-modal="true" aria-label="Adjust Leverage">
      <button className="trade-modal-scrim" type="button" onClick={onClose} aria-label="Close leverage" />
      <form className="trade-modal leverage-modal" onSubmit={submit}>
        <header className="trade-modal-header">
          <div><strong>Adjust Leverage</strong><small>{venue?.name === 'Hyperliquid' ? 'Native asset' : direction} · current {current}x · maximum {maximum}x</small></div>
          <button type="button" onClick={onClose}><X size={17} /></button>
        </header>
        <div className="trade-modal-body">
          <div className="leverage-input-row">
            <button type="button" onClick={() => updateDraft(draft - 1)} aria-label="Decrease leverage"><Minus size={16} /></button>
            <label><input className="number-clean" type="number" min="1" max={maximum} value={draft} onChange={(event) => updateDraft(Number(event.target.value))} /><strong>x</strong></label>
            <button type="button" onClick={() => updateDraft(draft + 1)} aria-label="Increase leverage"><Plus size={16} /></button>
          </div>
          <div className="leverage-range-block">
            <input aria-label="Leverage" type="range" min="1" max={maximum} step="1" value={draft} onChange={(event) => updateDraft(Number(event.target.value))} style={{ '--range-progress': `${progress}%` } as CSSProperties} />
            <div className="leverage-markers">{markers.map((value) => (
              <button
                type="button"
                className={draft === value ? 'active' : ''}
                style={{ left: `${maximum <= 1 ? 100 : ((value - 1) / (maximum - 1)) * 100}%` }}
                key={value}
                onClick={() => updateDraft(value)}
              >{value}x</button>
            ))}</div>
          </div>
          {linked && <div className="leverage-linked-note"><Info size={14} /><span>{venue?.name === 'Hyperliquid' ? 'This native asset uses one leverage setting for both directions.' : 'Cross Hedge: LONG and SHORT use the same leverage.'}</span></div>}
          {error && <div className="trade-inline-error">{error}</div>}
        </div>
        <footer className="trade-modal-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={!actionsEnabled || busy || draft === current}>{busy ? <><i className="button-spinner" />Updating…</> : `Confirm ${draft}x`}</button></footer>
      </form>
    </div>
  )
}

export function OrderConfirmationModal({ venue, exchange, response, status, onCancel, onConfirm, onRefresh }: {
  venue?: OrderEntryVenue
  exchange: ExchangeSessionState
  response: OrderPreviewResponse
  status: Props['status']
  onCancel: () => void
  onConfirm: (confirmation?: string) => Promise<void>
  onRefresh: () => Promise<void>
}) {
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const preview = response.preview
  const live = venue?.isLive ?? exchange.environment === 'prod-live'
  const marginAsset = venue?.marginAsset ?? settlementAsset(exchange.environment)
  const quoteAsset = venue?.quoteAsset ?? 'USDT'
  const venueName = venue?.name ?? 'BingX'
  const busy = status === 'executing' || status === 'previewing'
  const remainingSeconds = Math.max(0, Math.ceil((response.expiresAt - now) / 1_000))
  const expired = remainingSeconds === 0

  useEffect(() => {
    setNow(Date.now())
    setError(null)
    const timer = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [response.previewId])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    if (!venueWritesEnabled(venue)) return setError('Actions are disabled for this account or network')
    try {
      if (expired) {
        await onRefresh()
        return
      }
      await onConfirm(live ? 'CONFIRM' : undefined)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : `${venueName} rejected the order`)
    }
  }

  return (
    <div className="trade-modal-layer" role="dialog" aria-modal="true" aria-label="Confirm order">
      <button className="trade-modal-scrim" type="button" onClick={onCancel} />
      <form className="trade-modal confirmation-modal" onSubmit={submit}>
        <header className="trade-modal-header"><div><strong>Confirm {preview.direction}</strong><small>{venueName}{venue?.network ? ` ${venue.network}` : ''} · {preview.symbol} · {preview.exchangeOrderType} · {expired ? 'preview expired' : `valid for ${remainingSeconds}s`}</small></div><button type="button" onClick={onCancel}><X size={17} /></button></header>
        <div className="trade-modal-body">
          {venue?.account && <div className="modal-info">Owner: {venue.account}</div>}
          {live && <div className="live-order-banner"><LockKeyhole size={16} /><span>LIVE order — review the details, then confirm once. This action uses real funds on {venueName}.</span></div>}
          <div className="confirmation-grid">
            <span>Estimated entry<strong>{format(preview.estimatedAveragePrice, 8)} {quoteAsset}</strong></span>
            <span>Quantity<strong>{format(preview.quantity, 8)}</strong></span>
            <span>Position value<strong>{format(preview.notional)} {quoteAsset}</strong></span>
            <span>Initial margin<strong>{format(preview.estimatedMargin)} {marginAsset}</strong></span>
            <span>Open fee<strong>{format(preview.estimatedOpenFee)} {marginAsset}</strong></span>
            <span>{venue?.name === 'Hyperliquid' ? 'Closing fee estimate' : 'Closing fee reserve'}<strong>{format(preview.estimatedCloseFee)} {marginAsset}</strong></span>
            <span>Total order cost<strong>{format(preview.estimatedOrderCost)} {marginAsset}</strong></span>
            <span>Indicative liquidation<strong>{Number.isFinite(preview.indicativeLiquidationPrice) && preview.indicativeLiquidationPrice > 0 ? `≈ ${format(preview.indicativeLiquidationPrice, 8)}` : 'Not estimated'}</strong></span>
          </div>
          {(preview.takeProfit || preview.stopLoss) && (
            <section className="confirmation-protection">
              <header><span><ShieldCheck size={15} /> Attached TP/SL</span><strong>Will validate before send</strong></header>
              {preview.takeProfit && <div><span>Take Profit<small>{preview.takeProfit.workingType === 'MARK_PRICE' ? 'Mark price' : 'Last price'} · {preview.takeProfit.execution}{preview.takeProfit.price ? ` @ ${format(preview.takeProfit.price, 8)}` : ''}</small></span><strong>{format(preview.takeProfit.stopPrice, 8)} {quoteAsset}<small>≈ +{format(preview.takeProfit.expectedPnl)} {marginAsset}</small></strong></div>}
              {preview.stopLoss && <div><span>Stop Loss<small>{preview.stopLoss.workingType === 'MARK_PRICE' ? 'Mark price' : 'Last price'} · {preview.stopLoss.execution}{preview.stopLoss.price ? ` @ ${format(preview.stopLoss.price, 8)}` : ''}</small></span><strong>{format(preview.stopLoss.stopPrice, 8)} {quoteAsset}<small>≈ −{format(preview.stopLoss.expectedPnl)} {marginAsset}</small></strong></div>}
              <footer><span>{venue?.name === 'Hyperliquid' ? 'Protection requested' : 'Position protected'}</span><strong>100%{preview.riskReward ? ` · R/R 1:${preview.riskReward.toFixed(2)}` : ''}</strong></footer>
            </section>
          )}
          {preview.orderKind === 'MARKET' && <div className="slippage-row"><span>{venue?.name === 'Hyperliquid' ? 'Slippage limit' : 'Estimated book slippage'}</span><strong>{preview.estimatedSlippagePercent.toFixed(3)}%</strong></div>}
          <div className="modal-info"><Info size={15} /><span>{venue?.name === 'Hyperliquid' ? 'Liquidation is not estimated here. The final fill price and native maintenance margin determine it.' : `${venueName} liquidation depends on maintenance margin tiers and the final fill price; this estimate is not a guarantee.`}</span></div>
          {expired && <div className="modal-warning"><AlertTriangle size={16} /><span>The price preview expired. Refresh it here; the order will not be sent until you review the updated values and confirm again.</span></div>}
          {error && <div className="trade-inline-error">{error}</div>}
        </div>
        <footer className="trade-modal-actions"><button type="button" onClick={onCancel}>Cancel</button><button className={`primary ${preview.direction === 'SHORT' && !expired ? 'danger' : ''}`} disabled={!venueWritesEnabled(venue) || busy}>{busy ? <><i className="button-spinner" />{status === 'previewing' ? 'Refreshing…' : 'Sending…'}</> : expired ? 'Refresh order preview' : `Confirm ${preview.direction}`}</button></footer>
      </form>
    </div>
  )
}

export function OrderEntryPanel({ venue, price, marketDataExchange, market, exchange, status, exchangeError, settings, settingsLoading, instrumentSupported, positions, openOrders, onCreateOrder, onChangeMarginType, onChangeLeverage, onPreviewOrder, onExecuteOrder, onOpenRiskManagement, onProtectionDraftChange }: Props) {
  const hyperliquid = venue?.name === 'Hyperliquid'
  const venueName = venue?.name ?? 'BingX'
  const venueLabel = `${venueName}${venue?.network ? ` ${venue.network === 'testnet' ? 'Testnet' : 'Mainnet'}` : ''}`
  const actionsEnabled = venueWritesEnabled(venue)
  const quoteAsset = venue?.quoteAsset ?? 'USDT'
  const markPriceOnly = hyperliquid
  const risk = useRiskProfile(!hyperliquid)
  const symbol = venue?.executionSymbol ?? `${market.baseAsset}-USDT`
  const selectionIdentity = `${venueName}:${venue?.network ?? ''}:${venue?.account ?? exchange.accountId ?? ''}:${symbol}`
  const selectionRef = useRef(selectionIdentity)
  selectionRef.current = selectionIdentity
  const [direction, setDirection] = useState<PositionDirection>('LONG')
  const [kind, setKind] = useState<OrderKind>('MARKET')
  const [amountMode, setAmountMode] = useState<AmountMode>(hyperliquid ? 'COST' : 'VALUE')
  const [amount, setAmount] = useState('')
  const [percentage, setPercentage] = useState(0)
  const [orderPrice, setOrderPrice] = useState('')
  const [timeInForce, setTimeInForce] = useState<TimeInForce>('GTC')
  const [triggerPrice, setTriggerPrice] = useState('')
  const [triggerExecution, setTriggerExecution] = useState<TriggerExecution>('MARKET')
  const [workingType, setWorkingType] = useState<WorkingType>('MARK_PRICE')
  const [maxSlippage, setMaxSlippage] = useState(hyperliquid ? '0.25' : '0.50')
  const [reduceOnly, setReduceOnly] = useState(false)
  const [protectionEnabled, setProtectionEnabled] = useState(false)
  const [takeProfitEnabled, setTakeProfitEnabled] = useState(true)
  const [stopLossEnabled, setStopLossEnabled] = useState(true)
  const [protectionAdvancedOpen, setProtectionAdvancedOpen] = useState(false)
  const [protectionMode, setProtectionMode] = useState<'PRICE' | 'ROI' | 'PNL'>('PRICE')
  const [protectionSource, setProtectionSource] = useState<ProtectionWorkingType>('MARK_PRICE')
  const [protectionExecution, setProtectionExecution] = useState<'MARKET' | 'LIMIT'>('MARKET')
  const [takeProfit, setTakeProfit] = useState('')
  const [stopLoss, setStopLoss] = useState('')
  const [takeProfitLimit, setTakeProfitLimit] = useState('')
  const [stopLossLimit, setStopLossLimit] = useState('')
  const [localMarginType, setLocalMarginType] = useState<ExchangeMarginType>('CROSSED')
  const [localLeverage, setLocalLeverage] = useState(10)
  const [marginModalOpen, setMarginModalOpen] = useState(false)
  const [leverageModalOpen, setLeverageModalOpen] = useState(false)
  const [preview, setPreview] = useState<OrderPreviewResponse | null>(null)
  const [previewInput, setPreviewInput] = useState<AdvancedOrderInput | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const marginType = settings?.marginType ?? localMarginType
  const leverage = settings ? (direction === 'LONG' ? settings.longLeverage : settings.shortLeverage) : localLeverage
  const maximumLeverage = settings ? (direction === 'LONG' ? settings.maxLongLeverage : settings.maxShortLeverage) : 125
  const accountBalance = hyperliquid ? undefined : selectSettlementBalance(exchange.environment, exchange.snapshot?.balances)
  const marginAsset = venue?.marginAsset || accountBalance?.asset || settlementAsset(exchange.environment)
  const availableMargin = venue?.availableMargin ?? n(accountBalance?.availableMargin)
  const usableMargin = availableMargin * 0.995
  const referenceEntry = kind === 'LIMIT' || (kind === 'TRIGGER' && triggerExecution === 'LIMIT')
    ? n(orderPrice) || price
    : kind === 'TRIGGER' ? n(triggerPrice) || price : price
  const feeRate = kind === 'LIMIT' || (kind === 'TRIGGER' && triggerExecution === 'LIMIT')
    ? n(settings?.contract.makerFeeRate)
    : n(settings?.contract.takerFeeRate)
  const closeFeeRate = n(settings?.contract.takerFeeRate)
  const parsedAmount = n(amount)
  const estimatedNotional = estimateOrderNotional(amountMode, parsedAmount, referenceEntry, leverage, feeRate, closeFeeRate, hyperliquid)
  const estimatedQuantity = referenceEntry > 0 ? estimatedNotional / referenceEntry : 0
  const estimatedMargin = estimatedNotional / leverage
  const estimatedFees = estimatedNotional * (feeRate + closeFeeRate)
  const estimatedCost = estimatedMargin + estimatedFees
  const liveTriggerBlocked = !hyperliquid && exchange.connected && exchange.environment === 'prod-live' && kind === 'TRIGGER' && !exchange.liveTriggerOrdersEnabled
  const busy = status === 'previewing' || status === 'executing' || status === 'updating'
  const riskRuleKeys = ['fixedStopLoss', 'breakEven', 'riskPerTrade', 'dailyLossLimit', 'maxLeverage', 'maxTradesPerDay', 'maxConsecutiveLosses', 'cooldownMinutes', 'maxExposurePercent', 'maxOpenPositions'] as const
  const enabledRiskRules = useMemo(() => riskRuleKeys.filter((key) => risk.profile[key].enabled).length, [risk.profile])
  const protectionRequired = Boolean(risk.profile.active && risk.profile.fixedStopLoss.enabled)

  useEffect(() => {
    setAmount('')
    setPercentage(0)
    setOrderPrice('')
    setTriggerPrice('')
    setTakeProfit('')
    setStopLoss('')
    setPreview(null)
    setPreviewInput(null)
    setFormError(null)
    if (hyperliquid) { setAmountMode('COST'); setWorkingType('MARK_PRICE'); setProtectionSource('MARK_PRICE'); setTimeInForce('GTC'); if (!venue?.supportsTriggerOrders) setKind('MARKET') }
    if (exchange.connected && !instrumentSupported) return setFormError(`${symbol} is not available for API execution on ${venueName}.`)
  }, [market.symbol, venue?.name, venue?.network, venue?.account])

  useEffect(() => {
    if (!settings) return
    setLocalMarginType(settings.marginType)
    setLocalLeverage(direction === 'LONG' ? settings.longLeverage : settings.shortLeverage)
  }, [direction, settings])

  useEffect(() => {
    if (!protectionRequired) return
    setProtectionEnabled(true)
    setStopLossEnabled(true)
  }, [protectionRequired])

  const setFromPercentage = (raw: number) => {
    const next = clamp(Math.round(raw), 0, 100)
    setPercentage(next)
    const cost = usableMargin * next / 100
    const notional = cost / ((1 / leverage) + feeRate + closeFeeRate)
    const nextAmount = amountMode === 'COST' ? (hyperliquid ? notional / leverage : cost) : amountMode === 'VALUE' ? notional : referenceEntry > 0 ? notional / referenceEntry : 0
    setAmount(next === 0 ? '' : String(Number(nextAmount.toFixed(amountMode === 'QUANTITY' ? 8 : 4))))
  }

  const changeAmount = (value: string) => {
    setAmount(value)
    const numeric = n(value)
    const notional = estimateOrderNotional(amountMode, numeric, referenceEntry, leverage, feeRate, closeFeeRate, hyperliquid)
    const cost = notional / leverage + notional * (feeRate + closeFeeRate)
    setPercentage(usableMargin > 0 ? clamp(Math.round(cost / usableMargin * 100), 0, 100) : 0)
  }

  const changeAmountMode = (next: AmountMode) => {
    if (estimatedNotional > 0) {
      const nextValue = next === 'QUANTITY' ? estimatedQuantity : next === 'VALUE' ? estimatedNotional : hyperliquid ? estimatedMargin : estimatedCost
      setAmount(String(Number(nextValue.toFixed(next === 'QUANTITY' ? 8 : 4))))
    }
    setAmountMode(next)
  }

  const protectionPrice = (raw: string, target: 'TP' | 'SL') => {
    const value = Math.abs(n(raw))
    if (!(value > 0) || !(referenceEntry > 0)) return 0
    if (protectionMode === 'PRICE') return value
    const distance = protectionMode === 'ROI'
      ? referenceEntry * value / (100 * leverage)
      : estimatedQuantity > 0 ? value / estimatedQuantity : 0
    const upward = (direction === 'LONG' && target === 'TP') || (direction === 'SHORT' && target === 'SL')
    return upward ? referenceEntry + distance : referenceEntry - distance
  }

  const tpPrice = protectionPrice(takeProfit, 'TP')
  const slPrice = protectionPrice(stopLoss, 'SL')
  const activeTpPrice = protectionEnabled && takeProfitEnabled ? tpPrice : 0
  const activeSlPrice = protectionEnabled && stopLossEnabled ? slPrice : 0
  const expectedProfit = activeTpPrice > 0 ? Math.abs(activeTpPrice - referenceEntry) * estimatedQuantity : 0
  const expectedLoss = activeSlPrice > 0 ? Math.abs(activeSlPrice - referenceEntry) * estimatedQuantity : 0
  const takeProfitDistance = activeTpPrice > 0 && referenceEntry > 0 ? Math.abs(activeTpPrice - referenceEntry) / referenceEntry * 100 : 0
  const stopLossDistance = activeSlPrice > 0 && referenceEntry > 0 ? Math.abs(activeSlPrice - referenceEntry) / referenceEntry * 100 : 0
  const accountEquity = venue?.accountEquity ?? (n(accountBalance?.equity) || n(accountBalance?.balance))
  const accountRisk = expectedLoss > 0 && accountEquity > 0 ? expectedLoss / accountEquity * 100 : 0
  const amountModeLabel = amountMode === 'QUANTITY' ? market.baseAsset : amountMode === 'COST' ? marginAsset : quoteAsset
  const protectionInputLabel = protectionMode === 'PRICE' ? 'Trigger price' : protectionMode === 'ROI' ? 'Target ROI' : 'Target P&L'
  const protectionUnit = protectionMode === 'ROI' ? '%' : protectionMode === 'PNL' ? marginAsset : quoteAsset

  useEffect(() => {
    if (!(referenceEntry > 0) || (!activeTpPrice && !activeSlPrice)) {
      onProtectionDraftChange(null)
      return
    }
    onProtectionDraftChange({
      symbol: market.symbol,
      direction,
      entryPrice: referenceEntry,
      quantity: estimatedQuantity,
      ...(activeTpPrice > 0 ? { takeProfitPrice: activeTpPrice } : {}),
      ...(activeSlPrice > 0 ? { stopLossPrice: activeSlPrice } : {}),
    })
  }, [activeSlPrice, activeTpPrice, direction, estimatedQuantity, market.symbol, onProtectionDraftChange, referenceEntry])

  useEffect(() => () => onProtectionDraftChange(null), [onProtectionDraftChange])
  const riskGuardState = hyperliquid
    ? { tone: 'paused', title: 'Hyperliquid BTC Protection', detail: venue?.statusMessage ?? 'Separate testnet connection; this order form does not arm it.' }
    : risk.error
    ? { tone: 'warning', title: 'Risk Guard status unavailable', detail: 'The server will still validate this order before exchange.' }
    : risk.status === 'loading'
      ? { tone: 'loading', title: 'Risk Guard', detail: 'Loading server policy…' }
      : !risk.profile.active
        ? { tone: 'paused', title: 'Risk Guard paused', detail: 'No personal policy is active.' }
        : risk.runtime.blocked
          ? { tone: 'blocked', title: 'Trading blocked', detail: riskBlockDescription(risk.runtime) }
          : { tone: 'active', title: 'Risk Guard active', detail: `${enabledRiskRules} enabled rule${enabledRiskRules === 1 ? '' : 's'} checked before exchange.` }
  const missingOrderPrice = kind === 'LIMIT' && !(n(orderPrice) > 0)
  const missingTriggerPrice = kind === 'TRIGGER' && !(n(triggerPrice) > 0)
  const missingTriggerLimit = kind === 'TRIGGER' && triggerExecution === 'LIMIT' && !(n(orderPrice) > 0)
  const missingProtection = protectionEnabled && !activeTpPrice && !activeSlPrice
  const missingRequiredStop = protectionRequired && !activeSlPrice
  const missingProtectionLimit = protectionEnabled && protectionExecution === 'LIMIT' && (
    (activeTpPrice > 0 && !(n(takeProfitLimit) > 0)) || (activeSlPrice > 0 && !(n(stopLossLimit) > 0))
  )
  const ctaLabel = !actionsEnabled ? 'Actions disabled' : hyperliquid && !exchange.connected ? 'Link Hyperliquid master EOA' : status === 'previewing'
    ? 'Calculating order cost…'
    : status === 'executing'
      ? 'Sending order…'
      : risk.runtime.blocked
        ? 'Blocked by Risk Guard'
        : !instrumentSupported
          ? `Unavailable on ${venueName}`
          : liveTriggerBlocked
            ? 'Trigger is VST only'
            : settingsLoading && exchange.connected
              ? `Loading ${venueName} contract…`
              : !(parsedAmount > 0)
                ? 'Enter an amount'
                : missingOrderPrice
                  ? 'Enter a limit price'
                  : missingTriggerPrice
                    ? 'Enter a trigger price'
                    : missingTriggerLimit
                      ? 'Enter an execution price'
                      : missingRequiredStop
                        ? 'Add required Stop Loss'
                        : missingProtection
                          ? 'Add Take Profit or Stop Loss'
                          : missingProtectionLimit
                            ? 'Add protection limit price'
                            : exchange.connected
                              ? `Review ${direction} · ${hyperliquid ? venueLabel : `BingX ${exchange.environment === 'prod-live' ? 'LIVE' : 'VST'}`}`
                              : `${direction === 'LONG' ? 'Buy' : 'Sell'} ${market.baseAsset} · Demo`
  const ctaDisabled = !actionsEnabled || (hyperliquid && !exchange.connected) || !Number.isFinite(referenceEntry) || !(referenceEntry > 0) || busy
    || Boolean(risk.runtime.blocked)
    || liveTriggerBlocked
    || !(parsedAmount > 0)
    || missingOrderPrice
    || missingTriggerPrice
    || missingTriggerLimit
    || missingRequiredStop
    || missingProtection
    || missingProtectionLimit
    || (exchange.connected && (!instrumentSupported || !settings))

  const submit = async () => {
    setFormError(null)
    if (!actionsEnabled || (hyperliquid && !exchange.connected)) return setFormError('Link this account and enable testnet actions before reviewing an order.')
    if (!(parsedAmount > 0)) return setFormError('Enter an order amount greater than zero.')
    if (kind === 'LIMIT' && !(n(orderPrice) > 0)) return setFormError('Enter a valid limit price.')
    if (kind === 'TRIGGER' && !(n(triggerPrice) > 0)) return setFormError('Enter a valid trigger price.')
    if (kind === 'TRIGGER' && triggerExecution === 'LIMIT' && !(n(orderPrice) > 0)) return setFormError('Enter a valid execution limit price.')
    if (protectionEnabled && !activeTpPrice && !activeSlPrice) return setFormError('Enter Take Profit, Stop Loss, or both.')
    if (protectionRequired && !activeSlPrice) return setFormError(`Risk Management requires a Stop Loss within ${risk.profile.fixedStopLoss.value}% of entry.`)
    if (protectionEnabled && protectionExecution === 'LIMIT' && activeTpPrice > 0 && !(n(takeProfitLimit) > 0)) return setFormError('Enter the Take Profit limit execution price.')
    if (protectionEnabled && protectionExecution === 'LIMIT' && activeSlPrice > 0 && !(n(stopLossLimit) > 0)) return setFormError('Enter the Stop Loss limit execution price.')
    if (liveTriggerBlocked) return setFormError('Trigger orders are VST-only until the BingX mapping is validated.')

    if (!exchange.connected && !hyperliquid) {
      onCreateOrder({
        id: `AT-${Date.now().toString().slice(-7)}`,
        symbol: market.symbol,
        side: direction === 'LONG' ? 'Buy' : 'Sell',
        type: kind,
        price: referenceEntry,
        quantity: estimatedQuantity,
        status: kind === 'MARKET' ? 'Filled (demo)' : 'Open (demo)',
        createdAt: new Date().toLocaleTimeString('en-GB'),
      })
      setToast('Demo order created locally')
      window.setTimeout(() => setToast(null), 2600)
      return
    }
    if (!settings) return setFormError(`${venueName} contract settings are still loading.`)

    const input: AdvancedOrderInput = {
      symbol,
      direction,
      orderKind: kind,
      amountMode,
      amount: parsedAmount,
      leverage,
      marginType,
      ...(kind === 'LIMIT' || (kind === 'TRIGGER' && triggerExecution === 'LIMIT') ? { price: n(orderPrice), timeInForce } : {}),
      ...(kind === 'TRIGGER' ? { triggerPrice: n(triggerPrice), triggerExecution, workingType } : {}),
      ...(kind === 'MARKET' ? { maxSlippagePercent: n(maxSlippage) } : {}),
      ...(reduceOnly ? { reduceOnly: true } : {}),
      ...(activeTpPrice > 0 ? { takeProfit: { stopPrice: activeTpPrice, execution: protectionExecution, ...(protectionExecution === 'LIMIT' ? { price: n(takeProfitLimit) } : {}), workingType: protectionSource } } : {}),
      ...(activeSlPrice > 0 ? { stopLoss: { stopPrice: activeSlPrice, execution: protectionExecution, ...(protectionExecution === 'LIMIT' ? { price: n(stopLossLimit) } : {}), workingType: protectionSource } } : {}),
    }
    try {
      validateVenueOrderInput(input, venue)
      const identity = selectionRef.current
      setPreviewInput(input)
      const response = await onPreviewOrder(input)
      if (identity === selectionRef.current) setPreview(response)
    } catch (requestError) {
      setFormError(requestError instanceof Error ? requestError.message : 'Could not review the order')
    }
  }

  const confirmOrder = async (confirmation?: string) => {
    if (!preview) return
    if (!actionsEnabled) throw new Error('Actions are disabled for this account or network')
    const identity = selectionRef.current
    await onExecuteOrder({ previewId: preview.previewId, confirmation })
    if (identity !== selectionRef.current) return
    setPreview(null)
    setPreviewInput(null)
    setAmount('')
    setPercentage(0)
    setToast(hyperliquid ? 'Hyperliquid response received; account refresh confirms the outcome.' : `${exchange.environment === 'prod-live' ? 'Live' : 'VST'} order accepted by BingX`)
    window.setTimeout(() => setToast(null), 3200)
  }

  const refreshOrderPreview = async () => {
    if (!previewInput) throw new Error('Order form data is unavailable. Close the preview and review the order again.')
    const refreshedInput: AdvancedOrderInput = {
      ...previewInput,
      ...(previewInput.takeProfit ? { takeProfit: { ...previewInput.takeProfit, stopPrice: activeTpPrice } } : {}),
      ...(previewInput.stopLoss ? { stopLoss: { ...previewInput.stopLoss, stopPrice: activeSlPrice } } : {}),
    }
    setPreviewInput(refreshedInput)
    validateVenueOrderInput(refreshedInput, venue)
    const identity = selectionRef.current
    const response = await onPreviewOrder(refreshedInput)
    if (identity === selectionRef.current) setPreview(response)
  }

  const amountLabel = amountMode === 'QUANTITY' ? 'Quantity' : amountMode === 'VALUE' ? 'Position value' : hyperliquid ? 'Margin' : 'Margin cost'

  return (
    <aside className="order-panel panel advanced-order-panel">
      <div className="order-balance" aria-label="Execution instrument"><span>{venue ? venueLabel : 'BingX execution'}</span><strong>{symbol}</strong></div>
      <div className="order-topline">
        <button className={marginModalOpen ? 'dropdown-open' : ''} type="button" onClick={() => setMarginModalOpen(true)} disabled={!actionsEnabled || (hyperliquid && !exchange.connected) || (exchange.connected && (settingsLoading || !instrumentSupported))} aria-expanded={marginModalOpen}>{marginType === 'CROSSED' ? 'Cross' : 'Isolated'} <ChevronDown size={13} /></button>
        <button className={leverageModalOpen ? 'dropdown-open leverage-button' : 'leverage-button'} type="button" onClick={() => setLeverageModalOpen(true)} disabled={!actionsEnabled || (hyperliquid && !exchange.connected) || (exchange.connected && (settingsLoading || !instrumentSupported))} aria-expanded={leverageModalOpen}>{hyperliquid && !settings ? '—' : leverage}x</button>
        <button className="order-settings" type="button"><Settings size={15} /></button>
      </div>
      <div className="side-switch"><button className={direction === 'LONG' ? 'buy active' : ''} type="button" onClick={() => setDirection('LONG')}>Buy / Long</button><button className={direction === 'SHORT' ? 'sell active' : ''} type="button" onClick={() => setDirection('SHORT')}>Sell / Short</button></div>
      <div className="order-types">{(['LIMIT', 'MARKET', ...(!hyperliquid || venue?.supportsTriggerOrders ? ['TRIGGER'] : [])] as OrderKind[]).map((item) => <button type="button" className={kind === item ? 'active' : ''} onClick={() => setKind(item)} key={item}>{item[0]}{item.slice(1).toLowerCase()}{item === 'TRIGGER' && exchange.environment === 'prod-live' && !exchange.liveTriggerOrdersEnabled && <small>VST</small>}</button>)}</div>
      <div className="order-balance"><span>Available</span><strong>{exchange.connected ? `${format(availableMargin)} ${marginAsset}` : hyperliquid ? settingsLoading ? 'Loading account…' : 'Not linked' : 'Demo mode'}</strong></div>

      {kind === 'TRIGGER' && (
        <div className="trigger-block">
          <label className="input-shell"><span>Trigger Price</span><input className="number-clean" inputMode="decimal" value={triggerPrice} onChange={(event) => setTriggerPrice(event.target.value)} placeholder={format(price, 8)} /><strong>{quoteAsset}</strong></label>
          <div className="compact-setting-row"><span>Trigger by</span><select aria-label="Trigger price source" value={workingType} onChange={(event) => setWorkingType(event.target.value as WorkingType)}>{!markPriceOnly && <option value="CONTRACT_PRICE">Last</option>}<option value="MARK_PRICE">Mark</option>{!markPriceOnly && <option value="INDEX_PRICE">Index</option>}</select></div>
          <div className="segmented-control"><button type="button" className={triggerExecution === 'MARKET' ? 'active' : ''} onClick={() => setTriggerExecution('MARKET')}>Market execution</button><button type="button" className={triggerExecution === 'LIMIT' ? 'active' : ''} onClick={() => setTriggerExecution('LIMIT')}>Limit execution</button></div>
        </div>
      )}
      {(kind === 'LIMIT' || (kind === 'TRIGGER' && triggerExecution === 'LIMIT')) && <label className="input-shell"><span>{kind === 'TRIGGER' ? 'Limit Price' : 'Order Price'}</span><input className="number-clean" inputMode="decimal" value={orderPrice} onChange={(event) => setOrderPrice(event.target.value)} placeholder={format(price, 8)} /><strong>{quoteAsset}</strong></label>}
      {kind === 'LIMIT' && <div className="tif-row"><span>Time in Force</span><div>{(venue?.supportedTimeInForce ?? (hyperliquid ? ['GTC', 'IOC', 'PostOnly'] : ['GTC', 'IOC', 'FOK', 'PostOnly']) as TimeInForce[]).filter(value => !hyperliquid || value !== 'FOK').map((value) => <button type="button" className={timeInForce === value ? 'active' : ''} onClick={() => setTimeInForce(value)} key={value}>{value}</button>)}</div></div>}
      {kind === 'MARKET' && (
        <div className="compact-setting-row slippage-setting" title={`Validated against the ${venueName} order book during preview`}>
          <span>Slippage limit</span>
          <label><input className="number-clean" inputMode="decimal" aria-label="Slippage limit percentage" value={maxSlippage} onChange={(event) => setMaxSlippage(event.target.value)} /><strong>%</strong></label>
        </div>
      )}

      <section className="order-size-section">
        <header className="order-section-heading"><strong>Order size</strong><span className="order-size-percent">{percentage}%</span></header>
        <div className="amount-mode-switch">{(['QUANTITY', 'VALUE', 'COST'] as AmountMode[]).map((value) => (
          <button type="button" className={amountMode === value ? 'active' : ''} onClick={() => changeAmountMode(value)} key={value}>
            {value === 'QUANTITY' ? 'Quantity' : value === 'VALUE' ? 'Position value' : 'Margin'}
          </button>
        ))}</div>
        <label className="input-shell amount-input"><span>{amountLabel}</span><input className="number-clean" inputMode="decimal" value={amount} onChange={(event) => changeAmount(event.target.value)} placeholder="Enter amount" /><strong>{amountModeLabel}</strong></label>
        <div className="percentage-presets">{[25, 50, 75, 100].map((value) => (
          <button type="button" className={percentage === value ? 'active' : ''} key={value} onClick={() => setFromPercentage(value)}>{value === 100 ? 'Max' : `${value}%`}</button>
        ))}</div>
        <div className="percentage-control">
          <input aria-label="Order size percentage" aria-valuetext={`${percentage}% of usable margin`} type="range" min="0" max="100" step="1" value={percentage} onChange={(event) => setFromPercentage(Number(event.target.value))} style={{ '--range-progress': `${percentage}%` } as CSSProperties} />
        </div>
        <div className="order-size-summary">
          <span>Required margin<strong>{format(estimatedMargin)} {marginAsset}</strong></span>
          <span>Position value<strong>{format(estimatedNotional)} {quoteAsset}</strong></span>
          <span>Est. fees<strong>{format(estimatedFees)} {marginAsset}</strong></span>
        </div>
        <div className="order-size-note"><span>Est. {format(estimatedQuantity, 8)} {market.baseAsset}</span><span>Max reserves 0.5% for fees</span></div>
      </section>

      <label className={`reduce-only-row ${settings?.dualSidePosition ? 'unavailable' : ''}`}>
        <input type="checkbox" checked={reduceOnly} disabled={settings?.dualSidePosition} onChange={(event) => setReduceOnly(event.target.checked)} />
        <span>Reduce-only</span>
        {settings?.dualSidePosition && <small>Unavailable in Hedge</small>}
      </label>

      <section className={`protection-block ${protectionEnabled ? 'enabled' : ''}`}>
        <header className="protection-heading">
          <div><strong>Position protection</strong>{protectionRequired && <small>Required by active RM policy</small>}</div>
          <button
            className={`ui-switch protection-master-switch ${protectionEnabled ? 'active' : ''}`}
            type="button"
            role="switch"
            aria-checked={protectionEnabled}
            aria-label="Position protection"
            disabled={protectionRequired}
            onClick={() => setProtectionEnabled((current) => !current)}
          ><i /></button>
        </header>

        {protectionEnabled && (
          <>
            <div className="protection-toolbar">
              <div>{(['PRICE', 'ROI', 'PNL'] as const).map((value) => <button type="button" className={protectionMode === value ? 'active' : ''} onClick={() => setProtectionMode(value)} key={value}>{value === 'PRICE' ? 'Price' : value === 'ROI' ? 'ROI%' : 'P&L'}</button>)}</div>
              <label><span>Trigger by</span><select value={protectionSource} onChange={(event) => setProtectionSource(event.target.value as ProtectionWorkingType)}>{!markPriceOnly && <option value="CONTRACT_PRICE">Last price</option>}<option value="MARK_PRICE">Mark price</option></select></label>
            </div>

            <div className="protection-fields">
              <article className={`protection-leg take-profit ${takeProfitEnabled ? 'active' : 'inactive'}`}>
                <header><span><i />Take Profit</span><button className={`ui-switch ${takeProfitEnabled ? 'active' : ''}`} type="button" role="switch" aria-checked={takeProfitEnabled} aria-label="Take Profit" onClick={() => setTakeProfitEnabled((current) => !current)}><i /></button></header>
                <div className="protection-leg-grid">
                  <label><span>{protectionInputLabel}</span><div><input className="number-clean" inputMode="decimal" disabled={!takeProfitEnabled} value={takeProfit} onChange={(event) => setTakeProfit(event.target.value)} placeholder="Optional" /><strong>{protectionUnit}</strong></div></label>
                  <span><small>Expected profit</small><strong>{expectedProfit > 0 ? `+${format(expectedProfit)} ${marginAsset}` : '—'}</strong></span>
                  <span><small>Distance</small><strong>{takeProfitDistance > 0 ? `+${format(takeProfitDistance, 2)}%` : '—'}</strong></span>
                </div>
                {protectionMode !== 'PRICE' && activeTpPrice > 0 && <footer>Trigger ≈ {format(activeTpPrice, 8)} {quoteAsset}</footer>}
              </article>

              <article className={`protection-leg stop-loss ${stopLossEnabled ? 'active' : 'inactive'}`}>
                <header>
                  <span><i />Stop Loss</span>
                  {protectionRequired && <em>Required by RM · max {risk.profile.fixedStopLoss.value}%</em>}
                  <button className={`ui-switch ${stopLossEnabled ? 'active' : ''}`} type="button" role="switch" aria-checked={stopLossEnabled} aria-label="Stop Loss" disabled={protectionRequired} onClick={() => setStopLossEnabled((current) => !current)}><i /></button>
                </header>
                <div className="protection-leg-grid">
                  <label><span>{protectionInputLabel}</span><div><input className="number-clean" inputMode="decimal" disabled={!stopLossEnabled} value={stopLoss} onChange={(event) => setStopLoss(event.target.value)} placeholder={protectionRequired ? 'Required' : 'Optional'} /><strong>{protectionUnit}</strong></div></label>
                  <span><small>{hyperliquid ? 'Estimated loss' : 'Maximum loss'}</small><strong>{expectedLoss > 0 ? `−${format(expectedLoss)} ${marginAsset}` : '—'}</strong></span>
                  <span><small>Account risk</small><strong>{accountRisk > 0 ? `${format(accountRisk, 2)}%` : '—'}</strong></span>
                </div>
                {protectionMode !== 'PRICE' && activeSlPrice > 0 && <footer>Trigger ≈ {format(activeSlPrice, 8)} {quoteAsset} · Distance {format(stopLossDistance, 2)}%</footer>}
              </article>
            </div>

            {protectionRequired && !activeSlPrice && <div className="protection-requirement"><AlertTriangle size={14} /> Enter a Stop Loss within {risk.profile.fixedStopLoss.value}% of entry.</div>}
            <div className="risk-reward-row"><span>Risk / Reward<strong>{expectedLoss > 0 && expectedProfit > 0 ? `1 : ${(expectedProfit / expectedLoss).toFixed(2)}` : '—'}</strong></span><span>{hyperliquid ? 'Protection requested' : 'Position protected'}<strong>{activeTpPrice > 0 || activeSlPrice > 0 ? '100%' : '—'}</strong></span></div>
            <button className={`protection-advanced-toggle ${protectionAdvancedOpen ? 'open' : ''}`} type="button" onClick={() => setProtectionAdvancedOpen((current) => !current)} aria-expanded={protectionAdvancedOpen}>
              <span><ChevronDown size={14} /> Advanced settings</span><small>{protectionSource === 'MARK_PRICE' ? 'Mark price' : 'Last price'} · {protectionExecution === 'MARKET' ? 'Market execution' : 'Limit execution'}</small>
            </button>
            {protectionAdvancedOpen && (
              <div className="protection-advanced">
                <div className="protection-execution"><span>Execution</span><div><button type="button" className={protectionExecution === 'MARKET' ? 'active' : ''} onClick={() => setProtectionExecution('MARKET')}>Market</button><button type="button" className={protectionExecution === 'LIMIT' ? 'active' : ''} onClick={() => setProtectionExecution('LIMIT')}>Limit</button></div></div>
                {protectionExecution === 'LIMIT' && <div className="protection-limit-fields"><input className="number-clean" inputMode="decimal" value={takeProfitLimit} onChange={(event) => setTakeProfitLimit(event.target.value)} placeholder="TP limit price" /><input className="number-clean" inputMode="decimal" value={stopLossLimit} onChange={(event) => setStopLossLimit(event.target.value)} placeholder="SL limit price" /></div>}
                <div className="attached-protection-note"><Info size={13} /> {hyperliquid ? 'Native reduce-only TP/SL requested; confirm each provider order after execution.' : 'BingX attached TP/SL protects 100% of this new order.'}</div>
              </div>
            )}
          </>
        )}
      </section>

      {(formError || exchangeError) && <div className="order-error">{formError || exchangeError}</div>}
      <div className={`pretrade-risk-status ${riskGuardState.tone}`}>
        <ShieldCheck size={16} />
        <span><strong>{riskGuardState.title}</strong><small>{riskGuardState.detail}</small></span>
        {(hyperliquid || risk.runtime.blocked) && <button type="button" onClick={onOpenRiskManagement}>{hyperliquid ? 'Open Protection' : 'Review rules'}</button>}
      </div>
      <button className={`place-order ${direction === 'LONG' ? 'buy' : 'sell'}`} type="button" onClick={submit} disabled={ctaDisabled}>{ctaLabel}</button>
      {!exchange.connected && <div className="order-connect-hint">{hyperliquid ? 'Link the master EOA above to review a wallet-signed testnet order' : 'Connect BingX above to execute this order'}</div>}
      {exchange.connected && <div className="execution-note">{instrumentSupported ? `Chart: ${MARKET_DATA_LABELS[marketDataExchange]} Perpetual · Execution: ${venueLabel} ${symbol} ${kind[0]}${kind.slice(1).toLowerCase()} · Max ${maximumLeverage}x` : `${symbol} is available for charting but not for ${venueName} API execution`}</div>}
      {toast && <div className="demo-toast"><Zap size={14} /> {toast}</div>}

      {marginModalOpen && <MarginModeModal venue={venue} exchange={exchange} settings={settings} status={status} positions={positions} openOrders={openOrders} symbol={symbol} localMarginType={localMarginType} onLocalChange={setLocalMarginType} onChangeMarginType={onChangeMarginType} onClose={() => setMarginModalOpen(false)} />}
      {leverageModalOpen && <LeverageModal venue={venue} exchange={exchange} settings={settings} status={status} direction={direction} localLeverage={localLeverage} onLocalChange={setLocalLeverage} onChangeLeverage={onChangeLeverage} onClose={() => setLeverageModalOpen(false)} />}
      {preview && <OrderConfirmationModal venue={venue} exchange={exchange} response={preview} status={status} onCancel={() => { setPreview(null); setPreviewInput(null) }} onConfirm={confirmOrder} onRefresh={refreshOrderPreview} />}
    </aside>
  )
}
