import * as crypto from "crypto";
import JSONBig from "json-bigint";
const JSONBigParse = JSONBig({ storeAsString: true });

// Base URLs — see references/base-urls.md for all environments
// Each env maps to [primary (.com), fallback (.pro)].
// Fallback is used ONLY when primary is unreachable or times out.
const ENV_URLS: Record<string, string[]> = {
  "prod-live": ["https://open-api.bingx.com", "https://open-api.bingx.pro"],
  "prod-vst":  ["https://open-api-vst.bingx.com", "https://open-api-vst.bingx.pro"],
};

const serverTimeOffsets = new Map<string, number>();
const serverTimeSyncs = new Map<string, Promise<number>>();

async function synchronizeServerTime(env: string): Promise<number> {
  const activeSync = serverTimeSyncs.get(env);
  if (activeSync) return activeSync;

  const sync = (async () => {
    const baseUrls = ENV_URLS[env] ?? ENV_URLS["prod-live"];
    let lastError: unknown;
    for (const baseUrl of baseUrls) {
      const requestedAt = Date.now();
      try {
        const response = await fetch(`${baseUrl}/openApi/swap/v2/server/time`, {
          signal: AbortSignal.timeout(10000),
        });
        const receivedAt = Date.now();
        const json = JSONBigParse.parse(await response.text());
        const serverTime = Number(json?.data?.serverTime);
        if (!response.ok || json?.code !== 0 || !Number.isFinite(serverTime)) {
          throw new Error(`BingX server time request failed with HTTP ${response.status}`);
        }
        const offset = Math.round(serverTime - ((requestedAt + receivedAt) / 2));
        serverTimeOffsets.set(env, offset);
        return offset;
      } catch (error) {
        lastError = error;
        if (!isNetworkOrTimeout(error) || baseUrl === baseUrls[baseUrls.length - 1]) throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Unable to synchronize BingX server time');
  })();

  serverTimeSyncs.set(env, sync);
  try {
    return await sync;
  } finally {
    serverTimeSyncs.delete(env);
  }
}

function isNetworkOrTimeout(e: unknown): boolean {
  if (e instanceof TypeError) return true;
  if (e instanceof DOMException && e.name === "AbortError") return true;
  if (e instanceof Error && e.name === "TimeoutError") return true;
  return false;
}

function isTimestampError(code: unknown, message: unknown): boolean {
  if (Number(code) === 100421) return true;
  const normalizedMessage = String(message ?? '');
  return /timestamp/i.test(normalizedMessage)
    && /(invalid|mismatch|expired|ahead|behind)/i.test(normalizedMessage);
}

/**
 * Reject parameter values containing query-string metacharacters to prevent
 * signed parameter pollution (e.g. "BTC-USDT&side=SELL&quantity=100").
 */
function validateParams(params: Record<string, unknown>): void {
  const FORBIDDEN = /[&=?#\r\n]/;
  for (const [k, v] of Object.entries(params)) {
    const s = String(v);
    if (FORBIDDEN.test(s)) {
      throw new Error(
        `Parameter "${k}" contains forbidden character in value: "${s}". ` +
        `Possible parameter injection attempt.`
      );
    }
  }
}

/**
 * Build the canonical signing string: ASCII-sort all keys, join as key=value pairs.
 * Values must NOT be URL-encoded at this stage.
 */
function buildCanonical(params: Record<string, unknown>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
}

/**
 * URL-encode only the values in a query string when the canonical string
 * contains '[' or '{' (e.g. batch order arrays). Keys are never encoded.
 */
function encodeQueryValues(params: Record<string, unknown>, signature: string): string {
  const pairs = Object.keys(params)
    .sort()
    .map((k) => {
      const v = String(params[k]);
      const needsEncoding = v.includes("[") || v.includes("{");
      return `${k}=${needsEncoding ? encodeURIComponent(v) : v}`;
    });
  pairs.push(`signature=${signature}`);
  return pairs.join("&");
}

/**
 * Make a signed BingX REST request.
 *
 * @param jsonBody - When true, sends POST body as application/json with
 *                   timestamp and signature embedded in the JSON object.
 *                   When false (default), uses application/x-www-form-urlencoded.
 */
async function fetchSigned(
  env: string,
  apiKey: string,
  secretKey: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, unknown> = {},
  jsonBody = false,
  allowTimestampRetry = true,
): Promise<unknown> {
  const baseUrls = ENV_URLS[env] ?? ENV_URLS["prod-live"];
  const timestamp = Math.round(Date.now() + (serverTimeOffsets.get(env) ?? 0));
  const allParams = { ...params, timestamp };

  validateParams(allParams);

  const canonical = buildCanonical(allParams);

  const signature = crypto
    .createHmac("sha256", secretKey)
    .update(canonical)
    .digest("hex");

  const needsValueEncoding = canonical.includes("[") || canonical.includes("{");

  for (const baseUrl of baseUrls) {
    try {
      let url: string;
      let body: string | undefined;
      let contentType: string | undefined;

      if (method === "POST" && jsonBody) {
        url = `${baseUrl}${path}`;
        body = JSON.stringify({ ...allParams, signature });
        contentType = "application/json";
      } else if (method === "POST") {
        url = `${baseUrl}${path}`;
        body = `${canonical}&signature=${signature}`;
        contentType = "application/x-www-form-urlencoded";
      } else {
        const query = needsValueEncoding
          ? encodeQueryValues(allParams, signature)
          : `${canonical}&signature=${signature}`;
        url = `${baseUrl}${path}?${query}`;
      }

      const res = await fetch(url, {
        method,
        headers: {
          "X-BX-APIKEY": apiKey,
          "X-SOURCE-KEY": "BX-AI-SKILL",
          ...(contentType ? { "Content-Type": contentType } : {}),
        },
        body,
        signal: AbortSignal.timeout(10000),
      });

      const json = JSONBigParse.parse(await res.text());
      if (isTimestampError(json.code, json.msg) && allowTimestampRetry) {
        await synchronizeServerTime(env);
        return fetchSigned(env, apiKey, secretKey, method, path, params, jsonBody, false);
      }
      if (json.code !== 0) throw new Error(`BingX error ${json.code}: ${json.msg}`);
      return json.data;
    } catch (e) {
      if (!isNetworkOrTimeout(e) || baseUrl === baseUrls[baseUrls.length - 1]) throw e;
    }
  }
}

export type BingxEnvironment = 'prod-vst' | 'prod-live'
export type BingxCredentials = { apiKey: string; secretKey: string }
export type PositionDirection = 'LONG' | 'SHORT'
export type MarginType = 'CROSSED' | 'ISOLATED'

export type BingxBalance = {
  asset: string
  balance: string
  equity: string
  unrealizedProfit: string
  availableMargin: string
  usedMargin: string
}

export type BingxPosition = {
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

export type BingxOrder = Record<string, unknown> & {
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

export type BingxContract = {
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

export type BingxTradingSettings = {
  symbol: string
  marginType: MarginType
  longLeverage: number
  shortLeverage: number
  maxLongLeverage: number
  maxShortLeverage: number
  dualSidePosition: boolean
  contract: BingxContract
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
  marginType: MarginType
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

export type PreparedOrder = {
  input: AdvancedOrderInput
  params: Record<string, unknown>
  preview: {
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
    marginType: MarginType
    leverage: number
    maker: boolean
    triggerLiveVerified: boolean
    takeProfit?: AttachedProtection & { expectedPnl: number }
    stopLoss?: AttachedProtection & { expectedPnl: number }
    riskReward?: number
  }
}

function assertEnvironment(environment: string): asserts environment is BingxEnvironment {
  if (environment !== 'prod-vst' && environment !== 'prod-live') throw new Error('Unsupported BingX environment')
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : []
}

function balanceRows(value: unknown): BingxBalance[] {
  const rows = asArray<BingxBalance>(value)
  if (rows.length) return rows
  const nested = (value as { balance?: unknown } | null)?.balance
  if (Array.isArray(nested)) return nested as BingxBalance[]
  return nested && typeof nested === 'object' ? [nested as BingxBalance] : []
}

export function settlementAsset(environment: BingxEnvironment) {
  return environment === 'prod-vst' ? 'VST' : 'USDT'
}

export function selectSettlementBalance(environment: BingxEnvironment, balances: BingxBalance[]) {
  const preferredAsset = settlementAsset(environment)
  return balances.find((balance) => balance.asset.toUpperCase() === preferredAsset)
    ?? (balances.length === 1 ? balances[0] : undefined)
}

function request(
  environment: BingxEnvironment,
  credentials: BingxCredentials,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  params: Record<string, unknown> = {},
) {
  assertEnvironment(environment)
  return fetchSigned(environment, credentials.apiKey, credentials.secretKey, method, path, {
    ...params,
    recvWindow: 5000,
  })
}

export async function getAccountSnapshot(environment: BingxEnvironment, credentials: BingxCredentials) {
  const [balanceResponse, positionsResponse, ordersResponse, positionModeResponse] = await Promise.all([
    request(environment, credentials, 'GET', '/openApi/swap/v3/user/balance'),
    request(environment, credentials, 'GET', '/openApi/swap/v2/user/positions'),
    request(environment, credentials, 'GET', '/openApi/swap/v2/trade/openOrders'),
    request(environment, credentials, 'GET', '/openApi/swap/v1/positionSide/dual'),
  ])

  const balances = balanceRows(balanceResponse)

  const nestedOrders = (ordersResponse as { orders?: unknown } | null)?.orders
  const orders = asArray<BingxOrder>(ordersResponse).length
    ? asArray<BingxOrder>(ordersResponse)
    : asArray<BingxOrder>(nestedOrders)

  return {
    balances,
    positions: asArray<BingxPosition>(positionsResponse).filter((position) => Math.abs(Number(position.positionAmt)) > 0),
    openOrders: orders,
    dualSidePosition: Boolean((positionModeResponse as { dualSidePosition?: boolean } | null)?.dualSidePosition),
    updatedAt: Date.now(),
  }
}

export async function getMarginType(environment: BingxEnvironment, credentials: BingxCredentials, symbol: string) {
  return request(environment, credentials, 'GET', '/openApi/swap/v2/trade/marginType', { symbol }) as Promise<{ marginType?: MarginType }>
}

export async function getLeverage(environment: BingxEnvironment, credentials: BingxCredentials, symbol: string) {
  return request(environment, credentials, 'GET', '/openApi/swap/v2/trade/leverage', { symbol }) as Promise<{
    longLeverage?: number
    shortLeverage?: number
    maxLongLeverage?: number
    maxShortLeverage?: number
  }>
}

export async function getPositionMode(environment: BingxEnvironment, credentials: BingxCredentials) {
  return request(environment, credentials, 'GET', '/openApi/swap/v1/positionSide/dual') as Promise<{ dualSidePosition?: boolean }>
}

const contractCache = new Map<string, { expiresAt: number; contract: BingxContract }>()
const contractListCache = new Map<BingxEnvironment, { expiresAt: number; contracts: BingxContract[] }>()

function firstObject<T>(value: unknown): T | undefined {
  if (Array.isArray(value)) return value[0] as T | undefined
  return value && typeof value === 'object' ? value as T : undefined
}

function asFiniteNumber(value: unknown, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function normalizeContractRow(row: Record<string, unknown>): BingxContract {
  const symbol = String(row.symbol ?? '')
  return {
    symbol,
    quantityPrecision: asFiniteNumber(row.quantityPrecision),
    pricePrecision: asFiniteNumber(row.pricePrecision),
    makerFeeRate: asFiniteNumber(row.makerFeeRate ?? row.feeRate),
    takerFeeRate: asFiniteNumber(row.takerFeeRate ?? row.feeRate),
    tradeMinQuantity: asFiniteNumber(row.tradeMinQuantity ?? row.tradeMinLimit),
    tradeMinUSDT: asFiniteNumber(row.tradeMinUSDT),
    maxLongLeverage: asFiniteNumber(row.maxLongLeverage, 1),
    maxShortLeverage: asFiniteNumber(row.maxShortLeverage, 1),
    status: asFiniteNumber(row.status),
    apiStateOpen: String(row.apiStateOpen ?? 'true'),
    apiStateClose: String(row.apiStateClose ?? 'true'),
    asset: String(row.asset ?? symbol.split('-')[0]),
    currency: String(row.currency ?? 'USDT'),
  }
}

export async function listTradableContracts(
  environment: BingxEnvironment,
  credentials: BingxCredentials,
) {
  const cached = contractListCache.get(environment)
  if (cached && cached.expiresAt > Date.now()) return cached.contracts
  const response = await request(environment, credentials, 'GET', '/openApi/swap/v2/quote/contracts')
  const contracts = asArray<Record<string, unknown>>(response)
    .map(normalizeContractRow)
    .filter((contract) => (
      contract.symbol.endsWith('-USDT')
      && contract.status === 1
      && contract.apiStateOpen.toLowerCase() === 'true'
    ))
  for (const contract of contracts) {
    contractCache.set(`${environment}:${contract.symbol}`, { expiresAt: Date.now() + 5 * 60_000, contract })
  }
  contractListCache.set(environment, { expiresAt: Date.now() + 5 * 60_000, contracts })
  return contracts
}

async function getContract(
  environment: BingxEnvironment,
  credentials: BingxCredentials,
  symbol: string,
) {
  const cacheKey = `${environment}:${symbol}`
  const cached = contractCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.contract

  const response = await request(environment, credentials, 'GET', '/openApi/swap/v2/quote/contracts', { symbol })
  const row = asArray<Record<string, unknown>>(response).find((item) => item.symbol === symbol)
    ?? firstObject<Record<string, unknown>>(response)
  if (!row || row.symbol !== symbol) throw new Error(`BingX contract ${symbol} is unavailable`)

  const contract = normalizeContractRow(row)
  contractCache.set(cacheKey, { expiresAt: Date.now() + 60_000, contract })
  return contract
}

export async function getTradingSettings(
  environment: BingxEnvironment,
  credentials: BingxCredentials,
  symbol: string,
): Promise<BingxTradingSettings> {
  const [contract, margin, leverage, positionMode, premiumResponse, bookResponse] = await Promise.all([
    getContract(environment, credentials, symbol),
    getMarginType(environment, credentials, symbol),
    getLeverage(environment, credentials, symbol),
    getPositionMode(environment, credentials),
    request(environment, credentials, 'GET', '/openApi/swap/v2/quote/premiumIndex', { symbol }),
    request(environment, credentials, 'GET', '/openApi/swap/v2/quote/bookTicker', { symbol }),
  ])
  const premiumOuter = firstObject<Record<string, unknown>>(premiumResponse) ?? {}
  const premium = firstObject<Record<string, unknown>>(premiumOuter.premium_index ?? premiumOuter.premiumIndex)
    ?? premiumOuter
  const bookOuter = firstObject<Record<string, unknown>>(bookResponse) ?? {}
  const book = firstObject<Record<string, unknown>>(bookOuter.book_ticker ?? bookOuter.bookTicker)
    ?? bookOuter
  let bidPrice = asFiniteNumber(book.bidPrice ?? book.bid_price)
  let askPrice = asFiniteNumber(book.askPrice ?? book.ask_price)
  if (!(bidPrice > 0) || !(askPrice > 0)) {
    const depth = await request(environment, credentials, 'GET', '/openApi/swap/v2/quote/depth', {
      symbol,
      limit: 5,
    }) as { bids?: Array<[string, string]>; asks?: Array<[string, string]> }
    bidPrice = asFiniteNumber(depth.bids?.[0]?.[0], bidPrice)
    askPrice = asFiniteNumber(depth.asks?.[0]?.[0], askPrice)
  }
  return {
    symbol,
    marginType: margin.marginType === 'ISOLATED' ? 'ISOLATED' : 'CROSSED',
    longLeverage: asFiniteNumber(leverage.longLeverage, 1),
    shortLeverage: asFiniteNumber(leverage.shortLeverage, 1),
    maxLongLeverage: asFiniteNumber(leverage.maxLongLeverage, contract.maxLongLeverage),
    maxShortLeverage: asFiniteNumber(leverage.maxShortLeverage, contract.maxShortLeverage),
    dualSidePosition: Boolean(positionMode.dualSidePosition),
    contract,
    prices: {
      markPrice: asFiniteNumber(premium.markPrice),
      indexPrice: asFiniteNumber(premium.indexPrice),
      bidPrice,
      askPrice,
    },
    updatedAt: Date.now(),
  }
}

export async function updateMarginType(
  environment: BingxEnvironment,
  credentials: BingxCredentials,
  symbol: string,
  marginType: MarginType,
) {
  const settings = await getTradingSettings(environment, credentials, symbol)
  if (settings.marginType !== marginType) {
    await request(environment, credentials, 'POST', '/openApi/swap/v2/trade/marginType', { symbol, marginType })
  }
  return { ...settings, marginType, updatedAt: Date.now() }
}

export async function updateLeverage(
  environment: BingxEnvironment,
  credentials: BingxCredentials,
  input: { symbol: string; direction: PositionDirection; leverage: number },
) {
  const settings = await getTradingSettings(environment, credentials, input.symbol)
  const linkedCrossHedge = settings.dualSidePosition && settings.marginType === 'CROSSED'
  const maximum = linkedCrossHedge
    ? Math.min(settings.maxLongLeverage, settings.maxShortLeverage)
    : input.direction === 'LONG' ? settings.maxLongLeverage : settings.maxShortLeverage
  if (input.leverage > maximum) throw new Error(`BingX allows up to ${maximum}x for ${input.symbol} ${input.direction}`)
  const current = input.direction === 'LONG' ? settings.longLeverage : settings.shortLeverage
  const oppositeCurrent = input.direction === 'LONG' ? settings.shortLeverage : settings.longLeverage
  if (linkedCrossHedge && (current !== input.leverage || oppositeCurrent !== input.leverage)) {
    await request(environment, credentials, 'POST', '/openApi/swap/v2/trade/leverage', {
      symbol: input.symbol,
      side: 'LONG',
      leverage: input.leverage,
    })
    await request(environment, credentials, 'POST', '/openApi/swap/v2/trade/leverage', {
      symbol: input.symbol,
      side: 'SHORT',
      leverage: input.leverage,
    })
  } else if (current !== input.leverage) {
    await request(environment, credentials, 'POST', '/openApi/swap/v2/trade/leverage', {
      symbol: input.symbol,
      side: settings.dualSidePosition ? input.direction : 'BOTH',
      leverage: input.leverage,
    })
  }
  return {
    ...settings,
    longLeverage: linkedCrossHedge || !settings.dualSidePosition || input.direction === 'LONG'
      ? input.leverage
      : settings.longLeverage,
    shortLeverage: linkedCrossHedge || !settings.dualSidePosition || input.direction === 'SHORT'
      ? input.leverage
      : settings.shortLeverage,
    updatedAt: Date.now(),
  }
}

export async function placeMarketOrder(
  environment: BingxEnvironment,
  credentials: BingxCredentials,
  input: {
    symbol: string
    direction: PositionDirection
    quoteOrderQty: number
    leverage: number
    marginType: MarginType
    clientOrderId: string
  },
) {
  const positionMode = await getPositionMode(environment, credentials)
  const dualSide = Boolean(positionMode?.dualSidePosition)
  const positionSide = dualSide ? input.direction : 'BOTH'
  const leverageSide = dualSide ? input.direction : 'BOTH'
  const [currentMargin, currentLeverage] = await Promise.all([
    getMarginType(environment, credentials, input.symbol),
    getLeverage(environment, credentials, input.symbol),
  ])

  const maximumLeverage = input.direction === 'LONG'
    ? currentLeverage?.maxLongLeverage
    : currentLeverage?.maxShortLeverage
  if (Number(maximumLeverage) > 0 && input.leverage > Number(maximumLeverage)) {
    throw new Error(`BingX allows up to ${maximumLeverage}x leverage for ${input.symbol} ${input.direction}`)
  }

  if (currentMargin?.marginType !== input.marginType) {
    await request(environment, credentials, 'POST', '/openApi/swap/v2/trade/marginType', {
      symbol: input.symbol,
      marginType: input.marginType,
    })
  }

  const sideLeverage = input.direction === 'LONG' ? currentLeverage?.longLeverage : currentLeverage?.shortLeverage
  if (Number(sideLeverage) !== input.leverage) {
    await request(environment, credentials, 'POST', '/openApi/swap/v2/trade/leverage', {
      symbol: input.symbol,
      side: leverageSide,
      leverage: input.leverage,
    })
  }

  return request(environment, credentials, 'POST', '/openApi/swap/v2/trade/order', {
    symbol: input.symbol,
    side: input.direction === 'LONG' ? 'BUY' : 'SELL',
    positionSide,
    type: 'MARKET',
    quoteOrderQty: input.quoteOrderQty,
    clientOrderId: input.clientOrderId,
  })
}

function floorToPrecision(value: number, precision: number) {
  const factor = 10 ** precision
  return Math.floor((value + Number.EPSILON) * factor) / factor
}

function roundToPrecision(value: number, precision: number) {
  const factor = 10 ** precision
  return Math.round((value + Number.EPSILON) * factor) / factor
}

function normalizeProtection(
  protection: AttachedProtection | undefined,
  precision: number,
  kind: 'stopLoss' | 'takeProfit',
) {
  if (!protection) return undefined
  const stopPrice = roundToPrecision(protection.stopPrice, precision)
  const limitPrice = protection.execution === 'LIMIT'
    ? roundToPrecision(Number(protection.price), precision)
    : undefined
  if (!(stopPrice > 0)) throw new Error(`${kind} trigger price must be positive`)
  if (protection.execution === 'LIMIT' && !(Number(limitPrice) > 0)) {
    throw new Error(`${kind} limit price must be positive`)
  }
  return JSON.stringify({
    type: kind === 'stopLoss'
      ? protection.execution === 'MARKET' ? 'STOP_MARKET' : 'STOP'
      : protection.execution === 'MARKET' ? 'TAKE_PROFIT_MARKET' : 'TAKE_PROFIT',
    stopPrice,
    ...(limitPrice ? { price: limitPrice } : {}),
    workingType: protection.workingType,
    // BingX currently parses this nested field as a string even though some
    // versions of the public examples show a JSON boolean.
    stopGuaranteed: 'false',
  })
}

function validateProtectionDirection(
  input: AdvancedOrderInput,
  entryPrice: number,
) {
  if (input.takeProfit) {
    const valid = input.direction === 'LONG'
      ? input.takeProfit.stopPrice > entryPrice
      : input.takeProfit.stopPrice < entryPrice
    if (!valid) throw new Error(`Take Profit must be ${input.direction === 'LONG' ? 'above' : 'below'} the estimated entry price`)
  }
  if (input.stopLoss) {
    const valid = input.direction === 'LONG'
      ? input.stopLoss.stopPrice < entryPrice
      : input.stopLoss.stopPrice > entryPrice
    if (!valid) throw new Error(`Stop Loss must be ${input.direction === 'LONG' ? 'below' : 'above'} the estimated entry price`)
  }
}

function estimateDepthFill(
  levels: Array<[string, string]>,
  target: { quantity?: number; notional?: number },
) {
  let remainingQuantity = target.quantity ?? 0
  let remainingNotional = target.notional ?? 0
  let filledQuantity = 0
  let filledNotional = 0
  for (const [rawPrice, rawQuantity] of levels) {
    const levelPrice = Number(rawPrice)
    const levelQuantity = Number(rawQuantity)
    if (!(levelPrice > 0) || !(levelQuantity > 0)) continue
    const takeQuantity = target.quantity !== undefined
      ? Math.min(levelQuantity, remainingQuantity)
      : Math.min(levelQuantity, remainingNotional / levelPrice)
    filledQuantity += takeQuantity
    filledNotional += takeQuantity * levelPrice
    if (target.quantity !== undefined) remainingQuantity -= takeQuantity
    else remainingNotional -= takeQuantity * levelPrice
    if (remainingQuantity <= 1e-12 && remainingNotional <= 1e-8) break
  }
  const complete = target.quantity !== undefined ? remainingQuantity <= 1e-12 : remainingNotional <= 1e-6
  if (!complete || !(filledQuantity > 0)) throw new Error('BingX order book does not have enough visible liquidity for this preview')
  return { averagePrice: filledNotional / filledQuantity, quantity: filledQuantity, notional: filledNotional }
}

async function getAvailableSettlementMargin(environment: BingxEnvironment, credentials: BingxCredentials) {
  const response = await request(environment, credentials, 'GET', '/openApi/swap/v3/user/balance')
  return asFiniteNumber(selectSettlementBalance(environment, balanceRows(response))?.availableMargin)
}

export async function prepareAdvancedOrder(
  environment: BingxEnvironment,
  credentials: BingxCredentials,
  input: AdvancedOrderInput,
): Promise<PreparedOrder> {
  const settings = await getTradingSettings(environment, credentials, input.symbol)
  const maximumLeverage = input.direction === 'LONG' ? settings.maxLongLeverage : settings.maxShortLeverage
  const actualLeverage = input.direction === 'LONG' ? settings.longLeverage : settings.shortLeverage
  if (input.marginType !== settings.marginType) throw new Error('Margin mode changed on BingX. Refresh the form before placing the order.')
  if (input.leverage !== actualLeverage) throw new Error('Leverage changed on BingX. Refresh the form before placing the order.')
  if (input.leverage > maximumLeverage) throw new Error(`Maximum leverage for ${input.symbol} ${input.direction} is ${maximumLeverage}x`)
  if (settings.contract.status !== 1 || settings.contract.apiStateOpen !== 'true') {
    throw new Error(`${input.symbol} is not open for API trading on BingX`)
  }
  if (input.reduceOnly && settings.dualSidePosition) {
    throw new Error('Reduce-only is unavailable in Hedge Mode. Choose the position to close instead.')
  }

  const marketReference = input.direction === 'LONG' ? settings.prices.askPrice : settings.prices.bidPrice
  const triggerMarketReference = input.triggerPrice || marketReference
  const referencePrice = input.orderKind === 'LIMIT'
    ? Number(input.price)
    : input.orderKind === 'TRIGGER' && input.triggerExecution === 'LIMIT'
      ? Number(input.price)
      : input.orderKind === 'TRIGGER'
        ? triggerMarketReference
        : marketReference
  if (!(referencePrice > 0)) throw new Error('A valid BingX reference price is unavailable')

  const maker = input.orderKind === 'LIMIT' || (input.orderKind === 'TRIGGER' && input.triggerExecution === 'LIMIT')
  const openFeeRate = maker ? settings.contract.makerFeeRate : settings.contract.takerFeeRate
  const closeFeeRate = settings.contract.takerFeeRate
  let rawQuantity = 0
  let targetNotional = 0
  if (input.amountMode === 'QUANTITY') {
    rawQuantity = input.amount
    targetNotional = rawQuantity * referencePrice
  } else if (input.amountMode === 'VALUE') {
    targetNotional = input.amount
    rawQuantity = targetNotional / referencePrice
  } else {
    targetNotional = input.amount / ((1 / input.leverage) + openFeeRate + closeFeeRate)
    rawQuantity = targetNotional / referencePrice
  }

  const quoteSizedMarket = input.orderKind === 'MARKET' && input.amountMode !== 'QUANTITY'
  let quantity = quoteSizedMarket
    ? rawQuantity
    : floorToPrecision(rawQuantity, settings.contract.quantityPrecision)
  if (!(quantity > 0)) throw new Error('Order quantity rounds to zero at the BingX contract precision')

  let estimatedAveragePrice = referencePrice
  let notional = quantity * referencePrice
  let estimatedSlippagePercent = 0
  if (input.orderKind === 'MARKET') {
    const depthResponse = await request(environment, credentials, 'GET', '/openApi/swap/v2/quote/depth', {
      symbol: input.symbol,
      limit: 100,
    }) as { asks?: Array<[string, string]>; bids?: Array<[string, string]> }
    const levels = input.direction === 'LONG' ? depthResponse.asks ?? [] : depthResponse.bids ?? []
    const fill = estimateDepthFill(
      levels,
      input.amountMode === 'QUANTITY' ? { quantity } : { notional: targetNotional },
    )
    quantity = quoteSizedMarket
      ? fill.quantity
      : floorToPrecision(fill.quantity, settings.contract.quantityPrecision)
    estimatedAveragePrice = fill.averagePrice
    notional = quoteSizedMarket ? fill.notional : quantity * estimatedAveragePrice
    const bestPrice = Number(levels[0]?.[0])
    estimatedSlippagePercent = bestPrice > 0
      ? Math.abs((estimatedAveragePrice - bestPrice) / bestPrice) * 100
      : 0
    if (input.maxSlippagePercent !== undefined && estimatedSlippagePercent > input.maxSlippagePercent) {
      throw new Error(`Estimated slippage ${estimatedSlippagePercent.toFixed(3)}% exceeds your ${input.maxSlippagePercent}% limit`)
    }
  }

  if (settings.contract.tradeMinQuantity > 0 && quantity < settings.contract.tradeMinQuantity) {
    throw new Error(`Minimum quantity for ${input.symbol} is ${settings.contract.tradeMinQuantity}`)
  }
  if (settings.contract.tradeMinUSDT > 0 && notional < settings.contract.tradeMinUSDT) {
    throw new Error(`Minimum order value for ${input.symbol} is ${settings.contract.tradeMinUSDT} USDT`)
  }

  validateProtectionDirection(input, estimatedAveragePrice)
  const estimatedMargin = notional / input.leverage
  const estimatedOpenFee = notional * openFeeRate
  const estimatedCloseFee = notional * closeFeeRate
  const estimatedOrderCost = estimatedMargin + estimatedOpenFee + estimatedCloseFee
  const availableMargin = await getAvailableSettlementMargin(environment, credentials)
  const marginAsset = settlementAsset(environment)
  if (estimatedOrderCost > availableMargin) {
    throw new Error(`Estimated order cost ${estimatedOrderCost.toFixed(4)} ${marginAsset} exceeds available margin ${availableMargin.toFixed(4)} ${marginAsset}`)
  }

  const dualSide = settings.dualSidePosition
  const exchangeOrderType = input.orderKind === 'MARKET'
    ? 'MARKET'
    : input.orderKind === 'LIMIT'
      ? 'LIMIT'
      : input.triggerExecution === 'LIMIT' ? 'TRIGGER_LIMIT' : 'TRIGGER_MARKET'
  const params: Record<string, unknown> = {
    symbol: input.symbol,
    side: input.direction === 'LONG' ? 'BUY' : 'SELL',
    positionSide: dualSide ? input.direction : 'BOTH',
    type: exchangeOrderType,
  }

  if (input.orderKind === 'MARKET' && input.amountMode !== 'QUANTITY') {
    params.quoteOrderQty = roundToPrecision(notional, 4)
  } else {
    params.quantity = quantity
  }
  if (input.orderKind === 'LIMIT' || (input.orderKind === 'TRIGGER' && input.triggerExecution === 'LIMIT')) {
    params.price = roundToPrecision(Number(input.price), settings.contract.pricePrecision)
    params.timeInForce = input.timeInForce ?? 'GTC'
  }
  if (input.orderKind === 'TRIGGER') {
    params.stopPrice = roundToPrecision(Number(input.triggerPrice), settings.contract.pricePrecision)
    params.workingType = input.workingType ?? 'MARK_PRICE'
  }
  if (input.reduceOnly && !dualSide) params.reduceOnly = 'true'
  const stopLoss = normalizeProtection(input.stopLoss, settings.contract.pricePrecision, 'stopLoss')
  const takeProfit = normalizeProtection(input.takeProfit, settings.contract.pricePrecision, 'takeProfit')
  if (stopLoss) params.stopLoss = stopLoss
  if (takeProfit) params.takeProfit = takeProfit

  const liquidationDistance = estimatedAveragePrice / input.leverage
  return {
    input,
    params,
    preview: {
      symbol: input.symbol,
      direction: input.direction,
      orderKind: input.orderKind,
      exchangeOrderType,
      amountMode: input.amountMode,
      quantity,
      notional,
      estimatedMargin,
      estimatedOpenFee,
      estimatedCloseFee,
      estimatedOrderCost,
      estimatedAveragePrice,
      estimatedSlippagePercent,
      indicativeLiquidationPrice: input.direction === 'LONG'
        ? Math.max(0, estimatedAveragePrice - liquidationDistance)
        : estimatedAveragePrice + liquidationDistance,
      marginType: input.marginType,
      leverage: input.leverage,
      maker,
      triggerLiveVerified: input.orderKind !== 'TRIGGER',
      ...(input.takeProfit ? {
        takeProfit: {
          ...input.takeProfit,
          expectedPnl: Math.abs(input.takeProfit.stopPrice - estimatedAveragePrice) * quantity,
        },
      } : {}),
      ...(input.stopLoss ? {
        stopLoss: {
          ...input.stopLoss,
          expectedPnl: Math.abs(input.stopLoss.stopPrice - estimatedAveragePrice) * quantity,
        },
      } : {}),
      ...(input.takeProfit && input.stopLoss ? {
        riskReward: Math.abs(input.takeProfit.stopPrice - estimatedAveragePrice)
          / Math.abs(input.stopLoss.stopPrice - estimatedAveragePrice),
      } : {}),
    },
  }
}

export async function executePreparedOrder(
  environment: BingxEnvironment,
  credentials: BingxCredentials,
  prepared: PreparedOrder,
  clientOrderId: string,
) {
  // BingX documents clientOrderId for MARKET/LIMIT; trigger order support varies by API release.
  const params = prepared.input.orderKind === 'TRIGGER'
    ? { ...prepared.params }
    : { ...prepared.params, clientOrderId }
  if (prepared.input.orderKind === 'TRIGGER' || prepared.input.stopLoss || prepared.input.takeProfit) {
    await request(environment, credentials, 'POST', '/openApi/swap/v2/trade/order/test', params)
  }
  return request(environment, credentials, 'POST', '/openApi/swap/v2/trade/order', params)
}

export async function cancelOpenOrder(
  environment: BingxEnvironment,
  credentials: BingxCredentials,
  input: { symbol: string; orderId?: string; clientOrderId?: string },
) {
  if (!input.orderId && !input.clientOrderId) throw new Error('Order ID is required')
  return request(environment, credentials, 'DELETE', '/openApi/swap/v2/trade/order', {
    symbol: input.symbol,
    ...(input.orderId ? { orderId: input.orderId } : { clientOrderId: input.clientOrderId! }),
  })
}

export async function amendOpenOrder(
  environment: BingxEnvironment,
  credentials: BingxCredentials,
  input: { symbol: string; orderId?: string; clientOrderId?: string; quantity: number },
) {
  if (!input.orderId && !input.clientOrderId) throw new Error('Order ID is required')
  if (!(input.quantity > 0)) throw new Error('New order quantity must be positive')
  return request(environment, credentials, 'POST', '/openApi/swap/v1/trade/amend', {
    symbol: input.symbol,
    ...(input.orderId ? { orderId: input.orderId } : { clientOrderId: input.clientOrderId! }),
    quantity: input.quantity,
  })
}

export async function closePosition(
  environment: BingxEnvironment,
  credentials: BingxCredentials,
  input: { positionId: string; quantity?: number; clientOrderId: string },
) {
  const snapshot = await getAccountSnapshot(environment, credentials)
  const position = snapshot.positions.find((item) => item.positionId === input.positionId)
  if (!position) throw new Error('The position no longer exists')

  const availableQuantity = Math.abs(Number(position.availableAmt || position.positionAmt))
  if (!input.quantity || input.quantity >= availableQuantity) {
    return request(environment, credentials, 'POST', '/openApi/swap/v1/trade/closePosition', {
      positionId: input.positionId,
    })
  }

  const contract = await getContract(environment, credentials, position.symbol)
  const quantity = floorToPrecision(input.quantity, contract.quantityPrecision)
  if (!(quantity > 0)) throw new Error('Close quantity rounds to zero at the BingX contract precision')
  if (contract.tradeMinQuantity > 0 && quantity < contract.tradeMinQuantity) {
    throw new Error(`Minimum close quantity for ${position.symbol} is ${contract.tradeMinQuantity}`)
  }

  const positionMode = await getPositionMode(environment, credentials)
  const dualSide = Boolean(positionMode?.dualSidePosition)
  return request(environment, credentials, 'POST', '/openApi/swap/v2/trade/order', {
    symbol: position.symbol,
    side: position.positionSide === 'LONG' ? 'SELL' : 'BUY',
    positionSide: dualSide ? position.positionSide : 'BOTH',
    type: 'MARKET',
    quantity,
    ...(dualSide ? {} : { reduceOnly: 'true' }),
    clientOrderId: input.clientOrderId,
  })
}

function responseRows<T extends Record<string, unknown>>(response: unknown, ...nestedKeys: string[]) {
  if (Array.isArray(response)) return response as T[]
  if (!response || typeof response !== 'object') return []
  const outer = response as Record<string, unknown>
  for (const key of nestedKeys) {
    if (Array.isArray(outer[key])) return outer[key] as T[]
  }
  return []
}

export async function getOrderHistory(
  environment: BingxEnvironment,
  credentials: BingxCredentials,
  limit = 500,
) {
  const response = await request(environment, credentials, 'GET', '/openApi/swap/v2/trade/allOrders', {
    limit: Math.min(1_000, Math.max(1, Math.floor(limit))),
    currency: 'USDT',
  })
  return responseRows<BingxOrder>(response, 'orders', 'data')
}

export async function getTradeFillHistory(
  environment: BingxEnvironment,
  credentials: BingxCredentials,
  input: { startTime?: number; endTime?: number } = {},
) {
  const endTs = input.endTime ?? Date.now()
  const startTs = input.startTime ?? endTs - 7 * 24 * 60 * 60 * 1_000
  const response = await request(environment, credentials, 'GET', '/openApi/swap/v2/trade/allFillOrders', {
    tradingUnit: 'COIN',
    startTs,
    endTs,
    currency: 'USDT',
  })
  return responseRows<Record<string, unknown>>(response, 'fillOrders', 'orders', 'trades', 'data')
}

function orderIdentifier(order: BingxOrder) {
  return String(order.orderId ?? order.orderID ?? '')
}

export function responseOrderIdentifier(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const row = value as Record<string, unknown>
  const direct = row.newOrderID ?? row.newOrderId ?? row.orderID ?? row.orderId
  if (direct !== undefined && direct !== null && String(direct)) return String(direct)
  for (const key of ['newOrderResponse', 'newOrder', 'order']) {
    const nested = responseOrderIdentifier(row[key])
    if (nested) return nested
  }
  return ''
}

export async function placeOrReplaceProtectiveStop(
  environment: BingxEnvironment,
  credentials: BingxCredentials,
  input: {
    position: BingxPosition
    stopPrice: number
    workingType: ProtectionWorkingType
    cancelOrderId?: string
    clientOrderId: string
  },
) {
  const [contract, positionMode] = await Promise.all([
    getContract(environment, credentials, input.position.symbol),
    getPositionMode(environment, credentials),
  ])
  const stopPrice = roundToPrecision(input.stopPrice, contract.pricePrecision)
  const quantity = floorToPrecision(
    Math.abs(Number(input.position.availableAmt || input.position.positionAmt)),
    contract.quantityPrecision,
  )
  if (!(stopPrice > 0) || !(quantity > 0)) throw new Error('A valid protective stop price and quantity are required')
  if (contract.tradeMinQuantity > 0 && quantity < contract.tradeMinQuantity) {
    throw new Error(`Minimum protection quantity for ${input.position.symbol} is ${contract.tradeMinQuantity}`)
  }
  const dualSide = Boolean(positionMode.dualSidePosition)
  const params = {
    symbol: input.position.symbol,
    side: input.position.positionSide === 'LONG' ? 'SELL' : 'BUY',
    positionSide: dualSide ? input.position.positionSide : 'BOTH',
    type: 'STOP_MARKET',
    quantity,
    stopPrice,
    workingType: input.workingType,
    positionId: input.position.positionId,
    ...(dualSide ? {} : { reduceOnly: 'true' }),
    clientOrderId: input.clientOrderId,
  }

  if (!input.cancelOrderId) {
    return request(environment, credentials, 'POST', '/openApi/swap/v2/trade/order', params) as Promise<Record<string, unknown>>
  }

  const replacement = await request(environment, credentials, 'POST', '/openApi/swap/v1/trade/cancelReplace', {
    ...params,
    cancelOrderId: input.cancelOrderId,
    cancelReplaceMode: 'STOP_ON_FAILURE',
  }) as Record<string, unknown>
  const cancelResult = String(replacement.cancelResult ?? '').toUpperCase()
  const newOrderResult = String(replacement.newOrderResult ?? '').toUpperCase()
  if (cancelResult && cancelResult !== 'SUCCESS') {
    throw new Error(`BingX kept the existing protective stop because cancel-replace returned ${cancelResult}`)
  }
  if (newOrderResult && newOrderResult !== 'SUCCESS') {
    if (cancelResult === 'SUCCESS') {
      return request(environment, credentials, 'POST', '/openApi/swap/v2/trade/order', params) as Promise<Record<string, unknown>>
    }
    throw new Error(`BingX rejected the replacement protective stop (${newOrderResult})`)
  }
  return replacement
}

function isProtectionOrder(order: BingxOrder, kind: 'TAKE_PROFIT' | 'STOP_LOSS') {
  const type = String(order.type ?? '').toUpperCase()
  return kind === 'TAKE_PROFIT'
    ? type.startsWith('TAKE_PROFIT')
    : type.startsWith('STOP') && !type.startsWith('TAKE_PROFIT')
}

export async function updatePositionProtection(
  environment: BingxEnvironment,
  credentials: BingxCredentials,
  input: {
    positionId: string
    orderId?: string
    kind: 'TAKE_PROFIT' | 'STOP_LOSS'
    stopPrice: number
    workingType: ProtectionWorkingType
    clientOrderId: string
  },
) {
  const snapshot = await getAccountSnapshot(environment, credentials)
  const position = snapshot.positions.find((item) => item.positionId === input.positionId)
  if (!position) throw new Error('The position no longer exists')

  const [contract, settings, positionMode] = await Promise.all([
    getContract(environment, credentials, position.symbol),
    getTradingSettings(environment, credentials, position.symbol),
    getPositionMode(environment, credentials),
  ])
  const stopPrice = roundToPrecision(input.stopPrice, contract.pricePrecision)
  const referencePrice = settings.prices.markPrice || Number(position.avgPrice)
  if (!(stopPrice > 0) || !(referencePrice > 0)) throw new Error('A valid protection price is required')

  const long = position.positionSide === 'LONG'
  const directionValid = input.kind === 'TAKE_PROFIT'
    ? long ? stopPrice > referencePrice : stopPrice < referencePrice
    : long ? stopPrice < referencePrice : stopPrice > referencePrice
  if (!directionValid) {
    const expected = input.kind === 'TAKE_PROFIT'
      ? long ? 'above' : 'below'
      : long ? 'below' : 'above'
    throw new Error(`${input.kind === 'TAKE_PROFIT' ? 'Take Profit' : 'Stop Loss'} must be ${expected} the current BingX mark price`)
  }

  const dualSide = Boolean(positionMode.dualSidePosition)
  const positionSide = dualSide ? position.positionSide : 'BOTH'
  const existing = input.orderId
    ? snapshot.openOrders.find((order) => orderIdentifier(order) === input.orderId)
    : undefined
  if (input.orderId && !existing) throw new Error('The selected protection order is no longer open. Refresh the chart and try again.')

  if (existing) {
    const existingPositionId = String(existing.positionID ?? existing.positionId ?? '')
    const matchesPosition = existing.symbol === position.symbol
      && isProtectionOrder(existing, input.kind)
      && String(existing.side ?? '').toUpperCase() === (long ? 'SELL' : 'BUY')
      && (String(existing.positionSide ?? positionSide) === positionSide || String(existing.positionSide) === position.positionSide)
      && (!existingPositionId || existingPositionId === position.positionId)
    if (!matchesPosition) throw new Error('The selected order does not protect this position')
  }

  const availableQuantity = Math.abs(Number(position.availableAmt || position.positionAmt))
  const originalQuantity = existing ? Number(existing.origQty ?? existing.quantity) : availableQuantity
  const executedQuantity = existing ? Math.abs(Number(existing.executedQty ?? 0)) : 0
  const unfilledQuantity = Math.max(0, originalQuantity - executedQuantity)
  const quantity = floorToPrecision(Math.min(unfilledQuantity, availableQuantity), contract.quantityPrecision)
  if (!(quantity > 0)) throw new Error('The protection quantity is no longer available')
  if (contract.tradeMinQuantity > 0 && quantity < contract.tradeMinQuantity) {
    throw new Error(`Minimum protection quantity for ${position.symbol} is ${contract.tradeMinQuantity}`)
  }

  const created = await request(environment, credentials, 'POST', '/openApi/swap/v2/trade/order', {
    symbol: position.symbol,
    side: long ? 'SELL' : 'BUY',
    positionSide,
    type: input.kind === 'TAKE_PROFIT' ? 'TAKE_PROFIT_MARKET' : 'STOP_MARKET',
    quantity,
    stopPrice,
    workingType: input.workingType,
    positionId: position.positionId,
    ...(dualSide ? {} : { reduceOnly: 'true' }),
    clientOrderId: input.clientOrderId,
  }) as Record<string, unknown>

  if (!existing) return created

  try {
    await cancelOpenOrder(environment, credentials, { symbol: position.symbol, orderId: orderIdentifier(existing) })
  } catch (error) {
    const createdOrderId = String(created.orderId ?? created.orderID ?? '')
    try {
      await cancelOpenOrder(environment, credentials, {
        symbol: position.symbol,
        ...(createdOrderId ? { orderId: createdOrderId } : { clientOrderId: input.clientOrderId }),
      })
    } catch (rollbackError) {
      throw new Error(`BingX could not cancel the previous protection or roll back its replacement. Both orders may be active; refresh Open Orders immediately. Original error: ${error instanceof Error ? error.message : 'unknown error'}. Rollback error: ${rollbackError instanceof Error ? rollbackError.message : 'unknown error'}`)
    }
    throw new Error(`BingX kept the previous protection because it could not be replaced safely: ${error instanceof Error ? error.message : 'unknown error'}`)
  }

  return created
}
