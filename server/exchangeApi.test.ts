import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'

process.env.NODE_ENV = 'test'
process.env.ALLOW_LIVE_TRADING = 'true'
process.env.ALLOW_LIVE_TRIGGER_ORDERS = 'false'

const nativeFetch = globalThis.fetch
const bingxWrites: Array<{ method: string; path: string; body: string }> = []
let currentMargin = 'CROSSED'
let longLeverage = 20
let shortLeverage = 20
let showProtectionOrders = false
let showFullProtectionOrder = false
let failCancelOrderId: string | undefined
let includeExternalPosition = false
let externalStopPrice: string | undefined
let btcPositionValue = '600'
let accountEquity = 1000

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url)
  const body = String(init?.body || '')
  const method = init?.method ?? 'GET'
  if (method !== 'GET') bingxWrites.push({ method, path: url.pathname, body: body || url.search.slice(1) })

  let data: unknown = []
  let code = 0
  let msg = ''
  if (url.pathname.endsWith('/user/balance')) {
    data = [{ asset: 'USDT', balance: String(accountEquity), equity: String(accountEquity), unrealizedProfit: '0', availableMargin: String(Math.max(0, accountEquity - 50)), usedMargin: '50' }]
  } else if (url.pathname.endsWith('/user/positions')) {
    data = [{
      symbol: 'BTC-USDT', positionId: '12345678901234567890', positionSide: 'LONG', isolated: false,
      positionAmt: '0.01', availableAmt: '0.01', unrealizedProfit: '2', initialMargin: '30',
      liquidationPrice: 40000, avgPrice: '60000', leverage: 20, positionValue: btcPositionValue, currency: 'USDT',
    }, ...(includeExternalPosition ? [{
      symbol: 'HYPE-USDT', positionId: '22345678901234567890', positionSide: 'SHORT', isolated: false,
      positionAmt: '1', availableAmt: '1', unrealizedProfit: '0', initialMargin: '5',
      liquidationPrice: 100, avgPrice: '20', leverage: 20, positionValue: '20', currency: 'USDT',
    }] : [])]
  } else if (url.pathname.endsWith('/positionSide/dual')) {
    data = { dualSidePosition: true }
  } else if (url.pathname.endsWith('/quote/contracts')) {
    const btcContract = {
      symbol: 'BTC-USDT', quantityPrecision: 3, pricePrecision: 1, makerFeeRate: 0.0002,
      takerFeeRate: 0.0005, tradeMinQuantity: 0.001, tradeMinUSDT: 5,
      maxLongLeverage: 50, maxShortLeverage: 40, status: 1, apiStateOpen: 'true',
      apiStateClose: 'true', asset: 'BTC', currency: 'USDT',
    }
    const hypeContract = { ...btcContract, symbol: 'HYPE-USDT', asset: 'HYPE', quantityPrecision: 4, pricePrecision: 3 }
    data = url.searchParams.get('symbol') === 'HYPE-USDT'
      ? [hypeContract]
      : url.searchParams.get('symbol')
        ? [btcContract]
        : [btcContract, hypeContract]
  } else if (url.pathname.endsWith('/quote/premiumIndex')) {
    data = { symbol: 'BTC-USDT', markPrice: '60000', indexPrice: '59995' }
  } else if (url.pathname.endsWith('/quote/bookTicker')) {
    data = { book_ticker: { symbol: 'BTC-USDT', bid_price: '59990', ask_price: '60000' } }
  } else if (url.pathname.endsWith('/quote/depth')) {
    data = { asks: [['60000', '1'], ['60010', '2']], bids: [['59990', '1'], ['59980', '2']] }
  } else if (url.pathname.endsWith('/marginType')) {
    if (method === 'POST') currentMargin = new URLSearchParams(body).get('marginType') ?? currentMargin
    data = { marginType: currentMargin }
  } else if (url.pathname.endsWith('/leverage')) {
    if (method === 'POST') {
      const params = new URLSearchParams(body)
      const value = Number(params.get('leverage'))
      const side = params.get('side')
      if (side === 'LONG' || side === 'BOTH') longLeverage = value
      if (side === 'SHORT' || side === 'BOTH') shortLeverage = value
    }
    data = { longLeverage, shortLeverage, maxLongLeverage: 50, maxShortLeverage: 40 }
  } else if (url.pathname.endsWith('/trade/openOrders')) {
    data = { orders: [
      { orderId: '88888888888888888888', symbol: 'BTC-USDT', side: 'BUY', positionSide: 'LONG', type: 'LIMIT', price: '59000', quantity: '0.01', executedQty: '0', status: 'NEW', time: Date.now() },
      ...(showProtectionOrders ? [
        { orderId: '77777777777777777771', positionID: '12345678901234567890', symbol: 'BTC-USDT', side: 'SELL', positionSide: 'LONG', type: 'STOP_MARKET', stopPrice: '59000', origQty: '0.006', executedQty: '0', closePosition: 'false', reduceOnly: true, workingType: 'MARK_PRICE', status: 'NEW' },
        { orderId: '77777777777777777772', positionID: '12345678901234567890', symbol: 'BTC-USDT', side: 'SELL', positionSide: 'LONG', type: 'STOP_MARKET', stopPrice: '59000', origQty: '0.004', executedQty: '0', closePosition: 'false', reduceOnly: true, workingType: 'MARK_PRICE', status: 'NEW' },
      ] : []),
      ...(showFullProtectionOrder ? [
        { orderId: '77777777777777777773', positionID: '12345678901234567890', symbol: 'BTC-USDT', side: 'SELL', positionSide: 'LONG', type: 'STOP_MARKET', stopPrice: '58800', origQty: '0.01', executedQty: '0', closePosition: 'false', reduceOnly: true, workingType: 'MARK_PRICE', status: 'NEW' },
      ] : []),
      ...(includeExternalPosition && externalStopPrice ? [
        { orderId: '77777777777777777780', positionID: '22345678901234567890', symbol: 'HYPE-USDT', side: 'BUY', positionSide: 'SHORT', type: 'STOP_MARKET', stopPrice: externalStopPrice, origQty: '1', executedQty: '0', closePosition: 'false', reduceOnly: true, workingType: 'MARK_PRICE', status: 'NEW' },
      ] : []),
    ] }
  } else if (url.pathname.endsWith('/trade/allOrders')) {
    data = [{ orderId: '7001', symbol: 'BTC-USDT', side: 'BUY', positionSide: 'LONG', type: 'MARKET', avgPrice: '60000', quantity: '0.01', executedQty: '0.01', status: 'FILLED', realizedPnl: '3.5', fee: '-0.03', time: Date.now() - 2_000 }]
  } else if (url.pathname.endsWith('/trade/allFillOrders')) {
    data = [{ tradeId: '8001', orderId: '7001', symbol: 'BTC-USDT', side: 'BUY', positionSide: 'LONG', price: '60000', qty: '0.01', realizedPnl: '3.5', fee: '-0.03', time: Date.now() - 1_000 }]
  } else if (url.pathname.endsWith('/trade/order/test')) {
    data = {}
  } else if (url.pathname.endsWith('/trade/amend')) {
    data = { orderId: '88888888888888888888', symbol: 'BTC-USDT', quantity: '0.02' }
  } else if (url.pathname.endsWith('/trade/cancelReplace')) {
    data = { cancelResult: 'SUCCESS', newOrderResult: 'SUCCESS', newOrderResponse: { orderId: '77777777777777777774' } }
  } else if (url.pathname.endsWith('/trade/order')) {
    if (method === 'DELETE' && url.searchParams.get('orderId') === failCancelOrderId) {
      code = 109400
      msg = 'simulated cancellation failure'
    } else {
      data = { orderID: '90071992547409931234', status: 'FILLED', symbol: 'BTC-USDT' }
    }
  } else if (url.pathname.endsWith('/closePosition')) {
    data = { orderId: '777', positionId: '12345678901234567890' }
  }

  return new Response(JSON.stringify({ code, msg, data }), { status: 200 })
}) as typeof fetch

const { app } = await import('./index')
const { incrementRiskTradeCount } = await import('./database')
const { runRiskMonitorOnce } = await import('./riskService')
const { disconnectSession } = await import('./sessionStore')
const listener = app.listen(0, '127.0.0.1')
await new Promise<void>((resolve) => listener.once('listening', resolve))
const address = listener.address() as AddressInfo
const baseUrl = `http://127.0.0.1:${address.port}`

async function appRequest(path: string, options?: RequestInit) {
  return nativeFetch(`${baseUrl}${path}`, {
    ...options,
    headers: { origin: 'http://localhost:5173', 'Content-Type': 'application/json', ...options?.headers },
  })
}

try {
  const registerResponse = await appRequest('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email: 'trader@example.com', password: 'correct-horse-battery-staple' }),
  })
  assert.equal(registerResponse.status, 201)
  const registeredUser = await registerResponse.clone().json() as { user: { id: string } }
  const cookie = registerResponse.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie?.startsWith('antytilt_auth='))

  const initialRiskResponse = await appRequest('/api/risk/profile', { headers: { cookie: cookie! } })
  assert.equal(initialRiskResponse.status, 200)
  const initialRiskProfile = await initialRiskResponse.json() as { active: boolean; maxLeverage: { value: number }; updatedAt: number }
  assert.equal(initialRiskProfile.active, false)
  assert.equal(initialRiskProfile.maxLeverage.value, 10)
  assert.equal(initialRiskProfile.updatedAt, 0)

  const riskProfileInput = {
    active: true,
    fixedStopLoss: { enabled: false, value: 3 },
    breakEven: { enabled: true, triggerMode: 'R_MULTIPLE', triggerValue: 1, offsetPercent: 0.05 },
    riskPerTrade: { enabled: false, value: 1 },
    dailyLossLimit: { enabled: false, value: 3 },
    closeExternalEntriesOnBreach: true,
    maxLeverage: { enabled: true, value: 25 },
    maxTradesPerDay: { enabled: true, value: 6 },
    maxConsecutiveLosses: { enabled: false, value: 3 },
    cooldownMinutes: { enabled: false, value: 30 },
    maxExposurePercent: { enabled: false, value: 100 },
    maxOpenPositions: { enabled: false, value: 3 },
  }
  const saveRiskResponse = await appRequest('/api/risk/profile', {
    method: 'PUT', headers: { cookie: cookie! }, body: JSON.stringify(riskProfileInput),
  })
  assert.equal(saveRiskResponse.status, 200)
  const savedRiskProfile = await saveRiskResponse.json() as typeof riskProfileInput & { updatedAt: number }
  assert.equal(savedRiskProfile.fixedStopLoss.value, 3)
  assert.equal(savedRiskProfile.maxLeverage.value, 25)
  assert.ok(savedRiskProfile.updatedAt > 0)

  const persistedRiskResponse = await appRequest('/api/risk/profile', { headers: { cookie: cookie! } })
  assert.deepEqual(await persistedRiskResponse.json(), savedRiskProfile)

  const connectResponse = await appRequest('/api/exchange/bingx/connect', {
    method: 'POST',
    headers: { cookie: cookie! },
    body: JSON.stringify({ apiKey: 'vst-api-key-1234', secretKey: 'vst-secret-key-5678', environment: 'prod-vst' }),
  })
  assert.equal(connectResponse.status, 201)
  const connected = await connectResponse.json() as Record<string, unknown>
  assert.equal(connected.connected, true)
  assert.equal(JSON.stringify(connected).includes('vst-secret-key-5678'), false)
  assert.equal(((connected.snapshot as { openOrders: unknown[] }).openOrders).length, 1, 'nested BingX open orders must be normalized')

  const settingsResponse = await appRequest('/api/exchange/contracts/BTC-USDT/settings', { headers: { cookie: cookie! } })
  assert.equal(settingsResponse.status, 200)
  const settings = await settingsResponse.json() as { marginType: string; maxLongLeverage: number; prices: { markPrice: number; askPrice: number } }
  assert.equal(settings.marginType, 'CROSSED')
  assert.equal(settings.maxLongLeverage, 50)
  assert.equal(settings.prices.markPrice, 60000)
  assert.equal(settings.prices.askPrice, 60000, 'nested snake_case BingX bookTicker must be normalized')

  const contractsResponse = await appRequest('/api/exchange/contracts', { headers: { cookie: cookie! } })
  assert.equal(contractsResponse.status, 200)
  const contractCatalog = await contractsResponse.json() as { contracts: Array<{ symbol: string }> }
  assert.deepEqual(contractCatalog.contracts.map((contract) => contract.symbol), ['BTC-USDT', 'HYPE-USDT'])

  const historyResponse = await appRequest('/api/account/history', { headers: { cookie: cookie! } })
  assert.equal(historyResponse.status, 200)
  const history = await historyResponse.json() as { orderHistory: Array<{ orderId: string }>; tradeHistory: Array<{ tradeId: string }> }
  assert.equal(history.orderHistory[0]?.orderId, '7001')
  assert.equal(history.tradeHistory[0]?.tradeId, '8001')

  const requestId = 'dd5d4b12-4028-4f12-95a4-e46ba14bf95f'
  const orderBody = JSON.stringify({
    symbol: 'BTC-USDT', direction: 'LONG', quoteOrderQty: 100, leverage: 20,
    marginType: 'CROSSED', clientRequestId: requestId,
  })
  const orderResponse = await appRequest('/api/exchange/orders/market', {
    method: 'POST', headers: { cookie: cookie! }, body: orderBody,
  })
  assert.equal(orderResponse.status, 201)
  const duplicateResponse = await appRequest('/api/exchange/orders/market', {
    method: 'POST', headers: { cookie: cookie! }, body: orderBody,
  })
  assert.equal(duplicateResponse.status, 200)
  disconnectSession(registeredUser.user.id)
  const afterRestartResponse = await appRequest('/api/exchange/orders/market', {
    method: 'POST', headers: { cookie: cookie! }, body: orderBody,
  })
  assert.equal(afterRestartResponse.status, 200)

  const openWrites = bingxWrites.filter((request) => request.path.endsWith('/trade/order') && request.body.includes('quoteOrderQty=100'))
  assert.equal(openWrites.length, 1, 'duplicate client request must execute once, including after session restart')
  assert.match(openWrites[0].body, /clientOrderId=antytilt-dd5d4b1240284f1295a4/)

  const closeResponse = await appRequest('/api/exchange/positions/12345678901234567890/close', {
    method: 'POST',
    headers: { cookie: cookie! },
    body: JSON.stringify({ quantity: 0.0059, clientRequestId: '93b56dad-e4f5-45c1-a54f-b5cc738363aa' }),
  })
  assert.equal(closeResponse.status, 201)
  const closeWrite = bingxWrites.find((request) => request.path.endsWith('/trade/order') && request.body.includes('quantity=0.005'))
  assert.match(closeWrite?.body || '', /positionSide=LONG/)
  assert.match(closeWrite?.body || '', /side=SELL/)
  assert.equal(new URLSearchParams(closeWrite?.body).get('quantity'), '0.005', 'partial close quantity must be floored to the contract precision')

  showProtectionOrders = true
  const protectionWritesStart = bingxWrites.length
  const protectionResponse = await appRequest('/api/exchange/positions/12345678901234567890/protection', {
    method: 'POST',
    headers: { cookie: cookie! },
    body: JSON.stringify({ orderId: '77777777777777777771', kind: 'STOP_LOSS', stopPrice: 58000, workingType: 'MARK_PRICE', clientRequestId: 'a52dd383-121b-43fd-96f8-d9906af5070e' }),
  })
  assert.equal(protectionResponse.status, 200)
  const protectionWrites = bingxWrites.slice(protectionWritesStart)
  const protectionWrite = protectionWrites.find((request) => request.method === 'POST' && request.path.endsWith('/trade/order') && request.body.includes('type=STOP_MARKET') && request.body.includes('stopPrice=58000'))
  assert.match(protectionWrite?.body || '', /positionSide=LONG/)
  assert.equal(new URLSearchParams(protectionWrite?.body).get('quantity'), '0.006')
  assert.equal(new URLSearchParams(protectionWrite?.body).get('positionId'), '12345678901234567890')
  assert.equal(new URLSearchParams(protectionWrite?.body).has('closePosition'), false)
  assert.equal(new URLSearchParams(protectionWrite?.body).has('reduceOnly'), false, 'Hedge Mode must not send reduceOnly explicitly')
  const selectedCancel = protectionWrites.find((request) => request.method === 'DELETE' && request.body.includes('orderId=77777777777777777771'))
  assert.ok(selectedCancel, 'only the selected protection order must be cancelled after replacement is accepted')
  assert.equal(protectionWrites.some((request) => request.method === 'DELETE' && request.body.includes('orderId=77777777777777777772')), false, 'another protection at the same price must remain unchanged')

  const staleWritesStart = bingxWrites.length
  const staleProtection = await appRequest('/api/exchange/positions/12345678901234567890/protection', {
    method: 'POST', headers: { cookie: cookie! },
    body: JSON.stringify({ orderId: '77777777777777777999', kind: 'STOP_LOSS', stopPrice: 57000, workingType: 'MARK_PRICE', clientRequestId: '242dd383-121b-43fd-96f8-d9906af5070e' }),
  })
  assert.equal(staleProtection.status, 500)
  assert.equal(bingxWrites.slice(staleWritesStart).some((request) => request.method === 'POST' && request.path.endsWith('/trade/order')), false, 'a stale graph line must not create a replacement')

  failCancelOrderId = '77777777777777777772'
  const rollbackWritesStart = bingxWrites.length
  const failedProtection = await appRequest('/api/exchange/positions/12345678901234567890/protection', {
    method: 'POST', headers: { cookie: cookie! },
    body: JSON.stringify({ orderId: failCancelOrderId, kind: 'STOP_LOSS', stopPrice: 57000, workingType: 'MARK_PRICE', clientRequestId: '342dd383-121b-43fd-96f8-d9906af5070e' }),
  })
  failCancelOrderId = undefined
  assert.equal(failedProtection.status, 502)
  const rollbackWrites = bingxWrites.slice(rollbackWritesStart)
  assert.ok(rollbackWrites.some((request) => request.method === 'DELETE' && request.body.includes('orderId=77777777777777777772')), 'the selected original order cancellation must be attempted')
  assert.ok(rollbackWrites.some((request) => request.method === 'DELETE' && request.body.includes('orderId=90071992547409931234')), 'the replacement must be rolled back when the original cannot be cancelled')

  const previewResponse = await appRequest('/api/exchange/orders/preview', {
    method: 'POST',
    headers: { cookie: cookie! },
    body: JSON.stringify({
      symbol: 'BTC-USDT', direction: 'LONG', orderKind: 'MARKET', amountMode: 'VALUE', amount: 100,
      leverage: 20, marginType: 'CROSSED', maxSlippagePercent: 0.5,
      takeProfit: { stopPrice: 61000, execution: 'MARKET', workingType: 'MARK_PRICE' },
      stopLoss: { stopPrice: 59000, execution: 'MARKET', workingType: 'MARK_PRICE' },
    }),
  })
  assert.equal(previewResponse.status, 200)
  const previewPayload = await previewResponse.json() as {
    previewId: string
    expiresAt: number
    preview: {
      notional: number
      estimatedOrderCost: number
      takeProfit?: { stopPrice: number; expectedPnl: number }
      stopLoss?: { stopPrice: number; expectedPnl: number }
      riskReward?: number
    }
  }
  assert.equal(previewPayload.preview.notional, 100)
  assert.ok(previewPayload.preview.estimatedOrderCost > 5)
  assert.ok(previewPayload.expiresAt - Date.now() > 80_000, 'live confirmation must have enough time to be reviewed')
  assert.equal(previewPayload.preview.takeProfit?.stopPrice, 61000)
  assert.equal(previewPayload.preview.stopLoss?.stopPrice, 59000)
  assert.ok(Number(previewPayload.preview.takeProfit?.expectedPnl) > 0)
  assert.ok(Math.abs(Number(previewPayload.preview.riskReward) - 1) < 1e-9)
  const advancedResponse = await appRequest('/api/exchange/orders', {
    method: 'POST',
    headers: { cookie: cookie! },
    body: JSON.stringify({ previewId: previewPayload.previewId, clientRequestId: '25770b7b-7bd2-4d0f-9b04-f7223d8982d1' }),
  })
  assert.equal(advancedResponse.status, 201)
  const testWrite = bingxWrites.find((request) => request.path.endsWith('/trade/order/test'))
  assert.ok(testWrite, 'VST attached TP/SL must pass BingX test-order validation first')
  const protectedWrite = bingxWrites.find((request) => request.path.endsWith('/trade/order') && request.body.includes('antytilt-25770b7b'))
  assert.match(protectedWrite?.body || '', /quoteOrderQty=100/)
  assert.match(protectedWrite?.body || '', /takeProfit=/)
  assert.match(protectedWrite?.body || '', /stopLoss=/)
  const takeProfitPayload = JSON.parse(new URLSearchParams(protectedWrite?.body).get('takeProfit') || '{}') as { stopGuaranteed?: unknown }
  const stopLossPayload = JSON.parse(new URLSearchParams(protectedWrite?.body).get('stopLoss') || '{}') as { stopGuaranteed?: unknown }
  assert.equal(takeProfitPayload.stopGuaranteed, 'false', 'BingX nested TP stopGuaranteed must be a string')
  assert.equal(stopLossPayload.stopGuaranteed, 'false', 'BingX nested SL stopGuaranteed must be a string')

  const limitPreviewResponse = await appRequest('/api/exchange/orders/preview', {
    method: 'POST', headers: { cookie: cookie! },
    body: JSON.stringify({
      symbol: 'BTC-USDT', direction: 'LONG', orderKind: 'LIMIT', amountMode: 'QUANTITY', amount: 0.002,
      leverage: 20, marginType: 'CROSSED', price: 59000, timeInForce: 'PostOnly', reduceOnly: false,
    }),
  })
  assert.equal(limitPreviewResponse.status, 200)
  const limitPreview = await limitPreviewResponse.json() as { preview: { exchangeOrderType: string; maker: boolean } }
  assert.equal(limitPreview.preview.exchangeOrderType, 'LIMIT')
  assert.equal(limitPreview.preview.maker, true)

  const triggerVstPreviewResponse = await appRequest('/api/exchange/orders/preview', {
    method: 'POST', headers: { cookie: cookie! },
    body: JSON.stringify({
      symbol: 'BTC-USDT', direction: 'SHORT', orderKind: 'TRIGGER', amountMode: 'QUANTITY', amount: 0.002,
      leverage: 20, marginType: 'CROSSED', triggerPrice: 61000, triggerExecution: 'LIMIT',
      price: 60900, workingType: 'INDEX_PRICE', timeInForce: 'GTC',
    }),
  })
  assert.equal(triggerVstPreviewResponse.status, 200)
  const triggerVstPreview = await triggerVstPreviewResponse.json() as { previewId: string }
  const triggerVstExecute = await appRequest('/api/exchange/orders', {
    method: 'POST', headers: { cookie: cookie! },
    body: JSON.stringify({ previewId: triggerVstPreview.previewId, clientRequestId: 'a42dd383-121b-43fd-96f8-d9906af5070e' }),
  })
  assert.equal(triggerVstExecute.status, 201)
  const triggerWrite = bingxWrites.find((request) => request.path.endsWith('/trade/order') && request.body.includes('type=TRIGGER_LIMIT'))
  assert.match(triggerWrite?.body || '', /stopPrice=61000/)
  assert.match(triggerWrite?.body || '', /price=60900/)
  assert.match(triggerWrite?.body || '', /workingType=INDEX_PRICE/)
  assert.equal(triggerWrite?.body.includes('clientOrderId='), false, 'unsupported Trigger clientOrderId must be omitted')

  const amendResponse = await appRequest('/api/exchange/orders/88888888888888888888/amend', {
    method: 'POST', headers: { cookie: cookie! },
    body: JSON.stringify({ symbol: 'BTC-USDT', quantity: 0.02, clientRequestId: '32fd23c0-8e6f-49a8-8996-d931e0ee0cf6' }),
  })
  assert.equal(amendResponse.status, 200)
  const amendWrite = bingxWrites.find((request) => request.path.endsWith('/trade/amend'))
  assert.match(amendWrite?.body || '', /orderId=88888888888888888888/)
  assert.match(amendWrite?.body || '', /quantity=0.02/)

  const cancelResponse = await appRequest('/api/exchange/orders/88888888888888888888', {
    method: 'DELETE',
    headers: { cookie: cookie! },
    body: JSON.stringify({ symbol: 'BTC-USDT', clientRequestId: 'c4930f6f-1ea7-4882-a0d9-a7d7330d193c' }),
  })
  assert.equal(cancelResponse.status, 200)
  const cancelWrite = bingxWrites.find((request) => request.method === 'DELETE' && request.path.endsWith('/trade/order') && request.body.includes('orderId=88888888888888888888'))
  assert.match(cancelWrite?.body || '', /orderId=88888888888888888888/)

  const isolatedResponse = await appRequest('/api/exchange/contracts/BTC-USDT/margin', {
    method: 'POST', headers: { cookie: cookie! },
    body: JSON.stringify({ marginType: 'ISOLATED', clientRequestId: 'c5be6a37-f47e-42ec-a95f-37dac47ade90' }),
  })
  assert.equal(isolatedResponse.status, 200)
  assert.equal((await isolatedResponse.json() as { marginType: string }).marginType, 'ISOLATED')
  const marginWrite = bingxWrites.find((request) => request.path.endsWith('/marginType') && request.body.includes('marginType=ISOLATED'))
  assert.ok(marginWrite)
  await appRequest('/api/exchange/contracts/BTC-USDT/margin', {
    method: 'POST', headers: { cookie: cookie! },
    body: JSON.stringify({ marginType: 'CROSSED', clientRequestId: '31563493-c022-44af-aead-8b443459b389' }),
  })

  const leverageResponse = await appRequest('/api/exchange/contracts/BTC-USDT/leverage', {
    method: 'POST', headers: { cookie: cookie! },
    body: JSON.stringify({ direction: 'LONG', leverage: 15, clientRequestId: '2b435af4-192c-4053-acfc-bf9728150a5c' }),
  })
  assert.equal(leverageResponse.status, 200)
  const updatedLeverage = await leverageResponse.json() as { longLeverage: number; shortLeverage: number }
  assert.equal(updatedLeverage.longLeverage, 15)
  assert.equal(updatedLeverage.shortLeverage, 15, 'Cross Hedge leverage must remain linked')
  const linkedWrites = bingxWrites.filter((request) => request.path.endsWith('/leverage') && request.body.includes('leverage=15'))
  assert.equal(linkedWrites.length, 2)
  await appRequest('/api/exchange/contracts/BTC-USDT/leverage', {
    method: 'POST', headers: { cookie: cookie! },
    body: JSON.stringify({ direction: 'LONG', leverage: 20, clientRequestId: '6ccb9563-9942-4251-a37a-087a335078eb' }),
  })

  const liveConnect = await appRequest('/api/exchange/bingx/connect', {
    method: 'POST',
    headers: { cookie: cookie! },
    body: JSON.stringify({ apiKey: 'live-api-key-1234', secretKey: 'live-secret-key-5678', environment: 'prod-live' }),
  })
  assert.equal(liveConnect.status, 201)
  const liveConnectPayload = await liveConnect.clone().json() as { accountId: string }
  assert.match(liveConnectPayload.accountId, /^[0-9a-f-]{36}$/i)
  const accountListResponse = await appRequest('/api/exchange/accounts', { headers: { cookie: cookie! } })
  assert.equal(accountListResponse.status, 200)
  const accountList = await accountListResponse.json() as { accounts: Array<{ id: string; environment: string; isDefault: boolean }> }
  assert.equal(accountList.accounts.length, 2)
  assert.equal(accountList.accounts.find((account) => account.isDefault)?.id, liveConnectPayload.accountId)
  const vstAccount = accountList.accounts.find((account) => account.environment === 'prod-vst')
  assert.ok(vstAccount)
  const selectVstResponse = await appRequest(`/api/exchange/accounts/${vstAccount.id}/select`, {
    method: 'POST', headers: { cookie: cookie! },
  })
  assert.equal(selectVstResponse.status, 200)
  assert.equal((await selectVstResponse.json() as { accountId: string }).accountId, vstAccount.id)
  const selectLiveResponse = await appRequest(`/api/exchange/accounts/${liveConnectPayload.accountId}/select`, {
    method: 'POST', headers: { cookie: cookie! },
  })
  assert.equal(selectLiveResponse.status, 200)
  const liveCookie = cookie
  const writesBeforeMissingConfirmation = bingxWrites.length
  const blockedLiveOrder = await appRequest('/api/exchange/orders/market', {
    method: 'POST',
    headers: { cookie: liveCookie! },
    body: JSON.stringify({
      symbol: 'BTC-USDT', direction: 'SHORT', quoteOrderQty: 50, leverage: 5,
      marginType: 'CROSSED', clientRequestId: '846b72eb-611f-4e9d-a775-f85b27ef0e70',
    }),
  })
  assert.equal(blockedLiveOrder.status, 409)
  assert.equal(bingxWrites.length, writesBeforeMissingConfirmation, 'unconfirmed live order must never reach BingX')

  const liveProtectedPreviewResponse = await appRequest('/api/exchange/orders/preview', {
    method: 'POST', headers: { cookie: liveCookie! },
    body: JSON.stringify({
      symbol: 'BTC-USDT', direction: 'LONG', orderKind: 'MARKET', amountMode: 'VALUE', amount: 100,
      leverage: 20, marginType: 'CROSSED', maxSlippagePercent: 0.5,
      takeProfit: { stopPrice: 61000, execution: 'MARKET', workingType: 'MARK_PRICE' },
      stopLoss: { stopPrice: 59000, execution: 'MARKET', workingType: 'CONTRACT_PRICE' },
    }),
  })
  assert.equal(liveProtectedPreviewResponse.status, 200)
  const liveProtectedPreview = await liveProtectedPreviewResponse.json() as { previewId: string }
  const writesBeforeLiveProtected = bingxWrites.length
  const liveProtectedExecute = await appRequest('/api/exchange/orders', {
    method: 'POST', headers: { cookie: liveCookie! },
    body: JSON.stringify({ previewId: liveProtectedPreview.previewId, clientRequestId: '80ed6b76-5861-4fe0-aac8-03518bb15f11', confirmation: 'CONFIRM' }),
  })
  assert.equal(liveProtectedExecute.status, 201)
  const liveProtectedWrites = bingxWrites.slice(writesBeforeLiveProtected)
  assert.equal(liveProtectedWrites[0]?.path.endsWith('/trade/order/test'), true, 'Live TP/SL must be test-validated before order placement')
  assert.equal(liveProtectedWrites[1]?.path.endsWith('/trade/order'), true)
  assert.match(liveProtectedWrites[1]?.body || '', /takeProfit=/)
  assert.match(liveProtectedWrites[1]?.body || '', /stopLoss=/)

  const triggerPreviewResponse = await appRequest('/api/exchange/orders/preview', {
    method: 'POST', headers: { cookie: liveCookie! },
    body: JSON.stringify({
      symbol: 'BTC-USDT', direction: 'SHORT', orderKind: 'TRIGGER', amountMode: 'VALUE', amount: 100,
      leverage: 20, marginType: 'CROSSED', triggerPrice: 59000, triggerExecution: 'MARKET', workingType: 'MARK_PRICE',
    }),
  })
  assert.equal(triggerPreviewResponse.status, 200)
  const triggerPreview = await triggerPreviewResponse.json() as { previewId: string }
  const writesBeforeBlockedTrigger = bingxWrites.length
  const blockedTrigger = await appRequest('/api/exchange/orders', {
    method: 'POST', headers: { cookie: liveCookie! },
    body: JSON.stringify({ previewId: triggerPreview.previewId, clientRequestId: '5464b059-49a7-482b-a745-15d3005de71b', confirmation: 'CONFIRM' }),
  })
  assert.equal(blockedTrigger.status, 403)
  assert.equal(bingxWrites.length, writesBeforeBlockedTrigger, 'unverified live Trigger must never reach BingX')

  await appRequest('/api/exchange/bingx/connect', {
    method: 'POST', headers: { cookie: cookie! },
    body: JSON.stringify({ apiKey: 'vst-api-key-1234', secretKey: 'vst-secret-key-5678', environment: 'prod-vst' }),
  })
  const limitProfileResponse = await appRequest('/api/risk/profile', {
    method: 'PUT', headers: { cookie: cookie! },
    body: JSON.stringify({
      ...riskProfileInput,
      timezone: 'UTC',
      externalViolationPolicy: 'BLOCK_NEW_ENTRIES',
      maxTradesPerDay: { enabled: true, value: 3 },
    }),
  })
  assert.equal(limitProfileResponse.status, 200)
  const tradingDay = new Date().toISOString().slice(0, 10)
  for (let index = 0; index < 3; index += 1) {
    incrementRiskTradeCount({
      userId: registeredUser.user.id,
      environment: 'prod-vst',
      tradingDay,
      timezone: 'UTC',
      openingEquityMicros: 1_000_000_000,
      lastEquityMicros: 1_000_000_000,
      initialized: true,
    })
  }
  const writesBeforeRiskBlock = bingxWrites.length
  const fourthTrade = await appRequest('/api/exchange/orders/market', {
    method: 'POST', headers: { cookie: cookie! },
    body: JSON.stringify({
      symbol: 'HYPE-USDT', direction: 'SHORT', quoteOrderQty: 50, leverage: 20,
      marginType: 'CROSSED', clientRequestId: '146b72eb-611f-4e9d-a775-f85b27ef0e70',
    }),
  })
  assert.equal(fourthTrade.status, 409)
  assert.equal((await fourthTrade.json() as { code: string }).code, 'MAX_TRADES_PER_DAY')
  assert.equal(bingxWrites.length, writesBeforeRiskBlock, 'the fourth trade must be blocked before any BingX write')
  const riskStatus = await appRequest('/api/risk/status', { headers: { cookie: cookie! } })
  assert.equal(riskStatus.status, 200)
  const riskStatusPayload = await riskStatus.json() as {
    tradesUsed: number
    blocked: boolean
    blockCode: string
    blockRule: string
    blockReason: string
    blockDetails: { used: number; reserved: number; limit: number; resetAt: number }
    dailyPnl: number
    dailyOpeningEquity: number
    currentEquity: number
    openPositions: number
  }
  assert.equal(riskStatusPayload.tradesUsed, 3)
  assert.equal(riskStatusPayload.blocked, true)
  assert.equal(riskStatusPayload.blockCode, 'MAX_TRADES_PER_DAY')
  assert.equal(riskStatusPayload.blockRule, 'maxTradesPerDay')
  assert.match(riskStatusPayload.blockReason, /daily limit of 3 trades/i)
  assert.deepEqual(
    { used: riskStatusPayload.blockDetails.used, reserved: riskStatusPayload.blockDetails.reserved, limit: riskStatusPayload.blockDetails.limit },
    { used: 3, reserved: 1, limit: 3 },
  )
  assert.ok(riskStatusPayload.blockDetails.resetAt > Date.now())
  assert.equal(riskStatusPayload.dailyPnl, 0)
  assert.equal(riskStatusPayload.dailyOpeningEquity, 1_000)
  assert.equal(riskStatusPayload.currentEquity, 1_000)
  assert.equal(typeof riskStatusPayload.openPositions, 'number')

  const closeExternalProfile = await appRequest('/api/risk/profile', {
    method: 'PUT', headers: { cookie: cookie! },
    body: JSON.stringify({
      ...riskProfileInput,
      timezone: 'UTC',
      externalViolationPolicy: 'BLOCK_NEW_ENTRIES',
      breachAction: 'BLOCK_NEW_ENTRIES',
      closeExternalEntriesOnBreach: true,
      automationConsent: true,
      maxTradesPerDay: { enabled: true, value: 3 },
    }),
  })
  assert.equal(closeExternalProfile.status, 200)
  await runRiskMonitorOnce(false)
  const writesBeforeExternalClose = bingxWrites.length
  includeExternalPosition = true
  await runRiskMonitorOnce(false)
  includeExternalPosition = false
  const externalClose = bingxWrites.slice(writesBeforeExternalClose)
    .find((request) => request.path.endsWith('/closePosition') && request.body.includes('22345678901234567890'))
  assert.ok(externalClose, 'an external fourth VST position must be closed by the RM monitor')
  const riskEvents = await appRequest('/api/risk/events', { headers: { cookie: cookie! } })
  assert.equal(riskEvents.status, 200)
  const riskEventPayload = await riskEvents.json() as { events: Array<{ action: string; outcome: string }> }
  assert.ok(riskEventPayload.events.some((event) => event.action === 'CLOSE_EXTERNAL_POSITION' && event.outcome === 'SUCCEEDED'))

  await runRiskMonitorOnce(false)
  await runRiskMonitorOnce(false)
  const dailyLossBypassProfile = await appRequest('/api/risk/profile', {
    method: 'PUT', headers: { cookie: cookie! },
    body: JSON.stringify({
      ...riskProfileInput,
      timezone: 'UTC',
      breachAction: 'BLOCK_NEW_ENTRIES',
      closeExternalEntriesOnBreach: true,
      automationConsent: true,
      dailyLossLimit: { enabled: true, value: 5, unit: 'PERCENT' },
      maxTradesPerDay: { enabled: false, value: 3 },
    }),
  })
  assert.equal(dailyLossBypassProfile.status, 200)
  accountEquity = 900
  const writesBeforeDailyLossBypassClose = bingxWrites.length
  includeExternalPosition = true
  await runRiskMonitorOnce(false)
  includeExternalPosition = false
  const dailyLossBypassClose = bingxWrites.slice(writesBeforeDailyLossBypassClose)
    .find((request) => request.path.endsWith('/closePosition') && request.body.includes('22345678901234567890'))
  assert.ok(dailyLossBypassClose, 'a direct VST entry after the daily loss limit must be closed by the RM monitor')
  const dailyLossEvents = await appRequest('/api/risk/events', { headers: { cookie: cookie! } })
  const dailyLossEventPayload = await dailyLossEvents.json() as { events: Array<{ rule: string; action: string; outcome: string }> }
  assert.ok(dailyLossEventPayload.events.some((event) => (
    event.rule === 'dailyLossLimit'
    && event.action === 'CLOSE_EXTERNAL_POSITION'
    && event.outcome === 'SUCCEEDED'
  )))
  accountEquity = 1000
  await runRiskMonitorOnce(false)
  await runRiskMonitorOnce(false)

  const maxOpenProfile = await appRequest('/api/risk/profile', {
    method: 'PUT', headers: { cookie: cookie! },
    body: JSON.stringify({
      ...riskProfileInput,
      timezone: 'UTC',
      externalViolationPolicy: 'BLOCK_AND_CLOSE_EXTERNAL',
      breachAction: 'CLOSE_VIOLATING_POSITION',
      automationConsent: true,
      maxTradesPerDay: { enabled: false, value: 3 },
      maxOpenPositions: { enabled: true, value: 1 },
    }),
  })
  assert.equal(maxOpenProfile.status, 200)
  const writesBeforeMaxOpenClose = bingxWrites.length
  includeExternalPosition = true
  await runRiskMonitorOnce(false)
  includeExternalPosition = false
  const maxOpenClose = bingxWrites.slice(writesBeforeMaxOpenClose)
    .find((request) => request.path.endsWith('/closePosition') && request.body.includes('22345678901234567890'))
  assert.ok(maxOpenClose, 'a new external position above maxOpenPositions must be closed by the RM monitor')
  const maxOpenEvents = await appRequest('/api/risk/events', { headers: { cookie: cookie! } })
  const maxOpenEventPayload = await maxOpenEvents.json() as { events: Array<{ rule: string; action: string; outcome: string }> }
  assert.ok(maxOpenEventPayload.events.some((event) => (
    event.rule === 'maxOpenPositions'
    && event.action === 'CLOSE_EXTERNAL_POSITION'
    && event.outcome === 'SUCCEEDED'
  )))

  await runRiskMonitorOnce(false)
  await runRiskMonitorOnce(false)
  const externalRiskProfile = await appRequest('/api/risk/profile', {
    method: 'PUT', headers: { cookie: cookie! },
    body: JSON.stringify({
      ...riskProfileInput,
      timezone: 'UTC',
      externalViolationPolicy: 'BLOCK_AND_CLOSE_EXTERNAL',
      breachAction: 'CLOSE_VIOLATING_POSITION',
      automationConsent: true,
      riskPerTrade: { enabled: true, value: 0.1 },
      maxTradesPerDay: { enabled: false, value: 3 },
      maxOpenPositions: { enabled: false, value: 1 },
    }),
  })
  assert.equal(externalRiskProfile.status, 200)
  externalStopPrice = '22'
  includeExternalPosition = true
  const writesBeforeExternalRiskClose = bingxWrites.length
  await runRiskMonitorOnce(false)
  includeExternalPosition = false
  externalStopPrice = undefined
  const externalRiskClose = bingxWrites.slice(writesBeforeExternalRiskClose)
    .find((request) => request.path.endsWith('/closePosition') && request.body.includes('22345678901234567890'))
  assert.ok(externalRiskClose, 'an external position above riskPerTrade must be closed by the RM monitor')
  const externalRiskEvents = await appRequest('/api/risk/events', { headers: { cookie: cookie! } })
  const externalRiskEventPayload = await externalRiskEvents.json() as { events: Array<{ rule: string; action: string; outcome: string }> }
  assert.ok(externalRiskEventPayload.events.some((event) => (
    event.rule === 'riskPerTrade'
    && event.action === 'CLOSE_EXTERNAL_POSITION'
    && event.outcome === 'SUCCEEDED'
  )))

  await runRiskMonitorOnce(false)
  await runRiskMonitorOnce(false)
  includeExternalPosition = true
  const writesBeforeMissingStop = bingxWrites.length
  await runRiskMonitorOnce(false)
  assert.equal(
    bingxWrites.slice(writesBeforeMissingStop).some((request) => request.path.endsWith('/closePosition') && request.body.includes('22345678901234567890')),
    false,
    'the first missing-stop snapshot must allow one worker cycle for BingX order synchronization',
  )
  await runRiskMonitorOnce(false)
  includeExternalPosition = false
  const missingStopClose = bingxWrites.slice(writesBeforeMissingStop)
    .find((request) => request.path.endsWith('/closePosition') && request.body.includes('22345678901234567890'))
  assert.ok(missingStopClose, 'an external position without a full-size Stop Loss must be closed after the synchronization grace cycle')

  await runRiskMonitorOnce(false)
  await runRiskMonitorOnce(false)
  const blockExternalRiskProfile = await appRequest('/api/risk/profile', {
    method: 'PUT', headers: { cookie: cookie! },
    body: JSON.stringify({
      ...riskProfileInput,
      timezone: 'UTC',
      externalViolationPolicy: 'BLOCK_NEW_ENTRIES',
      breachAction: 'BLOCK_NEW_ENTRIES',
      automationConsent: false,
      riskPerTrade: { enabled: true, value: 0.1 },
      maxTradesPerDay: { enabled: false, value: 3 },
      maxOpenPositions: { enabled: false, value: 1 },
    }),
  })
  assert.equal(blockExternalRiskProfile.status, 200)
  externalStopPrice = '22'
  includeExternalPosition = true
  await runRiskMonitorOnce(false)
  const blockedByExternalRisk = await appRequest('/api/exchange/orders/preview', {
    method: 'POST', headers: { cookie: cookie! },
    body: JSON.stringify({
      symbol: 'BTC-USDT', direction: 'LONG', orderKind: 'MARKET', amountMode: 'VALUE', amount: 100,
      leverage: 20, marginType: 'CROSSED', maxSlippagePercent: 0.5,
      stopLoss: { stopPrice: 59950, execution: 'MARKET', workingType: 'MARK_PRICE' },
    }),
  })
  assert.equal(blockedByExternalRisk.status, 409)
  const blockedByExternalRiskPayload = await blockedByExternalRisk.json() as { code: string; rule: string; error: string }
  assert.equal(blockedByExternalRiskPayload.code, 'RISK_PER_TRADE')
  assert.equal(blockedByExternalRiskPayload.rule, 'riskPerTrade')
  assert.match(blockedByExternalRiskPayload.error, /external HYPE-USDT SHORT position/i)
  includeExternalPosition = false
  externalStopPrice = undefined

  const protectionProfile = await appRequest('/api/risk/profile', {
    method: 'PUT', headers: { cookie: cookie! },
    body: JSON.stringify({
      ...riskProfileInput,
      timezone: 'UTC',
      breachAction: 'BLOCK_NEW_ENTRIES',
      automationConsent: false,
      fixedStopLoss: { enabled: true, value: 2, workingType: 'MARK_PRICE' },
      breakEven: { enabled: true, triggerMode: 'PERCENT', triggerValue: 1, offsetPercent: 0.05 },
      maxTradesPerDay: { enabled: false, value: 3 },
    }),
  })
  assert.equal(protectionProfile.status, 200)
  showProtectionOrders = false
  showFullProtectionOrder = true
  btcPositionValue = '600'
  await runRiskMonitorOnce(false)
  const writesBeforeBreakEven = bingxWrites.length
  btcPositionValue = '606'
  await runRiskMonitorOnce(false)
  const breakEvenReplace = bingxWrites.slice(writesBeforeBreakEven)
    .find((request) => request.path.endsWith('/trade/cancelReplace'))
  assert.ok(breakEvenReplace, 'the RM monitor must replace the initial stop after the break-even trigger')
  const breakEvenBody = new URLSearchParams(breakEvenReplace.body)
  assert.equal(breakEvenBody.get('cancelOrderId'), '77777777777777777773')
  assert.equal(breakEvenBody.get('stopPrice'), '60030')
  showFullProtectionOrder = false
  btcPositionValue = '600'

  const secondRegister = await appRequest('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email: 'second@example.com', password: 'another-correct-horse-password' }),
  })
  const secondCookie = secondRegister.headers.get('set-cookie')?.split(';')[0]
  assert.ok(secondCookie)
  const secondExchangeSession = await appRequest('/api/exchange/session', { headers: { cookie: secondCookie! } })
  assert.equal(secondExchangeSession.status, 200)
  assert.equal((await secondExchangeSession.json() as { connected: boolean }).connected, false, 'a second user must not inherit the first user exchange connection')
  const secondAccount = await appRequest('/api/exchange/account', { headers: { cookie: secondCookie! } })
  assert.equal(secondAccount.status, 401, 'a second user must not read the first user account')
  const firstHistoryAgain = await appRequest('/api/account/history', { headers: { cookie: cookie! } })
  assert.equal((await firstHistoryAgain.json() as { orderHistory: Array<{ orderId: string }> }).orderHistory[0]?.orderId, '7001')

  console.log('Exchange API integration test passed')
} finally {
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()))
  globalThis.fetch = nativeFetch
}
