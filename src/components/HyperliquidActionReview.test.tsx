import React from 'react'
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {renderToStaticMarkup} from 'react-dom/server'
import {HyperliquidActionReview} from './HyperliquidActionReview'
import type {HlTerminalPacket} from '../../shared/hyperliquidTerminal'
const packet = { id:'settings-review', network:'testnet', account:'0x00000000000000000000000000000000000a11ce', kind:'settings', settingBefore:{leverage:20,marginType:'cross'}, action:{type:'updateLeverage',asset:3,isCross:true,leverage:10}, summary:{quantity:null}, expiresAfter:Date.now()+60000 } as HlTerminalPacket
test('settings review shows current and requested native leverage with exact master before wallet',()=>{
 const html=renderToStaticMarkup(<HyperliquidActionReview review={{packet,confirm:async()=>{},cancel:()=>{}}}/>)
 assert.match(html,/20×/);assert.match(html,/10×/);assert.match(html,/0x00000000000000000000000000000000000a11ce/);assert.match(html,/Confirm in wallet/)
 assert.doesNotMatch(html,/disabled=""/)
})
test('expired packet disables owner confirmation and offers discard',()=>{
 const html=renderToStaticMarkup(<HyperliquidActionReview review={{packet:{...packet,expiresAfter:Date.now()-1000},confirm:async()=>{},cancel:()=>{}}}/>)
 assert.match(html,/Review expired/);assert.match(html,/<button[^>]+disabled=""[^>]*>Confirm in wallet/)
})
test('agent review explicitly confirms one reviewed Testnet action without claiming another wallet signature',()=>{
 const html=renderToStaticMarkup(<HyperliquidActionReview review={{packet,signingMode:'agent',confirm:async()=>{},cancel:()=>{}}}/> )
 assert.match(html,/Confirm Testnet action/);assert.match(html,/approved API wallet/);assert.doesNotMatch(html,/Confirm in wallet|One wallet signature/)
})
