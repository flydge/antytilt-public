import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mapHyperliquidSnapshot, mapHyperliquidPreview, toHyperliquidOrderInput, accountResponseCurrent } from './terminalView'
import type { HlTerminalSnapshot, HlTerminalPacket } from '../../shared/hyperliquidTerminal'

test('native preview uses absolute loss amount and leaves unavailable liquidation unestimated',()=>{
 const input={symbol:'BTC-USD',direction:'LONG',orderKind:'LIMIT',amountMode:'COST',amount:100,leverage:10,marginType:'CROSSED',price:80000,stopLoss:{stopPrice:79000,execution:'MARKET',workingType:'MARK_PRICE'}} as const
 const p={id:'preview',expiresAfter:Date.now()+60000,summary:{quantity:'0.0125',notionalUsd:'1000',marginUsdc:'100',referencePrice:'80000',leverage:10,requestedAmount:'100'}} as HlTerminalPacket
 const view=mapHyperliquidPreview(p,input,mapHyperliquidSnapshot(snapshot).settings).preview
 assert.equal(view.stopLoss?.expectedPnl,12.5)
 assert.ok(Number.isNaN(view.indicativeLiquidationPrice))
})

test('maps provider BTC position and reduce-only stop without inventing a local fill', () => {
  const view=mapHyperliquidSnapshot(snapshot)
  assert.equal(view.settings.longLeverage,10)
  assert.equal(view.settings.symbol,'BTC-USD')
  assert.equal(view.snapshot.positions[0].positionAmt,'0.0121')
  assert.equal(view.snapshot.positions[0].positionSide,'LONG')
  assert.equal(view.snapshot.openOrders[0].stopPrice,'82000')
  assert.equal(view.snapshot.openOrders[0].type,'STOP_MARKET')
  assert.equal(view.availableMargin,899)
  assert.equal(view.snapshot.balances[0].balance,'999')
  assert.equal(view.equity,999)
})
test('Unified perps accountValue zero is not substituted for real active-asset available margin', () => {
  const view=mapHyperliquidSnapshot({...snapshot,position:'0',clearinghouseState:{...snapshot.clearinghouseState,assetPositions:[]},activeAssetData:{...snapshot.activeAssetData,availableToTrade:['999','999']}})
  assert.equal(view.availableMargin,999)
  assert.equal(view.snapshot.positions.length,0)
})
test('order form sends margin mode unchanged and native mark-only stop; unsupported mappings reject', () => {
  const input=toHyperliquidOrderInput({symbol:'BTC-USD',direction:'LONG',orderKind:'MARKET',amountMode:'COST',amount:100,leverage:10,marginType:'CROSSED',maxSlippagePercent:0.25,stopLoss:{stopPrice:82000,execution:'MARKET',workingType:'MARK_PRICE'}})
  assert.deepEqual(input,{side:'BUY',orderType:'MARKET',sizeMode:'COST',amount:'100',leverage:10,marginType:'cross',maxSlippageBps:25,stopLoss:'82000',triggerSource:'MARK_PRICE'})
  assert.throws(()=>toHyperliquidOrderInput({symbol:'BTC-USD',direction:'LONG',orderKind:'LIMIT',amountMode:'COST',amount:100,leverage:10,marginType:'CROSSED',timeInForce:'FOK',price:82600}),/FOK|Unsupported/)
})
test('late status from a different network or prior selection cannot repopulate account data',()=>{
  assert.equal(accountResponseCurrent('testnet',3,'testnet',3),true)
  assert.equal(accountResponseCurrent('testnet',3,'mainnet',3),false)
  assert.equal(accountResponseCurrent('testnet',3,'testnet',4),false)
})
const summary={accountValue:'0',totalNtlPos:'0',totalRawUsd:'0',totalMarginUsed:'0'}
export const snapshot:HlTerminalSnapshot={network:'testnet',account:'0x00000000000000000000000000000000000a11ce',coin:'BTC',asset:3,szDecimals:5,maxLeverage:40,makerFeeRate:0.00015,takerFeeRate:0.00045,mode:'unifiedAccount',masterRole:'user',checkedAt:1000,markPx:'82626',bid:'82625',ask:'82627',leverage:10,marginType:'cross',position:'0.0121',activeAssetData:{user:'0x00000000000000000000000000000000000a11ce',coin:'BTC',leverage:{type:'cross',value:10},maxTradeSzs:['1','1'],availableToTrade:['899','899'],markPx:'82626'},clearinghouseState:{marginSummary:summary,crossMarginSummary:summary,crossMaintenanceMarginUsed:'0',withdrawable:'0',time:1000,assetPositions:[{type:'oneWay',position:{coin:'BTC',szi:'0.0121',leverage:{type:'cross',value:10},entryPx:'82620',positionValue:'1000',unrealizedPnl:'2',returnOnEquity:'0.02',liquidationPx:null,marginUsed:'100',maxLeverage:40,cumFunding:{allTime:'0',sinceOpen:'0',sinceChange:'0'}}}]},spotClearinghouseState:{balances:[{coin:'USDC',token:0,total:'999',hold:'0',entryNtl:'0'}]},openOrders:[{coin:'BTC',side:'A',limitPx:'81918',sz:'0.0121',oid:123,timestamp:1000,origSz:'0.0121',cloid:'0x00000000000000000000000000000001',reduceOnly:true,isTrigger:true,triggerCondition:'Price below 82000',triggerPx:'82000',orderType:'Stop Market',isPositionTpsl:true,children:[],tif:null}]}
