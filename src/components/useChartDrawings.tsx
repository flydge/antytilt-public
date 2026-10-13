import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import type { IChartApi, ISeriesApi, Logical, MouseEventParams, Time, UTCTimestamp } from 'lightweight-charts'
import {
  Copy,
  Download,
  Eye,
  EyeOff,
  Lock,
  Magnet,
  Pin,
  Redo2,
  Trash2,
  Undo2,
  Unlock,
  Upload,
  X,
} from 'lucide-react'
import type { Candle } from '../types'

export type DrawingTool =
  | 'cursor'
  | 'trend'
  | 'ray'
  | 'horizontal'
  | 'vertical'
  | 'fib'
  | 'rectangle'
  | 'measure'
  | 'long'
  | 'short'
  | 'text'

type DrawingAnchor = {
  time: number
  price: number
  logical?: number
}

type DrawingStyle = {
  color: string
  lineWidth: number
  lineStyle: 'solid' | 'dashed' | 'dotted'
  fillOpacity: number
}

export type ChartDrawing = {
  id: string
  type: Exclude<DrawingTool, 'cursor'>
  anchors: DrawingAnchor[]
  style: DrawingStyle
  locked: boolean
  hidden: boolean
  text?: string
  createdAt: number
}

type Dimensions = { width: number; height: number }
type Point = { x: number; y: number }

type DragState = {
  drawingId: string
  anchorIndex: number | null
  start: Point
  original: ChartDrawing
  snapshot: ChartDrawing[]
  projectedAnchors: Array<Point | null>
  moved: boolean
}

type PlacementGesture = {
  tool: 'measure'
  pointerId: number
  start: Point
  dragged: boolean
}

const DEFAULT_STYLE: DrawingStyle = {
  color: '#f3b83c',
  lineWidth: 1,
  lineStyle: 'solid',
  fillOpacity: 0.1,
}

const TOOL_NAMES: Record<ChartDrawing['type'], string> = {
  trend: 'Trend line',
  ray: 'Ray',
  horizontal: 'Horizontal line',
  vertical: 'Vertical line',
  fib: 'Fibonacci retracement',
  rectangle: 'Rectangle',
  measure: 'Price range',
  long: 'Long position',
  short: 'Short position',
  text: 'Text note',
}

const TOOL_ANCHORS: Record<Exclude<DrawingTool, 'cursor'>, number> = {
  trend: 2,
  ray: 2,
  horizontal: 1,
  vertical: 1,
  fib: 2,
  rectangle: 2,
  measure: 2,
  long: 3,
  short: 3,
  text: 1,
}

const palette = ['#f3b83c', '#ffffff', '#0ecb81', '#f6465d', '#4b8df8', '#a978ed']
const PRICE_SCALE_GUTTER = 55
const TIME_SCALE_GUTTER = 25
const MAGNET_RADIUS = 14

function typicalCandleInterval(candles: Candle[]) {
  const intervals = candles
    .slice(-80)
    .map((candle, index, source) => index === 0 ? 0 : candle.time - source[index - 1].time)
    .filter((value) => value > 0)
    .sort((left, right) => left - right)
  return intervals[Math.floor(intervals.length / 2)] ?? 60
}

function cloneDrawings(drawings: ChartDrawing[]) {
  return drawings.map((drawing) => ({
    ...drawing,
    anchors: drawing.anchors.map((anchor) => ({ ...anchor })),
    style: { ...drawing.style },
  }))
}

function loadDrawings(storageKey: string): ChartDrawing[] {
  try {
    const spotKey = storageKey.includes(':PERPETUAL:') ? storageKey.replace(':PERPETUAL:', ':SPOT:') : null
    const legacyKey = storageKey.endsWith(':BTCUSDT:v2') ? 'antytilt:drawings:BTCUSDT:v2' : null
    const stored = localStorage.getItem(storageKey)
      ?? (spotKey ? localStorage.getItem(spotKey) : null)
      ?? (legacyKey ? localStorage.getItem(legacyKey) : null)
    if (!stored) return []
    const parsed = JSON.parse(stored) as ChartDrawing[]
    if (!Array.isArray(parsed)) return []
    return parsed.filter((drawing) => drawing.id && drawing.type && Array.isArray(drawing.anchors))
  } catch {
    return []
  }
}

function timeToNumber(time: Time): number {
  if (typeof time === 'number') return time
  if (typeof time === 'string') return Math.floor(new Date(`${time}T00:00:00Z`).getTime() / 1000)
  return Math.floor(Date.UTC(time.year, time.month - 1, time.day) / 1000)
}

function dashArray(style: DrawingStyle['lineStyle']) {
  if (style === 'dashed') return '7 5'
  if (style === 'dotted') return '2 4'
  return undefined
}

function alpha(hex: string, opacity: number) {
  const clean = hex.replace('#', '')
  if (clean.length !== 6) return `rgba(243,184,60,${opacity})`
  const value = Number.parseInt(clean, 16)
  return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${opacity})`
}

function formatMeasurementNumber(value: number) {
  const absolute = Math.abs(value)
  const digits = absolute >= 1_000 ? 2 : absolute >= 1 ? 4 : 6
  return value.toLocaleString('en-US', { maximumFractionDigits: digits })
}

function formatMeasurementDuration(seconds: number) {
  const value = Math.max(0, Math.round(seconds))
  if (value < 60) return `${value}s`
  const minutes = Math.floor(value / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

function nearlyEqualDrawings(left: ChartDrawing[], right: ChartDrawing[]) {
  return JSON.stringify(left) === JSON.stringify(right)
}

type HookOptions = {
  chartRef: RefObject<IChartApi | null>
  seriesRef: RefObject<ISeriesApi<'Candlestick'> | null>
  containerRef: RefObject<HTMLDivElement | null>
  candles: Candle[]
  enabled: boolean
  storageKey: string
  exportSymbol: string
}

export function useChartDrawings({ chartRef, seriesRef, containerRef, candles, enabled, storageKey, exportSymbol }: HookOptions) {
  const [drawings, setDrawings] = useState<ChartDrawing[]>(() => loadDrawings(storageKey))
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [activeTool, setActiveToolState] = useState<DrawingTool>('cursor')
  const [pendingAnchors, setPendingAnchors] = useState<DrawingAnchor[]>([])
  const [previewAnchor, setPreviewAnchor] = useState<DrawingAnchor | null>(null)
  const [magnetEnabled, setMagnetEnabled] = useState(true)
  const [keepDrawing, setKeepDrawing] = useState(false)
  const [objectsOpen, setObjectsOpen] = useState(false)
  const [editingTextId, setEditingTextId] = useState<string | null>(null)
  const [draggingDrawingId, setDraggingDrawingId] = useState<string | null>(null)
  const [dimensions, setDimensions] = useState<Dimensions>({ width: 0, height: 0 })
  const [, setViewportRevision] = useState(0)
  const [past, setPast] = useState<ChartDrawing[][]>([])
  const [future, setFuture] = useState<ChartDrawing[][]>([])

  const drawingsRef = useRef(drawings)
  const activeToolRef = useRef(activeTool)
  const pendingRef = useRef(pendingAnchors)
  const previewRef = useRef(previewAnchor)
  const magnetRef = useRef(magnetEnabled)
  const keepDrawingRef = useRef(keepDrawing)
  const candlesRef = useRef(candles)
  const dragRef = useRef<DragState | null>(null)
  const placementGestureRef = useRef<PlacementGesture | null>(null)
  const importRef = useRef<HTMLInputElement>(null)
  const pastRef = useRef(past)
  const futureRef = useRef(future)

  drawingsRef.current = drawings
  activeToolRef.current = activeTool
  pendingRef.current = pendingAnchors
  previewRef.current = previewAnchor
  magnetRef.current = magnetEnabled
  keepDrawingRef.current = keepDrawing
  candlesRef.current = candles
  pastRef.current = past
  futureRef.current = future

  useEffect(() => {
    const timer = window.setTimeout(() => localStorage.setItem(storageKey, JSON.stringify(drawings)), 120)
    return () => window.clearTimeout(timer)
  }, [drawings, storageKey])

  const pushHistory = useCallback((snapshot: ChartDrawing[]) => {
    const nextPast = [...pastRef.current.slice(-79), cloneDrawings(snapshot)]
    pastRef.current = nextPast
    futureRef.current = []
    setPast(nextPast)
    setFuture([])
  }, [])

  const commit = useCallback((next: ChartDrawing[] | ((current: ChartDrawing[]) => ChartDrawing[])) => {
    const before = drawingsRef.current
    const resolved = typeof next === 'function' ? next(before) : next
    if (nearlyEqualDrawings(before, resolved)) return
    pushHistory(before)
    drawingsRef.current = resolved
    setDrawings(resolved)
  }, [pushHistory])

  const undo = useCallback(() => {
    const previous = pastRef.current.at(-1)
    if (!previous) return
    const nextPast = pastRef.current.slice(0, -1)
    const nextFuture = [cloneDrawings(drawingsRef.current), ...futureRef.current.slice(0, 79)]
    const restored = cloneDrawings(previous)
    pastRef.current = nextPast
    futureRef.current = nextFuture
    drawingsRef.current = restored
    setPast(nextPast)
    setFuture(nextFuture)
    setDrawings(restored)
    setSelectedId(null)
  }, [])

  const redo = useCallback(() => {
    const next = futureRef.current[0]
    if (!next) return
    const nextPast = [...pastRef.current.slice(-79), cloneDrawings(drawingsRef.current)]
    const nextFuture = futureRef.current.slice(1)
    const restored = cloneDrawings(next)
    pastRef.current = nextPast
    futureRef.current = nextFuture
    drawingsRef.current = restored
    setPast(nextPast)
    setFuture(nextFuture)
    setDrawings(restored)
    setSelectedId(null)
  }, [])

  const setActiveTool = useCallback((tool: DrawingTool) => {
    activeToolRef.current = tool
    placementGestureRef.current = null
    pendingRef.current = []
    previewRef.current = null
    setPendingAnchors([])
    setPreviewAnchor(null)
    setActiveToolState(tool)
    if (tool !== 'cursor') setSelectedId(null)
  }, [])

  const cancelAction = useCallback(() => {
    placementGestureRef.current = null
    if (pendingRef.current.length > 0) {
      pendingRef.current = []
      previewRef.current = null
      setPendingAnchors([])
      setPreviewAnchor(null)
      return
    }
    setActiveTool('cursor')
    setSelectedId(null)
  }, [setActiveTool])

  const project = useCallback((anchor: DrawingAnchor): Point | null => {
    const chart = chartRef.current
    const series = seriesRef.current
    if (!chart || !series) return null
    const timeScale = chart.timeScale()
    const timeCoordinate = timeScale.timeToCoordinate(anchor.time as UTCTimestamp)
    const x = timeCoordinate ?? (Number.isFinite(anchor.logical) ? timeScale.logicalToCoordinate(anchor.logical as Logical) : null)
    const y = series.priceToCoordinate(anchor.price)
    if (x === null || y === null) return null
    return { x, y }
  }, [chartRef, seriesRef])

  const coordinateToAnchor = useCallback((point: Point, snap = magnetRef.current): DrawingAnchor | null => {
    const chart = chartRef.current
    const series = seriesRef.current
    const container = containerRef.current
    if (!chart || !series || !container) return null
    const timeScale = chart.timeScale()
    const plotPoint = {
      x: Math.max(0, Math.min(Math.max(0, container.clientWidth - PRICE_SCALE_GUTTER), point.x)),
      y: Math.max(0, Math.min(Math.max(0, container.clientHeight - TIME_SCALE_GUTTER), point.y)),
    }
    const logical = timeScale.coordinateToLogical(plotPoint.x)
    const time = timeScale.coordinateToTime(plotPoint.x)
    const price = series.coordinateToPrice(plotPoint.y)
    if (logical === null || price === null) return null

    let timeNumber: number
    if (time !== null) {
      timeNumber = timeToNumber(time)
    } else {
      const source = candlesRef.current
      if (source.length === 0) return null
      const first = source[0]
      const last = source.at(-1) as Candle
      const endpoints = [first, last].map((candle) => {
        const coordinate = timeScale.timeToCoordinate(candle.time as UTCTimestamp)
        return { candle, logical: coordinate === null ? null : timeScale.coordinateToLogical(coordinate) }
      }).filter((item): item is { candle: Candle; logical: Logical } => item.logical !== null)
      if (endpoints.length === 0) return null
      const reference = endpoints.reduce((closest, item) => Math.abs(Number(item.logical) - Number(logical)) < Math.abs(Number(closest.logical) - Number(logical)) ? item : closest)
      timeNumber = Math.round(reference.candle.time + (Number(logical) - Number(reference.logical)) * typicalCandleInterval(source))
    }

    const rawAnchor: DrawingAnchor = {
      time: timeNumber,
      price: Number(price),
      // Preserve the visual position as well as time. Lightweight Charts can
      // return null for future timestamps until new bars arrive; the logical
      // coordinate keeps drawings stable in that whitespace in the meantime.
      logical: Number(logical),
    }
    if (!snap || candlesRef.current.length === 0) return rawAnchor

    let closestCandle: Candle | null = null
    let closestXDistance = Number.POSITIVE_INFINITY
    for (const candle of candlesRef.current) {
      const coordinate = timeScale.timeToCoordinate(candle.time as UTCTimestamp)
      if (coordinate === null) continue
      const distance = Math.abs(coordinate - plotPoint.x)
      if (distance < closestXDistance) {
        closestCandle = candle
        closestXDistance = distance
      }
    }
    if (!closestCandle || closestXDistance > MAGNET_RADIUS) return rawAnchor

    let snappedPrice: number | null = null
    let closestPointDistance = MAGNET_RADIUS
    for (const candidate of [closestCandle.open, closestCandle.high, closestCandle.low, closestCandle.close]) {
      const coordinate = series.priceToCoordinate(candidate)
      if (coordinate === null) continue
      const distance = Math.hypot(closestXDistance, coordinate - plotPoint.y)
      if (distance < closestPointDistance) {
        closestPointDistance = distance
        snappedPrice = candidate
      }
    }
    return snappedPrice === null ? rawAnchor : { time: closestCandle.time, price: snappedPrice }
  }, [chartRef, containerRef, seriesRef])

  const createDrawing = useCallback((tool: Exclude<DrawingTool, 'cursor'>, anchors: DrawingAnchor[]) => {
    const id = `${tool}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const color = tool === 'long' ? '#0ecb81' : tool === 'short' ? '#f6465d' : DEFAULT_STYLE.color
    const drawing: ChartDrawing = {
      id,
      type: tool,
      anchors,
      style: { ...DEFAULT_STYLE, color },
      locked: false,
      hidden: false,
      text: tool === 'text' ? 'Note' : undefined,
      createdAt: Date.now(),
    }
    commit([...drawingsRef.current, drawing])
    setSelectedId(id)
    if (tool === 'text') setEditingTextId(id)
  }, [commit])

  const placeAnchorAtPoint = useCallback((point: Point) => {
    const tool = activeToolRef.current
    if (tool === 'cursor') return
    const anchor = coordinateToAnchor(point)
    if (!anchor) return
    const nextAnchors = [...pendingRef.current, anchor]
    const required = TOOL_ANCHORS[tool]
    if (nextAnchors.length < required) {
      pendingRef.current = nextAnchors
      setPendingAnchors(nextAnchors)
      return
    }
    createDrawing(tool, nextAnchors.slice(0, required))
    pendingRef.current = []
    previewRef.current = null
    setPendingAnchors([])
    setPreviewAnchor(null)
    if (!keepDrawingRef.current) setActiveTool('cursor')
  }, [coordinateToAnchor, createDrawing, setActiveTool])

  const placeAnchor = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    const tool = activeToolRef.current
    if (tool === 'cursor') return
    event.preventDefault()
    const container = containerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top }
    const startsMeasureGesture = tool === 'measure' && pendingRef.current.length === 0
    if (startsMeasureGesture) {
      placementGestureRef.current = {
        tool: 'measure',
        pointerId: event.pointerId,
        start: point,
        dragged: false,
      }
      try {
        event.currentTarget.setPointerCapture?.(event.pointerId)
      } catch {
        // Synthetic pointer events used by tests may not own an active pointer.
      }
    } else {
      placementGestureRef.current = null
    }
    placeAnchorAtPoint(point)
  }, [containerRef, placeAnchorAtPoint])

  const movePreview = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    if (activeToolRef.current === 'cursor' || pendingRef.current.length === 0) return
    const container = containerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top }
    const gesture = placementGestureRef.current
    if (gesture?.pointerId === event.pointerId && Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y) >= 4) {
      gesture.dragged = true
    }
    const anchor = coordinateToAnchor(point)
    previewRef.current = anchor
    setPreviewAnchor(anchor)
  }, [containerRef, coordinateToAnchor])

  const finishPlacement = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    const gesture = placementGestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    placementGestureRef.current = null
    if (!gesture.dragged || activeToolRef.current !== 'measure' || pendingRef.current.length !== 1) return
    event.preventDefault()
    const container = containerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    placeAnchorAtPoint({ x: event.clientX - rect.left, y: event.clientY - rect.top })
  }, [containerRef, placeAnchorAtPoint])

  const cancelPlacement = useCallback(() => {
    placementGestureRef.current = null
  }, [])

  useEffect(() => {
    if (!enabled) return
    const chart = chartRef.current
    if (!chart) return

    const handleClick = (param: MouseEventParams<Time>) => {
      if (activeToolRef.current === 'cursor' && param.point) setSelectedId(null)
    }

    chart.subscribeClick(handleClick)
    return () => chart.unsubscribeClick(handleClick)
  }, [enabled, chartRef])

  useEffect(() => {
    if (!enabled) return
    const chart = chartRef.current
    const container = containerRef.current
    if (!chart || !container) return
    const refresh = () => setViewportRevision((revision) => revision + 1)
    const observer = new ResizeObserver(() => {
      const rect = container.getBoundingClientRect()
      setDimensions({ width: rect.width, height: rect.height })
      refresh()
    })
    observer.observe(container)
    const rect = container.getBoundingClientRect()
    setDimensions({ width: rect.width, height: rect.height })
    chart.timeScale().subscribeVisibleLogicalRangeChange(refresh)
    return () => {
      observer.disconnect()
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(refresh)
    }
  }, [enabled, chartRef, containerRef])

  const startDrag = useCallback((
    event: ReactPointerEvent<SVGElement>,
    drawingId: string,
    anchorIndex: number | null,
  ) => {
    event.preventDefault()
    event.stopPropagation()
    const drawing = drawingsRef.current.find((item) => item.id === drawingId)
    const container = containerRef.current
    if (!drawing || !container) return
    setSelectedId(drawingId)
    if (drawing.locked) return
    setDraggingDrawingId(drawingId)
    const rect = container.getBoundingClientRect()
    dragRef.current = {
      drawingId,
      anchorIndex,
      start: { x: event.clientX - rect.left, y: event.clientY - rect.top },
      original: cloneDrawings([drawing])[0],
      snapshot: cloneDrawings(drawingsRef.current),
      projectedAnchors: drawing.anchors.map(project),
      moved: false,
    }
  }, [containerRef, project])

  useEffect(() => {
    const handleMove = (event: PointerEvent) => {
      const drag = dragRef.current
      const container = containerRef.current
      if (!drag || !container) return
      const rect = container.getBoundingClientRect()
      const currentPoint = { x: event.clientX - rect.left, y: event.clientY - rect.top }
      const dx = currentPoint.x - drag.start.x
      const dy = currentPoint.y - drag.start.y
      if (Math.abs(dx) + Math.abs(dy) < 1) return
      drag.moved = true

      let anchors = drag.original.anchors
      if (drag.anchorIndex !== null) {
        const anchor = coordinateToAnchor(currentPoint, magnetRef.current)
        if (!anchor) return
        anchors = drag.original.anchors.map((item, index) => index === drag.anchorIndex ? anchor : item)
      } else {
        anchors = drag.original.anchors.map((item, index) => {
          const originalPoint = drag.projectedAnchors[index]
          if (!originalPoint) return item
          return coordinateToAnchor({ x: originalPoint.x + dx, y: originalPoint.y + dy }, false) ?? item
        })
      }
      const nextDrawings = drawingsRef.current.map((drawing) => drawing.id === drag.drawingId ? { ...drawing, anchors } : drawing)
      drawingsRef.current = nextDrawings
      setDrawings(nextDrawings)
    }

    const handleUp = () => {
      const drag = dragRef.current
      if (drag && drag.moved && !nearlyEqualDrawings(drag.snapshot, drawingsRef.current)) pushHistory(drag.snapshot)
      dragRef.current = null
      setDraggingDrawingId(null)
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    window.addEventListener('pointercancel', handleUp)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      window.removeEventListener('pointercancel', handleUp)
    }
  }, [containerRef, coordinateToAnchor, pushHistory])

  const deleteDrawing = useCallback((id: string) => {
    commit(drawingsRef.current.filter((drawing) => drawing.id !== id))
    setSelectedId((current) => current === id ? null : current)
    setEditingTextId((current) => current === id ? null : current)
  }, [commit])

  const deleteSelected = useCallback(() => {
    if (selectedId) deleteDrawing(selectedId)
  }, [deleteDrawing, selectedId])

  const updateDrawing = useCallback((id: string, patch: Partial<ChartDrawing>) => {
    commit(drawingsRef.current.map((drawing) => drawing.id === id ? {
      ...drawing,
      ...patch,
      style: patch.style ? { ...drawing.style, ...patch.style } : drawing.style,
    } : drawing))
  }, [commit])

  const duplicateDrawing = useCallback((id: string) => {
    const source = drawingsRef.current.find((drawing) => drawing.id === id)
    if (!source) return
    const secondsOffset = Math.max(60, Math.round((candlesRef.current.at(-1)?.time ?? 0) - (candlesRef.current.at(-2)?.time ?? -60))) * 3
    const copy: ChartDrawing = {
      ...cloneDrawings([source])[0],
      id: `${source.type}-${Date.now()}-copy`,
      anchors: source.anchors.map((anchor) => ({
        time: anchor.time + secondsOffset,
        price: anchor.price,
        ...(Number.isFinite(anchor.logical) ? { logical: Number(anchor.logical) + 3 } : {}),
      })),
      locked: false,
      createdAt: Date.now(),
    }
    commit([...drawingsRef.current, copy])
    setSelectedId(copy.id)
  }, [commit])

  const clearAll = useCallback(() => {
    if (drawingsRef.current.length === 0) return
    commit([])
    setSelectedId(null)
  }, [commit])

  const exportDrawings = useCallback(() => {
    const blob = new Blob([JSON.stringify(drawingsRef.current, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `antytilt-${exportSymbol}-drawings-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    URL.revokeObjectURL(url)
  }, [exportSymbol])

  const importDrawings = useCallback(async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as ChartDrawing[]
      if (!Array.isArray(parsed) || parsed.some((item) => !item.id || !item.type || !Array.isArray(item.anchors))) return
      commit(parsed)
      setSelectedId(null)
    } catch {
      // Ignore malformed drawing files and preserve the current workspace.
    }
  }, [commit])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return
      const modifier = event.metaKey || event.ctrlKey
      if (modifier && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
        return
      }
      if (modifier && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        redo()
        return
      }
      if (event.key === 'Escape') cancelAction()
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId) {
        event.preventDefault()
        deleteSelected()
      }
      if (!modifier) {
        const shortcuts: Partial<Record<string, DrawingTool>> = {
          v: 'cursor', t: 'trend', h: 'horizontal', f: 'fib', r: 'rectangle', m: 'measure', n: 'text',
        }
        const tool = shortcuts[event.key.toLowerCase()]
        if (tool) setActiveTool(tool)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [cancelAction, deleteSelected, redo, selectedId, setActiveTool, undo])

  const visibleDrawings = useMemo(() => drawings.filter((drawing) => !drawing.hidden), [drawings])
  const selectedDrawing = drawings.find((drawing) => drawing.id === selectedId) ?? null
  const previewDrawing = useMemo<ChartDrawing | null>(() => {
    if (activeTool === 'cursor' || pendingAnchors.length === 0 || !previewAnchor) return null
    return {
      id: 'preview',
      type: activeTool,
      anchors: [...pendingAnchors, previewAnchor],
      style: { ...DEFAULT_STYLE, color: activeTool === 'long' ? '#0ecb81' : activeTool === 'short' ? '#f6465d' : DEFAULT_STYLE.color },
      locked: true,
      hidden: false,
      createdAt: 0,
      text: activeTool === 'text' ? 'Note' : undefined,
    }
  }, [activeTool, pendingAnchors, previewAnchor])

  const currentStep = activeTool === 'cursor' ? 0 : pendingAnchors.length + 1
  const totalSteps = activeTool === 'cursor' ? 0 : TOOL_ANCHORS[activeTool]

  return {
    drawings,
    visibleDrawings,
    selectedId,
    selectedDrawing,
    activeTool,
    pendingAnchors,
    previewDrawing,
    currentStep,
    totalSteps,
    dimensions,
    magnetEnabled,
    keepDrawing,
    objectsOpen,
    editingTextId,
    draggingDrawingId,
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    importRef,
    setActiveTool,
    setSelectedId,
    setMagnetEnabled,
    setKeepDrawing,
    setObjectsOpen,
    setEditingTextId,
    startDrag,
    placeAnchor,
    movePreview,
    finishPlacement,
    cancelPlacement,
    project,
    updateDrawing,
    deleteDrawing,
    deleteSelected,
    duplicateDrawing,
    clearAll,
    undo,
    redo,
    exportDrawings,
    importDrawings,
    toolName: activeTool === 'cursor' ? 'Cursor' : TOOL_NAMES[activeTool],
  }
}

type OverlayProps = {
  drawings: ChartDrawing[]
  previewDrawing: ChartDrawing | null
  selectedId: string | null
  dimensions: Dimensions
  project: (anchor: DrawingAnchor) => Point | null
  candles: Candle[]
  activeTool: DrawingTool
  onSelect: (id: string | null) => void
  onEditText: (id: string | null) => void
  onStartDrag: (event: ReactPointerEvent<SVGElement>, id: string, anchorIndex: number | null) => void
  onPlaceAnchor: (event: ReactPointerEvent<SVGSVGElement>) => void
  onMovePreview: (event: ReactPointerEvent<SVGSVGElement>) => void
  onFinishPlacement: (event: ReactPointerEvent<SVGSVGElement>) => void
  onCancelPlacement: () => void
}

function DrawingShape({
  drawing,
  selected,
  preview,
  dimensions,
  project,
  candles,
  onSelect,
  onEditText,
  onStartDrag,
}: {
  drawing: ChartDrawing
  selected: boolean
  preview: boolean
  dimensions: Dimensions
  project: (anchor: DrawingAnchor) => Point | null
  candles: Candle[]
  onSelect: (id: string | null) => void
  onEditText: (id: string | null) => void
  onStartDrag: OverlayProps['onStartDrag']
}) {
  const points = drawing.anchors.map(project)
  if (points.some((point) => point === null)) return null
  const resolved = points as Point[]
  const plotWidth = Math.max(0, dimensions.width - PRICE_SCALE_GUTTER)
  const plotHeight = Math.max(0, dimensions.height - TIME_SCALE_GUTTER)
  const color = drawing.style.color
  const dash = dashArray(drawing.style.lineStyle)
  const common = {
    stroke: color,
    strokeWidth: drawing.style.lineWidth,
    strokeDasharray: dash,
    vectorEffect: 'non-scaling-stroke' as const,
  }

  const bodyPointerDown = (event: ReactPointerEvent<SVGElement>) => onStartDrag(event, drawing.id, null)
  const hitLine = (x1: number, y1: number, x2: number, y2: number, key = 'hit') => (
    <line key={key} className="drawing-hit" x1={x1} y1={y1} x2={x2} y2={y2} onPointerDown={bodyPointerDown} />
  )

  let body: React.ReactNode = null
  const first = resolved[0]
  const second = resolved[1] ?? first

  if (drawing.type === 'trend') {
    body = <>{hitLine(first.x, first.y, second.x, second.y)}<line {...common} x1={first.x} y1={first.y} x2={second.x} y2={second.y} /></>
  }

  if (drawing.type === 'ray') {
    const dx = second.x - first.x
    const dy = second.y - first.y
    const ratio = Math.abs(dx) < 0.1 ? 1 : (plotWidth - first.x) / dx
    const end = { x: Math.abs(dx) < 0.1 ? first.x : plotWidth, y: Math.abs(dx) < 0.1 ? plotHeight : first.y + dy * ratio }
    body = <>{hitLine(first.x, first.y, end.x, end.y)}<line {...common} x1={first.x} y1={first.y} x2={end.x} y2={end.y} /></>
  }

  if (drawing.type === 'horizontal') {
    const label = drawing.anchors[0].price.toFixed(1)
    const labelWidth = Math.max(58, label.length * 6.3 + 14)
    const labelY = Math.max(19, Math.min(plotHeight - 5, first.y - 5))
    body = <>{hitLine(0, first.y, plotWidth, first.y)}<line {...common} x1={0} y1={first.y} x2={plotWidth} y2={first.y} /><g className="drawing-axis-badge"><rect x={plotWidth - labelWidth - 8} y={labelY - 15} width={labelWidth} height={19} rx={3} fill="#11161d" stroke={color} strokeOpacity={0.48} /><text className="drawing-axis-label" textAnchor="end" x={plotWidth - 15} y={labelY - 2} fill={color}>{label}</text></g></>
  }

  if (drawing.type === 'vertical') {
    body = <>{hitLine(first.x, 0, first.x, plotHeight)}<line {...common} x1={first.x} y1={0} x2={first.x} y2={plotHeight} /></>
  }

  if (drawing.type === 'rectangle') {
    const x = Math.min(first.x, second.x)
    const y = Math.min(first.y, second.y)
    const width = Math.abs(second.x - first.x)
    const height = Math.abs(second.y - first.y)
    body = <rect className="drawing-shape" x={x} y={y} width={width} height={height} {...common} fill={alpha(color, drawing.style.fillOpacity)} onPointerDown={bodyPointerDown} />
  }

  if (drawing.type === 'fib') {
    const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]
    const x1 = Math.min(first.x, second.x)
    const x2 = Math.max(first.x, second.x)
    body = <g onPointerDown={bodyPointerDown}>
      <rect className="drawing-shape" x={x1} y={Math.min(first.y, second.y)} width={Math.max(2, x2 - x1)} height={Math.abs(second.y - first.y)} fill={alpha(color, 0.025)} stroke="transparent" />
      {levels.map((level) => {
        const y = first.y + (second.y - first.y) * level
        const price = drawing.anchors[0].price + (drawing.anchors[1].price - drawing.anchors[0].price) * level
        return <g key={level}>
          <line {...common} opacity={level === 0 || level === 1 ? 1 : 0.72} x1={x1} y1={y} x2={x2} y2={y} />
          <text className="drawing-label" x={x1 + 4} y={y - 3} fill={color}>{(level * 100).toFixed(1)}% · {price.toFixed(1)}</text>
        </g>
      })}
    </g>
  }

  if (drawing.type === 'measure') {
    const x = Math.min(first.x, second.x)
    const y = Math.min(first.y, second.y)
    const width = Math.abs(second.x - first.x)
    const height = Math.abs(second.y - first.y)
    const priceDelta = drawing.anchors[1].price - drawing.anchors[0].price
    const change = drawing.anchors[0].price ? priceDelta / drawing.anchors[0].price * 100 : 0
    const from = Math.min(drawing.anchors[0].time, drawing.anchors[1].time)
    const to = Math.max(drawing.anchors[0].time, drawing.anchors[1].time)
    const loadedBars = candles.filter((candle) => candle.time >= from && candle.time <= to).length
    const firstLogical = drawing.anchors[0].logical
    const secondLogical = drawing.anchors[1].logical
    const logicalBars = Number.isFinite(firstLogical) && Number.isFinite(secondLogical)
      ? Math.round(Math.abs(Number(secondLogical) - Number(firstLogical))) + 1
      : 0
    const bars = Math.max(1, loadedBars, logicalBars)
    const duration = formatMeasurementDuration(to - from)
    const measureColor = change >= 0 ? '#0ecb81' : '#f6465d'
    const signedDelta = `${priceDelta >= 0 ? '+' : ''}${formatMeasurementNumber(priceDelta)}`
    const signedPercent = `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`
    const barText = `${bars} bar${bars === 1 ? '' : 's'} · ${duration}`
    const rangeText = `${formatMeasurementNumber(drawing.anchors[0].price)} → ${formatMeasurementNumber(drawing.anchors[1].price)}`
    const labelWidth = Math.max(174, Math.min(232, Math.max(`${signedPercent}  ${signedDelta}`.length * 6.2, rangeText.length * 5.3) + 22))
    const labelHeight = 58
    const endpointOnRight = second.x >= first.x
    const preferredX = endpointOnRight ? second.x + 10 : second.x - labelWidth - 10
    const fallbackX = endpointOnRight ? second.x - labelWidth - 10 : second.x + 10
    const candidateX = preferredX >= 6 && preferredX + labelWidth <= plotWidth - 6 ? preferredX : fallbackX
    const boxX = Math.max(6, Math.min(plotWidth - labelWidth - 6, candidateX))
    const boxY = Math.max(6, Math.min(plotHeight - labelHeight - 6, second.y - labelHeight / 2))
    const connectorX = boxX > second.x ? boxX : boxX + labelWidth
    const measureDash = dash ?? '5 4'
    body = <g onPointerDown={bodyPointerDown}>
      <rect className="drawing-shape drawing-measure-area" x={x} y={y} width={Math.max(1, width)} height={Math.max(1, height)} stroke={measureColor} strokeWidth={Math.max(1, drawing.style.lineWidth)} strokeDasharray={measureDash} fill={alpha(measureColor, Math.max(0.055, drawing.style.fillOpacity * 0.8))} />
      <line className="drawing-measure-diagonal" x1={first.x} y1={first.y} x2={second.x} y2={second.y} stroke={measureColor} strokeWidth={Math.max(1, drawing.style.lineWidth)} strokeDasharray={measureDash} />
      <circle className="drawing-measure-point" cx={first.x} cy={first.y} r={2.6} fill={measureColor} />
      <circle className="drawing-measure-point" cx={second.x} cy={second.y} r={2.6} fill={measureColor} />
      <line className="drawing-measure-connector" x1={second.x} y1={second.y} x2={connectorX} y2={boxY + labelHeight / 2} stroke={measureColor} strokeOpacity={0.55} strokeWidth={1} />
      <rect className="drawing-measure-card" x={boxX} y={boxY} width={labelWidth} height={labelHeight} rx={6} fill="#11161d" stroke={alpha(measureColor, 0.72)} />
      <rect className="drawing-measure-accent" x={boxX} y={boxY} width={3} height={labelHeight} rx={1.5} fill={measureColor} />
      <text className="drawing-measure-label" x={boxX + 12} y={boxY + 17} fill={measureColor}>
        <tspan className="measure-primary">{signedPercent}</tspan>
        <tspan className="measure-value" dx={8}>{signedDelta}</tspan>
        <tspan className="measure-secondary" x={boxX + 12} dy={15}>{barText}</tspan>
        <tspan className="measure-secondary" x={boxX + 12} dy={14}>{rangeText}</tspan>
      </text>
    </g>
  }

  if (drawing.type === 'long' || drawing.type === 'short') {
    const stop = resolved[1] ?? first
    const target = resolved[2] ?? second
    const endX = Math.max(first.x + 46, stop.x, target.x)
    const rewardColor = drawing.type === 'long' ? '#0ecb81' : '#f6465d'
    const riskColor = drawing.type === 'long' ? '#f6465d' : '#0ecb81'
    const risk = Math.abs(drawing.anchors[0].price - drawing.anchors[1].price)
    const reward = Math.abs(drawing.anchors[2]?.price - drawing.anchors[0].price)
    const ratio = risk ? reward / risk : 0
    body = <g onPointerDown={bodyPointerDown}>
      <rect className="drawing-shape" x={first.x} y={Math.min(first.y, target.y)} width={endX - first.x} height={Math.abs(target.y - first.y)} stroke={rewardColor} strokeWidth={1} fill={alpha(rewardColor, 0.12)} />
      <rect className="drawing-shape" x={first.x} y={Math.min(first.y, stop.y)} width={endX - first.x} height={Math.abs(stop.y - first.y)} stroke={riskColor} strokeWidth={1} fill={alpha(riskColor, 0.12)} />
      <line x1={first.x} y1={first.y} x2={endX} y2={first.y} stroke="#dfe4ea" strokeWidth={1} />
      <rect className="drawing-risk-card" x={first.x + 5} y={first.y - 10} width={84} height={20} rx={3} fill="#11161d" stroke="#3c4654" />
      <text className="drawing-measure-label" x={first.x + 11} y={first.y + 4} fill="#e7eaf0">Risk / Reward {ratio.toFixed(2)}</text>
    </g>
  }

  if (drawing.type === 'text') {
    body = <g className="drawing-text-group" onPointerDown={bodyPointerDown} onDoubleClick={(event) => { event.stopPropagation(); onEditText(drawing.id) }}>
      <rect className="drawing-text-card" x={first.x - 5} y={first.y - 18} width={Math.max(65, (drawing.text?.length ?? 4) * 6.2)} height={25} rx={3} fill="rgba(15,19,25,.9)" stroke={selected ? color : '#323a46'} />
      <text className="drawing-text" x={first.x + 3} y={first.y - 2} fill={color}>{drawing.text}</text>
    </g>
  }

  return <g
    className={`chart-drawing ${selected ? 'selected' : ''} ${drawing.locked ? 'locked' : ''} ${preview ? 'preview' : ''}`}
    onPointerDown={(event) => {
      if (preview) return
      event.stopPropagation()
      onSelect(drawing.id)
    }}
  >
    {body}
    {selected && !drawing.locked && !preview && resolved.map((point, index) => (
      <circle
        className="drawing-anchor"
        key={`${drawing.id}-anchor-${index}`}
        cx={point.x}
        cy={point.y}
        r={4.5}
        fill="var(--drawing-anchor-fill, #0b0e13)"
        stroke={color}
        strokeWidth={1.5}
        onPointerDown={(event) => onStartDrag(event, drawing.id, index)}
      />
    ))}
  </g>
}

export function DrawingOverlay({ drawings, previewDrawing, selectedId, dimensions, project, candles, activeTool, onSelect, onEditText, onStartDrag, onPlaceAnchor, onMovePreview, onFinishPlacement, onCancelPlacement }: OverlayProps) {
  return <svg
    className={`drawing-overlay ${activeTool !== 'cursor' ? 'placing' : ''}`}
    width={dimensions.width}
    height={dimensions.height}
    viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}
    onPointerMove={onMovePreview}
    onPointerUp={onFinishPlacement}
    onPointerCancel={onCancelPlacement}
    onPointerDown={(event) => {
      if (activeTool !== 'cursor') {
        onPlaceAnchor(event)
        return
      }
      if (event.target === event.currentTarget) onSelect(null)
    }}
  >
    {drawings.map((drawing) => (
      <DrawingShape
        key={drawing.id}
        drawing={drawing}
        selected={drawing.id === selectedId}
        preview={false}
        dimensions={dimensions}
        project={project}
        candles={candles}
        onSelect={onSelect}
        onEditText={onEditText}
        onStartDrag={onStartDrag}
      />
    ))}
    {previewDrawing && <DrawingShape
      drawing={previewDrawing}
      selected={false}
      preview
      dimensions={dimensions}
      project={project}
      candles={candles}
      onSelect={onSelect}
      onEditText={onEditText}
      onStartDrag={onStartDrag}
    />}
  </svg>
}

type PropertiesProps = {
  drawing: ChartDrawing
  onUpdate: (id: string, patch: Partial<ChartDrawing>) => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
  onClose: () => void
}

export function DrawingProperties({ drawing, onUpdate, onDuplicate, onDelete, onClose }: PropertiesProps) {
  return <div className="drawing-properties" role="toolbar" aria-label={`${TOOL_NAMES[drawing.type]} properties`}>
    <div className="drawing-properties-title">
      <span>{TOOL_NAMES[drawing.type]}</span>
      <button onClick={onClose} aria-label="Close drawing properties" title="Close"><X size={14} /></button>
    </div>
    {drawing.type === 'text' && <input
      className="drawing-text-input"
      value={drawing.text ?? ''}
      maxLength={80}
      onChange={(event) => onUpdate(drawing.id, { text: event.target.value })}
    />}
    {drawing.type !== 'measure' && <div className="drawing-property-row drawing-property-colors" aria-label="Line color">
      <span>Color</span>
      <div className="drawing-colors">
        {palette.map((color) => <button
          key={color}
          className={drawing.style.color === color ? 'active' : ''}
          style={{ background: color }}
          onClick={() => onUpdate(drawing.id, { style: { ...drawing.style, color } })}
          aria-label={`Color ${color}`}
        />)}
      </div>
    </div>}
    <div className="drawing-property-row" aria-label="Line width">
      <span>Width</span>
      <div className="segmented-property">
        {[1, 2, 3].map((width) => <button
          className={drawing.style.lineWidth === width ? 'active' : ''}
          key={width}
          onClick={() => onUpdate(drawing.id, { style: { ...drawing.style, lineWidth: width } })}
        >{width}px</button>)}
      </div>
    </div>
    <div className="drawing-property-row" aria-label="Line style">
      <span>Style</span>
      <div className="segmented-property line-styles">
        {(['solid', 'dashed', 'dotted'] as const).map((lineStyle) => <button
          className={drawing.style.lineStyle === lineStyle ? 'active' : ''}
          key={lineStyle}
          onClick={() => onUpdate(drawing.id, { style: { ...drawing.style, lineStyle } })}
        ><i className={lineStyle} /></button>)}
      </div>
    </div>
    <div className="drawing-property-actions">
      <button className={drawing.locked ? 'active' : ''} onClick={() => onUpdate(drawing.id, { locked: !drawing.locked })} title="Lock">
        {drawing.locked ? <Lock size={14} /> : <Unlock size={14} />}
      </button>
      <button onClick={() => onDuplicate(drawing.id)} title="Duplicate"><Copy size={14} /></button>
      <button className="delete" onClick={() => onDelete(drawing.id)} title="Delete"><Trash2 size={14} /></button>
    </div>
  </div>
}

type HistoryControlsProps = {
  canUndo: boolean
  canRedo: boolean
  magnetEnabled: boolean
  keepDrawing: boolean
  onUndo: () => void
  onRedo: () => void
  onMagnet: () => void
  onKeepDrawing: () => void
}

export function DrawingHistoryControls(props: HistoryControlsProps) {
  return <>
    <button className="drawing-tool" disabled={!props.canUndo} aria-label="Undo drawing" onClick={props.onUndo}><Undo2 size={16} /><span className="drawing-tooltip"><strong>Undo</strong><kbd>⌘ Z</kbd></span></button>
    <button className="drawing-tool" disabled={!props.canRedo} aria-label="Redo drawing" onClick={props.onRedo}><Redo2 size={16} /><span className="drawing-tooltip"><strong>Redo</strong><kbd>⇧⌘ Z</kbd></span></button>
    <span className="tool-divider" />
    <button className={`drawing-tool ${props.magnetEnabled ? 'active' : ''}`} aria-label="Magnet mode" aria-pressed={props.magnetEnabled} onClick={props.onMagnet}><Magnet size={16} /><span className="drawing-tooltip"><strong>Magnet</strong><small>Snap near OHLC</small></span></button>
    <button className={`drawing-tool ${props.keepDrawing ? 'active' : ''}`} aria-label="Keep drawing tool active" aria-pressed={props.keepDrawing} onClick={props.onKeepDrawing}><Pin size={16} /><span className="drawing-tooltip"><strong>Stay in drawing mode</strong></span></button>
  </>
}

type ObjectPanelProps = {
  drawings: ChartDrawing[]
  selectedId: string | null
  importRef: RefObject<HTMLInputElement | null>
  onSelect: (id: string | null) => void
  onUpdate: (id: string, patch: Partial<ChartDrawing>) => void
  onDelete: (id: string) => void
  onClear: () => void
  onExport: () => void
  onImport: (file: File) => void
  onClose: () => void
}

export function DrawingObjectsPanel(props: ObjectPanelProps) {
  return <div className="drawing-objects-panel">
    <div className="objects-title">
      <span>Objects <small>{props.drawings.length}</small></span>
      <button onClick={props.onClose}><X size={13} /></button>
    </div>
    <div className="objects-list">
      {props.drawings.length === 0 && <div className="objects-empty">No drawings on this chart</div>}
      {[...props.drawings].reverse().map((drawing) => <button
        className={`object-row ${props.selectedId === drawing.id ? 'selected' : ''}`}
        key={drawing.id}
        onClick={() => props.onSelect(drawing.id)}
      >
        <span className="object-color" style={{ background: drawing.style.color }} />
        <span className="object-name">{drawing.text || TOOL_NAMES[drawing.type]}</span>
        <span className="object-actions">
          <i onClick={(event) => { event.stopPropagation(); props.onUpdate(drawing.id, { hidden: !drawing.hidden }) }}>{drawing.hidden ? <EyeOff size={12} /> : <Eye size={12} />}</i>
          <i onClick={(event) => { event.stopPropagation(); props.onUpdate(drawing.id, { locked: !drawing.locked }) }}>{drawing.locked ? <Lock size={12} /> : <Unlock size={12} />}</i>
          <i className="delete" onClick={(event) => { event.stopPropagation(); props.onDelete(drawing.id) }}><Trash2 size={12} /></i>
        </span>
      </button>)}
    </div>
    <div className="objects-footer">
      <button onClick={props.onExport} disabled={props.drawings.length === 0}><Download size={12} /> Export</button>
      <button onClick={() => props.importRef.current?.click()}><Upload size={12} /> Import</button>
      <button className="clear" onClick={props.onClear} disabled={props.drawings.length === 0}><Trash2 size={12} /> Clear</button>
      <input
        ref={props.importRef}
        type="file"
        accept="application/json"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void props.onImport(file)
          event.target.value = ''
        }}
      />
    </div>
  </div>
}
