import {test} from 'node:test'
import assert from 'node:assert/strict'
import {terminalAgentReady,terminalWritesReady} from './useHyperliquidAccount'
import type {HlTerminalAgentStatus} from '../../shared/hyperliquidTerminalAgent'
import type {HlTerminalStatus} from '../../shared/hyperliquidTerminal'
import {manualPendingStorageKey,readTerminalPending,type PendingStorage} from '../hyperliquid/terminalPending'
const now=Date.now(),account='0x'+'1'.repeat(40)
const agent:HlTerminalAgentStatus={network:'testnet',account,id:'agent',phase:'ACTIVE',agentAddress:'0x'+'2'.repeat(40),agentName:`AntyTILT-Trade valid_until ${now+10000}`,expiresAt:now+10000,checkedAt:now,reason:'Verified'}
test('active fresh agent permits only matching Testnet owner; stale/expired/changed account fail',()=>{assert.equal(terminalAgentReady(agent,'testnet',account,now),true);for(const a of[{...agent,phase:'PREPARED'},{...agent,checkedAt:now-30001},{...agent,expiresAt:now-1},{...agent,account:'0x'+'3'.repeat(40)}])assert.equal(terminalAgentReady(a as HlTerminalAgentStatus,'testnet',account,now),false);assert.equal(terminalAgentReady(agent,'mainnet',account,now),false)})
test('legacy pending survives reload and network selection and blocks writes even with an active agent',()=>{const values=new Map<string,string>();const storage:PendingStorage={getItem:k=>values.get(k)??null,setItem:(k,v)=>{values.set(k,v)},removeItem:k=>{values.delete(k)}};storage.setItem(manualPendingStorageKey(account,'testnet'),JSON.stringify({cloid:'0x'+'a'.repeat(32),message:'unknown'}));const status={network:'testnet',writesEnabled:true,snapshot:{network:'testnet',account,coin:'BTC',masterRole:'user',mode:'disabled',checkedAt:now}} as HlTerminalStatus;assert.equal(terminalWritesReady(status,now,readTerminalPending(storage,'testnet',account),true),false);assert.equal(readTerminalPending(storage,'mainnet',account),null);assert.equal(terminalWritesReady(status,now,readTerminalPending(storage,'testnet',account),true),false);assert.equal(values.size,1)})
test('late recovery HTTP success after selection change cannot retire legacy bytes',async()=>{
 const hook=await import('./useHyperliquidAccount');assert.equal(typeof hook.confirmLegacyRecoveryRequest,'function')
 const master='0x00000000000000000000000000000000000a11ce',cloid='0x0123456789abcdef0123456789abcdef',key=manualPendingStorageKey(master,'testnet'),raw=JSON.stringify({cloid,message:'Unknown',unknown:true}),values=new Map([[key,raw]]),storage:PendingStorage={getItem:k=>values.get(k)??null,setItem:(k,v)=>{values.set(k,v)},removeItem:k=>{values.delete(k)}}
 let selected=true
 const review={network:'testnet',account:master,cloid,storageKey:key,raw,rawHash:'x',outcome:'UNKNOWN',expiresAfter:Date.now()+300000} as import('../../shared/hyperliquidLegacyRecovery').HlLegacyRecoveryReview
 await assert.rejects(hook.confirmLegacyRecoveryRequest(storage,review,{uncertainty:true,stoppedPrompts:true},async()=>{selected=false;return {}},()=>selected),/selection/)
 assert.equal(values.get(key),raw);assert.equal(values.size,1)
})
