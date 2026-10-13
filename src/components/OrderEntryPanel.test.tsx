/// <reference types="node" />
import React from 'react'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { OrderEntryPanel, OrderConfirmationModal, LeverageModal, estimateOrderNotional, validateVenueOrderInput, type OrderEntryPanelProps, type OrderEntryVenue } from './OrderEntryPanel'
import type { AdvancedOrderInput } from '../types'
const venue: OrderEntryVenue = { name: 'Hyperliquid', network: 'testnet', quoteAsset: 'USD', marginAsset: 'USDC', executionSymbol: 'BTC-USD', isLive: false, actionsEnabled: true, availableMargin: 999 }
const props: OrderEntryPanelProps = { price: 100000, marketDataExchange: 'hyperliquid', market: { id: 'btc', symbol: 'BTC/USD', baseAsset: 'BTC', quoteAsset: 'USD', name: 'Bitcoin', logoUrl: '', marketCapRank: 0, lastPrice: 100000, priceChangePercent: 0, exchanges: ['hyperliquid'] }, exchange: { connected: true, liveTradingEnabled: false, liveTriggerOrdersEnabled: false }, status: 'idle', exchangeError: null, settingsLoading: false, instrumentSupported: true, positions: [], openOrders: [], settings: { symbol: 'BTC-USD', marginType: 'CROSSED', longLeverage: 10, shortLeverage: 10, maxLongLeverage: 40, maxShortLeverage: 40, dualSidePosition: false, contract: { symbol: 'BTC-USD', quantityPrecision: 5, pricePrecision: 1, makerFeeRate: .00015, takerFeeRate: .00045, tradeMinQuantity: .0001, tradeMinUSDT: 10, maxLongLeverage: 40, maxShortLeverage: 40, status: 1, apiStateOpen: 'true', apiStateClose: 'true', asset: 'BTC', currency: 'USD' }, prices: { markPrice: 100000, indexPrice: 100000, bidPrice: 99999, askPrice: 100001 }, updatedAt: Date.now() }, onCreateOrder: () => {}, onChangeMarginType: async () => props.settings!, onChangeLeverage: async () => props.settings!, onPreviewOrder: async () => { throw Error('Not called in rendering') }, onExecuteOrder: async () => {}, onOpenRiskManagement: () => {}, onProtectionDraftChange: () => {} }
test('Hyperliquid margin amount means margin times leverage; BingX fee-inclusive cost retained', () => {
 assert.equal(estimateOrderNotional('COST', 100, 100000, 10, .001, .001, true), 1000)
 assert.equal(estimateOrderNotional('VALUE', 100, 100000, 10, .001, .001, true), 100)
 assert.equal(estimateOrderNotional('QUANTITY', .001, 100000, 10, .001, .001, true), 100)
 assert.ok(Math.abs(estimateOrderNotional('COST', 100, 100000, 10, .001, .001, false) - 100 / .102) < 1e-9)
})
test('shared Hyperliquid form keeps original controls with native venue labels and neutral guard', () => {
 const html = renderToStaticMarkup(<OrderEntryPanel {...props} venue={venue} />)
 assert.match(html, /order-panel panel advanced-order-panel/); assert.match(html, /10x/); assert.match(html, /Buy \/ Long/); assert.match(html, /Sell \/ Short/)
 assert.match(html, /aria-label="Slippage limit percentage"[^>]*value="0.25"/); assert.match(html, /999 USDC/); assert.match(html, /BTC-USD/); assert.match(html, /Hyperliquid Testnet/)
 assert.match(html, /class="active"[^>]*>Margin/); assert.match(html, /Position protection/)
 assert.doesNotMatch(html, /Risk Guard paused|Risk Guard active|Connect BingX|BingX confirmed/)
})
test('mainnet and disconnected Hyperliquid cannot expose a local demo order path', () => {
 for (const input of [{ ...venue, network: 'mainnet' as const, isLive: true }, { ...venue, actionsEnabled: false }]) {
 const html = renderToStaticMarkup(<OrderEntryPanel {...props} exchange={{ ...props.exchange, connected: false }} venue={input} />)
 assert.match(html, /class="place-order buy"[^>]*disabled=""/); assert.doesNotMatch(html, /Demo mode|Buy BTC · Demo/)
 }
})
test('default BingX renders its original value sizing and guard', () => {
 const html = renderToStaticMarkup(<OrderEntryPanel {...props} marketDataExchange="bingx" market={{ ...props.market, symbol: 'BTCUSDT', quoteAsset: 'USDT' }} />)
 assert.match(html, /class="active"[^>]*>Position value/); assert.match(html, /Risk Guard/); assert.match(html, /USDT/)
})
const input: AdvancedOrderInput = { symbol: 'BTC-USD', direction: 'LONG', orderKind: 'LIMIT', amountMode: 'COST', amount: 100, leverage: 10, marginType: 'CROSSED', price: 100000, timeInForce: 'GTC' }
test('native unsupported options fail before preview while default BingX capabilities stay unchanged', () => {
 assert.throws(() => validateVenueOrderInput({ ...input, timeInForce: 'FOK' }, venue), /FOK/)
 assert.throws(() => validateVenueOrderInput({ ...input, stopLoss: { stopPrice: 99000, execution: 'MARKET', workingType: 'CONTRACT_PRICE' } }, venue), /Mark/)
 assert.throws(() => validateVenueOrderInput(input, { ...venue, network: 'mainnet' }), /disabled/)
 assert.doesNotThrow(() => validateVenueOrderInput({ ...input, timeInForce: 'FOK' }))
})

test('native confirmation keeps original modal but shows USD/USDC, owner and requested stop truthfully', () => {
 const now = Date.now()
 const html = renderToStaticMarkup(<OrderConfirmationModal venue={{ ...venue, account: '0xmaster' }} exchange={props.exchange} status="idle" onCancel={() => {}} onConfirm={async () => {}} onRefresh={async () => {}} response={{ previewId: 'preview', expiresAt: now + 60000, preview: { symbol: 'BTC-USD', direction: 'LONG', orderKind: 'MARKET', exchangeOrderType: 'IOC', amountMode: 'COST', quantity: .01, notional: 1000, estimatedMargin: 100, estimatedOpenFee: .45, estimatedCloseFee: .45, estimatedOrderCost: 100.9, estimatedAveragePrice: 100000, estimatedSlippagePercent: .025, indicativeLiquidationPrice: NaN, marginType: 'CROSSED', leverage: 10, maker: false, triggerLiveVerified: true, stopLoss: { stopPrice: 99000, execution: 'MARKET', workingType: 'MARK_PRICE', expectedPnl: -10 } } }} />)
 assert.match(html, /trade-modal confirmation-modal/); assert.match(html, /Hyperliquid testnet/); assert.match(html, /Owner: 0xmaster/)
 assert.match(html, /1,000 USD/); assert.match(html, /100 USDC/); assert.match(html, /99,000 USD/); assert.match(html, /Protection requested/)
 assert.doesNotMatch(html, /USDT|BingX|Position protected/)
})
test('native leverage modal uses provider maximum and one asset setting, mainnet confirm disabled', () => {
 const html = renderToStaticMarkup(<LeverageModal venue={{ ...venue, network: 'mainnet' }} exchange={props.exchange} settings={props.settings} status="idle" direction="SHORT" localLeverage={3} onLocalChange={() => {}} onChangeLeverage={props.onChangeLeverage} onClose={() => {}} />)
 assert.match(html, /current 10x · maximum 40x/); assert.match(html, /one leverage setting/); assert.match(html, /class="primary"[^>]*disabled=""/)
})
test('FOK cannot be enabled by a Hyperliquid capability override', () => {
 assert.throws(() => validateVenueOrderInput({ ...input, timeInForce: 'FOK' }, { ...venue, supportedTimeInForce: ['GTC', 'FOK'] }), /FOK/)
})
test('disabled risk hook returns a neutral profile and refuses an outgoing risk save', async () => {
 const { useRiskProfile, defaultRiskProfile } = await import('../hooks/useRiskProfile')
 let disabledSave: ((next: typeof defaultRiskProfile) => Promise<typeof defaultRiskProfile>) | undefined
 function Probe() { const risk = useRiskProfile(false); disabledSave = risk.save; return <span>{String(risk.profile.active)}:{String(risk.profile.riskPerTrade.enabled)}:{risk.status}:{risk.events.length}</span> }
 assert.match(renderToStaticMarkup(<Probe />), /false:false:idle:0/)
 const previous = globalThis.fetch
 globalThis.fetch = async () => { throw Error('Network must not be used by a disabled risk hook') }
 try { await assert.rejects(disabledSave!(defaultRiskProfile), /not enabled for this venue/) } finally { globalThis.fetch = previous }
})

test('native mark-price Stop Limit is accepted without rewriting trigger or limit price', () => {
 const order = { ...input, stopLoss: { stopPrice: 99000, execution: 'LIMIT' as const, price: 98500, workingType: 'MARK_PRICE' as const } }
 const before = structuredClone(order)
 assert.doesNotThrow(() => validateVenueOrderInput(order, venue))
 assert.deepEqual(order, before)
})
