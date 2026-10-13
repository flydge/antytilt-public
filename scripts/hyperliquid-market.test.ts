import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getMarketDataAdapter } from '../src/marketData/index'
import type { MarketDataExchange } from '../src/marketData/types'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { useMarketData } from '../src/hooks/useMarketData'
import * as marketHook from '../src/hooks/useMarketData'

const request = { baseAsset: 'BTC', interval: '1m', fallbackPrice: 999_999, network: 'testnet' as const }
const candle = { t: 1_700_000_000_000, T: 1_700_000_059_999, s: 'BTC', i: '1m', o: '100', h: '110', l: '90', c: '105', v: '2' }
const context = { markPx: '106', prevDayPx: '100', dayNtlVlm: '2000', dayBaseVlm: '20', funding: '0.0001' }
const adapter = () => {
  const value = getMarketDataAdapter('hyperliquid' as MarketDataExchange)
  assert.ok(value, 'Hyperliquid chart adapter must be registered')
  return value
}

test('consumer book merge clears known liquidity on empty provider snapshots, preserves it for omitted fields', () => {
  const hook = marketHook as unknown as { replaceMarketBook: (current: unknown[], incoming?: unknown[]) => unknown[] }
  assert.equal(typeof hook.replaceMarketBook, 'function', 'Hook must distinguish empty snapshots from omitted fields')
  const current = [{ price: 100, quantity: 2, total: 2 }]
  assert.deepEqual(hook.replaceMarketBook(current, []), [])
  assert.equal(hook.replaceMarketBook(current, undefined), current)
  assert.deepEqual(hook.replaceMarketBook(current, [{ price: 101, quantity: 3, total: 3 }]), [{ price: 101, quantity: 3, total: 3 }])
})

test('failed Hyperliquid initial history cannot become Live from a valid candle; legacy candle readiness stays unchanged', () => {
  const hook = marketHook as unknown as { marketStreamCanBeLive: (exchange: string, snapshotInitialized: boolean, candleReceived: boolean) => boolean }
  assert.equal(typeof hook.marketStreamCanBeLive, 'function', 'Hook must gate Hyperliquid on successful initial snapshot')
  assert.equal(hook.marketStreamCanBeLive('hyperliquid', false, true), false)
  assert.equal(hook.marketStreamCanBeLive('hyperliquid', true, true), true)
  assert.equal(hook.marketStreamCanBeLive('hyperliquid', true, false), true)
  assert.equal(hook.marketStreamCanBeLive('bingx', false, true), true)
  assert.equal(hook.marketStreamCanBeLive('bingx', true, false), false)
})

test('Hyperliquid initial chart state never seeds Binance catalog prices', () => {
  function View() {
    const data = useMarketData('hyperliquid', 'BTC', '1m', 999_999)
    return createElement('span', null, Number.isNaN(data.ticker.lastPrice) ? 'Unavailable' : String(data.ticker.lastPrice))
  }
  assert.equal(renderToStaticMarkup(createElement(View)), '<span>Unavailable</span>')
})

test('loads BTC testnet POST snapshots and normalizes provider data without fallback prices', async () => {
  const calls: Array<{ url: string; body: any }> = []
  const original = globalThis.fetch
  const controller = new AbortController()
  globalThis.fetch = async (input, init) => {
    assert.equal(init?.method, 'POST')
    assert.ok(init?.signal)
    const body = JSON.parse(String(init?.body))
    calls.push({ url: String(input), body })
    const data = body.type === 'candleSnapshot' ? [candle]
      : body.type === 'metaAndAssetCtxs' ? [{ universe: [{ name: 'ETH' }, { name: 'BTC' }] }, [{}, context]]
      : body.type === 'l2Book' ? { coin: 'BTC', levels: [[{ px: '104', sz: '3', n: 1 }], [{ px: '107', sz: '4', n: 1 }]] }
      : [{ coin: 'BTC', px: '105', sz: '0.5', time: 1_700_000_000_000, side: 'A', tid: 7 }]
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
  }
  try {
    const data = await adapter().loadInitial(request, controller.signal)
    assert.equal(calls.length, 4)
    assert.ok(calls.every((call) => call.url === 'https://api.hyperliquid-testnet.xyz/info'))
    assert.deepEqual(calls.map((call) => call.body.type).sort(), ['candleSnapshot', 'l2Book', 'metaAndAssetCtxs', 'recentTrades'])
    const history = calls.find((call) => call.body.type === 'candleSnapshot')!.body.req
    assert.equal(history.coin, 'BTC'); assert.equal(history.interval, '1m')
    assert.ok(history.endTime > history.startTime)
    assert.ok(history.endTime - history.startTime <= 500 * 60_000)
    assert.deepEqual(data.candles, [{ time: 1_700_000_000, open: 100, high: 110, low: 90, close: 105, volume: 2 }])
    assert.equal(data.ticker?.lastPrice, 106)
    assert.equal(data.ticker?.priceChangePercent, 6)
    assert.ok(Number.isNaN(data.ticker?.highPrice), 'Unavailable 24h highs must not be fabricated')
    assert.equal(data.bids?.[0].price, 104); assert.equal(data.asks?.[0].total, 4)
    assert.equal(data.trades?.[0].side, 'sell'); assert.equal(data.fundingRate, 0.0001)
  } finally { globalThis.fetch = original }
})

test('rejects unsupported instruments and malformed/empty snapshots without fallback', async () => {
  const value = adapter()
  await assert.rejects(value.loadInitial({ ...request, baseAsset: '../BTC' }, new AbortController().signal), /coin|symbol/)
  await assert.rejects(value.loadInitial({ ...request, interval: '6h' }, new AbortController().signal), /interval/)
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response('[]')
  try { await assert.rejects(value.loadInitial(request, new AbortController().signal), /unavailable|Invalid|Empty/) }
  finally { globalThis.fetch = original }
})

test('routes default Mainnet and explicit Testnet snapshots using exact requested native coins', async () => {
  const original = globalThis.fetch
  const calls: Array<{ url: string; body: any }> = []
  let coin = 'ETH'
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)); calls.push({ url: String(input), body })
    const data = body.type === 'metaAndAssetCtxs' ? [{ universe: [{ name: 'BTC' }, { name: coin }] }, [{ ...context, markPx: '999' }, context]]
      : body.type === 'candleSnapshot' ? [{ ...candle, s: coin }]
      : body.type === 'l2Book' ? { coin, levels: [[{ px: '104', sz: '1' }], [{ px: '107', sz: '2' }]] }
      : [{ coin, px: '105', sz: '1', time: candle.t, side: 'B', tid: 1 }]
    return new Response(JSON.stringify(data))
  }
  try {
    const main = await adapter().loadInitial({ baseAsset: coin, interval: '1m', fallbackPrice: 999_999 }, new AbortController().signal)
    assert.ok(calls.every(call => call.url === 'https://api.hyperliquid.xyz/info'))
    assert.equal(main.ticker?.lastPrice, 106, 'Metadata context must match requested coin index')
    assert.equal(main.trades?.[0].side, 'buy'); assert.equal(main.candles?.[0].close, 105)
    assert.ok(calls.filter(call => call.body.coin || call.body.req).every(call => (call.body.coin ?? call.body.req.coin) === 'ETH'))
    calls.length = 0; coin = 'kPEPE'
    await adapter().loadInitial({ ...request, baseAsset: coin }, new AbortController().signal)
    assert.ok(calls.every(call => call.url === 'https://api.hyperliquid-testnet.xyz/info'))
    assert.ok(calls.filter(call => call.body.coin || call.body.req).every(call => (call.body.coin ?? call.body.req.coin) === 'kPEPE'))
  } finally { globalThis.fetch = original }
})

test('rejects unavailable or delisted metadata coin even with plausible prices and candles', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async (_input, init) => {
    const type = JSON.parse(String(init?.body)).type
    const data = type === 'metaAndAssetCtxs' ? [{ universe: [{ name: 'BTC', isDelisted: true }] }, [context]]
      : type === 'candleSnapshot' ? [candle] : type === 'l2Book' ? { coin: 'BTC', levels: [[], []] } : []
    return new Response(JSON.stringify(data))
  }
  try { await assert.rejects(adapter().loadInitial(request, new AbortController().signal), /unavailable|delisted/) }
  finally { globalThis.fetch = original }
})

test('network-specific labels and identity prevent Mainnet/Testnet cache reuse without changing legacy identities', async () => {
  const market = await import('../src/marketData/index') as unknown as { marketDataSourceLabel: (exchange: string, network?: string) => string }
  const hook = marketHook as unknown as { marketDataIdentity: (exchange: string, coin: string, interval: string, network?: string) => string }
  assert.equal(typeof market.marketDataSourceLabel, 'function')
  assert.equal(typeof hook.marketDataIdentity, 'function')
  assert.equal(market.marketDataSourceLabel('hyperliquid'), 'Hyperliquid Mainnet')
  assert.equal(market.marketDataSourceLabel('hyperliquid', 'testnet'), 'Hyperliquid Testnet')
  assert.notEqual(hook.marketDataIdentity('hyperliquid', 'ETH', '1m', 'mainnet'), hook.marketDataIdentity('hyperliquid', 'ETH', '1m', 'testnet'))
  assert.equal(hook.marketDataIdentity('bingx', 'BTC', '1m', 'testnet'), 'bingx:BTC:1m')
})

test('catalog reflects provider-native universe and quotes without invented rank, fallback prices, or Binance joins', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://api.hyperliquid.xyz/info')
    assert.deepEqual(JSON.parse(String(init?.body)), { type: 'metaAndAssetCtxs' })
    return new Response(JSON.stringify([{ universe: [{ name: 'BTC' }, { name: 'kPEPE' }, { name: 'DEAD', isDelisted: true }] }, [context, { ...context, markPx: '0.012' }, context]]))
  }
  try {
    const module = await import('../src/marketData/hyperliquidAdapter') as unknown as { loadHyperliquidMarketCatalog: (network: string, signal: AbortSignal) => Promise<any[]> }
    assert.equal(typeof module.loadHyperliquidMarketCatalog, 'function')
    const markets = await module.loadHyperliquidMarketCatalog('mainnet', new AbortController().signal)
    assert.deepEqual(markets.map(item => item.symbol), ['BTC/USD', 'kPEPE/USD'])
    assert.equal(markets[1].baseAsset, 'kPEPE'); assert.equal(markets[1].lastPrice, 0.012)
    assert.equal(markets[0].marketCapRank, 0); assert.equal(markets[0].quoteAsset, 'USD')
    assert.deepEqual(markets[0].exchanges, ['hyperliquid'])
  } finally { globalThis.fetch = original }
})

test('24h extrema use only exactly covered provider hourly intervals, otherwise remain unavailable', async () => {
  const module = await import('../src/marketData/hyperliquidAdapter') as unknown as { hyperliquid24hExtrema: (candles: any[], interval: string, now: number) => { highPrice: number; lowPrice: number } }
  assert.equal(typeof module.hyperliquid24hExtrema, 'function')
  const now = 1_728_086_400_000
  assert.equal(now % 3_600_000, 0)
  const rows = Array.from({ length: 24 }, (_, index) => ({ time: (now - 86_400_000 + index * 3_600_000) / 1000, open: 100, high: 110 + index, low: 90 - index, close: 105, volume: 2 }))
  assert.deepEqual(module.hyperliquid24hExtrema(rows, '1h', now), { highPrice: 133, lowPrice: 67 })
  assert.ok(Number.isNaN(module.hyperliquid24hExtrema(rows.slice(1), '1h', now).highPrice))
  assert.ok(Number.isNaN(module.hyperliquid24hExtrema(rows, '1h', now + 1).highPrice), 'Hourly bars cannot determine extrema within a partial boundary hour')
})

test('network-bound sockets use requested native coin and ignore foreign candle, book and context updates', () => {
  const original = globalThis.WebSocket
  class Socket {
    static latest: Socket
    readyState = 1; sent: any[] = []
    onopen: (() => void) | null = null; onmessage: ((event: { data: string }) => void) | null = null
    onclose: (() => void) | null = null; onerror: (() => void) | null = null
    constructor(public url: string) { Socket.latest = this }
    send(value: string) { this.sent.push(JSON.parse(value)) }
    close() { this.onclose?.() }
  }
  globalThis.WebSocket = Socket as unknown as typeof WebSocket
  try {
    for (const [network, coin, expectedUrl] of [['mainnet', 'ETH', 'wss://api.hyperliquid.xyz/ws'], ['testnet', 'kPEPE', 'wss://api.hyperliquid-testnet.xyz/ws']] as const) {
      const updates: any[] = []
      const stop = getMarketDataAdapter('hyperliquid', network).subscribe({ baseAsset: coin, interval: '1m', fallbackPrice: NaN }, { onOpen: () => {}, onClose: () => {}, onUpdate: update => updates.push(update) })
      try {
        const socket = Socket.latest; assert.equal(socket.url, expectedUrl); socket.onopen!()
        assert.ok(socket.sent.every(item => item.subscription.coin === coin))
        const send = (channel: string, data: unknown) => socket.onmessage!({ data: JSON.stringify({ channel, data }) })
        send('candle', candle); send('l2Book', { coin: 'BTC', levels: [[], []] }); send('activeAssetCtx', { coin: 'BTC', ctx: context })
        assert.equal(updates.length, 0, 'Other native coin data must not enter this source')
        send('candle', { ...candle, s: coin }); send('l2Book', { coin, levels: [[], []] }); send('activeAssetCtx', { coin, ctx: context })
        assert.equal(updates[0].candles[0].close, 105); assert.deepEqual(updates[1], { asks: [], bids: [] }); assert.equal(updates[2].ticker.lastPrice, 106)
      } finally { stop() }
    }
  } finally { globalThis.WebSocket = original }
})

test('catalog provider errors and ambiguous metadata reject instead of falling back to invented markets', async () => {
  const original = globalThis.fetch
  const { loadHyperliquidMarketCatalog } = await import('../src/marketData/hyperliquidAdapter')
  try {
    globalThis.fetch = async () => new Response('unavailable', { status: 503 })
    await assert.rejects(loadHyperliquidMarketCatalog('mainnet', new AbortController().signal), /503/)
    globalThis.fetch = async () => new Response(JSON.stringify([{ universe: [{ name: 'ETH' }, { name: 'ETH' }] }, [context, context]]))
    await assert.rejects(loadHyperliquidMarketCatalog('testnet', new AbortController().signal), /ambiguous/)
  } finally { globalThis.fetch = original }
})

test('aborts snapshots and surfaces provider HTTP errors', async () => {
  const value = adapter(); const original = globalThis.fetch
  globalThis.fetch = async () => new Response('unavailable', { status: 503 })
  try { await assert.rejects(value.loadInitial(request, new AbortController().signal), /503/) }
  finally { globalThis.fetch = original }
  const controller = new AbortController(); controller.abort()
  await assert.rejects(value.loadInitial(request, controller.signal), /abort/i)
})

test('subscribes to native BTC streams, rejects foreign data, and disposes without late callbacks', () => {
  const value = adapter(); const original = globalThis.WebSocket
  class Socket {
    static latest: Socket
    readyState = 1; sent: any[] = []; closed = 0
    onopen: (() => void) | null = null; onmessage: ((event: { data: string }) => void) | null = null
    onclose: (() => void) | null = null; onerror: (() => void) | null = null
    constructor(public url: string) { Socket.latest = this }
    send(data: string) { this.sent.push(JSON.parse(data)) }
    close() { this.closed++; this.onclose?.() }
  }
  globalThis.WebSocket = Socket as unknown as typeof WebSocket
  const updates: any[] = []; let opened = 0; let closed = 0
  try {
    const stop = value.subscribe(request, { onOpen: () => opened++, onClose: () => closed++, onUpdate: (update) => updates.push(update) })
    const socket = Socket.latest
    assert.equal(socket.url, 'wss://api.hyperliquid-testnet.xyz/ws')
    socket.onopen!(); assert.equal(opened, 1)
    assert.deepEqual(socket.sent.map((message) => message.subscription), [{ type: 'candle', coin: 'BTC', interval: '1m' }, { type: 'l2Book', coin: 'BTC' }, { type: 'trades', coin: 'BTC' }, { type: 'activeAssetCtx', coin: 'BTC' }])
    const send = (channel: string, data: unknown) => socket.onmessage!({ data: JSON.stringify({ channel, data }) })
    send('candle', { ...candle, s: 'ETH' }); assert.equal(updates.length, 0)
    send('candle', candle); assert.equal(updates[0].candles[0].close, 105)
    send('activeAssetCtx', { coin: 'BTC', ctx: context }); assert.equal(updates[1].ticker.lastPrice, 106)
    send('l2Book', { coin: 'BTC', levels: [[{ px: '104', sz: '2' }], [{ px: '108', sz: '1' }]] }); assert.equal(updates[2].bids[0].quantity, 2)
    send('trades', [{ coin: 'BTC', side: 'B', px: '107', sz: '1', time: 1_700_000_000_001, tid: 9 }]); assert.equal(updates[3].trades[0].side, 'buy')
    const late = socket.onmessage!; stop(); stop()
    late({ data: JSON.stringify({ channel: 'candle', data: candle }) })
    assert.equal(updates.length, 4); assert.equal(socket.closed, 1); assert.equal(closed, 0)
    value.subscribe(request, { onOpen: () => undefined, onClose: () => closed++, onUpdate: () => assert.fail('Malformed message cannot become a market update') })
    Socket.latest.onmessage!({ data: '{invalid' }); assert.equal(closed, 1)
  } finally { globalThis.WebSocket = original }
})

test('failed snapshot cancels remaining provider requests', async () => {
  const original = globalThis.fetch
  const signals: AbortSignal[] = []
  globalThis.fetch = async (_input, init) => {
    signals.push(init!.signal as AbortSignal)
    if (JSON.parse(String(init!.body)).type === 'l2Book') return new Response('', { status: 503 })
    return new Response('[]')
  }
  try {
    await assert.rejects(adapter().loadInitial(request, new AbortController().signal), /503/)
    assert.ok(signals.every((signal) => signal.aborted), 'Sibling requests must be cancelled after failure')
  } finally { globalThis.fetch = original }
})
