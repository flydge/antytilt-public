/// <reference types="node" />
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeTerminalPending, withTerminalReceipt, readTerminalPending, persistTerminalPending, clearTerminalPending, pendingCanResolve, manualPendingStorageKey } from './terminalPending'
import type { HlTerminalPacket, HlTerminalReconcile } from '../../shared/hyperliquidTerminal'
const account = `0x${'1'.repeat(40)}`
const packet = (type: 'settings' | 'order' = 'order'): HlTerminalPacket => ({ id: 'p1', seal: 'seal', network: 'testnet', account, coin: 'BTC', kind: type, asset: 0, szDecimals: 5, mode: 'unifiedAccount', positionBefore: '0', settingBefore: { leverage: 5, marginType: 'cross' }, ordersBefore: [], checkedAt: 1000, createdAt: 1000, expiresAfter: 61000, summary: { quantity: '.001', notionalUsd: '100', marginUsdc: '10', referencePrice: '100000', leverage: 10, marginType: 'cross' }, action: type === 'settings' ? { type: 'updateLeverage', asset: 0, isCross: true, leverage: 10 } : { type: 'order', grouping: 'na', orders: [{ a: 0, b: true, p: '100000', s: '.001', r: false, c: `0x${'2'.repeat(32)}`, t: { limit: { tif: 'Ioc' } } }] } })
const storage = () => { const values = new Map<string,string>(); return { getItem: (key:string) => values.get(key) ?? null, setItem: (key:string,v:string) => { values.set(key,v) }, removeItem: (key:string) => { values.delete(key) } } }
test('old unresolved manual cloid blocks new terminal action instead of being overwritten', () => {
 const s = storage(); s.setItem(manualPendingStorageKey(account, 'testnet'), JSON.stringify({ cloid: `0x${'3'.repeat(32)}`, unknown: true, message: 'Unknown' }))
 assert.equal(readTerminalPending(s, 'testnet', account)?.legacy, true)
 assert.throws(() => persistTerminalPending(s, makeTerminalPending(packet())), /reconciliation/)
})
test('public pending persists before signing and remains scoped to account/network', () => {
 const s = storage(); const pending = makeTerminalPending(packet()); persistTerminalPending(s, pending)
 assert.equal(readTerminalPending(s, 'testnet', account)?.packetId, 'p1'); assert.equal(readTerminalPending(s, 'mainnet', account), null)
 assert.throws(() => persistTerminalPending(s, { ...pending, packetId: 'p2' }), /reconciliation/)
 clearTerminalPending(s, pending); assert.equal(readTerminalPending(s, 'testnet', account), null)
})
test('unknownOid or missing attribution does not resolve an ambiguous native order', () => {
 const p = makeTerminalPending(packet()); const r = { network: 'testnet', snapshot: { account, network: 'testnet', checkedAt:Date.now() }, orders: [{ id: p.ids[0], status: 'unknownOid' }] } as HlTerminalReconcile
 assert.equal(pendingCanResolve(p,r), false); r.orders = []; assert.equal(pendingCanResolve(p,r), false)
 r.orders = [{ id: p.ids[0], status: 'open' }]; assert.equal(pendingCanResolve(p,r), true)
})
test('settings reconcile after server restart from actual native leverage/margin snapshot', () => {
 const p = makeTerminalPending(packet('settings')); const r = { network: 'testnet', snapshot: { account, network: 'testnet', checkedAt:Date.now(), leverage: 10, marginType: 'cross' }, orders: [] } as unknown as HlTerminalReconcile
 assert.equal(pendingCanResolve(p,r), true); r.snapshot.marginType = 'isolated'; assert.equal(pendingCanResolve(p,r), false)
 r.snapshot.marginType = 'cross'; r.snapshot.account = `0x${'4'.repeat(40)}`; assert.equal(pendingCanResolve(p,r), false)
})
test('corrupt durable pending fails closed rather than silently permitting another signature', () => {
 const s = storage(); s.setItem(manualPendingStorageKey(account,'testnet'), '{broken')
 assert.equal(readTerminalPending(s,'testnet',account)?.invalid, true)
 assert.throws(() => persistTerminalPending(s,makeTerminalPending(packet())), /reconciliation/)
})
test('old order ID open does not prove an ambiguous amendment applied', () => {
 const q = packet(); q.kind = 'amend'; const order = q.action.type === 'order' ? q.action.orders[0] : null
 q.action = { type: 'batchModify', modifies: [{ oid: 42, order: order! }] }
 const p = makeTerminalPending(q), r = { network: 'testnet', snapshot: { account, network:'testnet', checkedAt:Date.now() }, orders: [{ id:'42', status:'open' }] } as HlTerminalReconcile
 assert.equal(pendingCanResolve(p,r),false)
 r.orders.push({id: order!.c,status:'open'}); assert.equal(pendingCanResolve(p,r),true)
})
test('cancel unknown keeps its lock while target still open', () => {
 const q = packet(); q.kind='cancel'; q.action={type:'cancel',cancels:[{a:0,o:42}]}
 const p=makeTerminalPending(q), r={network:'testnet',snapshot:{account,network:'testnet',checkedAt:Date.now()},orders:[{id:'42',status:'open'}]} as HlTerminalReconcile
 assert.equal(pendingCanResolve(p,r),false); r.orders[0].status='canceled'; assert.equal(pendingCanResolve(p,r),true)
})

test('verified rejected SL receipt permits recovery after fresh native read, unknown SL remains locked', () => {
 const q=packet(); if(q.action.type!=='order')throw Error('fixture')
 q.action.orders.push({...q.action.orders[0],b:false,r:true,c:`0x${'5'.repeat(32)}`,t:{trigger:{isMarket:true,triggerPx:'99000',tpsl:'sl'}}})
 const p=makeTerminalPending(q), response={kind:'PARTIAL' as const,protection:'REJECTED' as const,orders:[{index:0,role:'parent' as const,cloid:p.ids[0],kind:'FILLED' as const},{index:1,role:'sl' as const,cloid:p.ids[1],kind:'REJECTED' as const,reason:'native SL rejected'}]}
 const r={network:'testnet',snapshot:{account,network:'testnet',checkedAt:Date.now()},orders:[{id:p.ids[0],status:'filled'},{id:p.ids[1],status:'unknownOid'}]} as HlTerminalReconcile
 assert.equal(pendingCanResolve(withTerminalReceipt(p,response),r),true)
 assert.equal(pendingCanResolve(withTerminalReceipt(p,{...response,kind:'UNKNOWN',protection:'UNKNOWN',orders:[response.orders[0],{...response.orders[1],kind:'UNKNOWN'}]}),r),false)
})
test('freshness is required even when every native receipt is already known', () => {
 const p=withTerminalReceipt(makeTerminalPending(packet()),{kind:'CONFIRMED',protection:'NONE',orders:[{index:0,role:'parent',cloid:`0x${'2'.repeat(32)}`,kind:'FILLED'}]})
 const r={network:'testnet',snapshot:{account,network:'testnet',checkedAt:Date.now()-30001},orders:[]} as unknown as HlTerminalReconcile
 assert.equal(pendingCanResolve(p,r),false);r.snapshot.checkedAt=Date.now();assert.equal(pendingCanResolve(p,r),true)
})
test('writes readiness rejects stale/missing/mainnet/unknown account and durable pending', async()=>{
 const {terminalWritesReady}=await import('../hooks/useHyperliquidAccount')
 const now=Date.now(),data={network:'testnet',writesEnabled:true,snapshot:{network:'testnet',account,coin:'BTC',masterRole:'user',mode:'unifiedAccount',checkedAt:now}} as import('../../shared/hyperliquidTerminal').HlTerminalStatus
 assert.equal(terminalWritesReady(data,now,null,true),true)
 assert.equal(terminalWritesReady(data,now+30001,null,true),false)
 assert.equal(terminalWritesReady(data,now,makeTerminalPending(packet()),true),false)
 assert.equal(terminalWritesReady(data,now,null,false),false)
 assert.equal(terminalWritesReady({...data,network:'mainnet'},now,null,true),false)
 assert.equal(terminalWritesReady({...data,snapshot:null},now,null,true),false)
 data.snapshot!.mode='default';assert.equal(terminalWritesReady(data,now,null,true),false)
})
