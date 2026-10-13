/// <reference types="node" />
import React from 'react'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ExecutionAccountChooser } from './ExecutionAccountChooser'
const callbacks = { onProvider: () => {}, onNetwork: () => {}, onManage: () => {}, onClose: () => {} }
test('chooser shows two execution venues without inventing an exchange account', () => {
 const html = renderToStaticMarkup(<ExecutionAccountChooser provider="bingx" network="testnet" {...callbacks} />)
 assert.match(html, /Choose Execution Account/)
 assert.match(html, /BingX/); assert.match(html, /Hyperliquid/)
 assert.match(html, /aria-pressed="true"[^>]*><strong>BingX/)
 assert.match(html, /Manage BingX Connection/)
 assert.doesNotMatch(html, /Hyperliquid execution network/)
})
test('Hyperliquid execution network remains explicit and distinct from chart and protection', () => {
 const html = renderToStaticMarkup(<ExecutionAccountChooser provider="hyperliquid" network="mainnet" {...callbacks} />)
 assert.match(html, /Hyperliquid execution network/)
 assert.match(html, /value="mainnet" selected=""/)
 assert.match(html, /Mainnet · read only/)
 assert.match(html, /testnet connection/)
 assert.match(html, /Manage Hyperliquid Master EOA/)
})
test('terminal API-wallet controls appear only for Hyperliquid Testnet', () => {
 const connectionContent = <section>Testnet terminal API wallet</section>
 const testnet = renderToStaticMarkup(<ExecutionAccountChooser provider="hyperliquid" network="testnet" connectionContent={connectionContent} {...callbacks} />)
 assert.match(testnet, /Testnet terminal API wallet/)
 for (const selection of [{provider: 'hyperliquid', network: 'mainnet'}, {provider: 'bingx', network: 'testnet'}] as const) {
  const html = renderToStaticMarkup(<ExecutionAccountChooser {...selection} connectionContent={connectionContent} {...callbacks} />)
  assert.doesNotMatch(html, /Testnet terminal API wallet/)
 }
})
