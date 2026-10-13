import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TerminalBottomPanel as BottomPanel } from './TerminalBottomPanel'

test('confirmed Hyperliquid position uses native venue, leverage and USD quote below chart', () => {
  const html = renderToStaticMarkup(<BottomPanel {...base} venue="Hyperliquid Testnet" quoteAsset="USD" settlementCurrency="USDC" positions={[{symbol:'BTC-USD',positionId:'testnet:BTC',positionSide:'LONG',positionAmt:'0.01210',availableAmt:'0.01210',isolated:false,unrealizedProfit:'2',initialMargin:'100',liquidationPrice:'0',avgPrice:'82620',leverage:10,positionValue:'1000',currency:'USDC'}]} />)
  assert.match(html, /Positions \(1\)/)
  assert.match(html, /Hyperliquid Testnet/)
  assert.match(html, /10<!-- -->x|10x/)
  assert.match(html, /1,000.*USD/)
  assert.doesNotMatch(html, /BingX|USDT/)
})
test('empty Hyperliquid account still keeps positions and open-orders tabs instead of removing lower panel', () => {
  const html = renderToStaticMarkup(<BottomPanel {...base} venue="Hyperliquid Testnet" quoteAsset="USD" settlementCurrency="USDC" positions={[]} />)
  assert.match(html, /Positions \(0\)/)
  assert.match(html, /Open Orders \(0\)/)
  assert.match(html, /No open Hyperliquid Testnet positions/)
  assert.doesNotMatch(html, /No open BingX positions/)
})
test('legacy BingX defaults retain its position and order labels', () => {
  const html = renderToStaticMarkup(<BottomPanel {...base} positions={[]} />)
  assert.match(html, /No open BingX positions/)
  assert.match(html, /Open Orders \(0\)/)
})
const base = { demoOrders:[],exchangeOrders:[],contracts:[],connected:true,balances:[],history:{orderHistory:[],tradeHistory:[],synchronizedAt:0,warnings:[]},historyLoading:false,liveTradingEnabled:false,executing:false,onRemoveDemo:()=>undefined,onCancelOrder:async()=>undefined,onAmendOrder:async()=>undefined,onClosePosition:async()=>undefined,onRefreshHistory:async()=>undefined }
