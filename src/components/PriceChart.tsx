import { normalizeInstrumentSymbol } from '../executionSelection'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react'
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from 'lightweight-charts'
import {
  ALargeSmall,
  BadgeMinus,
  BadgePlus,
  ChartNoAxesColumnIncreasing,
  ChevronRight,
  Crosshair,
  Layers3,
  Minus,
  MousePointer2,
  MoveUpRight,
  MoveVertical,
  RotateCcw,
  Ruler,
  ShieldCheck,
  Square,
  TrendingUp,
  X,
} from 'lucide-react'
import type { Candle, ExchangeOrder, ExchangePosition, OrderProtectionDraft, PositionProtectionInput, ProtectionWorkingType } from '../types'
import type { MarketDataExchange } from '../marketData'
import {
  DrawingHistoryControls,
  DrawingObjectsPanel,
  DrawingOverlay,
  DrawingProperties,
  type DrawingTool,
  useChartDrawings,
} from './useChartDrawings'

type Props = {
  candles: Candle[]
  interval: string
  symbol: string
  quoteAsset?: string
  executionVenue?: string
  markPriceOnly?: boolean
  existingProtectionEditable?: boolean
  storageScope: string
  marketExchange: MarketDataExchange
  marketNetwork?: 'mainnet' | 'testnet'
  marketStatus?: 'connecting' | 'live' | 'demo'
  marketError?: string | null
  referencePrice: number
  exchangeReferencePrice?: number
  priceDirection?: 'up' | 'down' | 'flat'
  theme?: 'dark' | 'light'
  positions?: ExchangePosition[]
  openOrders?: ExchangeOrder[]
  orderProtectionDraft?: OrderProtectionDraft | null
  protectionBusy?: boolean
  onUpdateProtection?: (positionId: string, input: PositionProtectionInput) => Promise<unknown>
  onIntervalChange: (interval: string) => void
}

const intervals = ['1m', '5m', '15m', '1h', '4h', '1d']

const formatChartQuantity = (value: number) => value.toLocaleString('en-US', {
  maximumFractionDigits: value >= 1 ? 3 : 6,
})

const projectedPnl = (direction: 'LONG' | 'SHORT', entryPrice: number, exitPrice: number, quantity: number) => {
  if (!(entryPrice > 0) || !(exitPrice > 0) || !(quantity > 0)) return 0
  return (exitPrice - entryPrice) * quantity * (direction === 'LONG' ? 1 : -1)
}

const formatProjectedPnl = (value: number, currency = 'USDT') => `${value >= 0 ? '+' : '−'}${Math.abs(value).toLocaleString('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})} ${currency}`

type VerticalMarker = { id: string; actualY: number }

const distributeVerticalMarkers = (markers: VerticalMarker[], minY: number, maxY: number, gap = 26) => {
  if (markers.length === 0) return new Map<string, number>()
  if (!(maxY > minY)) return new Map(markers.map((marker) => [marker.id, marker.actualY]))
  const ordered = [...markers].sort((left, right) => left.actualY - right.actualY)
  const placed = ordered.map((marker) => ({ ...marker, labelY: Math.max(minY, Math.min(maxY, marker.actualY)) }))

  for (let pass = 0; pass < 3; pass += 1) {
    for (let index = 1; index < placed.length; index += 1) {
      placed[index].labelY = Math.max(placed[index].labelY, placed[index - 1].labelY + gap)
    }
    const overflow = placed.at(-1)!.labelY - maxY
    if (overflow > 0) placed.forEach((marker) => { marker.labelY -= overflow })
    for (let index = placed.length - 2; index >= 0; index -= 1) {
      placed[index].labelY = Math.min(placed[index].labelY, placed[index + 1].labelY - gap)
    }
    const underflow = minY - placed[0].labelY
    if (underflow > 0) placed.forEach((marker) => { marker.labelY += underflow })
  }

  return new Map(placed.map((marker) => [marker.id, marker.labelY]))
}

type ToolDefinition = { id: DrawingTool; name: string; shortcut?: string; label: string; icon: typeof MousePointer2 }

const tools: ToolDefinition[] = [
  { id: 'cursor' as const, name: 'Cursor', shortcut: 'V', label: 'Cursor · V', icon: MousePointer2 },
  { id: 'trend' as const, name: 'Trend line', shortcut: 'T', label: 'Trend line · T', icon: TrendingUp },
  { id: 'ray' as const, name: 'Ray', label: 'Ray', icon: MoveUpRight },
  { id: 'horizontal' as const, name: 'Horizontal line', shortcut: 'H', label: 'Horizontal line · H', icon: Minus },
  { id: 'vertical' as const, name: 'Vertical line', label: 'Vertical line', icon: MoveVertical },
  { id: 'fib' as const, name: 'Fibonacci retracement', shortcut: 'F', label: 'Fibonacci · F', icon: ChartNoAxesColumnIncreasing },
  { id: 'rectangle' as const, name: 'Rectangle', shortcut: 'R', label: 'Rectangle · R', icon: Square },
  { id: 'measure' as const, name: 'Price range', shortcut: 'M', label: 'Price range · M', icon: Ruler },
  { id: 'long' as const, name: 'Long position', label: 'Long position', icon: BadgePlus },
  { id: 'short' as const, name: 'Short position', label: 'Short position', icon: BadgeMinus },
  { id: 'text' as const, name: 'Text note', shortcut: 'N', label: 'Text note · N', icon: ALargeSmall },
]

const toolGroups = [
  { id: 'lines', name: 'Line tools', tools: ['trend', 'ray', 'horizontal', 'vertical'] as DrawingTool[] },
  { id: 'structures', name: 'Fibonacci & shapes', tools: ['fib', 'rectangle'] as DrawingTool[] },
  { id: 'measure', name: 'Measure', tools: ['measure'] as DrawingTool[] },
  { id: 'positions', name: 'Risk / reward', tools: ['long', 'short'] as DrawingTool[] },
  { id: 'notes', name: 'Annotations', tools: ['text'] as DrawingTool[] },
]

const toolDefinition = (id: DrawingTool) => tools.find((tool) => tool.id === id) as ToolDefinition

function DrawingToolButton({ tool, active, onClick }: { tool: ToolDefinition; active: boolean; onClick: () => void }) {
  const Icon = tool.icon
  return <button
    type="button"
    className={`drawing-tool ${active ? 'active' : ''}`}
    aria-label={tool.label}
    aria-pressed={active}
    data-tool={tool.id}
    onClick={onClick}
  >
    <Icon size={17} strokeWidth={1.65} />
    <span className="drawing-tooltip"><strong>{tool.name}</strong>{tool.shortcut && <kbd>{tool.shortcut}</kbd>}</span>
  </button>
}

function DrawingToolbar({ activeTool, onSelect, onOpenMenu, history }: {
  activeTool: DrawingTool
  onSelect: (tool: DrawingTool) => void
  onOpenMenu: () => void
  history: Parameters<typeof DrawingHistoryControls>[0]
}) {
  const [openGroup, setOpenGroup] = useState<string | null>(null)
  const [recent, setRecent] = useState<Record<string, DrawingTool>>({ lines: 'trend', structures: 'fib', measure: 'measure', positions: 'long', notes: 'text' })
  const toolbarRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!toolbarRef.current?.contains(event.target as Node)) setOpenGroup(null)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenGroup(null)
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [])

  const choose = (groupId: string, tool: DrawingTool) => {
    setRecent((current) => ({ ...current, [groupId]: tool }))
    setOpenGroup(null)
    onSelect(tool)
  }

  return <div ref={toolbarRef} className={`drawing-toolbar ${activeTool !== 'cursor' ? 'tool-active' : ''}`} data-active-tool={activeTool} aria-label="Chart drawing tools">
    <DrawingToolButton tool={toolDefinition('cursor')} active={activeTool === 'cursor'} onClick={() => onSelect('cursor')} />
    <span className="tool-divider" />
    {toolGroups.map((group) => {
      const selected = group.tools.includes(activeTool) ? activeTool : recent[group.id]
      const primary = toolDefinition(selected)
      if (group.tools.length === 1) {
        return <DrawingToolButton key={group.id} tool={primary} active={activeTool === primary.id} onClick={() => choose(group.id, primary.id)} />
      }
      const PrimaryIcon = primary.icon
      const active = group.tools.includes(activeTool)
      return <div className={`drawing-tool-group ${active ? 'active' : ''}`} key={group.id}>
        <button type="button" className="drawing-tool group-primary" aria-label={`Use ${primary.name}`} aria-pressed={active} data-tool={primary.id} onClick={() => choose(group.id, primary.id)}>
          <PrimaryIcon size={17} strokeWidth={1.65} />
          <span className="drawing-tooltip"><strong>{primary.name}</strong>{primary.shortcut && <kbd>{primary.shortcut}</kbd>}</span>
        </button>
        <button
          type="button"
          className={`drawing-group-toggle ${openGroup === group.id ? 'open' : ''}`}
          aria-label={`Open ${group.name}`}
          aria-expanded={openGroup === group.id}
          onClick={() => {
            onOpenMenu()
            setOpenGroup((current) => current === group.id ? null : group.id)
          }}
        ><ChevronRight size={9} /></button>
        {openGroup === group.id && <div className="drawing-tool-flyout" role="menu" aria-label={group.name}>
          <header><strong>{group.name}</strong><small>Select a tool</small></header>
          {group.tools.map((id) => {
            const item = toolDefinition(id)
            const ItemIcon = item.icon
            return <button type="button" role="menuitem" key={id} className={activeTool === id ? 'active' : ''} aria-label={item.label} onClick={() => choose(group.id, id)}>
              <ItemIcon size={16} strokeWidth={1.7} />
              <span>{item.name}</span>
              {item.shortcut && <kbd>{item.shortcut}</kbd>}
            </button>
          })}
        </div>}
      </div>
    })}
    <span className="tool-divider" />
    <DrawingHistoryControls {...history} />
  </div>
}

function InlineTextEditor({ drawing, point, dimensions, onSave, onCancel }: {
  drawing: import('./useChartDrawings').ChartDrawing
  point: { x: number; y: number }
  dimensions: { width: number; height: number }
  onSave: (value: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(drawing.text ?? '')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [drawing.id])
  const left = Math.max(8, Math.min(dimensions.width - 250, point.x - 8))
  const top = Math.max(8, Math.min(dimensions.height - 64, point.y - 52))
  const save = () => onSave(value.trim() || 'Note')
  return <form className="drawing-inline-editor" style={{ left, top }} onSubmit={(event) => { event.preventDefault(); save() }}>
    <input ref={inputRef} value={value} maxLength={120} placeholder="Write a note…" onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); onCancel() } }} />
    <button type="submit">Save</button>
    <small>Enter to save · Esc to cancel</small>
  </form>
}

function drawingHint(tool: DrawingTool, step: number, total: number) {
  if (tool === 'horizontal') return 'Click the required price level'
  if (tool === 'vertical') return 'Click the required time'
  if (tool === 'text') return 'Click where the note should appear'
  if (tool === 'long' || tool === 'short') {
    const labels = ['entry', 'stop loss', 'take profit']
    return `Point ${step}/${total}: set ${labels[Math.min(step - 1, 2)]}`
  }
  return step <= 1 ? `Point 1/${total}: choose the starting point` : `Point ${step}/${total}: choose the ending point`
}

type ProtectionKind = PositionProtectionInput['kind']

type ProtectionLine = {
  key: string
  kind: ProtectionKind
  price: number
  position: ExchangePosition
  workingType: ProtectionWorkingType
  orders: Array<{ orderId: string; quantity: number }>
}

type ProtectionDraft = ProtectionLine & { nextPrice: number; targetOrderId?: string }

const protectionLabel = (kind: ProtectionKind) => kind === 'TAKE_PROFIT' ? 'Take Profit' : 'Stop Loss'

export function PriceChart({ candles, interval, symbol, quoteAsset = 'USDT', executionVenue = 'BingX', markPriceOnly = false, existingProtectionEditable = true, storageScope, marketExchange, marketNetwork = 'mainnet', marketStatus = 'connecting', marketError, referencePrice, exchangeReferencePrice, priceDirection = 'flat', theme = 'dark', positions = [], openOrders = [], orderProtectionDraft = null, protectionBusy = false, onUpdateProtection, onIntervalChange }: Props) {
  const sourceLabel = marketExchange === 'hyperliquid' ? `Hyperliquid ${marketNetwork === 'testnet' ? 'Testnet' : 'Mainnet'}` : marketExchange.toUpperCase()
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const protectionPointerOffsetRef = useRef(0)
  const initializedIntervalRef = useRef<string | null>(null)
  const [chartReady, setChartReady] = useState(false)
  const [, setProjectionRevision] = useState(0)
  const [draggingProtection, setDraggingProtection] = useState<ProtectionDraft | null>(null)
  const [pendingProtection, setPendingProtection] = useState<ProtectionDraft | null>(null)
  const [protectionError, setProtectionError] = useState<string | null>(null)
  const pricePrecision = referencePrice >= 1_000 ? 2 : referencePrice >= 1 ? 4 : referencePrice >= 0.01 ? 6 : 8

  const drawing = useChartDrawings({
    chartRef,
    seriesRef: candleSeriesRef,
    containerRef,
    candles,
    enabled: chartReady,
    storageKey: `antytilt:${storageScope}:drawings:${marketExchange.toUpperCase()}${marketExchange === 'hyperliquid' ? `:${marketNetwork}` : ''}:PERPETUAL:${symbol}:v2`,
    exportSymbol: symbol,
  })

  useEffect(() => {
    if (!containerRef.current) return

    const container = containerRef.current
    const light = theme === 'light'
    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: light ? '#ffffff' : '#0b0e13' },
        textColor: light ? '#657083' : '#788394',
        fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: light ? '#edf0f4' : '#171c24' },
        horzLines: { color: light ? '#edf0f4' : '#171c24' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: light ? '#8b96a5' : '#5d6878', width: 1, style: 3, labelBackgroundColor: light ? '#687586' : '#343c49' },
        horzLine: { color: light ? '#8b96a5' : '#5d6878', width: 1, style: 3, labelBackgroundColor: light ? '#687586' : '#343c49' },
      },
      rightPriceScale: {
        borderColor: light ? '#d9e0e8' : '#222833',
        scaleMargins: { top: 0.08, bottom: 0.24 },
      },
      timeScale: {
        borderColor: light ? '#d9e0e8' : '#222833',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 8,
        barSpacing: 8,
        minBarSpacing: 3,
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    })

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#0ecb81',
      downColor: '#f6465d',
      borderUpColor: '#0ecb81',
      borderDownColor: '#f6465d',
      wickUpColor: '#0ecb81',
      wickDownColor: '#f6465d',
      priceLineColor: '#dfe4ea',
      priceLineWidth: 1,
      lastValueVisible: false,
      priceLineVisible: false,
      priceFormat: {
        type: 'price',
        precision: pricePrecision,
        minMove: 10 ** -pricePrecision,
      },
    })

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      lastValueVisible: false,
      priceLineVisible: false,
    })
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })

    chartRef.current = chart
    candleSeriesRef.current = candleSeries
    volumeSeriesRef.current = volumeSeries
    setChartReady(true)

    return () => {
      setChartReady(false)
      chart.remove()
      chartRef.current = null
      candleSeriesRef.current = null
      volumeSeriesRef.current = null
    }
  }, [pricePrecision])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const light = theme === 'light'
    chart.applyOptions({
      layout: {
        background: { type: ColorType.Solid, color: light ? '#ffffff' : '#0b0e13' },
        textColor: light ? '#657083' : '#788394',
      },
      grid: {
        vertLines: { color: light ? '#edf0f4' : '#171c24' },
        horzLines: { color: light ? '#edf0f4' : '#171c24' },
      },
      crosshair: {
        vertLine: { color: light ? '#8b96a5' : '#5d6878', labelBackgroundColor: light ? '#687586' : '#343c49' },
        horzLine: { color: light ? '#8b96a5' : '#5d6878', labelBackgroundColor: light ? '#687586' : '#343c49' },
      },
      rightPriceScale: { borderColor: light ? '#d9e0e8' : '#222833' },
      timeScale: { borderColor: light ? '#d9e0e8' : '#222833' },
    })
  }, [theme])

  useEffect(() => {
    const series = candleSeriesRef.current
    const chart = chartRef.current
    if (!series || !chart || candles.length === 0) return
    series.setData(
      candles.map(({ time, open, high, low, close }) => ({
        time: time as Time,
        open,
        high,
        low,
        close,
      })),
    )
    volumeSeriesRef.current?.setData(
      candles.map(({ time, volume, open, close }) => ({
        time: time as Time,
        value: volume,
        color: close >= open ? 'rgba(14,203,129,.24)' : 'rgba(246,70,93,.24)',
      })),
    )
    if (initializedIntervalRef.current !== interval && candles.length > 10) {
      initializedIntervalRef.current = interval
      chart.timeScale().scrollToRealTime()
    }
  }, [candles, interval])

  useEffect(() => {
    const chart = chartRef.current
    const container = containerRef.current
    if (!chartReady || !chart || !container) return
    const update = () => setProjectionRevision((current) => current + 1)
    const observer = new ResizeObserver(update)
    observer.observe(container)
    chart.timeScale().subscribeVisibleLogicalRangeChange(update)
    container.addEventListener('wheel', update, { passive: true })
    container.addEventListener('pointermove', update, { passive: true })
    return () => {
      observer.disconnect()
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(update)
      container.removeEventListener('wheel', update)
      container.removeEventListener('pointermove', update)
    }
  }, [chartReady])

  const symbolPositions = useMemo(
    () => positions.filter((position) => normalizeInstrumentSymbol(position.symbol) === normalizeInstrumentSymbol(symbol) && Number(position.avgPrice) > 0),
    [positions, symbol],
  )

  const showOrderProtectionDraft = Boolean(
    orderProtectionDraft && normalizeInstrumentSymbol(orderProtectionDraft.symbol) === normalizeInstrumentSymbol(symbol)
    && orderProtectionDraft.quantity > 0
    && !symbolPositions.some((position) => (
      position.positionSide === orderProtectionDraft.direction
      && Math.abs(Number(position.positionAmt)) > 0
    )),
  )

  const protectionLines = useMemo(() => {
    const grouped = new Map<string, ProtectionLine>()
    for (const order of openOrders) {
      if (normalizeInstrumentSymbol(String(order.symbol ?? '')) !== normalizeInstrumentSymbol(symbol)) continue
      const type = String(order.type ?? '').toUpperCase()
      const kind: ProtectionKind | null = type.startsWith('TAKE_PROFIT')
        ? 'TAKE_PROFIT'
        : type.startsWith('STOP') ? 'STOP_LOSS' : null
      const price = Number(order.stopPrice)
      if (!kind || !(price > 0)) continue
      const orderId = String(order.orderId ?? order.orderID ?? '')
      if (!orderId) continue
      const orderSide = String(order.positionSide ?? '')
      const position = symbolPositions.find((item) => orderSide === item.positionSide)
        ?? (orderSide === 'BOTH' || !orderSide ? symbolPositions[0] : undefined)
      if (!position) continue
      const closesPosition = String(order.side ?? '').toUpperCase() === (position.positionSide === 'LONG' ? 'SELL' : 'BUY')
        && (
          orderSide !== 'BOTH'
          || String(order.closePosition ?? '').toLowerCase() === 'true'
          || String(order.reduceOnly ?? '').toLowerCase() === 'true'
          || String(order.clientOrderId ?? '').startsWith('antytilt-protect-')
        )
      if (!closesPosition) continue
      const workingType = String(order.workingType ?? 'MARK_PRICE') === 'CONTRACT_PRICE' ? 'CONTRACT_PRICE' : 'MARK_PRICE'
      const key = `${position.positionId}:${kind}:${price}:${workingType}`
      const originalQuantity = Number(order.origQty ?? order.quantity)
      const executedQuantity = Math.abs(Number(order.executedQty ?? 0))
      const quantity = Math.max(0, originalQuantity - executedQuantity)
      const current = grouped.get(key)
      const target = { orderId, quantity }
      grouped.set(key, current
        ? { ...current, orders: [...current.orders, target] }
        : { key, kind, price, position, workingType, orders: [target] })
    }
    return [...grouped.values()].map((line) => ({
      ...line,
      orders: [...line.orders].sort((left, right) => left.orderId.localeCompare(right.orderId)),
    }))
  }, [openOrders, symbol, symbolPositions])

  const coordinateForPrice = (price: number) => candleSeriesRef.current?.priceToCoordinate(price) ?? null

  const protectionPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingProtection || !event.currentTarget.hasPointerCapture(event.pointerId) || !containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const price = candleSeriesRef.current?.coordinateToPrice(event.clientY - rect.top - protectionPointerOffsetRef.current)
    if (price && price > 0) setDraggingProtection((current) => current ? { ...current, nextPrice: Number(price.toFixed(pricePrecision)) } : null)
  }

  const protectionPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingProtection) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    protectionPointerOffsetRef.current = 0
    setPendingProtection(draggingProtection)
    setDraggingProtection(null)
    setProtectionError(null)
  }

  const protectionPointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    protectionPointerOffsetRef.current = 0
    setDraggingProtection(null)
  }

  const openNewProtection = (position: ExchangePosition, kind: ProtectionKind) => {
    const current = exchangeReferencePrice && exchangeReferencePrice > 0 ? exchangeReferencePrice : Number(position.avgPrice)
    const long = position.positionSide === 'LONG'
    const multiplier = kind === 'TAKE_PROFIT'
      ? long ? 1.02 : 0.98
      : long ? 0.98 : 1.02
    const price = Number((current * multiplier).toFixed(pricePrecision))
    setPendingProtection({ key: `${position.positionId}:${kind}:new`, kind, price, nextPrice: price, position, workingType: 'MARK_PRICE', orders: [] })
    setProtectionError(null)
  }

  const confirmProtection = async (event: FormEvent) => {
    event.preventDefault()
    if (!pendingProtection || !onUpdateProtection || !(pendingProtection.nextPrice > 0)) return
    setProtectionError(null)
    try {
      await onUpdateProtection(pendingProtection.position.positionId, {
        ...(pendingProtection.targetOrderId ? { orderId: pendingProtection.targetOrderId } : {}),
        kind: pendingProtection.kind,
        stopPrice: pendingProtection.nextPrice,
        workingType: pendingProtection.workingType,
      })
      setPendingProtection(null)
    } catch (error) {
      setProtectionError(error instanceof Error ? error.message : `${executionVenue} rejected the protection change`)
    }
  }

  const editingTextDrawing = drawing.editingTextId
    ? drawing.drawings.find((item) => item.id === drawing.editingTextId && item.type === 'text')
    : undefined
  const editingTextPoint = editingTextDrawing ? drawing.project(editingTextDrawing.anchors[0]) : null

  const chartHeight = drawing.dimensions.height || containerRef.current?.clientHeight || 0
  const isVisibleCoordinate = (coordinate: number | null): coordinate is number => (
    coordinate !== null
    && Number.isFinite(coordinate)
    && coordinate >= 0
    && (chartHeight <= 0 || coordinate <= chartHeight - 24)
  )
  const latestChartPrice = Number(candles.at(-1)?.close ?? referencePrice)
  const latestChartCoordinate = coordinateForPrice(latestChartPrice)
  const currentPriceLevel = latestChartPrice > 0 && isVisibleCoordinate(latestChartCoordinate)
    ? { id: 'current-price', price: latestChartPrice, actualY: latestChartCoordinate }
    : null
  const positionLevels = symbolPositions.flatMap((position) => {
    const price = Number(position.avgPrice)
    const actualY = coordinateForPrice(price)
    return isVisibleCoordinate(actualY) ? [{ id: `position:${position.positionId}`, position, price, actualY }] : []
  })
  const activeProtectionLevels = protectionLines.flatMap((line) => {
    const active = draggingProtection?.key === line.key ? draggingProtection : null
    const price = active?.nextPrice ?? line.price
    const actualY = coordinateForPrice(price)
    if (!isVisibleCoordinate(actualY)) return []
    const quantity = line.orders.reduce((total, order) => total + order.quantity, 0)
      || Math.abs(Number(line.position.availableAmt || line.position.positionAmt))
    return [{
      id: `protection:${line.key}`,
      line,
      active,
      price,
      actualY,
      quantity,
      pnl: projectedPnl(line.position.positionSide, Number(line.position.avgPrice), price, quantity),
    }]
  })
  const draftProtectionLevels = showOrderProtectionDraft && orderProtectionDraft
    ? ([
        orderProtectionDraft.takeProfitPrice ? { kind: 'TAKE_PROFIT' as const, price: orderProtectionDraft.takeProfitPrice } : null,
        orderProtectionDraft.stopLossPrice ? { kind: 'STOP_LOSS' as const, price: orderProtectionDraft.stopLossPrice } : null,
      ]).filter((line): line is { kind: ProtectionKind; price: number } => Boolean(line)).flatMap((line) => {
        const actualY = coordinateForPrice(line.price)
        return isVisibleCoordinate(actualY) ? [{
          id: `draft:${line.kind}`,
          ...line,
          actualY,
          pnl: projectedPnl(orderProtectionDraft.direction, orderProtectionDraft.entryPrice, line.price, orderProtectionDraft.quantity),
        }] : []
      })
    : []
  const markerCoordinates = distributeVerticalMarkers([
    ...(currentPriceLevel ? [currentPriceLevel] : []),
    ...positionLevels,
    ...activeProtectionLevels,
    ...draftProtectionLevels,
  ], 14, Math.max(14, chartHeight - 34), 27)
  const markerOffset = (id: string, actualY: number) => (markerCoordinates.get(id) ?? actualY) - actualY
  const markerStyle = (actualY: number, offset: number) => ({
    top: actualY,
    '--marker-offset': `${offset}px`,
  } as CSSProperties)
  const connectorStyle = (offset: number) => ({
    top: Math.min(0, offset),
    height: Math.abs(offset),
  })
  const formatChartPrice = (price: number) => price.toLocaleString('en-US', {
    minimumFractionDigits: Math.min(pricePrecision, 2),
    maximumFractionDigits: pricePrecision,
  })

  return (
    <section className="chart-panel panel">
      <div className="chart-head panel-head">
        <div className="chart-tabs">
          <button className="panel-tab active">Chart</button>
          <button className="panel-tab">Overview</button>
          <button className="panel-tab">Trading data</button>
        </div>
        <div className="chart-controls">
          {intervals.map((item) => (
            <button
              key={item}
              className={`timeframe ${item === interval ? 'active' : ''}`}
              onClick={() => onIntervalChange(item)}
            >
              {item}
            </button>
          ))}
          <span className="control-divider" />
          <button className="control-text">Indicators</button>
          <button
            className={`control-text objects-control ${drawing.objectsOpen ? 'active' : ''}`}
            onClick={() => drawing.setObjectsOpen(!drawing.objectsOpen)}
          >
            <Layers3 size={13} /> Objects {drawing.drawings.length > 0 && <i>{drawing.drawings.length}</i>}
          </button>
          <button className="icon-button" aria-label="Reset chart" title="Fit chart" onClick={() => chartRef.current?.timeScale().fitContent()}>
            <RotateCcw size={14} />
          </button>
        </div>
      </div>
      <div className="chart-body">
        <DrawingToolbar
          activeTool={drawing.activeTool}
          onSelect={drawing.setActiveTool}
          onOpenMenu={() => drawing.setSelectedId(null)}
          history={{
            canUndo: drawing.canUndo,
            canRedo: drawing.canRedo,
            magnetEnabled: drawing.magnetEnabled,
            keepDrawing: drawing.keepDrawing,
            onUndo: drawing.undo,
            onRedo: drawing.redo,
            onMagnet: () => drawing.setMagnetEnabled(!drawing.magnetEnabled),
            onKeepDrawing: () => drawing.setKeepDrawing(!drawing.keepDrawing),
          }}
        />
        <div className="chart-viewport">
          <div ref={containerRef} className={`chart-canvas ${drawing.activeTool !== 'cursor' ? 'drawing-active' : ''}`} />
          {candles.length === 0 && (
            <div className="chart-data-state">
              <span className={marketStatus === 'connecting' ? 'button-spinner' : ''}>{marketStatus !== 'connecting' && <ChartNoAxesColumnIncreasing size={19} />}</span>
              <strong>{marketStatus === 'connecting' ? `Connecting to ${sourceLabel}…` : 'Market data unavailable'}</strong>
              <small>{marketError || 'The terminal will reconnect automatically. No synthetic candles are displayed.'}</small>
            </div>
          )}
          <DrawingOverlay
            drawings={drawing.visibleDrawings}
            previewDrawing={drawing.previewDrawing}
            selectedId={drawing.selectedId}
            dimensions={drawing.dimensions}
            project={drawing.project}
            candles={candles}
            activeTool={drawing.activeTool}
            onSelect={drawing.setSelectedId}
            onEditText={drawing.setEditingTextId}
            onStartDrag={drawing.startDrag}
            onPlaceAnchor={drawing.placeAnchor}
            onMovePreview={drawing.movePreview}
            onFinishPlacement={drawing.finishPlacement}
            onCancelPlacement={drawing.cancelPlacement}
          />
          {currentPriceLevel && (() => {
            const offset = markerOffset(currentPriceLevel.id, currentPriceLevel.actualY)
            return <div
              className={`chart-trade-level current-price ${priceDirection}`}
              data-trade-level="current"
              style={markerStyle(currentPriceLevel.actualY, offset)}
            >
              <span className="chart-trade-level-line" />
              {Math.abs(offset) > 1 && <i className="chart-trade-level-connector" style={connectorStyle(offset)} />}
              <span
                className="chart-trade-level-label"
                data-tooltip={`Current chart price\n${formatChartPrice(currentPriceLevel.price)} ${quoteAsset}\nSource: ${sourceLabel}`}
              ><strong>{formatChartPrice(currentPriceLevel.price)}</strong></span>
            </div>
          })()}
          {positionLevels.map((level) => {
            const offset = markerOffset(level.id, level.actualY)
            const directionClass = level.position.positionSide === 'LONG' ? 'long' : 'short'
            const currency = level.position.currency || 'USDT'
            return <div
              className={`chart-trade-level position-level ${directionClass}`}
              data-trade-level="position"
              data-position-side={level.position.positionSide}
              key={level.id}
              style={markerStyle(level.actualY, offset)}
            >
              <span className="chart-trade-level-line" />
              {Math.abs(offset) > 1 && <i className="chart-trade-level-connector" style={connectorStyle(offset)} />}
              <span
                className="chart-trade-level-label"
                data-tooltip={`${level.position.positionSide} position\nEntry: ${formatChartPrice(level.price)} ${quoteAsset}\nSize: ${formatChartQuantity(Math.abs(Number(level.position.positionAmt)))}\nUnrealized P&L: ${formatProjectedPnl(Number(level.position.unrealizedProfit), currency)}\nLeverage: ${level.position.leverage}x`}
              >
                <strong>{level.position.positionSide} {formatChartQuantity(Math.abs(Number(level.position.positionAmt)))}</strong>
                <b aria-hidden="true">|</b>
                <span>{formatChartPrice(level.price)}</span>
              </span>
            </div>
          })}
          <div className="position-protection-tools">
            {symbolPositions.map((position) => {
              const hasTp = protectionLines.some((line) => line.position.positionId === position.positionId && line.kind === 'TAKE_PROFIT')
              const hasSl = protectionLines.some((line) => line.position.positionId === position.positionId && line.kind === 'STOP_LOSS')
              return <div key={position.positionId}><span className={position.positionSide === 'LONG' ? 'up' : 'down'}>{position.positionSide}</span>{!hasTp && <button type="button" disabled={!onUpdateProtection || protectionBusy} onClick={() => openNewProtection(position, 'TAKE_PROFIT')}>+ TP</button>}{!hasSl && <button type="button" disabled={!onUpdateProtection || protectionBusy} onClick={() => openNewProtection(position, 'STOP_LOSS')}>+ SL</button>}</div>
            })}
          </div>
          {activeProtectionLevels.map((level) => {
            const { line } = level
            const offset = markerOffset(level.id, level.actualY)
            const currency = line.position.currency || 'USDT'
            const kindLabel = line.kind === 'TAKE_PROFIT' ? 'TP' : 'SL'
            const fullKindLabel = protectionLabel(line.kind)
            const tooltip = `${fullKindLabel} · ${line.position.positionSide}\nTrigger: ${formatChartPrice(level.price)} ${quoteAsset}\nEstimated P&L: ${formatProjectedPnl(level.pnl, currency)}\nTrigger by: ${line.workingType === 'MARK_PRICE' ? 'Mark price' : 'Last price'}\n${!existingProtectionEditable ? 'Cancel explicitly in Open Orders before creating a replacement' : line.orders.length > 1 ? `${line.orders.length} exchange orders` : 'Drag to modify'}`
            return <div
              className={`chart-trade-level trade-protection-line ${line.kind === 'TAKE_PROFIT' ? 'take-profit' : 'stop-loss'} ${level.active ? 'dragging' : ''}`}
              data-trade-level="protection"
              key={line.key}
              style={markerStyle(level.actualY, offset)}
              onPointerDown={(event) => {
                if (!onUpdateProtection || protectionBusy || !existingProtectionEditable) return
                event.preventDefault()
                const rect = containerRef.current?.getBoundingClientRect()
                protectionPointerOffsetRef.current = rect ? event.clientY - rect.top - level.actualY : 0
                event.currentTarget.setPointerCapture(event.pointerId)
                setDraggingProtection({
                  ...line,
                  nextPrice: line.price,
                  targetOrderId: line.orders.length === 1 ? line.orders[0].orderId : undefined,
                })
                setProtectionError(null)
              }}
              onPointerMove={protectionPointerMove}
              onPointerUp={protectionPointerUp}
              onPointerCancel={protectionPointerCancel}
            >
              <span className="chart-trade-level-line" />
              <span className="chart-trade-level-hit" title={existingProtectionEditable ? `Drag ${fullKindLabel} to a new price` : 'Cancel in Open Orders before creating a replacement'} />
              {Math.abs(offset) > 1 && <i className="chart-trade-level-connector" style={connectorStyle(offset)} />}
              <span className="chart-trade-level-label" data-tooltip={tooltip}>
                <strong>ACTIVE {kindLabel} · {line.position.positionSide}</strong>
                <b aria-hidden="true">|</b>
                <span>{formatChartPrice(level.price)}</span>
                <b aria-hidden="true">|</b>
                <small className={level.pnl >= 0 ? 'profit' : 'loss'}>{formatProjectedPnl(level.pnl, currency)}</small>
              </span>
            </div>
          })}
          {orderProtectionDraft && draftProtectionLevels.map((level) => {
            const offset = markerOffset(level.id, level.actualY)
            const kindLabel = level.kind === 'TAKE_PROFIT' ? 'TP' : 'SL'
            return <div
              className={`chart-trade-level trade-protection-line order-draft ${level.kind === 'TAKE_PROFIT' ? 'take-profit' : 'stop-loss'}`}
              data-trade-level="draft-protection"
              key={level.id}
              style={markerStyle(level.actualY, offset)}
            >
              <span className="chart-trade-level-line" />
              {Math.abs(offset) > 1 && <i className="chart-trade-level-connector" style={connectorStyle(offset)} />}
              <span
                className="chart-trade-level-label"
                data-tooltip={`${protectionLabel(level.kind)} preview · ${orderProtectionDraft.direction}\nTrigger: ${formatChartPrice(level.price)} ${quoteAsset}\nEstimated P&L: ${formatProjectedPnl(level.pnl, quoteAsset)}\nNot sent to the exchange`}
              >
                <strong>DRAFT {kindLabel} · {orderProtectionDraft.direction}</strong>
                <b aria-hidden="true">|</b>
                <span>{formatChartPrice(level.price)}</span>
                <b aria-hidden="true">|</b>
                <small className={level.pnl >= 0 ? 'profit' : 'loss'}>{formatProjectedPnl(level.pnl)}</small>
              </span>
            </div>
          })}
          <a
            className="chart-attribution"
            href="https://www.tradingview.com/"
            target="_blank"
            rel="noreferrer"
          >
            Charts by TradingView
          </a>
          {drawing.activeTool !== 'cursor' && (
            <div className="draw-hint">
              <Crosshair size={13} />
              <span><strong>{drawing.toolName}</strong>{drawingHint(drawing.activeTool, drawing.currentStep, drawing.totalSteps)}</span>
              {drawing.magnetEnabled && <small>MAGNET</small>}
            </div>
          )}
          {drawing.selectedDrawing && !drawing.draggingDrawingId && drawing.editingTextId !== drawing.selectedDrawing.id && <DrawingProperties
            drawing={drawing.selectedDrawing}
            onUpdate={drawing.updateDrawing}
            onDuplicate={drawing.duplicateDrawing}
            onDelete={drawing.deleteDrawing}
            onClose={() => drawing.setSelectedId(null)}
          />}
          {editingTextDrawing && editingTextPoint && <InlineTextEditor
            drawing={editingTextDrawing}
            point={editingTextPoint}
            dimensions={drawing.dimensions}
            onSave={(text) => {
              drawing.updateDrawing(editingTextDrawing.id, { text })
              drawing.setEditingTextId(null)
            }}
            onCancel={() => drawing.setEditingTextId(null)}
          />}
          {drawing.objectsOpen && <DrawingObjectsPanel
            drawings={drawing.drawings}
            selectedId={drawing.selectedId}
            importRef={drawing.importRef}
            onSelect={drawing.setSelectedId}
            onUpdate={drawing.updateDrawing}
            onDelete={drawing.deleteDrawing}
            onClear={drawing.clearAll}
            onExport={drawing.exportDrawings}
            onImport={drawing.importDrawings}
            onClose={() => drawing.setObjectsOpen(false)}
          />}
          {pendingProtection && <div className="chart-trade-modal-layer" role="dialog" aria-modal="true" aria-label={`Confirm ${protectionLabel(pendingProtection.kind)}`}>
            <button className="chart-trade-modal-scrim" type="button" onClick={() => !protectionBusy && setPendingProtection(null)} />
            <form className="chart-trade-modal" onSubmit={confirmProtection}>
              <header><div><ShieldCheck size={18} /><span><strong>Modify {protectionLabel(pendingProtection.kind)}</strong><small>{pendingProtection.position.symbol} · {pendingProtection.position.positionSide} · {executionVenue}</small></span></div><button type="button" disabled={protectionBusy} onClick={() => setPendingProtection(null)}><X size={16} /></button></header>
              <div className="chart-trade-modal-body">
                <div className="protection-price-change"><span>Current<strong>{pendingProtection.price.toLocaleString('en-US', { maximumFractionDigits: pricePrecision })}</strong></span><span>New trigger<strong className={pendingProtection.kind === 'TAKE_PROFIT' ? 'up' : 'down'}>{pendingProtection.nextPrice.toLocaleString('en-US', { maximumFractionDigits: pricePrecision })}</strong></span></div>
                {pendingProtection.orders.length > 1 && <label><span>Protection order</span><select value={pendingProtection.targetOrderId ?? ''} onChange={(event) => setPendingProtection((current) => current ? { ...current, targetOrderId: event.target.value || undefined } : null)}><option value="">Choose the quantity to modify</option>{pendingProtection.orders.map((order) => <option value={order.orderId} key={order.orderId}>{formatChartQuantity(order.quantity)} {pendingProtection.position.symbol.split('-')[0]} · #{order.orderId.slice(-8)}</option>)}</select></label>}
                {pendingProtection.orders.length === 1 && <p>Protection quantity: <strong>{formatChartQuantity(pendingProtection.orders[0].quantity)} {pendingProtection.position.symbol.split('-')[0]}</strong></p>}
                {pendingProtection.orders.length > 1 && <p>This price level contains {pendingProtection.orders.length} independent protection orders. Choose the exact quantity you want to move; the others will remain unchanged.</p>}
                <label><span>Trigger price</span><input className="number-clean" type="number" min="0" step={10 ** -pricePrecision} value={pendingProtection.nextPrice} onChange={(event) => setPendingProtection((current) => current ? { ...current, nextPrice: Number(event.target.value) } : null)} /></label>
                <label><span>Trigger by</span><select value={pendingProtection.workingType} onChange={(event) => setPendingProtection((current) => current ? { ...current, workingType: event.target.value as ProtectionWorkingType } : null)}><option value="MARK_PRICE">Mark Price</option>{!markPriceOnly && <option value="CONTRACT_PRICE">Last Price</option>}</select></label>
                <p>{existingProtectionEditable ? `The original order remains active until ${executionVenue} confirms the replacement.` : 'New protection requires a wallet signature. Existing protection must be cancelled explicitly before replacement.'}</p>
                {protectionError && <div className="exchange-error">{protectionError}</div>}
              </div>
              <footer><button type="button" disabled={protectionBusy} onClick={() => setPendingProtection(null)}>Cancel</button><button className={pendingProtection.kind === 'TAKE_PROFIT' ? 'confirm-tp' : 'confirm-sl'} disabled={protectionBusy || !(pendingProtection.nextPrice > 0) || (pendingProtection.orders.length > 1 && !pendingProtection.targetOrderId)}>{protectionBusy ? `Updating on ${executionVenue}…` : `Confirm ${pendingProtection.kind === 'TAKE_PROFIT' ? 'TP' : 'SL'}`}</button></footer>
            </form>
          </div>}
        </div>
      </div>
    </section>
  )
}
