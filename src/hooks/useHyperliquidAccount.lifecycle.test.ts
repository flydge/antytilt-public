import React from 'react'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {useHyperliquidAccount} from './useHyperliquidAccount'
import type {HlTerminalNetwork,HlTerminalPacket,HlTerminalSnapshot} from '../../shared/hyperliquidTerminal'
import {manualPendingStorageKey,readTerminalPending,terminalPendingStorageKey} from '../hyperliquid/terminalPending'
import type {HlTerminalAgentApproval,HlTerminalAgentStatus} from '../../shared/hyperliquidTerminalAgent'
const account=('0x'+'1'.repeat(40)) as `0x${string}`,agentAddress=('0x'+'2'.repeat(40)) as `0x${string}`
const json=(v:unknown)=>new Response(JSON.stringify(v),{headers:{'Content-Type':'application/json'}})
const tick=async()=>{for(let i=0;i<5;i++)await new Promise<void>(r=>setImmediate(r))}
function snapshot(network:HlTerminalNetwork='testnet'):HlTerminalSnapshot{const summary={accountValue:'1000',totalNtlPos:'0',totalRawUsd:'1000',totalMarginUsed:'0'};return{network,account,coin:'BTC',asset:3,szDecimals:5,maxLeverage:40,mode:'unifiedAccount',masterRole:'user',checkedAt:Date.now(),markPx:'80000',bid:'79999',ask:'80001',leverage:10,marginType:'cross',position:'0',makerFeeRate:0.00015,takerFeeRate:0.00045,activeAssetData:{user:account,coin:'BTC',leverage:{type:'cross',value:10},maxTradeSzs:['1','1'],availableToTrade:['1000','1000'],markPx:'80000'},clearinghouseState:{marginSummary:summary,crossMarginSummary:summary,crossMaintenanceMarginUsed:'0',withdrawable:'1000',time:Date.now(),assetPositions:[]},spotClearinghouseState:{balances:[{coin:'USDC',token:0,total:'1000',hold:'0',entryNtl:'0'}]},openOrders:[]}}
const agentStatus=():HlTerminalAgentStatus=>({network:'testnet',account,id:'agent-one',phase:'ACTIVE',agentAddress,agentName:`AntyTILT-Trade valid_until ${Date.now()+1800000}`,expiresAt:Date.now()+1800000,checkedAt:Date.now(),reason:'Verified'})
function packet():HlTerminalPacket{const now=Date.now();return{id:'settings-1',seal:'test-seal',network:'testnet',account,coin:'BTC',kind:'settings',asset:3,szDecimals:5,mode:'unifiedAccount',positionBefore:'0',settingBefore:{leverage:10,marginType:'cross'},ordersBefore:[],checkedAt:now,createdAt:now,expiresAfter:now+60000,action:{type:'updateLeverage',asset:3,isCross:true,leverage:5},summary:{quantity:null,notionalUsd:null,marginUsdc:null,referencePrice:'80000',leverage:5,marginType:'cross'}}}
/** Minimal dispatcher drives the actual hook/effects without a browser or wallet connection. */
function harness(storage:Storage,fetcher:typeof fetch){
 const saved={fetch:globalThis.fetch,window:globalThis.window,storage:globalThis.localStorage};let walletCalls=0
 globalThis.fetch=fetcher;globalThis.localStorage=storage;globalThis.window={setTimeout,clearTimeout,setInterval:()=>1,clearInterval:()=>{},ethereum:{isPhantom:true,request:async()=>{walletCalls++;throw Error('Wallet RPC forbidden in lifecycle test')}}} as unknown as Window&typeof globalThis
 const internals=(React as unknown as {__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE:{H:unknown}}).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
 const cells:unknown[]=[],effects:Array<{deps:unknown[];cleanup?:()=>void}>=[];let index=0,network:HlTerminalNetwork='testnet',effectWork:Array<()=>void>=[]
 let current:ReturnType<typeof useHyperliquidAccount>
 const dispatcher={useState(init:unknown){const at=index++;if(!(at in cells))cells[at]=typeof init==='function'?(init as ()=>unknown)():init;return[cells[at],(v:unknown)=>{cells[at]=typeof v==='function'?(v as (old:unknown)=>unknown)(cells[at]):v}]},useRef(init:unknown){const at=index++;if(!(at in cells))cells[at]={current:init};return cells[at]},useEffect(fn:()=>void|(()=>void),deps:unknown[]){const at=index++;if(!effects[at]||deps.some((d,i)=>d!==effects[at].deps[i])){const old=effects[at];effects[at]={deps};effectWork.push(()=>{old?.cleanup?.();const cleanup=fn();if(cleanup)effects[at].cleanup=cleanup})}}}
 const render=(next=network)=>{network=next;index=0;const old=internals.H;internals.H=dispatcher;try{current=useHyperliquidAccount(true,network)}finally{internals.H=old}const work=effectWork;effectWork=[];work.forEach(fn=>fn());return current}
 render()
 return{render,walletCalls:()=>walletCalls,dispose:()=>{effects.forEach(e=>e?.cleanup?.());globalThis.fetch=saved.fetch;globalThis.window=saved.window;globalThis.localStorage=saved.storage}}
}
function storage(){const m=new Map<string,string>();return{getItem:(k:string)=>m.get(k)??null,setItem:(k:string,v:string)=>{m.set(k,v)},removeItem:(k:string)=>{m.delete(k)},clear:()=>m.clear(),key:(i:number)=>[...m.keys()][i]??null,get length(){return m.size}} as Storage}
function api(extra:(path:string,body:Record<string,unknown>)=>Response|Promise<Response>|null):typeof fetch{return async(url,init)=>{const path=String(url),network=path.includes('network=mainnet')?'mainnet':'testnet',body=init?.body?JSON.parse(String(init.body)):{};const custom=await extra(path,body);if(custom)return custom;if(path.includes('/agent/status'))return json(agentStatus());if(path.includes('/status'))return json({network,writesEnabled:network==='testnet',snapshot:snapshot(network)});if(path.includes('/history'))return json({network,account,checkedAt:Date.now(),fills:[],orders:[]});if(path.includes('/reconcile'))return json({network,snapshot:snapshot(network),orders:[]});throw Error('Unexpected '+path)}}
test('actual hook persists pending before agent HTTP, never prompts Phantom, and blocks unresolved actions after reload/network change',async()=>{
 const store=storage();let sends=0
 const fetcher=api((path,body)=>{if(path.includes('/preview'))return json(packet());if(path.includes('/agent/execute')){sends++;assert.equal(readTerminalPending(store,'testnet',account)?.packetId,(body.packet as HlTerminalPacket).id);assert.ok(store.getItem(manualPendingStorageKey(account,'testnet')));return json({network:'testnet',packetId:'settings-1',state:'UNKNOWN',result:null,reason:'Unknown result'})}return null})
 let h=harness(store,fetcher)
 try{await tick();let hook=h.render();assert.equal(hook.writesEnabled,true);const outcome=hook.changeLeverage({direction:'LONG',leverage:5}).catch(e=>e);await tick();hook=h.render();assert.equal(hook.review?.signingMode,'agent');await hook.review!.confirm();assert.match(String(await outcome),/Unknown result/);hook=h.render();assert.equal(hook.writesEnabled,false);assert.equal(sends,1);assert.equal(h.walletCalls(),0);h.render('mainnet');await tick();assert.ok(store.getItem(terminalPendingStorageKey(account,'testnet')));h.dispose();h=harness(store,fetcher);await tick();hook=h.render();assert.equal(hook.writesEnabled,false);assert.ok(hook.pending);assert.equal(sends,1);assert.equal(h.walletCalls(),0)}finally{h.dispose()}
})
test('known pre-send agent rejection clears only its matching browser packet',async()=>{const store=storage();let sends=0;const h=harness(store,api(path=>{if(path.includes('/preview'))return json(packet());if(path.includes('/agent/execute')){sends++;return json({network:'testnet',packetId:'settings-1',state:'REJECTED',result:null,reason:'Rejected before network submission'})}return null}));try{await tick();let hook=h.render();const outcome=hook.changeLeverage({direction:'LONG',leverage:5}).catch(e=>e);await tick();hook=h.render();await hook.review!.confirm();assert.match(String(await outcome),/Rejected before network/);assert.equal(readTerminalPending(store,'testnet',account),null);assert.equal(sends,1);assert.equal(h.walletCalls(),0)}finally{h.dispose()}})
test('reload recovers unknown approval through exact readonly confirm even after review expiry',async()=>{const store=storage(),now=Date.now(),p:HlTerminalAgentApproval={network:'testnet',account,id:'agent-one',agentAddress,agentName:`AntyTILT-Trade valid_until ${now+1000000}`,expiresAt:now+1000000,nonce:now-120000,reviewExpiresAt:now-60000,checkedAt:now-120000};store.setItem(`antytilt:hl:agent-approval-attempt:testnet:${account}:agent-one`,JSON.stringify({nonce:p.nonce,state:'unknown',approval:p}));let confirms=0;const h=harness(store,api((path,body)=>{if(path.includes('/agent/status'))return json({...agentStatus(),phase:'PREPARED'});if(path.includes('/agent/confirm')){confirms++;assert.deepEqual(body.approval,p);return json(agentStatus())}return null}));try{await tick();assert.equal(h.render().agentStatus?.phase,'ACTIVE');assert.equal(h.render().writesEnabled,true);assert.equal(confirms,1);assert.equal(h.walletCalls(),0);await assert.rejects(()=>h.render().prepareAgent(),/existing API wallet/);assert.equal(h.walletCalls(),0)}finally{h.dispose()}})
test('matching durable rejected execution reconciles a browser lock after reload without unknown-ID assumptions',async()=>{const store=storage();const {makeTerminalPending,persistTerminalPending}=await import('../hyperliquid/terminalPending');persistTerminalPending(store,makeTerminalPending(packet()));const h=harness(store,api(path=>path.includes('/reconcile')?json({network:'testnet',snapshot:snapshot(),orders:[],agentExecution:{network:'testnet',packetId:'settings-1',state:'REJECTED',result:null,reason:'Known before HTTP'}}):null));try{await tick();assert.equal(readTerminalPending(store,'testnet',account),null);assert.equal(h.render().writesEnabled,true);assert.equal(h.walletCalls(),0)}finally{h.dispose()}})
test('unknown approval marker blocks prepare even when native grant is not yet visible',async()=>{const store=storage(),now=Date.now(),p:HlTerminalAgentApproval={network:'testnet',account,id:'agent-one',agentAddress,agentName:`AntyTILT-Trade valid_until ${now+1800000}`,expiresAt:now+1800000,nonce:now,reviewExpiresAt:now+60000,checkedAt:now};store.setItem(`antytilt:hl:agent-approval-attempt:testnet:${account}:agent-one`,JSON.stringify({nonce:p.nonce,state:'unknown',approval:p}));let prepares=0;const h=harness(store,api(path=>{if(path.includes('/agent/status')||path.includes('/agent/confirm'))return json({...agentStatus(),phase:'PREPARED',reason:'Native grant not visible'});if(path.includes('/agent/prepare')){prepares++;return json(p)}return null}));try{await tick();await assert.rejects(()=>h.render().prepareAgent(),/outcome unresolved/);assert.equal(prepares,0);assert.equal(h.walletCalls(),0)}finally{h.dispose()}})
test('fresh matching agent status clears a prior transport error after API recovery',async()=>{const store=storage();let failed=true;const h=harness(store,api(path=>{if(path.includes('/agent/status'))return failed?new Response(JSON.stringify({error:'Hyperliquid request unavailable (404)'}),{status:404,headers:{'Content-Type':'application/json'}}):json({...agentStatus(),id:null,phase:'MISSING',agentAddress:null,agentName:null,expiresAt:null,reason:'Prepare a Testnet API wallet'});return null}));try{await tick();assert.match(h.render().agentMessage,/404/);failed=false;await h.render().refreshAgent();assert.equal(h.render().agentStatus?.phase,'MISSING');assert.equal(h.render().agentMessage,'');assert.equal(h.walletCalls(),0)}finally{h.dispose()}})
test('successful verification retains an unresolved native approval warning',async()=>{const store=storage(),now=Date.now(),p:HlTerminalAgentApproval={network:'testnet',account,id:'agent-one',agentAddress,agentName:`AntyTILT-Trade valid_until ${now+1800000}`,expiresAt:now+1800000,nonce:now,reviewExpiresAt:now+60000,checkedAt:now};store.setItem(`antytilt:hl:agent-approval-attempt:testnet:${account}:agent-one`,JSON.stringify({nonce:p.nonce,state:'unknown',approval:p}));const h=harness(store,api(path=>path.includes('/agent/status')||path.includes('/agent/confirm')?json({...agentStatus(),phase:'PREPARED',reason:'Native grant not visible'}):null));try{await tick();await h.render().refreshAgent();assert.match(h.render().agentMessage,/outcome unresolved/);assert.equal(h.walletCalls(),0)}finally{h.dispose()}})
test('exact verified ACTIVE resolves its attempt marker and permits fresh preparation after native expiry',async()=>{
 const store=storage(),originalNow=Date.now;let clock=originalNow(),phase:'ACTIVE'|'EXPIRED'='ACTIVE',prepares=0
 Date.now=()=>clock
 const p:HlTerminalAgentApproval={network:'testnet',account,id:'agent-one',agentAddress,agentName:`AntyTILT-Trade valid_until ${clock+1800000}`,expiresAt:clock+1800000,nonce:clock,reviewExpiresAt:clock+60000,checkedAt:clock},key=`antytilt:hl:agent-approval-attempt:testnet:${account}:agent-one`
 store.setItem(key,JSON.stringify({nonce:p.nonce,state:'attempted',approval:p}))
 const h=harness(store,api(path=>{if(path.includes('/agent/status'))return json({...p,phase,checkedAt:clock,reason:'Native verified'});if(path.includes('/agent/prepare')){prepares++;return json({...p,agentName:`AntyTILT-Trade valid_until ${clock+1800000}`,expiresAt:clock+1800000,nonce:clock,reviewExpiresAt:clock+60000,checkedAt:clock})}return null}))
 try{await tick();assert.equal(h.render().agentStatus?.phase,'ACTIVE');assert.equal(store.getItem(key),null);clock=p.expiresAt+1;phase='EXPIRED';await h.render().refreshAgent();await h.render().prepareAgent();assert.equal(prepares,1);assert.equal(h.render().agentApproval?.nonce,clock);assert.equal(h.walletCalls(),0)}finally{h.dispose();Date.now=originalNow}
})
test('exact verified ACTIVE followed by local disable allows prepare attempt while native revocation is not claimed',async()=>{
 const store=storage(),now=Date.now(),p:HlTerminalAgentApproval={network:'testnet',account,id:'agent-one',agentAddress,agentName:`AntyTILT-Trade valid_until ${now+1800000}`,expiresAt:now+1800000,nonce:now,reviewExpiresAt:now+60000,checkedAt:now},key=`antytilt:hl:agent-approval-attempt:testnet:${account}:agent-one`;store.setItem(key,JSON.stringify({nonce:p.nonce,state:'attempted',approval:p}));let disabled=false,prepares=0
 const h=harness(store,api(path=>{if(path.includes('/agent/status'))return json({...p,phase:disabled?'DISABLED':'ACTIVE',checkedAt:Date.now(),reason:'Native verified'});if(path.includes('/agent/disable')){disabled=true;return json({...p,phase:'DISABLED',checkedAt:Date.now(),reason:'Local key removed'})}if(path.includes('/agent/prepare')){prepares++;return new Response(JSON.stringify({error:'Native terminal agent name collision; never overwrite another grant'}),{status:409,headers:{'Content-Type':'application/json'}})}return null}))
 try{await tick();assert.equal(store.getItem(key),null);await h.render().disableAgent();assert.match(h.render().agentMessage,/was not revoked/);await assert.rejects(()=>h.render().prepareAgent(),/Native terminal agent name collision/);assert.equal(prepares,1);assert.equal(h.walletCalls(),0)}finally{h.dispose()}
})
test('ACTIVE status for a different approval identity does not clear an unresolved attempt marker',async()=>{const store=storage(),now=Date.now(),p:HlTerminalAgentApproval={network:'testnet',account,id:'agent-one',agentAddress,agentName:`AntyTILT-Trade valid_until ${now+1800000}`,expiresAt:now+1800000,nonce:now,reviewExpiresAt:now+60000,checkedAt:now},key=`antytilt:hl:agent-approval-attempt:testnet:${account}:agent-one`;store.setItem(key,JSON.stringify({nonce:p.nonce,state:'unknown',approval:p}));const h=harness(store,api(path=>path.includes('/agent/status')?json({...p,agentAddress:'0x'+'3'.repeat(40),phase:'ACTIVE',checkedAt:Date.now(),reason:'Different grant'}):null));try{await tick();assert.ok(store.getItem(key));assert.equal(h.walletCalls(),0)}finally{h.dispose()}})
test('known wallet pre-send failure survives native-absent confirm and fresh PREPARED status retains candidate/disable access',async()=>{
 const store=storage(),now=Date.now(),p:HlTerminalAgentApproval={network:'testnet',account,id:'reject-approval',agentAddress,agentName:`AntyTILT-Trade valid_until ${now+1800000}`,expiresAt:now+1800000,nonce:now,reviewExpiresAt:now+60000,checkedAt:now};let prepared=false
 const h=harness(store,api(path=>{if(path.includes('/agent/status'))return json(prepared?{...p,phase:'PREPARED',checkedAt:Date.now(),reason:'Native grant absent'}:{...agentStatus(),id:null,phase:'MISSING',agentAddress:null,agentName:null,expiresAt:null});if(path.includes('/agent/prepare')){prepared=true;return json(p)}if(path.includes('/agent/confirm'))return new Response(JSON.stringify({error:'Exact native grant is not verified; approval response is not evidence'}),{status:409,headers:{'Content-Type':'application/json'}});return null}))
 try{await tick();await h.render().prepareAgent();await assert.rejects(()=>h.render().approveAgent(),/Wallet RPC forbidden/);let hook=h.render();assert.equal(hook.agentStatus?.phase,'PREPARED');assert.equal(hook.agentStatus?.id,p.id);assert.equal(hook.agentStatus?.agentAddress,p.agentAddress);assert.match(hook.agentMessage,/Wallet RPC forbidden/);await hook.refreshAgent();hook=h.render();assert.equal(hook.agentStatus?.phase,'PREPARED');assert.match(hook.agentMessage,/Wallet RPC forbidden/)}finally{h.dispose()}
})
test('unknown approval plus absent-native confirm keeps fresh PREPARED public candidate and never retries owner approval',async()=>{const store=storage(),now=Date.now(),p:HlTerminalAgentApproval={network:'testnet',account,id:'agent-one',agentAddress,agentName:`AntyTILT-Trade valid_until ${now+1800000}`,expiresAt:now+1800000,nonce:now,reviewExpiresAt:now+60000,checkedAt:now};store.setItem(`antytilt:hl:agent-approval-attempt:testnet:${account}:agent-one`,JSON.stringify({nonce:p.nonce,state:'unknown',approval:p}));const h=harness(store,api(path=>{if(path.includes('/agent/status'))return json({...p,phase:'PREPARED',checkedAt:Date.now(),reason:'Native grant absent'});if(path.includes('/agent/confirm'))return new Response(JSON.stringify({error:'Exact native grant is not verified'}),{status:409,headers:{'Content-Type':'application/json'}});return null}));try{await tick();assert.equal(h.render().agentStatus?.id,p.id);assert.equal(h.render().agentStatus?.agentAddress,p.agentAddress);assert.match(h.render().agentMessage,/outcome unresolved/);await assert.rejects(()=>h.render().prepareAgent(),/outcome unresolved/);assert.equal(h.walletCalls(),0)}finally{h.dispose()}})
function mixedOrderPacket():HlTerminalPacket{const p=packet();return{...p,id:'mixed-order',kind:'order',action:{type:'order',grouping:'normalTpsl',orders:[{a:3,b:true,p:'80200',s:'0.01',r:false,c:('0x'+'a'.repeat(32)) as `0x${string}`,t:{limit:{tif:'Ioc'}}},{a:3,b:false,p:'75810',s:'0.01',r:true,c:('0x'+'b'.repeat(32)) as `0x${string}`,t:{trigger:{isMarket:true,triggerPx:'76000',tpsl:'sl'}}}]},summary:{quantity:'0.01',notionalUsd:'800',marginUsdc:'80',referencePrice:'80000',leverage:10,marginType:'cross'}}}
test('reload merges exact settled durable mixed receipts so rejected SL unknownOid does not keep a permanent browser lock',async()=>{const store=storage(),p=mixedOrderPacket(),{makeTerminalPending,persistTerminalPending}=await import('../hyperliquid/terminalPending');persistTerminalPending(store,makeTerminalPending(p));const parent='0x'+'a'.repeat(32),sl='0x'+'b'.repeat(32),result={kind:'PARTIAL',protection:'REJECTED',orders:[{index:0,role:'parent',cloid:parent,kind:'FILLED',oid:'11',filledSize:'0.01',averagePrice:'80000'},{index:1,role:'sl',cloid:sl,kind:'REJECTED',reason:'Invalid trigger'}]};const h=harness(store,api(path=>path.includes('/reconcile')?json({network:'testnet',snapshot:snapshot(),orders:[{id:parent,status:'filled',oid:'11'},{id:sl,status:'unknownOid'}],agentExecution:{network:'testnet',packetId:p.id,state:'PARTIAL',result}}):null));try{await tick();assert.equal(readTerminalPending(store,'testnet',account),null);assert.match(h.render().message,/protection.*REJECTED/);assert.equal(h.walletCalls(),0)}finally{h.dispose()}})
test('reload unknown durable execution cannot consume a claimed rejected SL receipt to clear uncertainty',async()=>{const store=storage(),p=mixedOrderPacket(),{makeTerminalPending,persistTerminalPending}=await import('../hyperliquid/terminalPending');persistTerminalPending(store,makeTerminalPending(p));const parent='0x'+'a'.repeat(32),sl='0x'+'b'.repeat(32),result={kind:'PARTIAL',protection:'REJECTED',orders:[{index:0,role:'parent',cloid:parent,kind:'FILLED',oid:'11'},{index:1,role:'sl',cloid:sl,kind:'REJECTED',reason:'Invalid trigger'}]};const h=harness(store,api(path=>path.includes('/reconcile')?json({network:'testnet',snapshot:snapshot(),orders:[{id:parent,status:'filled'},{id:sl,status:'unknownOid'}],agentExecution:{network:'testnet',packetId:p.id,state:'UNKNOWN',result}}):null));try{await tick();assert.ok(readTerminalPending(store,'testnet',account));assert.equal(h.render().writesEnabled,false);assert.equal(h.walletCalls(),0)}finally{h.dispose()}})
const legacyMaster='0x00000000000000000000000000000000000a11ce',legacyCloid='0x0123456789abcdef0123456789abcdef'
const legacyRaw=JSON.stringify({cloid:legacyCloid,message:'Unknown result; no retry',unknown:true})
async function legacyReviewFixture(){const now=Date.now(),rawHash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(legacyRaw))).toString('hex'),observation={network:'testnet' as const,account:legacyMaster,checkedAt:now,orderStatus:'unknownOid',nonzeroPositions:0,openOrders:0,fillCount:0,historicalOrderCount:0,matchingFills:0,matchingOrders:0,historyCompleteness:false as const};return{id:'legacy-review',network:'testnet' as const,account:legacyMaster,cloid:legacyCloid,storageKey:manualPendingStorageKey(legacyMaster,'testnet'),raw:legacyRaw,rawHash,outcome:'UNKNOWN' as const,missingFields:['action','nonce','createdAt','expiresAfter'] as const,observation,createdAt:now,expiresAfter:now+300000,seal:'a'.repeat(64)}}
function legacyApi(extra:(path:string,body:Record<string,unknown>)=>Response|Promise<Response>|null):typeof fetch{return api((path,body)=>{const custom=extra(path,body);if(custom)return custom;const network=path.includes('network=mainnet')?'mainnet':'testnet';const s={...snapshot(network),account:legacyMaster,activeAssetData:{...snapshot(network).activeAssetData,user:legacyMaster as `0x${string}`}};if(path.includes('/legacy-recovery/journal'))return json({network:'testnet',account:legacyMaster,receipts:[]});if(path.includes('/agent/status'))return json({...agentStatus(),account:legacyMaster});if(path.includes('/status'))return json({network,writesEnabled:network==='testnet',snapshot:s});if(path.includes('/reconcile'))return json({network,snapshot:s,orders:[{id:legacyCloid,status:'unknownOid'}]});if(path.includes('/history'))return json({network,account:legacyMaster,checkedAt:Date.now(),fills:[],orders:[]});return null})}
test('actual hook archives only approved legacy bytes after receipt and recovers visible durable UNKNOWN journal on reload',async()=>{
 const store=storage(),review=await legacyReviewFixture(),receipt={id:'legacy-receipt',network:'testnet' as const,account:legacyMaster,cloid:legacyCloid,storageKey:review.storageKey,raw:legacyRaw,rawHash:review.rawHash,outcome:'UNKNOWN' as const,review,observation:review.observation,acknowledgments:{uncertainty:true as const,stoppedPrompts:true as const},retiredAt:Date.now(),reason:'Explicit UNKNOWN retirement'};store.setItem(review.storageKey,legacyRaw);let archived=false
 const fetcher=legacyApi((path,body)=>{if(path.includes('/legacy-recovery/preview'))return json(review);if(path.includes('/legacy-recovery/confirm')){assert.equal(store.getItem(review.storageKey),legacyRaw);assert.deepEqual(body.acknowledgments,{uncertainty:true,stoppedPrompts:true});archived=true;return json(receipt)}if(path.includes('/legacy-recovery/journal'))return json({network:'testnet',account:legacyMaster,receipts:archived?[receipt]:[]});return null})
 let h=harness(store,fetcher)
 try{await tick();assert.equal(h.render().writesEnabled,false);await h.render().reviewLegacyRequest();assert.equal(h.render().legacyRecoveryReview?.id,review.id);await h.render().archiveLegacyRequest({uncertainty:true,stoppedPrompts:true});assert.equal(store.getItem(review.storageKey),null);assert.equal(h.render().legacyRecoveryReceipts[0]?.outcome,'UNKNOWN');assert.equal(h.walletCalls(),0);h.dispose();h=harness(store,fetcher);await tick();assert.equal(h.render().legacyRecoveryReceipts[0]?.id,receipt.id);assert.equal(h.walletCalls(),0)}finally{h.dispose()}
})
test('actual hook late archive receipt after network switch preserves old bytes and never touches a foreign pending',async()=>{
 const store=storage(),review=await legacyReviewFixture(),receipt={id:'receipt',network:'testnet',account:legacyMaster,cloid:legacyCloid,storageKey:review.storageKey,raw:legacyRaw,rawHash:review.rawHash,outcome:'UNKNOWN',review,observation:review.observation,acknowledgments:{uncertainty:true,stoppedPrompts:true},retiredAt:Date.now(),reason:'UNKNOWN retirement'};store.setItem(review.storageKey,legacyRaw);let finish!: (r:Response)=>void
 const h=harness(store,legacyApi(path=>path.includes('/legacy-recovery/preview')?json(review):path.includes('/legacy-recovery/confirm')?new Promise<Response>(r=>finish=r):null))
 try{await tick();await h.render().reviewLegacyRequest();const result=h.render().archiveLegacyRequest({uncertainty:true,stoppedPrompts:true}).catch(e=>e);await tick();assert.ok(finish);h.render('mainnet');store.setItem(manualPendingStorageKey(legacyMaster,'mainnet'),'foreign evidence');finish(json(receipt));await tick();assert.match(String(await result),/selection/);assert.equal(store.getItem(review.storageKey),legacyRaw);assert.equal(store.getItem(manualPendingStorageKey(legacyMaster,'mainnet')),'foreign evidence');assert.equal(h.walletCalls(),0)}finally{h.dispose()}
})
async function canonicalFixture() {
  const shared = await import('../../shared/hyperliquidLegacyRecovery'),
    p = {
      version: 1,
      network: 'testnet',
      account: legacyMaster,
      packetId: shared.HL_CANONICAL_RECOVERY_PACKET,
      action: shared.HL_CANONICAL_RECOVERY_ACTION,
      ids: [legacyCloid],
      createdAt: shared.HL_CANONICAL_RECOVERY_CREATED_AT,
      expiresAfter: shared.HL_CANONICAL_RECOVERY_EXPIRES_AFTER,
      message: 'Unknown',
      legacy: false,
    },
    raw = JSON.stringify(p),
    mirrorRaw = JSON.stringify({
      cloid: legacyCloid,
      message: 'Unknown',
      unknown: true,
      terminalPacketId: p.packetId,
    }),
    sha = async (v: string) =>
      Buffer.from(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)),
      ).toString('hex')
  const r = {
    ...(await legacyReviewFixture()),
    format: 'CANONICAL_CLIENT_ONLY' as const,
    packetId: p.packetId,
    storageKey: `antytilt:hl:terminal-pending:testnet:${legacyMaster}`,
    raw,
    rawHash: await sha(raw),
    mirrorStorageKey: manualPendingStorageKey(legacyMaster, 'testnet'),
    mirrorRaw,
    mirrorHash: await sha(mirrorRaw),
    missingFields: ['nonce'] as const,
    evidenceHash: '',
  }
  r.evidenceHash = await sha(shared.canonicalRecoveryIdentityText(r))
  const receipt = {
    ...r,
    id: 'canonical-receipt',
    review: r,
    observation: r.observation,
    acknowledgments: {
      uncertainty: true as const,
      stoppedPrompts: true as const,
    },
    retiredAt: Date.now(),
    reason: 'Exact client-only UNKNOWN retirement',
  }
  return { review: r, receipt }
}
test('actual hook captures canonical plus mirror and retires both only after immutable receipt, journal survives reload', async () => {
  const store = storage(),
    { review, receipt } = await canonicalFixture()
  store.setItem(review.storageKey, review.raw)
  store.setItem(review.mirrorStorageKey, review.mirrorRaw)
  let archived = false
  const fetcher = legacyApi((path, body) => {
    if (path.includes('/legacy-recovery/preview')) {
      assert.equal(body.raw, review.raw)
      assert.equal(body.mirrorRaw, review.mirrorRaw)
      return json(review)
    }
    if (path.includes('/legacy-recovery/confirm')) {
      archived = true
      return json(receipt)
    }
    if (path.includes('/legacy-recovery/journal'))
      return json({
        network: 'testnet',
        account: legacyMaster,
        receipts: archived ? [receipt] : [],
      })
    return null
  })
  let h = harness(store, fetcher)
  try {
    await tick()
    assert.equal(h.render().writesEnabled, false)
    // Read-only reconciliation legitimately rewrites messages before owner Review.
    review.raw = store.getItem(review.storageKey)!
    review.mirrorRaw = store.getItem(review.mirrorStorageKey)!
    const sha = async (v: string) =>
      Buffer.from(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)),
      ).toString('hex')
    review.rawHash = await sha(review.raw)
    review.mirrorHash = await sha(review.mirrorRaw)
    review.evidenceHash = await sha(
      (
        await import('../../shared/hyperliquidLegacyRecovery')
      ).canonicalRecoveryIdentityText(review),
    )
    Object.assign(receipt, review, { id: 'canonical-receipt', review })
    await h.render().reviewLegacyRequest()
    await h
      .render()
      .archiveLegacyRequest({ uncertainty: true, stoppedPrompts: true })
    assert.equal(readTerminalPending(store, 'testnet', legacyMaster), null)
    assert.equal(h.walletCalls(), 0)
    h.dispose()
    h = harness(store, fetcher)
    await tick()
    assert.equal(h.render().legacyRecoveryReceipts[0]?.id, receipt.id)
    assert.equal(h.walletCalls(), 0)
  } finally {
    h.dispose()
  }
})
test('actual hook in-doubt reload blocks writes and performs no automatic restore; explicit Review restores only missing originals', async () => {
  const store = storage(),
    { review, receipt } = await canonicalFixture(),
    p = await import('../hyperliquid/terminalPending')
  store.setItem(p.legacyArchiveStorageKey(receipt), JSON.stringify(receipt))
  store.setItem(
    p.canonicalRecoveryInDoubtStorageKey(legacyMaster, 'testnet'),
    JSON.stringify({
      version: 1,
      state: 'IN_DOUBT',
      network: 'testnet',
      account: legacyMaster,
      packetId: review.packetId,
      receipt,
    }),
  )
  store.setItem(review.mirrorStorageKey, review.mirrorRaw)
  const h = harness(
    store,
    legacyApi((path) =>
      path.includes('/legacy-recovery/preview') ? json(review) : null,
    ),
  )
  try {
    await tick()
    assert.equal(h.render().writesEnabled, false)
    assert.equal(store.getItem(review.storageKey), null)
    await h.render().reviewLegacyRequest()
    assert.equal(store.getItem(review.storageKey), review.raw)
    assert.ok(readTerminalPending(store, 'testnet', legacyMaster)?.invalid)
    assert.equal(
      h.render().legacyRecoveryReview?.format,
      'CANONICAL_CLIENT_ONLY',
    )
    assert.equal(h.walletCalls(), 0)
  } finally {
    h.dispose()
  }
})
