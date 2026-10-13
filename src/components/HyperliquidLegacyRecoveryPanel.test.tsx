import React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import type { HlLegacyRecoveryReview } from "../../shared/hyperliquidLegacyRecovery";
const mod = (await import("./HyperliquidLegacyRecoveryPanel").catch(
  () => ({}),
)) as typeof import("./HyperliquidLegacyRecoveryPanel");
const account = "0x00000000000000000000000000000000000a11ce",
  cloid = "0x0123456789abcdef0123456789abcdef";
const props = {
  pending: {
    version: 1 as const,
    network: "testnet" as const,
    account,
    action: null,
    ids: [cloid],
    createdAt: 0,
    message: "Unknown",
    legacy: true,
  },
  review: null,
  receipt: null,
  busy: false,
  message: "",
  onReview: async () => {},
  onArchive: async () => {},
};
test("only exact legacy target shows explicit UNKNOWN retirement with a separate acknowledgment decision", () => {
  assert.equal(typeof mod.HyperliquidLegacyRecoveryPanel, "function");
  const html = renderToStaticMarkup(
    <mod.HyperliquidLegacyRecoveryPanel {...props} />,
  );
  assert.ok(html.includes(cloid));
  assert.match(html, /UNKNOWN/);
  assert.match(html, /Review Old Testnet Request/);
  assert.match(html, /signed old action may still/);
  assert.equal(
    renderToStaticMarkup(
      <mod.HyperliquidLegacyRecoveryPanel
        {...props}
        pending={{ ...props.pending, network: "mainnet" }}
      />,
    ),
    "",
  );
});
test("sealed review shows missing evidence, observation, five-minute deadline and two labeled acknowledgments before Archive", () => {
  assert.equal(typeof mod.HyperliquidLegacyRecoveryPanel, "function");
  const now = Date.now(),
    review = {
      id: "review",
      network: "testnet",
      account,
      cloid,
      storageKey: `antytilt:hl:manual-pending:testnet:${account}`,
      raw: JSON.stringify({ cloid, message: "Unknown", unknown: true }),
      rawHash: "1".repeat(64),
      seal: "2".repeat(64),
      outcome: "UNKNOWN",
      missingFields: ["action", "nonce", "createdAt", "expiresAfter"],
      createdAt: now,
      expiresAfter: now + 300000,
      observation: {
        network: "testnet",
        account,
        checkedAt: now,
        orderStatus: "unknownOid",
        nonzeroPositions: 0,
        openOrders: 0,
        fillCount: 0,
        historicalOrderCount: 0,
        matchingFills: 0,
        matchingOrders: 0,
        historyCompleteness: false,
      },
    } as HlLegacyRecoveryReview;
  const html = renderToStaticMarkup(
    <mod.HyperliquidLegacyRecoveryPanel {...props} review={review} />,
  );
  assert.match(html, /300s/);
  assert.equal((html.match(/type="checkbox"/g) || []).length, 2);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Archive Old Request/);
  assert.match(html, /wallet prompts and old operations/);
});
test('exact canonical target renders collapsed public diagnostics without legacy Review or Archive controls',()=>{
 const pending={...props.pending,legacy:false,packetId:'7c86ce01-ab21-4c7f-8af2-78a7e9fb8929',createdAt:1234,expiresAfter:5678,action:{type:'order' as const,grouping:'na' as const,orders:[{a:3,b:true,p:'80000',s:'0.001',r:false,c:cloid as `0x${string}`,t:{limit:{tif:'Ioc' as const}},providerSecret:'do-not-render-action-secret'}]},walletSecret:'do-not-render-pending-secret'}
 const html=renderToStaticMarkup(<mod.HyperliquidLegacyRecoveryPanel {...props} pending={pending}/>)
 assert.match(html,/Saved Pending Request/);assert.match(html,/not eligible for the legacy archive/);assert.match(html,/<details>/);assert.doesNotMatch(html,/<details[^>]*open/)
 for(const text of['7c86ce01-ab21-4c7f-8af2-78a7e9fb8929','1234','5678','version','legacy','invalid','network','account','packetId','ids','createdAt','expiresAfter','action','80000'])assert.ok(html.includes(text),text)
 assert.doesNotMatch(html,/Review Old Testnet Request|Archive Old Request|type="checkbox"/);assert.doesNotMatch(html,/do-not-render|providerSecret|walletSecret/)
})
test('diagnostics recognize mixed-case target account while hiding Mainnet and unrelated requests',()=>{
 const canonical={...props.pending,legacy:false,packetId:'canonical',account:account.toUpperCase()}
 assert.match(renderToStaticMarkup(<mod.HyperliquidLegacyRecoveryPanel {...props} pending={canonical}/>),/Saved Pending Request/)
 for(const pending of[{...canonical,network:'mainnet' as const},{...canonical,account:'0x'+'1'.repeat(40)},{...canonical,ids:['0x'+'a'.repeat(32)]}])assert.equal(renderToStaticMarkup(<mod.HyperliquidLegacyRecoveryPanel {...props} pending={pending}/>),'')
})
test('invalid target and terminal mirror cannot expose archive controls',()=>{
 for(const pending of[{...props.pending,invalid:true},{...props.pending,packetId:'terminal-mirror'}]){
 const html=renderToStaticMarkup(<mod.HyperliquidLegacyRecoveryPanel {...props} pending={pending}/>);assert.match(html,/Saved Pending Request/);assert.doesNotMatch(html,/Review Old Testnet Request|Archive Old Request|type="checkbox"/)
 }
})
test('reader-accepted malformed top-level metadata cannot expose nested stored fields through diagnostics',async()=>{
 const {readTerminalPending}=await import('../hyperliquid/terminalPending')
 const stored={...props.pending,legacy:{nestedLegacySecret:'CANARY-LEGACY'},packetId:{nestedPacketSecret:'CANARY-PACKET'},createdAt:{nestedCreatedSecret:'CANARY-CREATED'},expiresAfter:{nestedExpirySecret:'CANARY-EXPIRY'},action:{type:'cancel',cancels:[{a:3,o:123}]}}
 const storage={getItem:(key:string)=>key.includes(':terminal-pending:')?JSON.stringify(stored):null,setItem:()=>{},removeItem:()=>{}}
 const pending=readTerminalPending(storage,'testnet',account);assert.ok(pending);assert.equal(pending.invalid,undefined)
 const html=renderToStaticMarkup(<mod.HyperliquidLegacyRecoveryPanel {...props} pending={pending}/>);assert.match(html,/Saved Pending Request/);assert.doesNotMatch(html,/CANARY|nestedLegacySecret|nestedPacketSecret|nestedCreatedSecret|nestedExpirySecret/);assert.doesNotMatch(html,/Review Old Testnet Request|Archive Old Request/);for(const field of["legacy","packetId","createdAt","expiresAfter"])assert.ok(html.includes(`&quot;${field}&quot;: null`),field)
})
test('reader-accepted malformed scalar action and packet metadata are hidden while valid native price/size remain visible',async()=>{
 const {readTerminalPending}=await import('../hyperliquid/terminalPending')
 const stored={...props.pending,legacy:false,packetId:'SYNTHETIC-SENSITIVE-NOT-A-UUID',createdAt:-1,expiresAfter:1.5,action:{type:'order',grouping:'SYNTHETIC-SENSITIVE-NOT-A-GROUPING',orders:[{a:100001,b:1,p:'SYNTHETIC-SENSITIVE-NOT-A-PRICE',s:'SYNTHETIC-SENSITIVE-NOT-A-SIZE',r:'false',c:'SYNTHETIC-SENSITIVE-NOT-A-CLOID',t:{limit:{tif:'SYNTHETIC-SENSITIVE-NOT-A-TIF'}}},{a:3,b:true,p:'82923',s:'0.00944',r:false,c:cloid,t:{limit:{tif:'Ioc'}}},{a:3,b:false,p:'82923',s:'0.00944',r:true,c:cloid,t:{trigger:{isMarket:true,triggerPx:'SYNTHETIC-SENSITIVE-NOT-A-TRIGGER',tpsl:'SYNTHETIC-SENSITIVE-NOT-A-TPSL'}}}]}}
 const storage={getItem:(key:string)=>key.includes(':terminal-pending:')?JSON.stringify(stored):null,setItem:()=>{},removeItem:()=>{}}
 const pending=readTerminalPending(storage,'testnet',account);assert.ok(pending);assert.equal(pending.invalid,undefined)
 const html=renderToStaticMarkup(<mod.HyperliquidLegacyRecoveryPanel {...props} pending={pending}/>);assert.doesNotMatch(html,/SYNTHETIC-SENSITIVE/);assert.match(html,/82923/);assert.match(html,/0\.00944/);assert.doesNotMatch(html,/Review Old Testnet Request|Archive Old Request/);for(const field of['packetId','createdAt','expiresAfter','grouping','a','b','p','s','r','c','tif','triggerPx','tpsl'])assert.ok(html.includes(`&quot;${field}&quot;: null`),field)
})
test('reader-accepted oversized action arrays project at most eight native orders',async()=>{const {readTerminalPending}=await import('../hyperliquid/terminalPending');const stored={...props.pending,legacy:false,packetId:'7c86ce01-ab21-4c7f-8af2-78a7e9fb8929',action:{type:'order',grouping:'na',orders:Array.from({length:12},()=>({a:3,b:true,p:'82923',s:'0.00944',r:false,c:cloid,t:{limit:{tif:'Ioc'}}}))}};const storage={getItem:(key:string)=>key.includes(':terminal-pending:')?JSON.stringify(stored):null,setItem:()=>{},removeItem:()=>{}};const pending=readTerminalPending(storage,'testnet',account);assert.ok(pending);assert.equal(pending.invalid,undefined);const html=renderToStaticMarkup(<mod.HyperliquidLegacyRecoveryPanel {...props} pending={pending}/>);assert.equal((html.match(/82923/g)||[]).length,8);assert.equal((html.match(/0\.00944/g)||[]).length,8)})
test('only the approved canonical packet offers Review and plainly identifies the saved old 782.79 USD IOC request', async () => {
  const shared = await import('../../shared/hyperliquidLegacyRecovery'),
    pending = {
      ...props.pending,
      legacy: false,
      packetId: shared.HL_CANONICAL_RECOVERY_PACKET,
      action: JSON.parse(JSON.stringify(shared.HL_CANONICAL_RECOVERY_ACTION)),
      createdAt: shared.HL_CANONICAL_RECOVERY_CREATED_AT,
      expiresAfter: shared.HL_CANONICAL_RECOVERY_EXPIRES_AFTER,
    } as import('../hyperliquid/terminalPending').TerminalPending
  const html = renderToStaticMarkup(
    <mod.HyperliquidLegacyRecoveryPanel {...props} pending={pending} />,
  )
  assert.match(html, /Review Old Testnet Request/)
  assert.match(html, /Saved old request: BUY 0\.00944 BTC/)
  assert.doesNotMatch(html, /Archived old request|Archive saved|Archived UNKNOWN receipt/)
  assert.match(html, /BUY 0\.00944 BTC/)
  assert.match(html, /782\.79/)
  assert.match(html, /unverified saved metadata/)
  assert.match(html, /signing nonce/)
  for (const extra of [
    { packetId: 'other' },
    { invalid: true },
    { knownIds: [cloid] },
    { createdAt: pending.createdAt + 1 },
    { action: { ...pending.action!, secret: 'canary' } },
  ]) {
    const text = renderToStaticMarkup(
      <mod.HyperliquidLegacyRecoveryPanel
        {...props}
        pending={{ ...pending, ...extra } as typeof pending}
      />,
    )
    assert.doesNotMatch(text, /Review Old Testnet Request|Archive Old Request/)
    assert.doesNotMatch(text, /canary/)
  }
})
test('canonical review projects public action/times and hashes without echoing saved message bytes',async()=>{
 const shared=await import('../../shared/hyperliquidLegacyRecovery'),now=Date.now(),pending={...props.pending,legacy:false,packetId:shared.HL_CANONICAL_RECOVERY_PACKET,action:JSON.parse(JSON.stringify(shared.HL_CANONICAL_RECOVERY_ACTION)),createdAt:shared.HL_CANONICAL_RECOVERY_CREATED_AT,expiresAfter:shared.HL_CANONICAL_RECOVERY_EXPIRES_AFTER,message:'CANARY-SAVED-MESSAGE'},review={id:'review',network:'testnet',account,cloid,format:'CANONICAL_CLIENT_ONLY',packetId:pending.packetId,storageKey:`antytilt:hl:terminal-pending:testnet:${account}`,raw:JSON.stringify(pending),rawHash:'1'.repeat(64),mirrorRaw:JSON.stringify({cloid,message:'CANARY-MIRROR-MESSAGE',unknown:true,terminalPacketId:pending.packetId}),mirrorHash:'2'.repeat(64),evidenceHash:'3'.repeat(64),missingFields:['nonce'],outcome:'UNKNOWN',createdAt:now,expiresAfter:now+300000,seal:'4'.repeat(64),observation:{network:'testnet',account,checkedAt:now,orderStatus:'unknownOid',nonzeroPositions:0,openOrders:0,fillCount:0,historicalOrderCount:0,matchingFills:0,matchingOrders:0,historyCompleteness:false}} as HlLegacyRecoveryReview
 const html=renderToStaticMarkup(<mod.HyperliquidLegacyRecoveryPanel {...props} pending={pending} review={review}/>);assert.match(html,/Archive Old Request/);assert.match(html,/savedAction/);assert.match(html,/mirrorHash/);assert.match(html,/evidenceHash/);assert.doesNotMatch(html,/CANARY/)
})
