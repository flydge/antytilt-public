/// <reference types="node" />
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { selectExecutionPrice, readExecutionProvider, readHyperliquidNetwork } from './executionSelection'
import { normalizeInstrumentSymbol, showHyperliquidChartOverlays } from './executionSelection'
test('native Hyperliquid overlays require same execution network and normalize native symbols', () => {
 assert.equal(normalizeInstrumentSymbol('BTC/USD'), normalizeInstrumentSymbol('BTC-USD'))
 assert.equal(showHyperliquidChartOverlays('hyperliquid', 'hyperliquid', 'BTC', 'testnet', 'testnet'), true)
 assert.equal(showHyperliquidChartOverlays('hyperliquid', 'hyperliquid', 'BTC', 'mainnet', 'testnet'), false)
 assert.equal(showHyperliquidChartOverlays('hyperliquid', 'binance', 'BTC', 'testnet', 'testnet'), false)
 assert.equal(showHyperliquidChartOverlays('hyperliquid', 'hyperliquid', 'ETH', 'testnet', 'testnet'), false)
})
test('chart Hyperliquid prices never become BingX execution prices', () => {
 assert.equal(selectExecutionPrice('hyperliquid', 99999, 60100, 60000), 60100)
 assert.equal(selectExecutionPrice('hyperliquid', 99999, undefined, 60000), 60000)
 assert.ok(Number.isNaN(selectExecutionPrice('hyperliquid', 99999, undefined, undefined)))
})
test('execution and chart network defaults differ without sharing storage choice', () => {
 assert.equal(readExecutionProvider('hyperliquid'), 'hyperliquid')
 assert.equal(readExecutionProvider('binance'), 'bingx')
 assert.equal(readHyperliquidNetwork(null, 'testnet'), 'testnet')
 assert.equal(readHyperliquidNetwork(null, 'mainnet'), 'mainnet')
})
test('legacy chart overlays survive with BingX execution while HL charts never show them', async () => {
 const { showBingxChartOverlays } = await import('./executionSelection')
 for (const chart of ['binance', 'bybit', 'bingx'] as const) assert.equal(showBingxChartOverlays('bingx', chart, 'BTC', 'BTC'), true)
 assert.equal(showBingxChartOverlays('bingx', 'hyperliquid', 'BTC', 'BTC'), false)
 assert.equal(showBingxChartOverlays('hyperliquid', 'binance', 'BTC', 'BTC'), false)
 assert.equal(showBingxChartOverlays('bingx', 'binance', 'ETH', 'BTC'), false)
})
