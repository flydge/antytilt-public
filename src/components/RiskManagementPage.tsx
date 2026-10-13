import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion, useDragControls, useMotionValue, useReducedMotion, useTransform } from 'framer-motion'
import {
  Activity, AlertTriangle, ArrowLeft, Ban, Check, CheckCircle2, ChevronDown, ChevronLeft,
  ChevronRight, Clock3, Gauge, Info, Layers3, LockKeyhole, Pause, RefreshCw,
  RotateCcw, Settings2, ShieldCheck, Target, Undo2, X, type LucideIcon,
} from 'lucide-react'
import { defaultRiskProfile, useRiskProfile } from '../hooks/useRiskProfile'
import type {
  BreakEvenRiskRule, DailyLossRiskRule, FixedStopRiskRule, RiskBreachAction,
  RiskProfile, RiskRuntimeStatus, RiskValueRule,
} from '../types'

type ValueRuleKey = 'riskPerTrade' | 'maxLeverage' | 'maxTradesPerDay' | 'maxConsecutiveLosses'
  | 'cooldownMinutes' | 'maxExposurePercent' | 'maxOpenPositions'
type RuleKey = ValueRuleKey | 'fixedStopLoss' | 'dailyLossLimit' | 'breakEven'
type SwipeDirection = 'left' | 'right'

const ruleArtwork: Record<string, string> = {
  'sprite-0': '/assets/risk-management/protective-stop.png',
  'sprite-1': '/assets/risk-management/break-even.png',
  'sprite-2': '/assets/risk-management/trade-risk.png',
  'sprite-3': '/assets/risk-management/daily-loss.png',
  'sprite-4': '/assets/risk-management/leverage.png',
  'sprite-5': '/assets/risk-management/daily-trades.png',
  'sprite-6': '/assets/risk-management/loss-cooldown.png',
  'sprite-7': '/assets/risk-management/exposure-positions.png',
}

type RuleDefinition = {
  key: ValueRuleKey
  eyebrow: string
  title: string
  shortTitle: string
  description: string
  unit: string
  presets: number[]
  minimum: number
  maximum: number
  step: number
  sprite: string
  icon: LucideIcon
  consequence: string
  terminalEffect: string
  externalEffect: string
  details: string[]
}

type DeckItem = {
  key: RuleKey
  eyebrow: string
  title: string
  shortTitle: string
  sprite: string
  icon: LucideIcon
  description: string
  terminalEffect: string
  externalEffect: string
  details: string[]
}

const rules: RuleDefinition[] = [
  {
    key: 'riskPerTrade', eyebrow: 'Capital protection', title: 'Risk per Trade', shortTitle: 'Risk per trade',
    description: 'Limits the estimated loss at Stop Loss for one position to a percentage of account equity.', unit: '% equity', presets: [0.5, 1, 2],
    minimum: 0.1, maximum: 10, step: 0.1, sprite: 'sprite-2', icon: Activity,
    consequence: 'Order size, entry price and the full-size Stop Loss are checked together before execution.',
    terminalEffect: 'Position size is rejected above the selected equity risk.',
    externalEffect: 'External positions are checked against a full-size Stop Loss and can be closed on breach.',
    details: [
      'Estimated risk = distance from entry to Stop Loss × position quantity, divided by current account equity.',
      'A full-size Stop Loss is required. AntyTILT rejects an order when the calculated risk is above your limit.',
      'Direct exchange positions are checked by the worker. Close violation plus automation consent can close a position that is unprotected or over the limit.',
    ],
  },
  {
    key: 'maxLeverage', eyebrow: 'Leverage control', title: 'Maximum Leverage', shortTitle: 'Maximum leverage',
    description: 'Prevents a position from using leverage above your personal limit.', unit: 'x', presets: [5, 10, 20],
    minimum: 1, maximum: 250, step: 1, sprite: 'sprite-4', icon: Gauge,
    consequence: 'The exchange may require additional margin when leverage is reduced on an open position.',
    terminalEffect: 'Leverage above the selected ceiling is blocked.',
    externalEffect: 'Monitored leverage can be reduced when automation is authorized.',
    details: [
      'AntyTILT checks the requested leverage immediately before an order is sent to the exchange.',
      'If a monitored position uses higher leverage, the worker can lower it to your limit when the selected breach action and automation consent allow it.',
      'This personal ceiling never overrides a lower maximum imposed by the exchange or the selected contract.',
    ],
  },
  {
    key: 'maxTradesPerDay', eyebrow: 'Discipline', title: 'Trades per Day', shortTitle: 'Trades per day',
    description: 'Limits how many new positions may be opened during one trading day.', unit: 'trades', presets: [1, 3, 5],
    minimum: 1, maximum: 100, step: 1, sprite: 'sprite-5', icon: Activity,
    consequence: 'New position entries count; scale-ins and reduce-only orders do not.',
    terminalEffect: 'The next new entry is blocked before reaching BingX.',
    externalEffect: 'A direct BingX entry above the daily limit is detected and closed when bypass protection is authorized.',
    details: [
      'The counter increases only when a new symbol-and-side position is opened. Adding to an existing position does not use another trade.',
      'The counter resets at midnight in the timezone selected in this Risk Management profile.',
      'Orders from AntyTILT are blocked before BingX. A direct BingX entry above the limit is closed by the worker when bypass protection and automation consent are enabled.',
    ],
  },
  {
    key: 'maxConsecutiveLosses', eyebrow: 'Tilt protection', title: 'Consecutive Losses', shortTitle: 'Consecutive losses',
    description: 'Pauses new entries after the selected number of losing closes in a row.', unit: 'losses', presets: [2, 3, 4],
    minimum: 1, maximum: 20, step: 1, sprite: 'sprite-6', icon: AlertTriangle,
    consequence: 'A winning close resets the streak; a break-even close leaves it unchanged.',
    terminalEffect: 'New entries are blocked after the selected losing streak.',
    externalEffect: 'BingX close history is synchronized and evaluated by the worker.',
    details: [
      'The worker reads BingX closing orders for the current trading day and evaluates realized P&L after reported fees.',
      'Each loss adds one; a win resets the count to zero; a break-even result does not change it. Duplicate orders are ignored.',
      'Without Trading Cooldown, the lock lasts until the daily reset. With Cooldown enabled, the configured timer controls when entries resume.',
    ],
  },
  {
    key: 'cooldownMinutes', eyebrow: 'Recovery window', title: 'Trading Cooldown', shortTitle: 'Cooldown',
    description: 'Sets how long trading stays locked after the consecutive-loss limit is reached.', unit: 'minutes', presets: [15, 30, 60],
    minimum: 1, maximum: 1_440, step: 1, sprite: 'sprite-6', icon: Clock3,
    consequence: 'Trading Cooldown works only together with the Consecutive Losses rule.',
    terminalEffect: 'New entries stay blocked for the configured recovery window.',
    externalEffect: 'The worker keeps the cooldown state after restarts.',
    details: [
      'The timer starts when synchronized BingX history reaches your Consecutive Losses threshold.',
      'The lock is stored on the server, so closing the browser or restarting the worker does not remove it.',
      'When the timer expires, new entries are allowed again. A later qualifying loss can start or extend another cooldown.',
    ],
  },
  {
    key: 'maxExposurePercent', eyebrow: 'Portfolio risk', title: 'Maximum Exposure', shortTitle: 'Exposure',
    description: 'Limits the total notional value of all open positions relative to account equity.', unit: '% equity', presets: [50, 100, 200],
    minimum: 1, maximum: 1_000, step: 1, sprite: 'sprite-7', icon: Gauge,
    consequence: 'Projected exposure includes current positions and the full notional value of the new order.',
    terminalEffect: 'An entry is blocked when projected exposure exceeds the ceiling.',
    externalEffect: 'Excess exposure can be trimmed under the selected breach action.',
    details: [
      'Exposure is calculated as total open-position notional divided by current account equity.',
      'AntyTILT checks projected exposure before every new entry or scale-in. Reduce-only orders remain available.',
      'For an external breach, Close violation can reduce only the excess quantity; other selected breach actions may cancel entries or close all positions.',
    ],
  },
  {
    key: 'maxOpenPositions', eyebrow: 'Portfolio control', title: 'Open Positions', shortTitle: 'Open positions',
    description: 'Limits how many LONG and SHORT position legs may remain open at once.', unit: 'positions', presets: [2, 3, 5],
    minimum: 1, maximum: 50, step: 1, sprite: 'sprite-7', icon: Layers3,
    consequence: 'In Hedge Mode, LONG and SHORT on the same symbol count as two positions.',
    terminalEffect: 'A new market is blocked when the position limit is full.',
    externalEffect: 'A newly detected external position above the limit can be closed automatically.',
    details: [
      'Each open symbol-and-side leg counts once. LONG and SHORT are counted separately in Hedge Mode.',
      'When the limit is full, AntyTILT blocks only new position legs. Scale-ins and reduce-only orders remain available.',
      'A newly detected direct exchange position above the limit can be closed when Close violation and automation consent are selected.',
    ],
  },
]

const deck: DeckItem[] = [
  {
    key: 'fixedStopLoss', eyebrow: 'Position protection', title: 'Protective Stop Loss', shortTitle: 'Protective stop',
    sprite: 'sprite-0', icon: ShieldCheck,
    description: 'Requires a Stop Loss and keeps the full position protected within your maximum distance.',
    terminalEffect: 'An active protective rule requires a valid Stop Loss at entry.',
    externalEffect: 'The RM worker maintains a full-size protective stop on BingX.',
    details: [
      'Every AntyTILT entry must include a Stop Loss on the correct side of entry and no farther away than your selected percentage.',
      'The worker keeps one full-size protective stop synchronized after scale-ins or partial closes. A tighter manual stop is preserved.',
      'If protection cannot be restored after the market has crossed the required stop level, the worker closes the position when live automation is available.',
    ],
  },
  {
    key: 'breakEven', eyebrow: 'Position automation', title: 'Persistent Break-even', shortTitle: 'Break-even',
    sprite: 'sprite-1', icon: Target,
    description: 'Moves the Stop Loss to entry after the position reaches your selected profit trigger.',
    terminalEffect: 'The position is registered for persistent break-even monitoring.',
    externalEffect: 'The RM worker moves the stop to entry after the trigger.',
    details: [
      'Profit % measures favorable movement from average entry. R multiple compares that movement with the Protective Stop distance and requires that rule to be enabled.',
      'After the trigger, the stop moves to entry plus your offset. The trigger stays latched even if price retraces or the worker restarts.',
      'The worker continues maintaining the break-even stop after position-size or average-entry changes.',
    ],
  },
  {
    key: 'dailyLossLimit', eyebrow: 'Account protection', title: 'Daily Loss Limit', shortTitle: 'Daily loss',
    sprite: 'sprite-3', icon: Activity,
    description: 'Stops new entries after account equity falls by the amount or percentage you set.',
    terminalEffect: 'New entries are blocked after the daily equity loss is reached.',
    externalEffect: 'A new direct BingX entry after the loss limit is detected and closed when authorized.',
    details: [
      'The daily baseline is the first valid account equity recorded for the trading day in your selected timezone.',
      'The rule compares current equity with that baseline, so both realized results and open-position P&L can affect the measured loss.',
      'AntyTILT blocks new entries immediately. A new direct BingX entry is closed when bypass protection and automation consent are enabled.',
    ],
  },
  ...rules,
]

const breachOptions: Array<{
  value: RiskBreachAction
  title: string
  description: string
  icon: LucideIcon
  destructive: boolean
}> = [
  { value: 'BLOCK_NEW_ENTRIES', title: 'Block new entries', description: 'Prevent opening any new positions.', icon: Ban, destructive: false },
  { value: 'CANCEL_PENDING_ORDERS', title: 'Cancel pending orders', description: 'Cancel all resting entry orders.', icon: Clock3, destructive: true },
  { value: 'CLOSE_VIOLATING_POSITION', title: 'Close violating position', description: 'Close only the position that triggered the rule.', icon: Target, destructive: true },
  { value: 'CLOSE_ALL', title: 'Close all positions', description: 'Cancel entries and close every open position.', icon: AlertTriangle, destructive: true },
]

const commonTimezones = ['UTC', 'Europe/Warsaw', 'Europe/London', 'America/New_York', 'America/Chicago', 'Asia/Dubai', 'Asia/Singapore']

function availableTimezones() {
  const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return [...new Set([browserTimezone, ...commonTimezones].filter(Boolean))]
}

function isEnabled(profile: RiskProfile, key: RuleKey) {
  return profile[key].enabled
}

function withEnabled(profile: RiskProfile, key: RuleKey, enabled: boolean): RiskProfile {
  return { ...profile, [key]: { ...profile[key], enabled } }
}

function enabledCount(profile: RiskProfile) {
  return deck.filter((item) => isEnabled(profile, item.key)).length
}

function ruleValue(profile: RiskProfile, key: RuleKey) {
  if (key === 'fixedStopLoss') return `${profile.fixedStopLoss.value}%`
  if (key === 'breakEven') return `${profile.breakEven.triggerValue}${profile.breakEven.triggerMode === 'R_MULTIPLE' ? 'R' : '%'}`
  if (key === 'dailyLossLimit') return `${profile.dailyLossLimit.value}${profile.dailyLossLimit.unit === 'USDT' ? ' USDT' : '%'}`
  const value = profile[key].value
  if (key === 'riskPerTrade' || key === 'maxExposurePercent') return `${value}%`
  if (key === 'maxLeverage') return `${value}x`
  if (key === 'cooldownMinutes') return `${value} min`
  return String(value)
}

function formatMoney(value: number | undefined) {
  if (value === undefined) return '—'
  const sign = value > 0 ? '+' : value < 0 ? '−' : ''
  return `${sign}$${Math.abs(value).toFixed(2)}`
}

function formatCountdown(timestamp: number | undefined) {
  if (!timestamp) return '—'
  const minutes = Math.max(0, Math.ceil((timestamp - Date.now()) / 60_000))
  const hours = Math.floor(minutes / 60)
  return `${String(hours).padStart(2, '0')}h ${String(minutes % 60).padStart(2, '0')}m`
}

function workerLabel(runtime: RiskRuntimeStatus) {
  if (runtime.workerStatus === 'DISCONNECTED') return 'Exchange disconnected'
  if (runtime.workerStatus === 'ERROR') return runtime.lastError ? 'Monitoring error' : 'Monitoring unavailable'
  if (runtime.workerStatus === 'STALE') return 'Waiting for synchronization'
  if (runtime.workerStatus === 'RUNNING') {
    if (!runtime.lastCheckedAt) return 'Monitoring active'
    const seconds = Math.max(0, Math.round((Date.now() - runtime.lastCheckedAt) / 1_000))
    return `Monitoring active · checked ${seconds}s ago`
  }
  return 'Monitoring ready'
}

function PresetButtons({ values, selected, unit, onSelect }: { values: number[]; selected: number; unit: string; onSelect: (value: number) => void }) {
  const label = (value: number) => unit === 'x' ? `${value}x` : unit.includes('%') ? `${value}%` : unit === 'USDT' ? `${value} USDT` : String(value)
  return (
    <div className="rm2-presets">
      {values.map((value) => <button type="button" className={selected === value ? 'selected' : ''} onClick={() => onSelect(value)} key={value}>{label(value)}</button>)}
      <span>Custom</span>
    </div>
  )
}

function NumberField({ label, value, minimum, maximum, step, unit, onChange }: {
  label: string
  value: number
  minimum: number
  maximum: number
  step: number
  unit: string
  onChange: (value: number) => void
}) {
  const update = (next: number) => onChange(Math.min(maximum, Math.max(minimum, Number(next.toFixed(8)))))
  return (
    <label className="rm2-number-field">
      <span>{label}</span>
      <div>
        <input type="number" min={minimum} max={maximum} step={step} value={value} onChange={(event) => update(Number(event.target.value) || minimum)} />
        <strong>{unit}</strong>
        <button type="button" onClick={() => update(value - step)} aria-label={`Decrease ${label}`}>−</button>
        <button type="button" onClick={() => update(value + step)} aria-label={`Increase ${label}`}>+</button>
      </div>
    </label>
  )
}

function ValueRuleEditor({ definition, value, onChange }: { definition: RuleDefinition; value: RiskValueRule; onChange: (value: RiskValueRule) => void }) {
  return (
    <>
      <div className="rm2-editor-heading"><span>{definition.eyebrow}</span><h2>{definition.title}</h2><p>{definition.description}</p></div>
      <PresetButtons values={definition.presets} selected={value.value} unit={definition.unit} onSelect={(next) => onChange({ ...value, value: next })} />
      <NumberField label="Rule value" value={value.value} minimum={definition.minimum} maximum={definition.maximum} step={definition.step} unit={definition.unit} onChange={(next) => onChange({ ...value, value: next })} />
      <footer><Info size={15} /><span>{definition.consequence}</span></footer>
    </>
  )
}

function FixedStopEditor({ value, onChange }: { value: FixedStopRiskRule; onChange: (value: FixedStopRiskRule) => void }) {
  return (
    <>
      <div className="rm2-editor-heading"><span>Position protection</span><h2>Protective Stop Loss</h2><p>Requires a Stop Loss and keeps the full position protected within your maximum distance.</p></div>
      <PresetButtons values={[1, 2, 3]} selected={value.value} unit="%" onSelect={(next) => onChange({ ...value, value: next })} />
      <div className="rm2-dual-fields">
        <NumberField label="Maximum distance" value={value.value} minimum={0.1} maximum={25} step={0.1} unit="%" onChange={(next) => onChange({ ...value, value: next })} />
        <label className="rm2-select-field"><span>Trigger price</span><select value={value.workingType} onChange={(event) => onChange({ ...value, workingType: event.target.value as FixedStopRiskRule['workingType'] })}><option value="MARK_PRICE">Mark Price</option><option value="CONTRACT_PRICE">Last Price</option></select></label>
      </div>
      <footer><Info size={15} /><span>A tighter manual stop is preserved. If price crosses an unprotected stop, the position is closed.</span></footer>
    </>
  )
}

function DailyLossEditor({ value, onChange }: { value: DailyLossRiskRule; onChange: (value: DailyLossRiskRule) => void }) {
  const isUsdt = value.unit === 'USDT'
  const minimum = isUsdt ? 1 : 0.1
  const maximum = isUsdt ? 1_000_000 : 100
  return (
    <>
      <div className="rm2-editor-heading"><span>Account protection</span><h2>Daily Loss Limit</h2><p>Stops new entries after account equity falls by the amount or percentage you set.</p></div>
      <div className="rm2-mode-switch"><button type="button" className={!isUsdt ? 'selected' : ''} onClick={() => onChange({ ...value, unit: 'PERCENT', value: 3 })}>% of equity</button><button type="button" className={isUsdt ? 'selected' : ''} onClick={() => onChange({ ...value, unit: 'USDT', value: 100 })}>USDT amount</button></div>
      <PresetButtons values={isUsdt ? [10, 50, 100] : [2, 3, 5]} selected={value.value} unit={isUsdt ? 'USDT' : '%'} onSelect={(next) => onChange({ ...value, value: next })} />
      <NumberField label="Maximum daily loss" value={value.value} minimum={minimum} maximum={maximum} step={isUsdt ? 1 : 0.1} unit={isUsdt ? 'USDT' : '%'} onChange={(next) => onChange({ ...value, value: next })} />
      <footer><Info size={15} /><span>The baseline is captured for your selected trading day and is reset safely when the connected account changes.</span></footer>
    </>
  )
}

function BreakEvenEditor({ value, onChange, fixedStopEnabled }: { value: BreakEvenRiskRule; onChange: (value: BreakEvenRiskRule) => void; fixedStopEnabled: boolean }) {
  const isPercent = value.triggerMode === 'PERCENT'
  return (
    <>
      <div className="rm2-editor-heading"><span>Position automation</span><h2>Persistent Break-even</h2><p>Moves the Stop Loss to entry after the position reaches your selected profit trigger.</p></div>
      <div className="rm2-mode-switch"><button type="button" className={isPercent ? 'selected' : ''} onClick={() => onChange({ ...value, triggerMode: 'PERCENT' })}>Profit %</button><button type="button" className={!isPercent ? 'selected' : ''} onClick={() => onChange({ ...value, triggerMode: 'R_MULTIPLE' })}>R multiple</button></div>
      {!isPercent && !fixedStopEnabled && <div className="rm2-inline-warning"><AlertTriangle size={14} /> Enable Protective Stop Loss to define 1R.</div>}
      <PresetButtons values={isPercent ? [1, 2, 3] : [0.5, 1, 2]} selected={value.triggerValue} unit={isPercent ? '%' : 'R'} onSelect={(next) => onChange({ ...value, triggerValue: next })} />
      <div className="rm2-dual-fields">
        <NumberField label="Trigger at" value={value.triggerValue} minimum={0.1} maximum={50} step={0.1} unit={isPercent ? '%' : 'R'} onChange={(next) => onChange({ ...value, triggerValue: next })} />
        <NumberField label="Entry offset" value={value.offsetPercent} minimum={0} maximum={5} step={0.01} unit="%" onChange={(next) => onChange({ ...value, offsetPercent: next })} />
      </div>
      <footer><Info size={15} /><span>The latch survives retraces, service restarts and average-entry changes after scale-in.</span></footer>
    </>
  )
}

function SwipeCard({ item, index, enabled, exitDirection, onDecision, children }: {
  item: DeckItem
  index: number
  enabled: boolean
  exitDirection: SwipeDirection
  onDecision: (direction: SwipeDirection) => void
  children: ReactNode
}) {
  const x = useMotionValue(0)
  const rotate = useTransform(x, [-300, 0, 300], [-3, 0, 3])
  const artX = useTransform(x, [-300, 0, 300], [-7, 0, 7])
  const enableOpacity = useTransform(x, [28, 125], [0, 1])
  const disableOpacity = useTransform(x, [-125, -28], [1, 0])
  const dragControls = useDragControls()
  const reducedMotion = useReducedMotion()
  const helpRef = useRef<HTMLDivElement>(null)
  const [helpHovered, setHelpHovered] = useState(false)
  const [helpPinned, setHelpPinned] = useState(false)
  const helpOpen = helpHovered || helpPinned
  const helpId = `rm-rule-help-${item.key}`

  useEffect(() => {
    if (!helpPinned) return
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!helpRef.current?.contains(event.target as Node)) setHelpPinned(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setHelpPinned(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePress)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePress)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [helpPinned])

  return (
    <motion.article
      data-rule={item.key}
      className={`rm2-rule-card ${enabled ? 'enabled' : ''}`}
      custom={exitDirection}
      variants={{
        enter: (direction: SwipeDirection) => ({ opacity: 0.56, x: direction === 'right' ? -24 : 24, y: 15, scale: 0.978 }),
        center: { opacity: 1, x: 0, y: 0, scale: 1 },
        exit: (direction: SwipeDirection) => ({
          opacity: 0,
          x: direction === 'right' ? '108%' : '-108%',
          y: 5,
          scale: 0.986,
          transition: { duration: reducedMotion ? 0 : 0.32, ease: [0.32, 0.72, 0, 1] },
        }),
      }}
      initial={reducedMotion ? false : 'enter'}
      animate="center"
      exit="exit"
      transition={{ duration: reducedMotion ? 0 : 0.38, ease: [0.16, 1, 0.3, 1] }}
      drag="x"
      dragControls={dragControls}
      dragListener={false}
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={0.62}
      dragTransition={{ bounceStiffness: 470, bounceDamping: 32, power: 0.25, timeConstant: 180 }}
      whileDrag={reducedMotion ? undefined : { scale: 0.992, cursor: 'grabbing' }}
      style={{ x, rotate, touchAction: 'pan-y' }}
      onDragEnd={(_, info) => {
        const projected = info.offset.x + info.velocity.x * 0.12
        if (projected > 110) onDecision('right')
        else if (projected < -110) onDecision('left')
      }}
    >
      <div className={`rm-rule-visual rm2-card-art ${item.sprite}`} role="button" tabIndex={0} aria-label={`Swipe ${item.title} left to disable or right to enable`} onPointerDown={(event) => dragControls.start(event)}>
        <motion.img className="rm2-card-image" src={ruleArtwork[item.sprite]} alt="" aria-hidden="true" draggable={false} style={{ x: artX }} />
        <div className="rm2-card-topline">
          <span>{item.eyebrow}</span>
          <div className="rm2-card-actions">
            <i>{index + 1} / {deck.length}</i>
            <div
              ref={helpRef}
              className={`rm2-rule-help ${helpOpen ? 'open' : ''}`}
              onMouseEnter={() => setHelpHovered(true)}
              onMouseLeave={() => setHelpHovered(false)}
              onFocusCapture={() => setHelpHovered(true)}
              onBlurCapture={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHelpHovered(false)
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                className="rm2-rule-help-trigger"
                aria-label={`Explain ${item.title}`}
                aria-expanded={helpOpen}
                aria-controls={helpId}
                aria-describedby={helpOpen ? helpId : undefined}
                onClick={(event) => {
                  event.stopPropagation()
                  const next = !helpPinned
                  setHelpPinned(next)
                  if (!next) setHelpHovered(false)
                }}
              ><span aria-hidden="true">!</span></button>
              <AnimatePresence initial={false}>
                {helpOpen && (
                  <motion.div
                    id={helpId}
                    className="rm2-rule-tooltip"
                    role="tooltip"
                    initial={reducedMotion ? { opacity: 1 } : { opacity: 0, y: -9, scale: 0.94, filter: 'blur(5px)' }}
                    animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
                    exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -5, scale: 0.975, filter: 'blur(3px)' }}
                    transition={reducedMotion
                      ? { duration: 0.01 }
                      : { type: 'spring', stiffness: 430, damping: 31, mass: 0.72 }}
                  >
                    <motion.header
                      initial={reducedMotion ? false : { opacity: 0, y: -3 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: reducedMotion ? 0 : 0.035, duration: 0.18 }}
                    >
                      <small><ShieldCheck size={12} /> Rule guide</small>
                      <strong>{item.title}</strong>
                    </motion.header>
                    <motion.p
                      initial={reducedMotion ? false : { opacity: 0, y: 3 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: reducedMotion ? 0 : 0.065, duration: 0.2 }}
                    >{item.description}</motion.p>
                    <motion.ul
                      initial="hidden"
                      animate="shown"
                      variants={{
                        hidden: {},
                        shown: { transition: { delayChildren: reducedMotion ? 0 : 0.09, staggerChildren: reducedMotion ? 0 : 0.045 } },
                      }}
                    >
                      {item.details.map((detail, detailIndex) => (
                        <motion.li
                          key={detail}
                          variants={{
                            hidden: reducedMotion ? { opacity: 1 } : { opacity: 0, x: 7 },
                            shown: { opacity: 1, x: 0, transition: { duration: reducedMotion ? 0 : 0.18, ease: 'easeOut' } },
                          }}
                        ><b>{detailIndex + 1}</b><span>{detail}</span></motion.li>
                      ))}
                    </motion.ul>
                    <motion.footer
                      initial={reducedMotion ? false : { opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: reducedMotion ? 0 : 0.22, duration: 0.18 }}
                    ><LockKeyhole size={11} /> Enforced by the server when this rule is enabled</motion.footer>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>
        <motion.div className="rm2-swipe-intent enable" style={{ opacity: enableOpacity }}><Check size={15} /> Enable</motion.div>
        <motion.div className="rm2-swipe-intent disable" style={{ opacity: disableOpacity }}><Ban size={14} /> Disable</motion.div>
        <div className={`rm2-draft-state ${enabled ? 'enabled' : ''}`}>{enabled ? <><Check size={13} /> Enabled</> : 'Disabled'}</div>
      </div>
      <div className="rm2-rule-content">{children}</div>
    </motion.article>
  )
}

function DeckPreview({ item, depth }: { item: DeckItem; depth: number }) {
  const reducedMotion = useReducedMotion()
  const state = depth === 1
    ? { opacity: 0.8, y: 8, scale: 0.982 }
    : { opacity: 0.48, y: 0, scale: 0.962 }
  return <motion.div
    className={`rm2-deck-preview depth-${depth}`}
    aria-hidden="true"
    initial={false}
    animate={state}
    transition={reducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 310, damping: 30, mass: 0.8 }}
  ><div className={`rm-rule-visual ${item.sprite}`}><img className="rm2-card-image" src={ruleArtwork[item.sprite]} alt="" draggable={false} /></div></motion.div>
}

function RuntimeMetric({ icon: Icon, label, value, tone }: { icon: LucideIcon; label: string; value: string; tone?: string }) {
  return <div className={`rm2-metric ${tone || ''}`}><Icon size={20} /><span>{label}</span><strong>{value}</strong></div>
}

function LegacyRiskManagementPage({ onBackToTrade }: { onBackToTrade: () => void }) {
  const risk = useRiskProfile()
  const [draft, setDraft] = useState<RiskProfile>(defaultRiskProfile)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [decisionHistory, setDecisionHistory] = useState<Array<{ index: number; key: RuleKey; previousEnabled: boolean; direction: SwipeDirection }>>([])
  const [exitDirection, setExitDirection] = useState<SwipeDirection>('right')
  const [isTransitioning, setIsTransitioning] = useState(false)
  const [savedNotice, setSavedNotice] = useState(false)
  const transitionLockRef = useRef(false)

  useEffect(() => setDraft(risk.profile), [risk.profile])
  useEffect(() => {
    Object.values(ruleArtwork).forEach((source) => {
      const image = new Image()
      image.decoding = 'async'
      image.src = source
    })
  }, [])
  const dirty = useMemo(() => JSON.stringify({ ...draft, updatedAt: 0 }) !== JSON.stringify({ ...risk.profile, updatedAt: 0 }), [draft, risk.profile])
  const modifiedRuleCount = useMemo(() => deck.filter((item) => JSON.stringify(draft[item.key]) !== JSON.stringify(risk.profile[item.key])).length, [draft, risk.profile])
  const auxiliarySettingsChanged = draft.timezone !== risk.profile.timezone
    || draft.breachAction !== risk.profile.breachAction
    || draft.externalViolationPolicy !== risk.profile.externalViolationPolicy
    || draft.closeExternalEntriesOnBreach !== risk.profile.closeExternalEntriesOnBreach
    || draft.automationConsent !== risk.profile.automationConsent
  const modificationCount = Math.max(1, modifiedRuleCount + (auxiliarySettingsChanged ? 1 : 0))
  const current = deck[currentIndex]
  const count = enabledCount(draft)
  const bypassRulesEnabled = draft.maxTradesPerDay.enabled || draft.dailyLossLimit.enabled
  const externalBypassSelected = bypassRulesEnabled && draft.closeExternalEntriesOnBreach
  const automationSelected = draft.breachAction !== 'BLOCK_NEW_ENTRIES' || externalBypassSelected
  const automationReady = !automationSelected || draft.automationConsent
  const rMultipleReady = !(draft.breakEven.enabled && draft.breakEven.triggerMode === 'R_MULTIPLE') || draft.fixedStopLoss.enabled
  const cooldownReady = !draft.cooldownMinutes.enabled || draft.maxConsecutiveLosses.enabled
  const canActivate = count > 0 && automationReady && rMultipleReady && cooldownReady
  const canSaveAndActivate = canActivate && (dirty || !draft.active)
  const progress = (currentIndex + 1) / deck.length * 100

  const beginTransition = () => {
    if (transitionLockRef.current) return false
    transitionLockRef.current = true
    setIsTransitioning(true)
    return true
  }

  const finishTransition = () => {
    transitionLockRef.current = false
    setIsTransitioning(false)
  }

  const decide = (direction: SwipeDirection) => {
    if (!beginTransition()) return
    const item = deck[currentIndex]
    setExitDirection(direction)
    setDecisionHistory((history) => [...history, { index: currentIndex, key: item.key, previousEnabled: isEnabled(draft, item.key), direction }])
    setDraft((profile) => withEnabled(profile, item.key, direction === 'right'))
    setCurrentIndex((index) => (index + 1) % deck.length)
  }

  const undo = () => {
    const previous = decisionHistory[decisionHistory.length - 1]
    if (!previous || !beginTransition()) return
    setExitDirection(previous.direction === 'right' ? 'left' : 'right')
    setDraft((profile) => withEnabled(profile, previous.key, previous.previousEnabled))
    setCurrentIndex(previous.index)
    setDecisionHistory((history) => history.slice(0, -1))
  }

  const navigateTo = (index: number) => {
    if (index === currentIndex || !beginTransition()) return
    setExitDirection(index > currentIndex ? 'right' : 'left')
    setCurrentIndex(index)
  }

  const resetChanges = () => {
    setDraft(risk.profile)
    setDecisionHistory([])
  }

  const selectBreachAction = (breachAction: RiskBreachAction) => setDraft((profile) => ({
    ...profile,
    breachAction,
    externalViolationPolicy: breachAction === 'CLOSE_VIOLATING_POSITION' || breachAction === 'CLOSE_ALL' ? 'BLOCK_AND_CLOSE_EXTERNAL' : 'BLOCK_NEW_ENTRIES',
    automationConsent: breachAction === 'BLOCK_NEW_ENTRIES'
      && !(profile.closeExternalEntriesOnBreach && (profile.maxTradesPerDay.enabled || profile.dailyLossLimit.enabled))
      ? false
      : profile.automationConsent,
  }))

  const save = async (active = true) => {
    if (active && !canActivate) return
    try {
      const stored = await risk.save({ ...draft, active })
      setDraft(stored)
      setDecisionHistory([])
      setSavedNotice(true)
      window.setTimeout(() => setSavedNotice(false), 3_000)
    } catch {
      // The hook exposes the actionable API error below the workspace.
    }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('input, select, textarea, button, [contenteditable="true"]')) return
      if (event.key === 'ArrowLeft') decide('left')
      if (event.key === 'ArrowRight') decide('right')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  const valueRule = rules.find((rule) => rule.key === current.key)
  const nextCards = [2, 1].map((offset) => deck[(currentIndex + offset) % deck.length])
  const currentUsesBypassProtection = current.key === 'maxTradesPerDay' || current.key === 'dailyLossLimit'
  const externalBadge = currentUsesBypassProtection && externalBypassSelected && draft.automationConsent
      ? 'Bypass entry auto-closes'
      : current.key === 'fixedStopLoss' || current.key === 'breakEven'
      ? risk.runtime.liveAutomationEnabled === false ? 'Live automation unavailable' : 'Managed by RM worker'
      : automationSelected && draft.automationConsent
        ? 'Action within ~5 seconds'
        : 'Monitoring only'
  const pnlTone = risk.runtime.dailyPnl === undefined ? undefined : risk.runtime.dailyPnl > 0 ? 'positive' : risk.runtime.dailyPnl < 0 ? 'negative' : undefined
  const tradeLimit = risk.runtime.tradeLimit ?? (draft.maxTradesPerDay.enabled ? draft.maxTradesPerDay.value : undefined)
  const tradesTone = risk.runtime.tradesUsed !== undefined && tradeLimit !== undefined
    ? risk.runtime.tradesUsed > tradeLimit ? 'negative' : risk.runtime.tradesUsed === tradeLimit ? 'warning' : undefined
    : undefined
  const positionLimit = draft.maxOpenPositions.enabled ? draft.maxOpenPositions.value : undefined
  const positionsTone = risk.runtime.openPositions !== undefined && positionLimit !== undefined
    ? risk.runtime.openPositions > positionLimit ? 'negative' : risk.runtime.openPositions === positionLimit ? 'warning' : undefined
    : undefined

  return (
    <main className="rm2-page">
      <div className="rm2-shell">
        <header className="rm2-header">
          <div className="rm2-title-block">
            <button type="button" className="rm2-back" onClick={onBackToTrade} aria-label="Back to terminal"><ArrowLeft size={18} /></button>
            <div><h1>Risk Management</h1><p>Personal rules enforced by the server</p></div>
            <span className={`rm2-monitor ${risk.runtime.workerStatus === 'ERROR' ? 'error' : risk.runtime.workerStatus === 'DISCONNECTED' ? 'offline' : ''}`}><i />{workerLabel(risk.runtime)}</span>
          </div>
          <div className="rm2-header-actions">
            {draft.active && <button type="button" className="rm2-pause" disabled={risk.status === 'saving'} onClick={() => void save(false)}><Pause size={16} /> Pause policy</button>}
            {!dirty && (draft.active
              ? <span className="rm2-active-policy"><ShieldCheck size={16} /> Policy active</span>
              : <button type="button" className="rm2-primary" disabled={risk.status === 'saving' || !canSaveAndActivate} onClick={() => void save(true)}>{risk.status === 'saving' ? <span className="button-spinner" /> : <LockKeyhole size={16} />}Save &amp; activate</button>)}
          </div>
        </header>

        <section className="rm2-metrics" aria-label="Live risk status">
          <RuntimeMetric icon={Activity} label="Trades today" value={`${risk.runtime.tradesUsed ?? '—'} / ${tradeLimit ?? '—'}`} tone={tradesTone} />
          <RuntimeMetric icon={Gauge} label="Daily P&L" value={formatMoney(risk.runtime.dailyPnl)} tone={pnlTone} />
          <RuntimeMetric icon={Layers3} label="Open positions" value={`${risk.runtime.openPositions ?? '—'} / ${positionLimit ?? '—'}`} tone={positionsTone} />
          <RuntimeMetric icon={Clock3} label="Daily reset" value={formatCountdown(risk.runtime.nextResetAt)} />
        </section>

        {risk.status === 'loading' ? <div className="rm2-loading"><span className="button-spinner" /> Loading your risk profile…</div> : (
          <section className="rm2-workspace">
            <aside className="rm2-rule-nav">
              <header><div><h2>Rules</h2><span>{currentIndex + 1} of {deck.length}</span></div><strong>{count} enabled</strong></header>
              <div className="rm2-progress"><i style={{ width: `${progress}%` }} /></div>
              <nav>
                {deck.map((item, index) => {
                  const Icon = item.icon
                  const enabled = isEnabled(draft, item.key)
                  return (
                    <button type="button" className={index === currentIndex ? 'current' : ''} disabled={isTransitioning} onClick={() => navigateTo(index)} key={item.key}>
                      <Icon size={17} />
                      <span>{item.shortTitle}<small className={enabled ? 'enabled' : ''}>{enabled ? 'Enabled' : 'Disabled'}</small></span>
                      <strong>{ruleValue(draft, item.key)}</strong>
                      <ChevronRight size={15} />
                    </button>
                  )
                })}
              </nav>
              <button type="button" className="rm2-reset" disabled={!dirty} onClick={resetChanges}><RotateCcw size={14} /> Reset to saved</button>
            </aside>

            <div className="rm2-deck-column">
              <div className="rm2-deck-stage" aria-live="polite" aria-busy={isTransitioning}>
                {nextCards.map((item, index) => <DeckPreview key={item.key} item={item} depth={2 - index} />)}
                <AnimatePresence custom={exitDirection} mode="sync" initial={false} onExitComplete={finishTransition}>
                  <SwipeCard key={current.key} item={current} index={currentIndex} enabled={isEnabled(draft, current.key)} exitDirection={exitDirection} onDecision={decide}>
                    {current.key === 'fixedStopLoss'
                      ? <FixedStopEditor value={draft.fixedStopLoss} onChange={(fixedStopLoss) => setDraft((profile) => ({ ...profile, fixedStopLoss }))} />
                      : current.key === 'breakEven'
                        ? <BreakEvenEditor value={draft.breakEven} fixedStopEnabled={draft.fixedStopLoss.enabled} onChange={(breakEven) => setDraft((profile) => ({ ...profile, breakEven }))} />
                        : current.key === 'dailyLossLimit'
                          ? <DailyLossEditor value={draft.dailyLossLimit} onChange={(dailyLossLimit) => setDraft((profile) => ({ ...profile, dailyLossLimit }))} />
                          : <ValueRuleEditor definition={valueRule!} value={draft[current.key as ValueRuleKey]} onChange={(value) => setDraft((profile) => ({ ...profile, [current.key]: value }))} />}
                  </SwipeCard>
                </AnimatePresence>
              </div>
              <div className="rm2-swipe-actions">
                <button type="button" className="undo" disabled={!decisionHistory.length || isTransitioning} onClick={undo} aria-label="Undo previous swipe"><Undo2 size={19} /></button>
                <button type="button" className="disable" disabled={isTransitioning} onClick={() => decide('left')}><Ban size={18} /> Disable rule</button>
                <button type="button" className="enable" disabled={isTransitioning} onClick={() => decide('right')}><Check size={19} /> Enable rule</button>
              </div>
            </div>

            <aside className="rm2-inspector">
              <section className="rm2-panel rm2-enforcement-preview">
                <h2>Enforcement preview</h2>
                <div><span className="rm2-enforcement-icon terminal"><ShieldCheck size={18} /></span><p><strong>AntyTILT orders</strong><small>{current.terminalEffect}</small></p><i className="success">Pre-trade guard</i></div>
                <div><span className="rm2-enforcement-icon exchange"><RefreshCw size={18} /></span><p><strong>Direct BingX entries</strong><small>{current.externalEffect}</small></p><i className={externalBadge.includes('Action') || externalBadge.includes('Managed') ? 'warning' : ''}>{externalBadge}</i></div>
              </section>

              <section className="rm2-panel rm2-breach-panel">
                <h2>On breach</h2>
                <label className="rm2-consent rm2-bypass-protection">
                  <input
                    type="checkbox"
                    checked={draft.closeExternalEntriesOnBreach}
                    onChange={(event) => setDraft((profile) => ({
                      ...profile,
                      closeExternalEntriesOnBreach: event.target.checked,
                      automationConsent: event.target.checked ? profile.automationConsent : profile.breachAction === 'BLOCK_NEW_ENTRIES' ? false : profile.automationConsent,
                    }))}
                  />
                  <span>
                    <strong>Close direct exchange bypass entries</strong>
                    <small>If Trades per Day or Daily Loss already blocks entries, a new position opened directly on BingX is detected and closed.</small>
                  </span>
                </label>
                <div className="rm2-breach-options">
                  {breachOptions.map((option) => {
                    const Icon = option.icon
                    return <button type="button" aria-pressed={draft.breachAction === option.value} className={`${draft.breachAction === option.value ? 'selected' : ''} ${option.destructive ? 'danger' : ''}`} onClick={() => selectBreachAction(option.value)} key={option.value}><span><i>{draft.breachAction === option.value ? <Check size={13} /> : null}</i><Icon size={16} /></span><p><strong>{option.title}</strong><small>{option.description}</small></p></button>
                  })}
                </div>
                {automationSelected && <label className="rm2-consent"><input type="checkbox" checked={draft.automationConsent} onChange={(event) => setDraft((profile) => ({ ...profile, automationConsent: event.target.checked }))} /><span><strong>Automatic exchange actions authorized</strong><small>Market closes can have latency, fees and slippage.</small></span></label>}
                {!automationReady && <div className="rm2-validation"><AlertTriangle size={14} /> Consent is required before activation.</div>}
              </section>

              <section className="rm2-panel rm2-activity">
                <header><h2>Recent activity</h2><span>{risk.events.length}</span></header>
                {risk.events.length === 0 ? <p className="empty">No RM actions recorded.</p> : risk.events.slice(0, 3).map((event) => (
                  <div className="rm2-event" key={event.id}><i className={event.severity?.toLowerCase()} /><p><strong>{event.message}</strong><small>{event.rule || 'System'} · {new Date(event.createdAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</small></p><span>{event.outcome || 'OK'}</span></div>
                ))}
              </section>
            </aside>
          </section>
        )}

        {!rMultipleReady && <div className="rm2-page-warning"><AlertTriangle size={15} /> Enable Protective Stop Loss or change Break-even to Profit %.</div>}
        {!cooldownReady && <div className="rm2-page-warning"><AlertTriangle size={15} /> Trading Cooldown requires the Consecutive Losses rule.</div>}
        {risk.error && <div className="rm2-page-error"><AlertTriangle size={15} />{risk.error}</div>}

        {dirty && <div className="rm2-savebar"><p><i /> <strong>Unsaved changes</strong><span>· {modificationCount} {modificationCount === 1 ? 'setting' : 'settings'} modified</span></p><div><button type="button" onClick={resetChanges}>Discard</button><button type="button" className="primary" disabled={risk.status === 'saving' || !canActivate} onClick={() => void save(true)}>{risk.status === 'saving' ? <span className="button-spinner" /> : <LockKeyhole size={15} />}{draft.active ? 'Save changes' : 'Save & activate'}</button></div></div>}
        {savedNotice && <div className="rm2-toast"><CheckCircle2 size={16} /> Risk profile saved and active</div>}
      </div>
    </main>
  )
}

type RuleCategory = 'ALL' | 'POSITION' | 'ACCOUNT' | 'DISCIPLINE' | 'PORTFOLIO'
type RiskPageTab = 'RULES' | 'ACTIVITY'

const ruleCategories: Array<{ value: RuleCategory; label: string }> = [
  { value: 'ALL', label: 'All rules' },
  { value: 'POSITION', label: 'Position protection' },
  { value: 'ACCOUNT', label: 'Account limits' },
  { value: 'DISCIPLINE', label: 'Trading discipline' },
  { value: 'PORTFOLIO', label: 'Portfolio' },
]

const ruleCategoryByKey: Record<RuleKey, Exclude<RuleCategory, 'ALL'>> = {
  fixedStopLoss: 'POSITION',
  breakEven: 'POSITION',
  dailyLossLimit: 'ACCOUNT',
  riskPerTrade: 'ACCOUNT',
  maxLeverage: 'ACCOUNT',
  maxTradesPerDay: 'DISCIPLINE',
  maxConsecutiveLosses: 'DISCIPLINE',
  cooldownMinutes: 'DISCIPLINE',
  maxExposurePercent: 'PORTFOLIO',
  maxOpenPositions: 'PORTFOLIO',
}

const ruleNameByKey: Record<string, string> = Object.fromEntries(deck.map((item) => [item.key, item.shortTitle]))

function breachActionCopy(action: RiskBreachAction) {
  return breachOptions.find((option) => option.value === action) ?? breachOptions[0]
}

function humanRuleName(rule?: string) {
  if (!rule) return 'System'
  return ruleNameByKey[rule] || rule
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/^./, (character) => character.toUpperCase())
}

function humanEventTitle(message: string, action?: string, outcome?: string) {
  const source = `${message} ${action || ''} ${outcome || ''}`.toLowerCase().replace(/[_-]+/g, ' ')
  if (source.includes('detect') && source.includes('external')) return 'External entry detected'
  if ((source.includes('close position') || source.includes('position closed')) && (source.includes('success') || source.includes('complete'))) return 'Position closed'
  if (source.includes('blocked') || source.includes('reject')) return 'Entry blocked'
  if (source.includes('cancel') && source.includes('order')) return 'Pending order cancelled'
  if (source.includes('activat') && source.includes('profile')) return 'Risk profile activated'
  if (source.includes('baseline')) return 'Daily baseline updated'
  const compact = message.replace(/^rm system\s*/i, '').replace(/\s+/g, ' ').trim()
  return compact.length > 72 ? `${compact.slice(0, 69)}…` : compact || 'Risk event'
}

function humanOutcome(outcome?: string) {
  if (!outcome) return 'Recorded'
  const normalized = outcome.toLowerCase()
  if (normalized.includes('success') || normalized.includes('succeed') || normalized.includes('complete')) return 'Completed'
  if (normalized.includes('block') || normalized.includes('reject')) return 'Blocked'
  if (normalized.includes('detect')) return 'Detected'
  if (normalized.includes('fail') || normalized.includes('error')) return 'Failed'
  return outcome.replace(/_/g, ' ').replace(/^./, (character) => character.toUpperCase())
}

function eventTone(outcome?: string, severity?: string) {
  const source = `${outcome || ''} ${severity || ''}`.toLowerCase()
  if (source.includes('fail') || source.includes('error') || source.includes('block') || source.includes('reject')) return 'danger'
  if (source.includes('success') || source.includes('complete')) return 'success'
  if (source.includes('warning')) return 'warning'
  return 'info'
}

function RuleEditor({ item, draft, setDraft }: {
  item: DeckItem
  draft: RiskProfile
  setDraft: React.Dispatch<React.SetStateAction<RiskProfile>>
}) {
  const valueRule = rules.find((rule) => rule.key === item.key)
  if (item.key === 'fixedStopLoss') {
    return <FixedStopEditor value={draft.fixedStopLoss} onChange={(fixedStopLoss) => setDraft((profile) => ({ ...profile, fixedStopLoss }))} />
  }
  if (item.key === 'breakEven') {
    return <BreakEvenEditor value={draft.breakEven} fixedStopEnabled={draft.fixedStopLoss.enabled} onChange={(breakEven) => setDraft((profile) => ({ ...profile, breakEven }))} />
  }
  if (item.key === 'dailyLossLimit') {
    return <DailyLossEditor value={draft.dailyLossLimit} onChange={(dailyLossLimit) => setDraft((profile) => ({ ...profile, dailyLossLimit }))} />
  }
  return <ValueRuleEditor definition={valueRule!} value={draft[item.key as ValueRuleKey]} onChange={(value) => setDraft((profile) => ({ ...profile, [item.key]: value }))} />
}

function RulePreviewCard({ item, draft, side, onClick }: {
  item: DeckItem
  draft: RiskProfile
  side: 'previous' | 'next'
  onClick: () => void
}) {
  return (
    <button type="button" className={`rm3-preview-card ${side}`} onClick={onClick} aria-label={`Open ${item.title}`}>
      <span className="rm3-preview-visual"><img src={ruleArtwork[item.sprite]} alt="" draggable={false} /></span>
      <span className="rm3-preview-copy"><strong>{item.shortTitle}</strong><small>{item.description}</small></span>
      <span className={`rm3-preview-status ${isEnabled(draft, item.key) ? 'enabled' : ''}`} aria-label={isEnabled(draft, item.key) ? 'Enabled' : 'Disabled'} />
    </button>
  )
}

function RuleDetails({ item, externalBadge }: { item: DeckItem; externalBadge: string }) {
  return (
    <details className="rm3-rule-details">
      <summary><span><ChevronDown size={15} /> Calculation &amp; enforcement</span><small>How this rule is checked</small></summary>
      <div className="rm3-rule-details-body">
        <ol>{item.details.map((detail) => <li key={detail}>{detail}</li>)}</ol>
        <div className="rm3-enforcement-grid">
          <div><ShieldCheck size={17} /><span><strong>AntyTILT orders</strong><small>{item.terminalEffect}</small></span><i>Pre-trade guard</i></div>
          <div><RefreshCw size={17} /><span><strong>Direct BingX entries</strong><small>{item.externalEffect}</small></span><i>{externalBadge}</i></div>
        </div>
      </div>
    </details>
  )
}

function SelectedRuleCard({ item, index, enabled, direction, externalBadge, onToggle, onNavigate, children }: {
  item: DeckItem
  index: number
  enabled: boolean
  direction: SwipeDirection
  externalBadge: string
  onToggle: () => void
  onNavigate: (delta: number) => void
  children: ReactNode
}) {
  const reducedMotion = useReducedMotion()
  const [guideOpen, setGuideOpen] = useState(false)
  return (
    <motion.article
      data-rule={item.key}
      className="rm3-rule-card"
      custom={direction}
      variants={{
        enter: (move: SwipeDirection) => ({ opacity: 0, x: move === 'right' ? 38 : -38 }),
        center: { opacity: 1, x: 0 },
        exit: (move: SwipeDirection) => ({ opacity: 0, x: move === 'right' ? -38 : 38 }),
      }}
      initial={reducedMotion ? false : 'enter'}
      animate="center"
      exit="exit"
      transition={{ duration: reducedMotion ? 0 : 0.24, ease: [0.2, 0.8, 0.2, 1] }}
    >
      <motion.div
        className="rm3-card-art"
        drag="x"
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={0.16}
        onDragEnd={(_, info) => {
          const projected = info.offset.x + info.velocity.x * 0.08
          if (projected < -75) onNavigate(1)
          if (projected > 75) onNavigate(-1)
        }}
        aria-label={`Swipe to browse rules. ${item.title}, ${index + 1} of ${deck.length}`}
      >
        <img src={ruleArtwork[item.sprite]} alt="" draggable={false} />
        <span className="rm3-card-eyebrow">{item.eyebrow}</span>
        <span className="rm3-card-count">{String(index + 1).padStart(2, '0')} / {deck.length}</span>
        <div className="rm3-guide-anchor" onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" className="rm3-guide-button" aria-label={`Explain ${item.title}`} aria-expanded={guideOpen} onClick={() => setGuideOpen((open) => !open)}><Info size={16} /></button>
          <AnimatePresence>
            {guideOpen && <motion.div className="rm3-guide-popover" initial={{ opacity: 0, y: -6, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -4, scale: 0.98 }} role="dialog" aria-label={`${item.title} rule guide`}>
              <header><ShieldCheck size={16} /><span><small>Rule guide</small><strong>{item.title}</strong></span><button type="button" onClick={() => setGuideOpen(false)} aria-label="Close rule guide"><X size={15} /></button></header>
              <p>{item.description}</p>
              <ol>{item.details.map((detail) => <li key={detail}>{detail}</li>)}</ol>
            </motion.div>}
          </AnimatePresence>
        </div>
      </motion.div>
      <div className="rm3-card-body">
        <header className="rm3-card-heading">
          <div><small>{item.eyebrow}</small><h2>{item.title}</h2><p>{item.description}</p></div>
          <button type="button" className={`rm3-rule-toggle ${enabled ? 'enabled' : ''}`} aria-pressed={enabled} onClick={onToggle}><span /><strong>{enabled ? 'Enabled' : 'Disabled'}</strong></button>
        </header>
        <div className="rm3-editor">{children}</div>
        <RuleDetails item={item} externalBadge={externalBadge} />
      </div>
    </motion.article>
  )
}

function RuntimeMetric3({ icon: Icon, label, value, tone, onClick }: {
  icon: LucideIcon
  label: string
  value: string
  tone?: string
  onClick?: () => void
}) {
  const content = <><Icon size={20} /><span><small>{label}</small><strong>{value}</strong></span>{onClick && <ChevronRight size={15} />}</>
  return onClick
    ? <button type="button" className={`rm3-metric ${tone || ''}`} onClick={onClick}>{content}</button>
    : <div className={`rm3-metric ${tone || ''}`}>{content}</div>
}

function ActivityTable({ events, compact = false }: { events: ReturnType<typeof useRiskProfile>['events']; compact?: boolean }) {
  const visible = compact ? events.slice(0, 3) : events
  if (visible.length === 0) return <div className="rm3-activity-empty"><CheckCircle2 size={22} /><strong>No RM actions recorded</strong><span>Risk events will appear here after monitoring begins.</span></div>
  return (
    <div className="rm3-activity-table">
      <div className="rm3-activity-head"><span>Time</span><span>Event</span><span>Rule</span><span>Result</span></div>
      {visible.map((event) => {
        const tone = eventTone(event.outcome, event.severity)
        return <div className="rm3-activity-row" key={event.id} title={event.message}>
          <time>{new Date(event.createdAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</time>
          <strong>{humanEventTitle(event.message, event.action, event.outcome)}</strong>
          <span>{humanRuleName(event.rule)}</span>
          <i className={tone}><b />{humanOutcome(event.outcome)}</i>
        </div>
      })}
    </div>
  )
}

export function RiskManagementPage({ onBackToTrade }: { onBackToTrade: () => void }) {
  const risk = useRiskProfile()
  const reducedMotion = useReducedMotion()
  const [draft, setDraft] = useState<RiskProfile>(defaultRiskProfile)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [activeCategory, setActiveCategory] = useState<RuleCategory>('ALL')
  const [activeTab, setActiveTab] = useState<RiskPageTab>('RULES')
  const [direction, setDirection] = useState<SwipeDirection>('right')
  const [isTransitioning, setIsTransitioning] = useState(false)
  const [policyOpen, setPolicyOpen] = useState(false)
  const [savedNotice, setSavedNotice] = useState(false)
  const [confirmCloseAll, setConfirmCloseAll] = useState(false)

  useEffect(() => setDraft(risk.profile), [risk.profile])
  useEffect(() => {
    Object.values(ruleArtwork).forEach((source) => {
      const image = new Image()
      image.decoding = 'async'
      image.src = source
    })
  }, [])

  const dirty = useMemo(() => JSON.stringify({ ...draft, updatedAt: 0 }) !== JSON.stringify({ ...risk.profile, updatedAt: 0 }), [draft, risk.profile])
  const modifiedRuleCount = useMemo(() => deck.filter((item) => JSON.stringify(draft[item.key]) !== JSON.stringify(risk.profile[item.key])).length, [draft, risk.profile])
  const auxiliarySettingsChanged = draft.timezone !== risk.profile.timezone
    || draft.breachAction !== risk.profile.breachAction
    || draft.externalViolationPolicy !== risk.profile.externalViolationPolicy
    || draft.closeExternalEntriesOnBreach !== risk.profile.closeExternalEntriesOnBreach
    || draft.automationConsent !== risk.profile.automationConsent
  const modificationCount = Math.max(1, modifiedRuleCount + (auxiliarySettingsChanged ? 1 : 0))
  const current = deck[currentIndex]
  const count = enabledCount(draft)
  const visibleIndices = useMemo(() => deck
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => activeCategory === 'ALL' || ruleCategoryByKey[item.key] === activeCategory)
    .map(({ index }) => index), [activeCategory])
  const currentVisiblePosition = Math.max(0, visibleIndices.indexOf(currentIndex))
  const previousIndex = visibleIndices[(currentVisiblePosition - 1 + visibleIndices.length) % visibleIndices.length]
  const nextIndex = visibleIndices[(currentVisiblePosition + 1) % visibleIndices.length]
  const previousRule = deck[previousIndex]
  const nextRule = deck[nextIndex]

  const bypassRulesEnabled = draft.maxTradesPerDay.enabled || draft.dailyLossLimit.enabled
  const externalBypassSelected = bypassRulesEnabled && draft.closeExternalEntriesOnBreach
  const automationSelected = draft.breachAction !== 'BLOCK_NEW_ENTRIES' || externalBypassSelected
  const automationReady = !automationSelected || draft.automationConsent
  const rMultipleReady = !(draft.breakEven.enabled && draft.breakEven.triggerMode === 'R_MULTIPLE') || draft.fixedStopLoss.enabled
  const cooldownReady = !draft.cooldownMinutes.enabled || draft.maxConsecutiveLosses.enabled
  const canActivate = count > 0 && automationReady && rMultipleReady && cooldownReady
  const canSaveAndActivate = canActivate && (dirty || !draft.active)
  const currentUsesBypassProtection = current.key === 'maxTradesPerDay' || current.key === 'dailyLossLimit'
  const externalBadge = currentUsesBypassProtection && externalBypassSelected && draft.automationConsent
    ? 'Bypass protection active'
    : current.key === 'fixedStopLoss' || current.key === 'breakEven'
      ? risk.runtime.liveAutomationEnabled === false ? 'Live automation unavailable' : 'Managed by RM worker'
      : automationSelected && draft.automationConsent ? 'Automatic action authorized' : 'Monitoring only'
  const selectedBreach = breachActionCopy(draft.breachAction)

  const pnlTone = risk.runtime.dailyPnl === undefined ? undefined : risk.runtime.dailyPnl > 0 ? 'positive' : risk.runtime.dailyPnl < 0 ? 'negative' : undefined
  const tradeLimit = risk.runtime.tradeLimit ?? (draft.maxTradesPerDay.enabled ? draft.maxTradesPerDay.value : undefined)
  const tradesTone = risk.runtime.tradesUsed !== undefined && tradeLimit !== undefined
    ? risk.runtime.tradesUsed > tradeLimit ? 'negative' : risk.runtime.tradesUsed === tradeLimit ? 'warning' : undefined
    : undefined
  const positionLimit = draft.maxOpenPositions.enabled ? draft.maxOpenPositions.value : undefined
  const positionsTone = risk.runtime.openPositions !== undefined && positionLimit !== undefined
    ? risk.runtime.openPositions > positionLimit ? 'negative' : risk.runtime.openPositions === positionLimit ? 'warning' : undefined
    : undefined

  const navigateTo = (index: number) => {
    if (index === currentIndex || isTransitioning) return
    setDirection(index > currentIndex ? 'right' : 'left')
    setIsTransitioning(true)
    setCurrentIndex(index)
  }

  const navigateBy = (delta: number) => {
    if (!visibleIndices.length || isTransitioning) return
    const nextPosition = (currentVisiblePosition + delta + visibleIndices.length) % visibleIndices.length
    const index = visibleIndices[nextPosition]
    setDirection(delta > 0 ? 'right' : 'left')
    setIsTransitioning(true)
    setCurrentIndex(index)
  }

  const changeCategory = (category: RuleCategory) => {
    setActiveCategory(category)
    const matches = deck.map((item, index) => ({ item, index })).filter(({ item }) => category === 'ALL' || ruleCategoryByKey[item.key] === category)
    if (!matches.some(({ index }) => index === currentIndex) && matches[0]) navigateTo(matches[0].index)
  }

  const resetChanges = () => setDraft(risk.profile)

  const selectBreachAction = (breachAction: RiskBreachAction) => setDraft((profile) => ({
    ...profile,
    breachAction,
    externalViolationPolicy: breachAction === 'CLOSE_VIOLATING_POSITION' || breachAction === 'CLOSE_ALL' ? 'BLOCK_AND_CLOSE_EXTERNAL' : 'BLOCK_NEW_ENTRIES',
    automationConsent: breachAction === 'BLOCK_NEW_ENTRIES'
      && !(profile.closeExternalEntriesOnBreach && (profile.maxTradesPerDay.enabled || profile.dailyLossLimit.enabled))
      ? false
      : profile.automationConsent,
  }))

  const save = async (active = true) => {
    if (active && !canActivate) return
    try {
      const stored = await risk.save({ ...draft, active })
      setDraft(stored)
      setSavedNotice(true)
      setConfirmCloseAll(false)
      window.setTimeout(() => setSavedNotice(false), 3_000)
    } catch {
      // The hook exposes the actionable API error below the workspace.
    }
  }

  const requestSave = () => {
    if (draft.breachAction === 'CLOSE_ALL' && risk.profile.breachAction !== 'CLOSE_ALL') {
      setConfirmCloseAll(true)
      return
    }
    void save(true)
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPolicyOpen(false)
        setConfirmCloseAll(false)
        return
      }
      const target = event.target as HTMLElement | null
      if (activeTab !== 'RULES' || target?.closest('input, select, textarea, button, summary, [contenteditable="true"]')) return
      if (event.key === 'ArrowLeft') navigateBy(-1)
      if (event.key === 'ArrowRight') navigateBy(1)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  return (
    <main className="rm3-page">
      <div className="rm3-shell">
        <header className="rm3-header">
          <div className="rm3-title-block">
            <button type="button" className="rm3-back" onClick={onBackToTrade} aria-label="Back to terminal"><ArrowLeft size={19} /></button>
            <div><h1>Risk Management</h1><p>Personal rules enforced by the server</p></div>
            <span className={`rm3-monitor ${risk.runtime.workerStatus === 'ERROR' ? 'error' : risk.runtime.workerStatus === 'DISCONNECTED' ? 'offline' : ''}`}><i />{workerLabel(risk.runtime)}</span>
          </div>
          <div className="rm3-header-actions">
            {draft.active && <button type="button" className="rm3-pause" disabled={risk.status === 'saving'} onClick={() => void save(false)}><Pause size={16} /> Pause policy</button>}
            {!dirty && (draft.active
              ? <span className="rm3-policy-active"><ShieldCheck size={16} /> Policy active</span>
              : <button type="button" className="rm3-primary" disabled={risk.status === 'saving' || !canSaveAndActivate} onClick={() => void save(true)}><LockKeyhole size={16} /> Save &amp; activate</button>)}
          </div>
        </header>

        <section className="rm3-metrics" aria-label="Live risk status">
          <RuntimeMetric3 icon={Activity} label="Trades today" value={`${risk.runtime.tradesUsed ?? '—'} / ${tradeLimit ?? '—'}`} tone={tradesTone} />
          <RuntimeMetric3 icon={Gauge} label="Daily P&L" value={formatMoney(risk.runtime.dailyPnl)} tone={pnlTone} />
          <RuntimeMetric3 icon={Layers3} label="Open positions" value={`${risk.runtime.openPositions ?? '—'} / ${positionLimit ?? '—'}`} tone={positionsTone} />
          <RuntimeMetric3 icon={Clock3} label="Daily reset" value={formatCountdown(risk.runtime.nextResetAt)} onClick={() => setPolicyOpen(true)} />
        </section>

        <div className="rm3-tabs" role="tablist" aria-label="Risk management sections">
          <button type="button" role="tab" aria-selected={activeTab === 'RULES'} className={activeTab === 'RULES' ? 'active' : ''} onClick={() => setActiveTab('RULES')}>Rules <span>{count} / {deck.length}</span></button>
          <button type="button" role="tab" aria-selected={activeTab === 'ACTIVITY'} className={activeTab === 'ACTIVITY' ? 'active' : ''} onClick={() => setActiveTab('ACTIVITY')}>Activity <span>{risk.events.length}</span></button>
        </div>

        {risk.status === 'loading' ? <div className="rm3-loading"><span className="button-spinner" /> Loading your risk profile…</div> : activeTab === 'RULES' ? (
          <>
            <nav className="rm3-categories" aria-label="Rule categories">
              {ruleCategories.map((category) => {
                const total = category.value === 'ALL' ? deck.length : deck.filter((item) => ruleCategoryByKey[item.key] === category.value).length
                return <button type="button" className={activeCategory === category.value ? 'active' : ''} onClick={() => changeCategory(category.value)} key={category.value}>{category.label}{category.value === 'ALL' && <span>{total}</span>}</button>
              })}
            </nav>

            <section className="rm3-carousel" aria-live="polite" aria-busy={isTransitioning}>
              <button type="button" className="rm3-carousel-arrow previous" onClick={() => navigateBy(-1)} aria-label="Previous rule"><ChevronLeft size={21} /></button>
              {visibleIndices.length > 1 && <RulePreviewCard item={previousRule} draft={draft} side="previous" onClick={() => navigateTo(previousIndex)} />}
              <div className="rm3-selected-slot">
                <AnimatePresence mode="wait" custom={direction} initial={false} onExitComplete={() => setIsTransitioning(false)}>
                  <SelectedRuleCard
                    key={current.key}
                    item={current}
                    index={currentIndex}
                    enabled={isEnabled(draft, current.key)}
                    direction={direction}
                    externalBadge={externalBadge}
                    onToggle={() => setDraft((profile) => withEnabled(profile, current.key, !isEnabled(profile, current.key)))}
                    onNavigate={navigateBy}
                  ><RuleEditor item={current} draft={draft} setDraft={setDraft} /></SelectedRuleCard>
                </AnimatePresence>
              </div>
              {visibleIndices.length > 1 && <RulePreviewCard item={nextRule} draft={draft} side="next" onClick={() => navigateTo(nextIndex)} />}
              <button type="button" className="rm3-carousel-arrow next" onClick={() => navigateBy(1)} aria-label="Next rule"><ChevronRight size={21} /></button>
            </section>

            <div className="rm3-carousel-footer">
              <button type="button" onClick={() => navigateBy(-1)}><ChevronLeft size={16} /><span><small>Previous</small>{previousRule.shortTitle}</span></button>
              <div><strong>{String(currentVisiblePosition + 1).padStart(2, '0')}</strong><span>/ {visibleIndices.length}</span><small>Swipe card or use arrow keys</small></div>
              <button type="button" onClick={() => navigateBy(1)}><span><small>Next</small>{nextRule.shortTitle}</span><ChevronRight size={16} /></button>
            </div>

            <section className={`rm3-policy-summary ${draft.breachAction === 'CLOSE_ALL' ? 'danger' : ''}`}>
              <div className="rm3-policy-title"><Settings2 size={18} /><span><strong>Account policy</strong><small>Applies to all {deck.length} rules</small></span></div>
              <div className="rm3-policy-state"><AlertTriangle size={17} /><span><small>On breach</small><strong>{selectedBreach.title}</strong></span></div>
              <div><ShieldCheck size={17} /><span><small>Bypass protection</small><strong className={externalBypassSelected ? 'success' : ''}>{externalBypassSelected ? 'On' : 'Off'}</strong></span></div>
              <div><LockKeyhole size={17} /><span><small>Automatic actions</small><strong className={automationSelected && draft.automationConsent ? 'success' : ''}>{automationSelected ? draft.automationConsent ? 'Authorized' : 'Authorization required' : 'Not required'}</strong></span></div>
              <button type="button" onClick={() => setPolicyOpen(true)}>Edit policy <ChevronRight size={15} /></button>
            </section>
          </>
        ) : (
          <section className="rm3-activity-view">
            <header><div><h2>Risk activity</h2><p>Blocks, detected exchange entries and automatic actions for this account.</p></div><button type="button" onClick={() => void risk.refreshRuntime()}><RefreshCw size={15} /> Refresh</button></header>
            <ActivityTable events={risk.events} />
          </section>
        )}

        {!rMultipleReady && <div className="rm3-page-warning"><AlertTriangle size={15} /> Enable Protective Stop Loss or change Break-even to Profit %.</div>}
        {!cooldownReady && <div className="rm3-page-warning"><AlertTriangle size={15} /> Trading Cooldown requires the Consecutive Losses rule.</div>}
        {risk.error && <div className="rm3-page-error"><AlertTriangle size={15} />{risk.error}</div>}

        {dirty && <div className="rm3-savebar"><p><i /><strong>{modificationCount} unsaved {modificationCount === 1 ? 'change' : 'changes'}</strong><span>Review the policy before applying it to this account.</span></p><div><button type="button" onClick={resetChanges}><RotateCcw size={15} /> Discard</button><button type="button" className="primary" disabled={risk.status === 'saving' || !canActivate} onClick={requestSave}>{risk.status === 'saving' ? <span className="button-spinner" /> : <LockKeyhole size={15} />}{draft.active ? 'Save changes' : 'Save & activate'}</button></div></div>}
        {savedNotice && <div className="rm3-toast"><CheckCircle2 size={17} /> Risk profile saved and active</div>}
      </div>

      <AnimatePresence>
        {policyOpen && <>
          <motion.button type="button" className="rm3-drawer-scrim" aria-label="Close account policy" onClick={() => setPolicyOpen(false)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
          <motion.aside className="rm3-policy-drawer" role="dialog" aria-modal="true" aria-labelledby="rm3-policy-title" initial={reducedMotion ? { opacity: 1 } : { x: '100%' }} animate={{ x: 0, opacity: 1 }} exit={reducedMotion ? { opacity: 0 } : { x: '100%' }} transition={{ duration: reducedMotion ? 0 : 0.26, ease: [0.2, 0.8, 0.2, 1] }}>
            <header><div><h2 id="rm3-policy-title">Account policy</h2><p>Applies to all {deck.length} rules</p></div><button type="button" onClick={() => setPolicyOpen(false)} aria-label="Close account policy"><X size={20} /></button></header>
            <div className="rm3-drawer-scroll">
              <div className="rm3-drawer-intro"><Info size={17} /><span>Choose what happens when any active rule is breached.</span></div>
              <fieldset className="rm3-policy-options"><legend>On breach</legend>{breachOptions.map((option) => {
                const Icon = option.icon
                const selected = draft.breachAction === option.value
                return <button type="button" role="radio" aria-checked={selected} className={`${selected ? 'selected' : ''} ${option.value === 'CLOSE_ALL' ? 'critical' : ''}`} onClick={() => selectBreachAction(option.value)} key={option.value}><i>{selected ? <Check size={13} /> : null}</i><Icon size={18} /><span><strong>{option.title}</strong><small>{option.description}</small></span></button>
              })}</fieldset>

              {draft.breachAction === 'CLOSE_ALL' && <div className="rm3-critical-note"><AlertTriangle size={17} /><span><strong>Emergency action selected</strong><small>When a rule is breached, AntyTILT cancels entry orders and sends market-close requests for every open position.</small></span></div>}

              <section className="rm3-policy-toggle-section">
                <button type="button" className={`rm3-switch-row ${draft.closeExternalEntriesOnBreach ? 'enabled' : ''}`} aria-pressed={draft.closeExternalEntriesOnBreach} disabled={!bypassRulesEnabled} onClick={() => setDraft((profile) => ({
                  ...profile,
                  closeExternalEntriesOnBreach: !profile.closeExternalEntriesOnBreach,
                  automationConsent: profile.closeExternalEntriesOnBreach && profile.breachAction === 'BLOCK_NEW_ENTRIES' ? false : profile.automationConsent,
                }))}><span className="rm3-switch"><i /></span><span><strong>Close bypass entries</strong><small>{bypassRulesEnabled ? 'Close a new direct BingX entry after Daily Loss or Trades per Day has locked trading.' : 'Enable Daily Loss or Trades per Day to use this protection.'}</small></span></button>

                {automationSelected ? <button type="button" className={`rm3-switch-row ${draft.automationConsent ? 'enabled' : ''}`} aria-pressed={draft.automationConsent} onClick={() => setDraft((profile) => ({ ...profile, automationConsent: !profile.automationConsent }))}><span className="rm3-switch"><i /></span><span><strong>Allow automatic exchange actions</strong><small>Market closes can have latency, fees and slippage.</small></span></button> : <div className="rm3-permission-idle"><ShieldCheck size={18} /><span><strong>No exchange action permission required</strong><small>Blocking AntyTILT entries does not place or cancel an exchange order.</small></span></div>}
              </section>

              {!automationReady && <div className="rm3-validation"><AlertTriangle size={15} /> Authorize automatic exchange actions before saving this policy.</div>}

              <details className="rm3-drawer-disclosure"><summary><span><Clock3 size={17} /><strong>Execution details</strong></span><ChevronDown size={16} /></summary><div><label>Daily reset timezone<select value={draft.timezone} onChange={(event) => setDraft((profile) => ({ ...profile, timezone: event.target.value }))}>{availableTimezones().map((timezone) => <option value={timezone} key={timezone}>{timezone}</option>)}</select></label><p>Daily counters and the loss baseline reset at 00:00 in this timezone. Automatic market actions may experience slippage, fees and exchange latency.</p></div></details>
              <details className="rm3-drawer-disclosure"><summary><span><LockKeyhole size={17} /><strong>Permissions</strong></span><ChevronDown size={16} /></summary><div><p>AntyTILT can read account state for monitoring. Automatic trade actions are sent only when the authorization above is enabled and the saved policy requires them.</p></div></details>
            </div>
            <footer><span>Changes apply only after <strong>Save changes</strong>.</span><button type="button" onClick={() => setPolicyOpen(false)}>Done</button></footer>
          </motion.aside>
        </>}
      </AnimatePresence>

      <AnimatePresence>
        {confirmCloseAll && <div className="rm3-confirm-layer" role="dialog" aria-modal="true" aria-labelledby="rm3-confirm-title"><motion.div initial={reducedMotion ? false : { opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: 0.99 }}><span className="rm3-confirm-icon"><AlertTriangle size={22} /></span><h2 id="rm3-confirm-title">Use Close all positions on breach?</h2><p>This action will cancel entry orders and send market-close requests for every open position when an active rule is breached.</p><div><button type="button" onClick={() => setConfirmCloseAll(false)}>Review policy</button><button type="button" className="danger" onClick={() => void save(true)}>Confirm and save</button></div></motion.div></div>}
      </AnimatePresence>
    </main>
  )
}
