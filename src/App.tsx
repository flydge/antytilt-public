import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import {
  Activity,
  Bell,
  ChevronDown,
  Clock3,
  FlaskConical,
  Globe2,
  LayoutGrid,
  LockKeyhole,
  LogOut,
  Menu,
  Moon,
  Search,
  Settings,
  ShieldCheck,
  Star,
  Sun,
  X,
} from 'lucide-react'
import { PriceChart } from './components/PriceChart'
import { AuthScreen } from './components/AuthScreen'
import { ExecutionAccountChooser } from './components/ExecutionAccountChooser'
import { ExchangeConnectionModal } from './components/ExchangeConnectionModal'
import { OrderEntryPanel } from './components/OrderEntryPanel'
import { TerminalBottomPanel as BottomPanel } from './components/TerminalBottomPanel'
import { MarketPulseIntro } from './components/MarketPulseIntro'
import { HyperliquidProtectionPanel } from './components/HyperliquidProtectionPanel'
import { HyperliquidActionReview } from './components/HyperliquidActionReview'
import { HyperliquidTerminalAgentPanel } from './components/HyperliquidTerminalAgentPanel'
import { HyperliquidLegacyRecoveryPanel } from './components/HyperliquidLegacyRecoveryPanel'
import './components/HyperliquidProtectionPanel.css'
import { useExchangeAccount } from './hooks/useExchangeAccount'
import { useHyperliquidAccount } from './hooks/useHyperliquidAccount'
import { useAuth } from './hooks/useAuth'
import { useMarketCatalog } from './hooks/useMarketCatalog'
import { useHyperliquidMarketCatalog } from './hooks/useHyperliquidMarketCatalog'
import { readExecutionProvider, readHyperliquidNetwork, selectExecutionPrice, showBingxChartOverlays, showHyperliquidChartOverlays, type ExecutionProvider, type HyperliquidNetwork } from './executionSelection'
import { useMarketData } from './hooks/useMarketData'
import { MARKET_DATA_LABELS, type MarketDataExchange } from './marketData'
import type {
  AuthUser,
  BookLevel,
  DemoOrder,
  ExchangeSessionState,
  MarketInstrument,
  MarketTrade,
  OrderProtectionDraft,
  Ticker,
} from './types'

const RiskManagementPage = lazy(() => import('./components/RiskManagementPage').then((module) => ({ default: module.RiskManagementPage })))

const formatPrice = (value: number) => {
  if (!Number.isFinite(value)) return '--'
  const absolute = Math.abs(value)
  const maximumFractionDigits = absolute >= 1_000 ? 2 : absolute >= 1 ? 4 : absolute >= 0.01 ? 6 : 8
  const minimumFractionDigits = absolute >= 1 ? 2 : maximumFractionDigits
  return value.toLocaleString('en-US', { minimumFractionDigits, maximumFractionDigits })
}

type PriceDirection = 'up' | 'down' | 'flat'

function usePriceDirection(price: number, identity: string): PriceDirection {
  const previous = useRef({ identity, price })
  const [direction, setDirection] = useState<PriceDirection>('flat')
  useEffect(() => {
    if (previous.current.identity !== identity) {
      previous.current = { identity, price }
      setDirection('flat')
      return
    }
    if (price > previous.current.price) setDirection('up')
    else if (price < previous.current.price) setDirection('down')
    previous.current = { identity, price }
  }, [identity, price])
  return direction
}

const formatQuantity = (value: number) => value >= 1_000
  ? Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(value)
  : value.toLocaleString('en-US', { maximumFractionDigits: value >= 1 ? 3 : 6 })

const compact = (value: number) =>
  Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(value)

const formatCountdown = (timestamp: number) => {
  if (!timestamp) return '--:--:--'
  const seconds = Math.max(0, Math.floor((timestamp - Date.now()) / 1_000))
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  const remainder = seconds % 60
  return [hours, minutes, remainder].map((part) => part.toString().padStart(2, '0')).join(':')
}

const coinGlyph = (symbol: string) => ({ BTC: '₿', ETH: 'Ξ', DOGE: 'Ð', XRP: 'X' })[symbol] ?? symbol.slice(0, 1)

const coinColor = (symbol: string) => {
  const colors = ['#f7941a', '#627eea', '#8f6cff', '#20bca4', '#e0527d', '#4b8df8', '#e7ba45', '#7b8798']
  const hash = [...symbol].reduce((sum, character) => sum + character.charCodeAt(0), 0)
  return colors[hash % colors.length]
}

function CoinLogo({ market, className }: { market: MarketInstrument; className: string }) {
  const [imageFailed, setImageFailed] = useState(!market.logoUrl)
  const showFallback = imageFailed || !market.logoUrl

  useEffect(() => setImageFailed(!market.logoUrl), [market.logoUrl])

  return (
    <span
      className={`${className}${showFallback ? ' coin-image-fallback' : ''}`}
      style={showFallback ? { background: coinColor(market.baseAsset) } : undefined}
      aria-hidden="true"
    >
      {!showFallback && (
        <img
          src={market.logoUrl}
          alt=""
          width="32"
          height="32"
          loading={className === 'market-coin' ? 'lazy' : 'eager'}
          decoding="async"
          onError={() => setImageFailed(true)}
        />
      )}
      {showFallback && coinGlyph(market.baseAsset)}
    </span>
  )
}

function Logo() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <span />
        <span />
      </span>
      <span className="brand-name">ANTY<span>TILT</span></span>
    </div>
  )
}

type AppSection = 'trade' | 'risk'
type Theme = 'dark' | 'light'

function Header({ connection, marketSource, exchange, user, activeSection, theme, executionProvider, executionNetwork, hyperliquid = false, onNavigate, onSearch, onConnect, onLogout, onToggleTheme }: {
  connection: 'connecting' | 'live' | 'demo'
  marketSource: string
  exchange: ExchangeSessionState
  user: AuthUser
  activeSection: AppSection
  theme: Theme
  hyperliquid?: boolean
  executionProvider: ExecutionProvider
  executionNetwork: HyperliquidNetwork
  onNavigate: (section: AppSection) => void
  onSearch: () => void
  onConnect: () => void
  onLogout: () => void
  onToggleTheme: () => void
}) {
  const connected = executionProvider === 'bingx' && exchange.connected
  const isLiveTradingAccount = connected && exchange.environment === 'prod-live'
  const tradingAccountLabel = executionProvider === 'hyperliquid' ? `Hyperliquid ${executionNetwork === 'testnet' ? 'Testnet' : 'Mainnet'} · Manage Account` : exchange.connected
    ? `${MARKET_DATA_LABELS[exchange.exchange ?? 'bingx']} ${isLiveTradingAccount ? 'Live' : 'VST'}`
    : 'Connect exchange'
  return (
    <header className="app-header">
      <div className="header-left">
        <Logo />
        <nav className="main-nav">
          <button>Markets</button>
          <button className={activeSection === 'trade' ? 'active' : ''} onClick={() => onNavigate('trade')}>Trade</button>
          <button className={`rm-nav ${activeSection === 'risk' ? 'active' : ''}`} style={{ display: 'inline-flex' }} onClick={() => onNavigate('risk')}><ShieldCheck size={14} /> Risk Management</button>
        </nav>
      </div>
      <div className="header-actions">
        <div
          className={`connection-pill ${connection}`}
          aria-label={connection === 'live' ? `Market data: ${marketSource} Live` : connection === 'connecting' ? `Market data: Connecting ${marketSource}` : `Market data: ${marketSource} ${hyperliquid ? 'unavailable' : 'fallback'}`}
          title="Public market-data connection used by the chart and order book"
        >
          <span />
          <span className="connection-copy">
            <small>Market data:{' '}</small>
            <strong>{connection === 'live' ? `${marketSource} Live` : connection === 'connecting' ? `Connecting ${marketSource}` : `${marketSource} ${hyperliquid ? 'unavailable' : 'fallback'}`}</strong>
          </span>
        </div>
        <button
          className={`connect-button ${connected ? `connected ${isLiveTradingAccount ? 'live-account' : 'vst-account'}` : ''}`}
          onClick={onConnect}
          aria-label={`Choose execution account: ${tradingAccountLabel}`}
          title="Choose trading venue and account independently of chart source"
        >
          {isLiveTradingAccount ? <LockKeyhole size={14} /> : connected || executionProvider === 'hyperliquid' ? <FlaskConical size={14} /> : <LockKeyhole size={14} />}
          {connected && <span className="connect-prefix">Trading account:{' '}</span>}
          <strong>{tradingAccountLabel}</strong>
        </button>
        <button className="header-icon theme-toggle" onClick={onToggleTheme} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>
          {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
        </button>
        <button className="header-icon" onClick={onSearch} aria-label="Open market search"><Search size={17} /></button>
        <button className="header-icon has-dot"><Bell size={17} /></button>
        <button className="header-icon"><Settings size={17} /></button>
        <span className="header-user" title={user.email}>{user.email}</span>
        <button className="header-icon" onClick={onLogout} aria-label="Sign out" title="Sign out"><LogOut size={16} /></button>
        <button className="header-icon mobile-only"><Menu size={18} /></button>
      </div>
    </header>
  )
}

type CatalogStatus = ReturnType<typeof useMarketCatalog>['status'] | 'unavailable'

type MarketSelectorProps = {
  open: boolean
  markets: MarketInstrument[]
  selectedSymbol: string
  status: CatalogStatus
  executionExchange?: 'BingX'
  hyperliquidCatalog?: boolean
  onClose: () => void
  onSelect: (market: MarketInstrument) => void
}

function MarketSelector({ open, markets, selectedSymbol, status, executionExchange, hyperliquidCatalog = false, onClose, onSelect }: MarketSelectorProps) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const filteredMarkets = useMemo(() => {
    const normalized = query.trim().toUpperCase()
    if (!normalized) return markets
    return markets.filter((market) => (
      market.symbol.toUpperCase().includes(normalized)
      || market.baseAsset.toUpperCase().includes(normalized)
      || market.name.toUpperCase().includes(normalized)
    ))
  }, [markets, query])

  useEffect(() => {
    if (!open) return
    setQuery('')
    window.setTimeout(() => inputRef.current?.focus(), 0)
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose, open])

  if (!open) return null

  return (
    <>
      <button className="market-selector-scrim" onClick={onClose} aria-label="Close market catalog" tabIndex={-1} />
      <section className="market-selector" aria-label="Market catalog">
        <div className="market-selector-head">
          <div>
            <strong>Select market</strong>
            <span>{markets.length} assets · {hyperliquidCatalog ? 'Hyperliquid native perpetuals' : executionExchange ? `available on ${executionExchange}` : 'Binance Futures + Bybit'}</span>
          </div>
          <button onClick={onClose} aria-label="Close"><X size={15} /></button>
        </div>
        <label className="market-search">
          <Search size={14} />
          <input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name or symbol" />
          <kbd>/</kbd>
        </label>
        <div className="market-filter-row">
          <button className="active">{hyperliquidCatalog ? 'Native Markets' : 'Top 30'}</button>
          <span className={`catalog-source ${status}`}><i />{status === 'unavailable' ? 'Catalog unavailable' : status === 'live' ? hyperliquidCatalog ? 'Live native universe' : 'Live market-cap ranking' : status === 'loading' ? 'Updating catalog' : 'Verified fallback'}</span>
        </div>
        <div className="market-list-head"><span>Asset / rank</span><span>Exchange</span><span>Price / 24h</span></div>
        <div className="market-list">
          {filteredMarkets.map((market) => {
            const positive = market.priceChangePercent >= 0
            return (
              <button
                key={market.symbol}
                className={`market-row ${market.symbol === selectedSymbol ? 'selected' : ''}`}
                onClick={() => onSelect(market)}
              >
                <span className="market-identity">
                  <CoinLogo market={market} className="market-coin" />
                  <span><strong>{market.baseAsset}<small>/{market.quoteAsset}</small></strong><small>{market.marketCapRank > 0 ? `#${market.marketCapRank} · ` : ''}{market.name}</small></span>
                </span>
                <span className="exchange-availability">{market.exchanges.includes('hyperliquid') ? <i title="Hyperliquid">H</i> : <><i>B</i><i>Y</i>{executionExchange && <i className="bingx">X</i>}</>}</span>
                <span className="market-row-price"><strong>{formatPrice(market.lastPrice)}</strong><small className={positive ? 'up' : 'down'}>{Number.isFinite(market.priceChangePercent) ? `${positive ? '+' : ''}${market.priceChangePercent.toFixed(2)}%` : '--'}</small></span>
                {market.symbol === selectedSymbol && <span className="selected-check">✓</span>}
              </button>
            )
          })}
          {filteredMarkets.length === 0 && <div className="market-empty">{status === 'unavailable' ? 'Native catalog unavailable. No fallback markets.' : status === 'loading' ? 'Loading markets…' : 'No matching markets'}</div>}
        </div>
        <footer className="market-selector-footer">
          <span><ShieldCheck size={12} /> {hyperliquidCatalog ? 'Native USD perpetual market data; execution is selected separately' : `Active USDT Perpetual pairs ${executionExchange ? `available for ${executionExchange} execution` : 'on both market-data exchanges'}`}</span>
          {!hyperliquidCatalog && <a href="https://www.coingecko.com/" target="_blank" rel="noreferrer">Market cap by CoinGecko</a>}
        </footer>
      </section>
    </>
  )
}

type InstrumentBarProps = {
  ticker: Ticker
  priceDirection: PriceDirection
  fundingRate: number
  nextFundingTime: number
  market: MarketInstrument
  markets: MarketInstrument[]
  selectorOpen: boolean
  catalogStatus: CatalogStatus
  marketSource: string
  marketDataExchange: MarketDataExchange
  executionExchange?: 'BingX'
  hyperliquidNetwork: HyperliquidNetwork
  onHyperliquidNetwork: (network: HyperliquidNetwork) => void
  onOpenSelector: () => void
  onCloseSelector: () => void
  onSelectMarket: (market: MarketInstrument) => void
  onMarketDataExchange: (exchange: MarketDataExchange) => void
}

function InstrumentBar({ ticker, priceDirection, fundingRate, nextFundingTime, market, markets, selectorOpen, catalogStatus, marketSource, marketDataExchange, executionExchange, hyperliquidNetwork, onHyperliquidNetwork, onOpenSelector, onCloseSelector, onSelectMarket, onMarketDataExchange }: InstrumentBarProps) {
  const hyperliquid = marketDataExchange === 'hyperliquid'
  const quote = hyperliquid ? 'USD' : 'USDT'
  const changeTone = ticker.priceChangePercent > 0 ? 'up' : ticker.priceChangePercent < 0 ? 'down' : 'price-flat'
  return (
    <section className="instrument-bar">
      <div className="instrument-main">
        <button className="watch-star"><Star size={16} /></button>
        <CoinLogo market={market} className="coin-logo" />
        <div>
          <button className="instrument-name" onClick={onOpenSelector}>{market.symbol} <span>Perpetual</span> <ChevronDown size={14} /></button>
          <div className="instrument-meta">{market.name} · {marketSource} {quote} Perpetual</div>
        </div>
        <MarketSelector
          open={selectorOpen}
          markets={markets}
          selectedSymbol={market.symbol}
          status={catalogStatus}
          executionExchange={executionExchange}
          hyperliquidCatalog={hyperliquid}
          onClose={onCloseSelector}
          onSelect={onSelectMarket}
        />
      </div>
      <div className="market-source-switch" aria-label="Chart exchange">
        <span>Chart Source</span>
        {(['binance', 'bybit', 'bingx', 'hyperliquid'] as MarketDataExchange[]).map((source) => (
          <button type="button" key={source} className={marketDataExchange === source ? 'active' : ''} onClick={() => onMarketDataExchange(source)} aria-pressed={marketDataExchange === source} aria-label={`Chart source ${MARKET_DATA_LABELS[source]}`} title={`Use ${MARKET_DATA_LABELS[source]} market data`}>
            <i>{source === 'binance' ? 'B' : source === 'bingx' ? 'X' : source === 'hyperliquid' ? 'HL' : 'Y'}</i>{MARKET_DATA_LABELS[source]}
          </button>
        ))}
        {hyperliquid && <label className="chart-network">Chart Network<select aria-label="Hyperliquid chart network" value={hyperliquidNetwork} onChange={event => onHyperliquidNetwork(event.target.value as HyperliquidNetwork)}><option value="mainnet">Mainnet</option><option value="testnet">Testnet</option></select></label>}
      </div>
      <div className="instrument-price">
        <strong className={priceDirection === 'flat' ? 'price-flat' : priceDirection}>{formatPrice(ticker.lastPrice)}</strong>
        <span>{hyperliquid ? 'Mark · $' : '$'}{formatPrice(ticker.lastPrice)}</span>
      </div>
      <div className="market-stat">
        <span>24h Change</span>
        <strong className={changeTone}>{Number.isFinite(ticker.priceChangePercent) ? `${ticker.priceChangePercent > 0 ? '+' : ''}${ticker.priceChangePercent.toFixed(2)}%` : '--'}</strong>
      </div>
      <div className="market-stat">
        <span>24h High</span>
        <strong>{formatPrice(ticker.highPrice)}</strong>
      </div>
      <div className="market-stat">
        <span>24h Low</span>
        <strong>{formatPrice(ticker.lowPrice)}</strong>
      </div>
      <div className="market-stat optional-stat">
        <span>24h Volume ({market.baseAsset})</span>
        <strong>{Number.isFinite(ticker.volume) ? compact(ticker.volume) : '--'}</strong>
      </div>
      <div className="market-stat optional-stat">
        <span>24h Turnover ({quote})</span>
        <strong>{Number.isFinite(ticker.quoteVolume) ? compact(ticker.quoteVolume) : '--'}</strong>
      </div>
      <div className="market-stat optional-stat">
        <span>Funding / Countdown</span>
        <strong className="accent-text">{hyperliquid && !Number.isFinite(ticker.lastPrice) ? '--' : `${(fundingRate * 100).toFixed(4)}%`} <small>· {formatCountdown(nextFundingTime)}</small></strong>
      </div>
      <button className="instrument-more"><LayoutGrid size={15} /> Customize</button>
    </section>
  )
}

function BookRows({ rows, type, limit }: { rows: BookLevel[]; type: 'ask' | 'bid'; limit: number }) {
  const maxTotal = Math.max(...rows.map((row) => row.total), 1)
  const prepared = type === 'ask' ? [...rows].slice(0, limit).reverse() : rows.slice(0, limit)
  return (
    <div className={`book-side ${type}`}>
      {prepared.map((row) => (
        <div className="book-row" key={`${type}-${row.price}`}>
          <span className="book-depth" style={{ width: `${(row.total / maxTotal) * 100}%` }} />
          <span className="book-price">{formatPrice(row.price)}</span>
          <span>{formatQuantity(row.quantity)}</span>
          <span>{formatQuantity(row.total)}</span>
        </div>
      ))}
    </div>
  )
}

function OrderBook({ asks, bids, lastPrice, spread, baseAsset, priceDirection, exchange }: ReturnType<typeof useMarketData> & { lastPrice: number; baseAsset: string; priceDirection: PriceDirection }) {
  const panelRef = useRef<HTMLElement>(null)
  const [visibleLevels, setVisibleLevels] = useState(9)
  const precision = lastPrice >= 10_000 ? '0.1' : lastPrice >= 1_000 ? '0.01' : lastPrice >= 1 ? '0.001' : lastPrice >= 0.01 ? '0.0001' : '0.000001'

  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const updateVisibleLevels = () => {
      const fixedContentHeight = 38 + 26 + 23 + 28
      const rowHeight = 16
      const availableRows = Math.floor(Math.max(0, panel.clientHeight - fixedContentHeight) / (rowHeight * 2))
      const next = Math.max(6, Math.min(20, availableRows))
      setVisibleLevels((current) => current === next ? current : next)
    }
    updateVisibleLevels()
    const observer = new ResizeObserver(updateVisibleLevels)
    observer.observe(panel)
    return () => observer.disconnect()
  }, [])

  return (
    <section ref={panelRef} className="orderbook-panel panel">
      <div className="panel-head compact-head">
        <div className="chart-tabs">
          <button className="panel-tab active">Order Book</button>
          <button className="panel-tab">Trades</button>
        </div>
        <span className="precision-button" title="Price step">
          {precision} <ChevronDown size={12} />
        </span>
      </div>
      <div className="book-toolbar">
        <div className="book-modes">
          <button className="book-mode both" aria-label="Combined order book"><i /><i /><i /></button>
          <button className="book-mode"><i /><i /><i /></button>
          <button className="book-mode"><i /><i /><i /></button>
        </div>
      </div>
      <div className="book-columns"><span>Price ({exchange === 'hyperliquid' ? 'USD' : 'USDT'})</span><span>Size ({baseAsset})</span><span>Sum ({baseAsset})</span></div>
      <BookRows rows={asks} type="ask" limit={visibleLevels} />
      <div className="mid-price">
        <strong className={priceDirection === 'flat' ? 'price-flat' : priceDirection}>{formatPrice(lastPrice)}</strong>
        <span>{exchange === 'hyperliquid' ? 'Mark price' : priceDirection === 'up' ? 'Last tick ↑' : priceDirection === 'down' ? 'Last tick ↓' : 'Last price'}</span>
        <small>Spread {formatPrice(spread)}</small>
      </div>
      <BookRows rows={bids} type="bid" limit={visibleLevels} />
    </section>
  )
}

function RecentTrades({ trades, fallbackPrice, baseAsset, hyperliquid = false }: { trades: MarketTrade[]; fallbackPrice: number; baseAsset: string; hyperliquid?: boolean }) {
  const fallback = useMemo<MarketTrade[]>(
    () => hyperliquid ? [] : Array.from({ length: 15 }, (_, index) => ({
      id: index,
      price: Math.max(0, fallbackPrice + (Math.random() - 0.5) * fallbackPrice * 0.0008),
      quantity: 0.002 + Math.random() * 0.7,
      time: Date.now() - index * 2100,
      side: index % 3 === 0 ? 'sell' : 'buy',
    })),
    [fallbackPrice, hyperliquid],
  )
  const rows = trades.length ? trades : fallback
  return (
    <section className="trades-panel panel">
      <div className="panel-head compact-head">
        <div className="chart-tabs"><button className="panel-tab active">Recent Trades</button></div>
      </div>
      <div className="trade-columns"><span>Price ({hyperliquid ? 'USD' : 'USDT'})</span><span>Size ({baseAsset})</span><span>Time</span></div>
      <div className="trade-list">
        {hyperliquid && rows.length === 0 && <div className="empty-state"><span>No provider trades received</span></div>}
        {rows.slice(0, 16).map((trade) => (
          <div className="trade-row" key={trade.id}>
            <span className={trade.side === 'buy' ? 'up' : 'down'}>{formatPrice(trade.price)}</span>
            <span>{formatQuantity(trade.quantity)}</span>
            <span>{new Date(trade.time).toLocaleTimeString('en-GB')}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

function StatusBar({ protectionAware = false }: { protectionAware?: boolean }) {
  return (
    <footer className="status-bar">
      <div>{protectionAware ? 'Protection readiness and check times are shown above' : <><span className="status-dot" /> All systems operational</>}</div>
      {!protectionAware && <div className="status-links">
        <span><Clock3 size={12} /> UTC 13:42:18</span>
        <span><Activity size={12} /> 21 ms</span>
        <span><Globe2 size={12} /> English</span>
      </div>}
    </footer>
  )
}

function TerminalApp({ user, theme, onLogout, onToggleTheme }: { user: AuthUser; theme: Theme; onLogout: () => void; onToggleTheme: () => void }) {
  const [interval, setInterval] = useState('1m')
  const [activeSection, setActiveSection] = useState<AppSection>('trade')
  const [orders, setOrders] = useState<DemoOrder[]>([])
  const [selectorOpen, setSelectorOpen] = useState(false)
  const [exchangeModalOpen, setExchangeModalOpen] = useState(false)
  const [orderProtectionDraft, setOrderProtectionDraft] = useState<OrderProtectionDraft | null>(null)
  const [selectedSymbol, setSelectedSymbol] = useState(() => localStorage.getItem(`antytilt:${user.id}:selected-market`) ?? 'BTCUSDT')
  const [marketDataExchange, setMarketDataExchange] = useState<MarketDataExchange>(() => {
    const saved = localStorage.getItem(`antytilt:${user.id}:market-source`)
    return saved === 'bingx' || saved === 'bybit' || saved === 'binance' || saved === 'hyperliquid' ? saved : 'binance'
  })
  const [executionProvider, setExecutionProvider] = useState<ExecutionProvider>(() => readExecutionProvider(localStorage.getItem(`antytilt:${user.id}:execution-provider`)))
  const [executionNetwork, setExecutionNetwork] = useState<HyperliquidNetwork>(() => readHyperliquidNetwork(localStorage.getItem(`antytilt:${user.id}:execution-hl-network`), 'testnet'))
  const [chartHyperliquidNetwork, setChartHyperliquidNetwork] = useState<HyperliquidNetwork>(() => readHyperliquidNetwork(localStorage.getItem(`antytilt:${user.id}:chart-hl-network`), 'mainnet'))
  const [executionChooserOpen, setExecutionChooserOpen] = useState(false)
  const [hlSelectedCoin, setHlSelectedCoin] = useState(() => localStorage.getItem(`antytilt:${user.id}:hl-chart-coin`) ?? selectedSymbol.replace(/USDT$/, ''))
  const catalog = useMarketCatalog()
  const hlCatalog = useHyperliquidMarketCatalog(chartHyperliquidNetwork)
  const hyperliquidChart = marketDataExchange === 'hyperliquid'
  const hyperliquidExecution = executionProvider === 'hyperliquid'
  const executionMarket = catalog.markets.find(item => item.symbol === selectedSymbol) ?? catalog.markets[0]
  const hlMarket = hlCatalog.markets.find(item => item.baseAsset === hlSelectedCoin)
  const selectedMarket: MarketInstrument = hyperliquidChart ? hlMarket ?? { id: hlSelectedCoin, symbol: `${hlSelectedCoin}/USD`, baseAsset: hlSelectedCoin, quoteAsset: 'USD', name: hlSelectedCoin, logoUrl: '', marketCapRank: 0, lastPrice: NaN, priceChangePercent: NaN, exchanges: ['hyperliquid'] } : executionMarket
  const exchange = useExchangeAccount(`${executionMarket.baseAsset}-USDT`)
  const hlAccount = useHyperliquidAccount(hyperliquidExecution, executionNetwork)
  const account = hyperliquidExecution ? hlAccount : exchange
  const hlExecutionMarket: MarketInstrument = { id: 'BTC', symbol: 'BTC/USD', baseAsset: 'BTC', quoteAsset: 'USD', name: 'Bitcoin', logoUrl: executionMarket.baseAsset === 'BTC' ? executionMarket.logoUrl : '', marketCapRank: 1, lastPrice: hlAccount.settings?.prices.markPrice ?? NaN, priceChangePercent: NaN, exchanges: ['hyperliquid'] }
  const bingxSymbols = useMemo(() => new Set((exchange.contractCatalog?.contracts ?? []).map(contract => contract.symbol)), [exchange.contractCatalog])
  const executionMarkets = useMemo(() => exchange.session.connected && exchange.contractCatalog ? catalog.markets.filter(item => bingxSymbols.has(`${item.baseAsset}-USDT`)) : catalog.markets, [bingxSymbols, catalog.markets, exchange.contractCatalog, exchange.session.connected])
  const selectedInstrumentSupported = !exchange.session.connected || !exchange.contractCatalog || bingxSymbols.has(`${executionMarket.baseAsset}-USDT`)
  const market = useMarketData(marketDataExchange, selectedMarket.baseAsset, interval, hyperliquidChart ? NaN : selectedMarket.lastPrice, chartHyperliquidNetwork)
  const priceDirection = usePriceDirection(market.ticker.lastPrice, `${marketDataExchange}:${hyperliquidChart ? chartHyperliquidNetwork : ''}:${selectedMarket.symbol}`)
  const executionSettings = hyperliquidExecution ? hlAccount.settings : exchange.tradingSettings?.symbol === `${executionMarket.baseAsset}-USDT` ? exchange.tradingSettings : null
  const executionPrice = hyperliquidExecution ? hlAccount.settings?.prices.markPrice ?? NaN : selectExecutionPrice(marketDataExchange, market.ticker.lastPrice, executionSettings?.prices.markPrice, hyperliquidChart ? undefined : executionMarket.lastPrice)
  const showBingxOverlays = showBingxChartOverlays(executionProvider, marketDataExchange, selectedMarket.baseAsset, executionMarket.baseAsset)
  const showHlOverlays = showHyperliquidChartOverlays(executionProvider, marketDataExchange, selectedMarket.baseAsset, chartHyperliquidNetwork, executionNetwork)
  const showOverlays = showBingxOverlays || showHlOverlays
  const nativeIdentity = `${executionProvider}:${hyperliquidExecution ? `${executionNetwork}:${hlAccount.snapshot?.account ?? 'unlinked'}` : exchange.session.accountId ?? 'unlinked'}`

  useEffect(() => { localStorage.setItem(`antytilt:${user.id}:selected-market`, selectedSymbol) }, [selectedSymbol, user.id])
  useEffect(() => { localStorage.setItem(`antytilt:${user.id}:market-source`, marketDataExchange) }, [marketDataExchange, user.id])
  useEffect(() => { localStorage.setItem(`antytilt:${user.id}:execution-provider`, executionProvider) }, [executionProvider, user.id])
  useEffect(() => { localStorage.setItem(`antytilt:${user.id}:execution-hl-network`, executionNetwork) }, [executionNetwork, user.id])
  useEffect(() => { localStorage.setItem(`antytilt:${user.id}:chart-hl-network`, chartHyperliquidNetwork) }, [chartHyperliquidNetwork, user.id])
  useEffect(() => { localStorage.setItem(`antytilt:${user.id}:hl-chart-coin`, hlSelectedCoin) }, [hlSelectedCoin, user.id])

  const closeExecutionChooser = useCallback(() => setExecutionChooserOpen(false), [])

  const closeSelector = useCallback(() => setSelectorOpen(false), [])
  const selectMarket = useCallback((nextMarket: MarketInstrument) => {
    if (marketDataExchange === 'hyperliquid') setHlSelectedCoin(nextMarket.baseAsset)
    else setSelectedSymbol(nextMarket.symbol)
    setSelectorOpen(false)
  }, [marketDataExchange])

  return (
    <div className="app-shell">
      <Header
        connection={market.connection}
        marketSource={market.sourceLabel}
        exchange={exchange.session}
        user={user}
        activeSection={activeSection}
        theme={theme}
        hyperliquid={hyperliquidChart}
        executionProvider={executionProvider}
        executionNetwork={executionNetwork}
        onNavigate={setActiveSection}
        onSearch={() => setSelectorOpen(true)}
        onConnect={() => setExecutionChooserOpen(true)}
        onLogout={onLogout}
        onToggleTheme={onToggleTheme}
      />
      {activeSection === 'risk' ? (
        <>
          <Suspense fallback={<main className="rm-page"><div className="rm-loading"><span className="button-spinner" /> Loading risk management…</div></main>}>
            <RiskManagementPage onBackToTrade={() => setActiveSection('trade')} />
            <div className="hl-risk-section"><h2>Hyperliquid Testnet BTC Protection · Separate Connection</h2><HyperliquidProtectionPanel /></div>
          </Suspense>
          <StatusBar protectionAware />
        </>
      ) : (
      <>
      <InstrumentBar
        ticker={market.ticker}
        priceDirection={priceDirection}
        fundingRate={market.fundingRate}
        nextFundingTime={market.nextFundingTime}
        market={selectedMarket}
        markets={hyperliquidChart ? hlCatalog.markets : executionMarkets}
        selectorOpen={selectorOpen}
        catalogStatus={hyperliquidChart ? hlCatalog.status : catalog.status}
        marketSource={market.sourceLabel}
        marketDataExchange={marketDataExchange}
        executionExchange={!hyperliquidChart && !hyperliquidExecution && exchange.session.connected && exchange.contractCatalog ? 'BingX' : undefined}
        hyperliquidNetwork={chartHyperliquidNetwork}
        onHyperliquidNetwork={setChartHyperliquidNetwork}
        onOpenSelector={() => setSelectorOpen(true)}
        onCloseSelector={closeSelector}
        onSelectMarket={selectMarket}
        onMarketDataExchange={source => { if (source === 'hyperliquid' && marketDataExchange !== 'hyperliquid') setHlSelectedCoin(selectedMarket.baseAsset); setMarketDataExchange(source) }}
      />
      <main className="terminal-layout">
        <PriceChart
          key={`${marketDataExchange}:${hyperliquidChart ? chartHyperliquidNetwork : ''}:${selectedMarket.symbol}`}
          marketNetwork={hyperliquidChart ? chartHyperliquidNetwork : undefined}
          candles={market.candles}
          interval={interval}
          symbol={selectedMarket.symbol}
          quoteAsset={hyperliquidChart ? 'USD' : 'USDT'}
          storageScope={user.id}
          marketExchange={marketDataExchange}
          marketStatus={market.connection}
          marketError={market.error}
          referencePrice={hyperliquidChart ? market.ticker.lastPrice : selectedMarket.lastPrice}
          exchangeReferencePrice={showOverlays ? executionSettings?.prices.markPrice : undefined}
          executionVenue={hyperliquidExecution ? 'Hyperliquid' : 'BingX'}
          markPriceOnly={hyperliquidExecution}
          existingProtectionEditable={!hyperliquidExecution}
          priceDirection={priceDirection}
          theme={theme}
          positions={showOverlays ? account.session.snapshot?.positions ?? [] : []}
          openOrders={showOverlays ? account.session.snapshot?.openOrders ?? [] : []}
          orderProtectionDraft={showOverlays ? orderProtectionDraft : null}
          protectionBusy={account.status === 'executing' || account.status === 'updating'}
          onUpdateProtection={showOverlays ? account.updatePositionProtection : undefined}
          onIntervalChange={setInterval}
        />
        <aside className="market-column">
          <OrderBook {...market} lastPrice={market.ticker.lastPrice} baseAsset={selectedMarket.baseAsset} priceDirection={priceDirection} />
          <RecentTrades trades={market.trades} fallbackPrice={market.ticker.lastPrice} baseAsset={selectedMarket.baseAsset} hyperliquid={hyperliquidChart} />
        </aside>
        <OrderEntryPanel
          key={`order:${nativeIdentity}`}
          venue={hyperliquidExecution ? { name: 'Hyperliquid', network: executionNetwork, quoteAsset: 'USD', marginAsset: executionNetwork === 'testnet' ? 'test USDC' : 'USDC', executionSymbol: 'BTC-USD', account: hlAccount.snapshot?.account, isLive: executionNetwork === 'mainnet', actionsEnabled: hlAccount.writesEnabled && !hlAccount.pending, availableMargin: hlAccount.availableMargin, accountEquity: hlAccount.equity, sharedLeverage: true, markPriceOnly: true, supportsTriggerOrders: false, supportedTimeInForce: ['GTC', 'IOC', 'PostOnly'], statusMessage: 'Automatic BTC protection is Testnet-only; its current close limit is 20 USD. This form does not arm it.' } : undefined}
          price={executionPrice}
          marketDataExchange={marketDataExchange}
          market={hyperliquidExecution ? hlExecutionMarket : executionMarket}
          exchange={account.session}
          status={account.status}
          exchangeError={hyperliquidExecution ? hlAccount.pending?.message || hlAccount.error : account.error}
          settings={executionSettings}
          settingsLoading={account.settingsLoading || (account.session.connected && !executionSettings)}
          instrumentSupported={hyperliquidExecution ? Boolean(hlAccount.contract) : selectedInstrumentSupported}
          positions={account.session.snapshot?.positions ?? []}
          openOrders={account.session.snapshot?.openOrders ?? []}
          onCreateOrder={(order) => setOrders((current) => [order, ...current])}
          onChangeMarginType={account.changeMarginType}
          onChangeLeverage={account.changeLeverage}
          onPreviewOrder={account.previewOrder}
          onExecuteOrder={account.executeOrder}
          onOpenRiskManagement={() => setActiveSection('risk')}
          onProtectionDraftChange={setOrderProtectionDraft}
        />
        <BottomPanel
          key={`positions:${nativeIdentity}`}
          venue={hyperliquidExecution ? `Hyperliquid ${executionNetwork === 'testnet' ? 'Testnet' : 'Mainnet'}` : undefined}
          quoteAsset={hyperliquidExecution ? 'USD' : undefined}
          settlementCurrency={hyperliquidExecution ? 'USDC' : undefined}
          actionsEnabled={!hyperliquidExecution || hlAccount.writesEnabled && !hlAccount.pending}
          checkedAt={hyperliquidExecution ? hlAccount.snapshot?.checkedAt : undefined}
          statusMessage={hyperliquidExecution ? hlAccount.pending?.message || hlAccount.error || hlAccount.message || (hlAccount.status === 'checking' ? 'Loading native account…' : executionNetwork === 'mainnet' ? 'Mainnet · account reads only' : '') : undefined}
          onRefreshAccount={hyperliquidExecution ? hlAccount.refresh : undefined}
          onReconcilePending={hyperliquidExecution && hlAccount.pending ? hlAccount.reconcile : undefined}
          onOpenRiskManagement={() => setActiveSection('risk')}
          demoOrders={hyperliquidExecution ? [] : orders}
          exchangeOrders={account.session.snapshot?.openOrders ?? []}
          contracts={hyperliquidExecution ? hlAccount.contracts : exchange.contractCatalog?.contracts ?? []}
          connected={account.session.connected}
          positions={account.session.snapshot?.positions ?? []}
          balances={account.session.snapshot?.balances ?? []}
          history={account.history}
          historyLoading={account.historyLoading}
          environment={account.session.environment}
          liveTradingEnabled={account.session.liveTradingEnabled}
          executing={account.status === 'executing' || account.status === 'updating'}
          onRemoveDemo={(id) => setOrders((current) => current.filter((order) => order.id !== id))}
          onCancelOrder={account.cancelOrder}
          onAmendOrder={account.amendOrder}
          onClosePosition={account.closePosition}
          onRefreshHistory={() => account.refreshHistory()}
        />
      </main>
      <StatusBar protectionAware={hyperliquidExecution} />
      </>
      )}
      {hyperliquidExecution && <HyperliquidActionReview review={hlAccount.review} busy={hlAccount.busy} />}
      {executionChooserOpen && <ExecutionAccountChooser provider={executionProvider} network={executionNetwork}
        connectionContent={<><HyperliquidLegacyRecoveryPanel pending={hlAccount.pending} review={hlAccount.legacyRecoveryReview} receipt={hlAccount.legacyRecoveryReceipts[0]??null} busy={hlAccount.busy||hlAccount.agentBusy} message={hlAccount.legacyRecoveryMessage} onReview={hlAccount.reviewLegacyRequest} onArchive={hlAccount.archiveLegacyRequest}/><HyperliquidTerminalAgentPanel status={hlAccount.agentStatus} approval={hlAccount.agentApproval} busy={hlAccount.agentBusy||hlAccount.busy} message={hlAccount.agentMessage} onPrepare={hlAccount.prepareAgent} onApprove={hlAccount.approveAgent} onRefresh={hlAccount.refreshAgent} onDisable={hlAccount.disableAgent} /></>}
        onProvider={setExecutionProvider} onNetwork={setExecutionNetwork} onClose={closeExecutionChooser} onManage={() => { setExecutionChooserOpen(false); if (hyperliquidExecution) setActiveSection('risk'); else setExchangeModalOpen(true) }} />}
      <ExchangeConnectionModal
        open={!hyperliquidExecution && exchangeModalOpen}
        session={exchange.session}
        accounts={exchange.accounts}
        connecting={exchange.status === 'connecting'}
        error={exchange.error}
        onClose={() => setExchangeModalOpen(false)}
        onConnect={exchange.connect}
        onSelectAccount={exchange.selectAccount}
        onDisconnect={exchange.disconnect}
      />
    </div>
  )
}

export default function App() {
  const auth = useAuth()
  const [theme, setTheme] = useState<Theme>(() => document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')
  const [completedAuthSequence, setCompletedAuthSequence] = useState(0)
  const toggleTheme = useCallback(() => setTheme((current) => current === 'dark' ? 'light' : 'dark'), [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
    localStorage.setItem('antytilt:theme', theme)
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f4f6f8' : '#090b0f')
  }, [theme])

  if (auth.status === 'checking') return <div className="auth-shell"><div className="auth-loading"><span className="button-spinner" />Securing your session…</div></div>
  if (!auth.session.authenticated || !auth.session.user) {
    return <AuthScreen busy={auth.status === 'submitting'} error={auth.error} theme={theme} onToggleTheme={toggleTheme} onSubmit={auth.submit} />
  }
  const showMarketPulse = auth.manualAuthSequence > completedAuthSequence
  return (
    <>
      <TerminalApp user={auth.session.user} theme={theme} onToggleTheme={toggleTheme} onLogout={() => auth.logout().catch(() => undefined)} />
      {showMarketPulse && (
        <MarketPulseIntro
          key={auth.manualAuthSequence}
          onComplete={() => setCompletedAuthSequence(auth.manualAuthSequence)}
        />
      )}
    </>
  )
}
