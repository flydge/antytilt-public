export type Candle = {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export type BookLevel = {
  price: number
  quantity: number
  total: number
}

export type MarketTrade = {
  id: number
  price: number
  quantity: number
  time: number
  side: 'buy' | 'sell'
}

export type Ticker = {
  lastPrice: number
  priceChangePercent: number
  highPrice: number
  lowPrice: number
  volume: number
  quoteVolume: number
}

export type MarketInstrument = {
  id: string
  symbol: string
  baseAsset: string
  quoteAsset: 'USDT' | 'USD'
  name: string
  logoUrl: string
  marketCapRank: number
  lastPrice: number
  priceChangePercent: number
  exchanges: Array<'binance' | 'bybit' | 'hyperliquid'>
}

export type DemoOrder = {
  id: string
  symbol: string
  side: 'Buy' | 'Sell'
  type: string
  price: number
  quantity: number
  status: string
  createdAt: string
}

export type ExchangeEnvironment = 'prod-vst' | 'prod-live'
export type ExchangeId = 'bingx' | 'bybit' | 'binance' | 'okx'
export type PositionDirection = 'LONG' | 'SHORT'
export type ExchangeMarginType = 'CROSSED' | 'ISOLATED'

export type ExchangeBalance = {
  asset: string
  balance: string
  equity: string
  unrealizedProfit: string
  availableMargin: string
  usedMargin: string
}

export type ExchangePosition = {
  symbol: string
  positionId: string
  positionSide: PositionDirection
  isolated: boolean
  positionAmt: string
  availableAmt: string
  unrealizedProfit: string
  realisedProfit?: string
  initialMargin: string
  liquidationPrice: string | number
  avgPrice: string
  leverage: number
  positionValue?: string
  currency: string
}

export type ExchangeSnapshot = {
  balances: ExchangeBalance[]
  positions: ExchangePosition[]
  openOrders: ExchangeOrder[]
  dualSidePosition: boolean
  updatedAt: number
}

export type ExchangeOrder = Record<string, unknown> & {
  orderId?: string
  orderID?: string
  symbol?: string
  side?: string
  positionSide?: string
  type?: string
  price?: string
  stopPrice?: string
  origQty?: string
  quantity?: string
  executedQty?: string
  status?: string
  clientOrderId?: string
  time?: string | number
}

export type ExchangeSessionState = {
  connected: boolean
  accountId?: string
  exchange?: ExchangeId
  environment?: ExchangeEnvironment
  label?: string
  apiKeyMask?: string
  connectedAt?: number
  liveTradingEnabled: boolean
  liveTriggerOrdersEnabled: boolean
  snapshot?: ExchangeSnapshot
}

export type ExchangeAccountSummary = {
  id: string
  userId: string
  exchange: ExchangeId
  environment: ExchangeEnvironment
  label: string
  apiKeyMask: string
  status: 'ACTIVE' | 'REVOKED' | 'ARCHIVED'
  isDefault: boolean
  connectedAt: number
  lastVerifiedAt?: number
  createdAt: number
  updatedAt: number
}

export type AuthUser = {
  id: string
  email: string
  createdAt: number
}

export type AuthSessionState = {
  authenticated: boolean
  user?: AuthUser
}

export type RiskValueRule = {
  enabled: boolean
  value: number
}

export type DailyLossRiskRule = RiskValueRule & {
  unit: 'PERCENT' | 'USDT'
}

export type FixedStopRiskRule = RiskValueRule & {
  workingType: 'MARK_PRICE' | 'CONTRACT_PRICE'
}

export type BreakEvenRiskRule = {
  enabled: boolean
  triggerMode: 'PERCENT' | 'R_MULTIPLE'
  triggerValue: number
  offsetPercent: number
}

export type ExternalViolationPolicy = 'BLOCK_NEW_ENTRIES' | 'BLOCK_AND_CLOSE_EXTERNAL'
export type RiskBreachAction = 'BLOCK_NEW_ENTRIES' | 'CANCEL_PENDING_ORDERS' | 'CLOSE_VIOLATING_POSITION' | 'CLOSE_ALL'

export type RiskProfile = {
  active: boolean
  timezone: string
  externalViolationPolicy: ExternalViolationPolicy
  breachAction: RiskBreachAction
  closeExternalEntriesOnBreach: boolean
  automationConsent: boolean
  fixedStopLoss: FixedStopRiskRule
  breakEven: BreakEvenRiskRule
  riskPerTrade: RiskValueRule
  dailyLossLimit: DailyLossRiskRule
  maxLeverage: RiskValueRule
  maxTradesPerDay: RiskValueRule
  maxConsecutiveLosses: RiskValueRule
  cooldownMinutes: RiskValueRule
  maxExposurePercent: RiskValueRule
  maxOpenPositions: RiskValueRule
  updatedAt: number
}

export type RiskWorkerStatus = 'RUNNING' | 'IDLE' | 'STALE' | 'ERROR' | 'DISCONNECTED'

export type RiskRuntimeStatus = {
  active?: boolean
  enforcing?: boolean
  liveAutomationEnabled?: boolean
  timezone?: string
  tradingDay?: string
  tradesUsed?: number
  tradeLimit?: number
  tradesRemaining?: number
  dailyPnl?: number
  dailyOpeningEquity?: number
  currentEquity?: number
  openPositions?: number
  blocked?: boolean
  blockCode?: string
  blockRule?: string
  blockReason?: string
  blockDetails?: Record<string, string | number | boolean | undefined>
  nextResetAt?: number
  workerStatus?: RiskWorkerStatus
  lastCheckedAt?: number
  lastActionAt?: number
  lastError?: string
  retryAt?: number
  consecutiveLosses?: number
  cooldownUntil?: number
  trackedProtections?: number
  managedProtections?: number
  breakevenLatched?: number
  updatedAt?: number
}

export type RiskEvent = {
  id: string
  type: string
  message: string
  createdAt: number
  rule?: string
  action?: string
  outcome?: string
  severity?: 'INFO' | 'WARNING' | 'ERROR'
  source?: 'TERMINAL' | 'EXTERNAL' | 'SYSTEM'
  symbol?: string
  positionId?: string
  orderId?: string
  metadata?: Record<string, unknown>
}

export type OrderHistoryItem = {
  orderId: string
  symbol: string
  side: string
  positionSide: string
  type: string
  price: string
  avgPrice: string
  quantity: string
  executedQty: string
  status: string
  realizedPnl: string
  fee: string
  time: number
  updateTime: number
}

export type TradeHistoryItem = {
  tradeId: string
  orderId: string
  symbol: string
  side: string
  positionSide: string
  price: string
  quantity: string
  realizedPnl: string
  fee: string
  time: number
}

export type AccountHistory = {
  orderHistory: OrderHistoryItem[]
  tradeHistory: TradeHistoryItem[]
  synchronizedAt: number
  warnings: string[]
}

export type PositionProtectionInput = {
  orderId?: string
  kind: 'TAKE_PROFIT' | 'STOP_LOSS'
  stopPrice: number
  workingType: ProtectionWorkingType
}

export type MarketOrderInput = {
  symbol: string
  direction: PositionDirection
  quoteOrderQty: number
  leverage: number
  marginType: ExchangeMarginType
  confirmation?: string
}

export type ExchangeContract = {
  symbol: string
  quantityPrecision: number
  pricePrecision: number
  makerFeeRate: number
  takerFeeRate: number
  tradeMinQuantity: number
  tradeMinUSDT: number
  maxLongLeverage: number
  maxShortLeverage: number
  status: number
  apiStateOpen: string
  apiStateClose: string
  asset: string
  currency: string
}

export type ExchangeContractCatalog = {
  exchange: 'bingx'
  contracts: ExchangeContract[]
  updatedAt: number
}

export type TradingSettings = {
  symbol: string
  marginType: ExchangeMarginType
  longLeverage: number
  shortLeverage: number
  maxLongLeverage: number
  maxShortLeverage: number
  dualSidePosition: boolean
  contract: ExchangeContract
  prices: {
    markPrice: number
    indexPrice: number
    bidPrice: number
    askPrice: number
  }
  updatedAt: number
}

export type OrderKind = 'MARKET' | 'LIMIT' | 'TRIGGER'
export type AmountMode = 'QUANTITY' | 'VALUE' | 'COST'
export type TriggerExecution = 'MARKET' | 'LIMIT'
export type WorkingType = 'MARK_PRICE' | 'CONTRACT_PRICE' | 'INDEX_PRICE'
export type ProtectionWorkingType = 'MARK_PRICE' | 'CONTRACT_PRICE'
export type TimeInForce = 'GTC' | 'IOC' | 'FOK' | 'PostOnly'

export type AttachedProtection = {
  stopPrice: number
  execution: 'MARKET' | 'LIMIT'
  price?: number
  workingType: ProtectionWorkingType
}

export type AdvancedOrderInput = {
  symbol: string
  direction: PositionDirection
  orderKind: OrderKind
  amountMode: AmountMode
  amount: number
  leverage: number
  marginType: ExchangeMarginType
  price?: number
  timeInForce?: TimeInForce
  triggerPrice?: number
  triggerExecution?: TriggerExecution
  workingType?: WorkingType
  reduceOnly?: boolean
  maxSlippagePercent?: number
  takeProfit?: AttachedProtection
  stopLoss?: AttachedProtection
}

export type OrderPreview = {
  symbol: string
  direction: PositionDirection
  orderKind: OrderKind
  exchangeOrderType: string
  amountMode: AmountMode
  quantity: number
  notional: number
  estimatedMargin: number
  estimatedOpenFee: number
  estimatedCloseFee: number
  estimatedOrderCost: number
  estimatedAveragePrice: number
  estimatedSlippagePercent: number
  indicativeLiquidationPrice: number
  marginType: ExchangeMarginType
  leverage: number
  maker: boolean
  triggerLiveVerified: boolean
  takeProfit?: AttachedProtection & { expectedPnl: number }
  stopLoss?: AttachedProtection & { expectedPnl: number }
  riskReward?: number
}

export type OrderPreviewResponse = {
  previewId: string
  preview: OrderPreview
  expiresAt: number
}

export type OrderProtectionDraft = {
  symbol: string
  direction: PositionDirection
  entryPrice: number
  quantity: number
  takeProfitPrice?: number
  stopLossPrice?: number
}
