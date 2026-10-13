import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { getAccountSnapshot, placeOrReplaceProtectiveStop, responseOrderIdentifier, selectSettlementBalance, settlementAsset } from './bingxClient'

const originalFetch = globalThis.fetch
const originalDateNow = Date.now
const fixedTimestamp = 1_725_000_000_000
const apiKey = 'test-api-key-1234'
const secretKey = 'test-secret-key-5678'
const requests: Array<{ url: URL; init?: RequestInit }> = []
let timestampErrorsRemaining = 0
let timestampErrorCode = 100421
let serverTimeOffset = 0

Date.now = () => fixedTimestamp
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url)
  requests.push({ url, init })

  if (url.pathname.endsWith('/server/time')) {
    return new Response(JSON.stringify({
      code: 0,
      msg: '',
      data: { serverTime: fixedTimestamp + serverTimeOffset },
    }), { status: 200 })
  }
  if (timestampErrorsRemaining > 0) {
    timestampErrorsRemaining -= 1
    const msg = timestampErrorCode === 109400 ? 'timestamp is invalid' : 'timestamp mismatch'
    return new Response(JSON.stringify({ code: timestampErrorCode, msg, data: null }), { status: 200 })
  }

  let data: unknown
  if (url.pathname.endsWith('/user/balance')) {
    data = [{ asset: 'USDT', balance: '1000', equity: '1005', unrealizedProfit: '5', availableMargin: '900', usedMargin: '105' }]
  } else if (url.pathname.endsWith('/user/positions')) {
    data = [{
      symbol: 'BTC-USDT',
      positionId: '90071992547409931234',
      positionSide: 'LONG',
      isolated: false,
      positionAmt: '0.01',
      availableAmt: '0.01',
      unrealizedProfit: '5',
      initialMargin: '50',
      liquidationPrice: '40000',
      avgPrice: '60000',
      leverage: 20,
      currency: 'USDT',
    }]
  } else if (url.pathname.endsWith('/positionSide/dual')) {
    data = { dualSidePosition: true }
  } else if (url.pathname.endsWith('/quote/contracts')) {
    data = [{
      symbol: 'BTC-USDT', quantityPrecision: 3, pricePrecision: 1,
      tradeMinQuantity: 0.001, tradeMinUSDT: 5, maxLongLeverage: 50,
      maxShortLeverage: 50, status: 1, apiStateOpen: 'true', apiStateClose: 'true',
      asset: 'BTC', currency: 'USDT',
    }]
  } else if (url.pathname.endsWith('/trade/cancelReplace')) {
    data = { cancelResult: 'SUCCESS', newOrderResult: 'SUCCESS', newOrderResponse: { orderId: 'protective-replacement-1' } }
  } else if (url.pathname.endsWith('/trade/order')) {
    data = { orderId: 'protective-stop-1' }
  } else {
    data = []
  }

  return new Response(JSON.stringify({ code: 0, msg: '', data }), { status: 200 })
}) as typeof fetch

try {
  const snapshot = await getAccountSnapshot('prod-vst', { apiKey, secretKey })
  assert.equal(snapshot.balances[0]?.availableMargin, '900')
  assert.equal(snapshot.positions[0]?.positionId, '90071992547409931234', 'large IDs must remain exact strings')
  assert.equal(snapshot.dualSidePosition, true)
  assert.equal(requests.length, 4)
  const vstBalance = { ...snapshot.balances[0]!, asset: 'VST', availableMargin: '99699.9295' }
  assert.equal(settlementAsset('prod-vst'), 'VST')
  assert.equal(settlementAsset('prod-live'), 'USDT')
  assert.equal(selectSettlementBalance('prod-vst', [snapshot.balances[0]!, vstBalance])?.availableMargin, '99699.9295')
  assert.equal(selectSettlementBalance('prod-live', [snapshot.balances[0]!, vstBalance])?.availableMargin, '900')

  const canonical = `recvWindow=5000&timestamp=${fixedTimestamp}`
  const expectedSignature = createHmac('sha256', secretKey).update(canonical).digest('hex')
  for (const request of requests) {
    const headers = new Headers(request.init?.headers)
    assert.equal(headers.get('X-BX-APIKEY'), apiKey)
    assert.equal(headers.get('X-SOURCE-KEY'), 'BX-AI-SKILL')
    assert.equal(request.url.searchParams.get('signature'), expectedSignature)
    assert.equal(request.url.searchParams.get('timestamp'), String(fixedTimestamp))
    assert.equal(request.url.toString().includes(secretKey), false, 'secret must never be sent')
  }

  requests.length = 0
  timestampErrorsRemaining = 1
  serverTimeOffset = 2_500
  await getAccountSnapshot('prod-vst', { apiKey, secretKey })
  assert.equal(requests.filter((request) => request.url.pathname.endsWith('/server/time')).length, 1)
  assert.ok(
    requests.some((request) => request.url.searchParams.get('timestamp') === String(fixedTimestamp + serverTimeOffset)),
    'a timestamp mismatch must synchronize BingX server time and retry with the corrected timestamp',
  )

  requests.length = 0
  timestampErrorsRemaining = 1
  timestampErrorCode = 109400
  serverTimeOffset = 5_000
  await getAccountSnapshot('prod-vst', { apiKey, secretKey })
  assert.equal(requests.filter((request) => request.url.pathname.endsWith('/server/time')).length, 1)
  assert.ok(
    requests.some((request) => request.url.searchParams.get('timestamp') === String(fixedTimestamp + serverTimeOffset)),
    'BingX code 109400 with a timestamp message must also synchronize time and retry',
  )

  requests.length = 0
  const createdStop = await placeOrReplaceProtectiveStop('prod-vst', { apiKey, secretKey }, {
    position: snapshot.positions[0]!,
    stopPrice: 58_800.04,
    workingType: 'MARK_PRICE',
    clientOrderId: 'rm-stop-create',
  })
  assert.equal(responseOrderIdentifier(createdStop), 'protective-stop-1')
  const createRequest = requests.find((request) => request.url.pathname.endsWith('/trade/order') && request.init?.method === 'POST')
  assert.ok(createRequest)
  const createBody = new URLSearchParams(String(createRequest.init?.body))
  assert.equal(createBody.get('stopPrice'), '58800')
  assert.equal(createBody.get('quantity'), '0.01')
  assert.equal(createBody.get('workingType'), 'MARK_PRICE')

  requests.length = 0
  const replacedStop = await placeOrReplaceProtectiveStop('prod-vst', { apiKey, secretKey }, {
    position: snapshot.positions[0]!,
    stopPrice: 60_030,
    workingType: 'MARK_PRICE',
    cancelOrderId: 'old-stop-1',
    clientOrderId: 'rm-stop-replace',
  })
  assert.equal(responseOrderIdentifier(replacedStop), 'protective-replacement-1')
  const replaceRequest = requests.find((request) => request.url.pathname.endsWith('/trade/cancelReplace'))
  assert.ok(replaceRequest)
  const replaceBody = new URLSearchParams(String(replaceRequest.init?.body))
  assert.equal(replaceBody.get('cancelOrderId'), 'old-stop-1')
  assert.equal(replaceBody.get('cancelReplaceMode'), 'STOP_ON_FAILURE')

  console.log('BingX signed client test passed')
} finally {
  globalThis.fetch = originalFetch
  Date.now = originalDateNow
}
