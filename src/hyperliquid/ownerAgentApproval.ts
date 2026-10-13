import { ExchangeClient, HttpTransport, type IRequestTransport } from '@nktkas/hyperliquid'
import { ApproveAgentTypes } from '@nktkas/hyperliquid/api/exchange'
import { createWalletClient, custom, recoverTypedDataAddress } from 'viem'
import type { HlTerminalAgentApproval } from '../../shared/hyperliquidTerminalAgent'
import type { OwnerWallet } from './ownerTerminal'
export class AgentApprovalError extends Error { constructor(message:string,public readonly uncertain:boolean,cause?:unknown){super(message,{cause})} }
const attempted=new Set<string>()
const stable=(value:unknown):string=>JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v)
export function validateAgentApproval(p:HlTerminalAgentApproval,now:number):void {
 if(p.network!=='testnet'||!p.id||!/^0x[0-9a-fA-F]{40}$/.test(p.account)||!/^0x[0-9a-fA-F]{40}$/.test(p.agentAddress)||p.account.toLowerCase()===p.agentAddress.toLowerCase()||p.agentName!==`AntyTILT-Trade valid_until ${p.expiresAt}`||!Number.isSafeInteger(p.nonce)||!Number.isSafeInteger(p.expiresAt)||p.expiresAt<=now||p.expiresAt-p.nonce<=0||p.expiresAt-p.nonce>1800000||p.nonce>now+5000||now-p.nonce>60000||!Number.isSafeInteger(p.reviewExpiresAt)||p.reviewExpiresAt<=now||p.reviewExpiresAt>p.expiresAt||!Number.isFinite(p.checkedAt)||now-p.checkedAt>60000||p.checkedAt>now+5000)throw Error('Testnet agent approval is invalid or expired; verify the existing candidate before preparing again')
}
/** Conservative Phantom Ethereum-family signing domains; never switch wallet networks. */
export function agentSignatureChainId(chain:unknown):`0x${string}` {
 const id=typeof chain==='string'&&/^0x[0-9a-f]+$/i.test(chain)?Number(chain):NaN
 return [1,137,8453,11155111,84532,80002].includes(id)?`0x${id.toString(16)}`:'0x1'
}
function expectedAction(p:HlTerminalAgentApproval,chain:`0x${string}`){return{type:'approveAgent',signatureChainId:chain,hyperliquidChain:'Testnet',agentAddress:p.agentAddress.toLowerCase(),agentName:p.agentName,nonce:p.nonce}}
export function validateAgentTypedData(typed:unknown,p:HlTerminalAgentApproval,chain:`0x${string}`):void {
 const t=typed as {domain?:unknown;types?:unknown;primaryType?:unknown;message?:Record<string,unknown>}
 const domain={name:'HyperliquidSignTransaction',version:'1',chainId:Number(chain),verifyingContract:'0x0000000000000000000000000000000000000000'}
 const rawDomain=t?.domain as Record<string,unknown>|undefined
 const normalized=rawDomain?{...rawDomain,chainId:Number(rawDomain.chainId)}:null
 const types={...ApproveAgentTypes,EIP712Domain:[{name:'name',type:'string'},{name:'version',type:'string'},{name:'chainId',type:'uint256'},{name:'verifyingContract',type:'address'}]}
 const message=t?.message?{...t.message,nonce:Number(t.message.nonce)}:null
 if(stable(normalized)!==stable(domain)||stable(t.types)!==stable(types)||t.primaryType!=='HyperliquidTransaction:ApproveAgent'||stable(message)!==stable({hyperliquidChain:'Testnet',agentAddress:p.agentAddress.toLowerCase(),agentName:p.agentName,nonce:p.nonce}))throw Error('Unexpected agent approval typed data/domain/action')
}
/** Exactly one SDK approval attempt for the public candidate, with fresh checks surrounding owner signing. */
export async function approveTerminalAgent(approval:HlTerminalAgentApproval,provider:OwnerWallet,authorize:()=>Promise<void>,selectionGuard:()=>boolean):Promise<void> {
 const p=structuredClone(approval);validateAgentApproval(p,Date.now())
 const selected=()=>{if(!selectionGuard())throw Error('Execution account/network selection changed')}
 selected();if(attempted.has(`${p.id}:${p.nonce}`))throw Error('Agent approval already attempted; verify native grant before another approval')
 attempted.add(`${p.id}:${p.nonce}`)
 let submitted=false,signs=0,signed:string|null=null,guardError:Error|null=null
 const master=async(method='eth_accounts')=>{selected();const accounts=await provider.request({method});selected();if(!Array.isArray(accounts)||typeof accounts[0]!=='string'||accounts[0].toLowerCase()!==p.account.toLowerCase())throw Error('Select the linked master EOA in wallet')}
 const gate=async()=>{selected();validateAgentApproval(p,Date.now());await master();await authorize();selected();validateAgentApproval(p,Date.now());await master()}
 try{
  await master('eth_requestAccounts');let currentChain:unknown;try{currentChain=await provider.request({method:'eth_chainId'})}catch{currentChain=null}selected()
  const chain=agentSignatureChainId(currentChain)
  const guarded:OwnerWallet={request:async input=>{
   selected();if(input.method==='eth_accounts'){await master();return[p.account]}if(input.method==='eth_chainId')return chain;if(input.method!=='eth_signTypedData_v4')throw Error('Unexpected wallet RPC during agent approval')
   if(++signs!==1)throw Error('Only one owner approval signature allowed')
   try{await gate();const typed=JSON.parse(String(input.params?.[1]));validateAgentTypedData(typed,p,chain)
   if(String(input.params?.[0]).toLowerCase()!==p.account.toLowerCase())throw Error('Unexpected approval master')
   const signature=await provider.request(input);if(typeof signature!=='string')throw Error('Owner signature unavailable')
   const recovered=await recoverTypedDataAddress({...typed,signature:signature as `0x${string}`});if(recovered.toLowerCase()!==p.account.toLowerCase())throw Error('Signature is not from linked master')
   await gate();signed=signature;return signature}catch(e){guardError=e instanceof Error?e:Error('Invalid approval');throw e}
  }}
  const wallet=createWalletClient({account:p.account as `0x${string}`,transport:custom(guarded,{retryCount:0})}),http=new HttpTransport({isTestnet:true,timeout:8000})
  const transport:IRequestTransport={isTestnet:true,async request<T>(endpoint:'info'|'exchange',payload:unknown,signal?:AbortSignal):Promise<T>{
   await gate();const b=payload as {action?:unknown;nonce?:number;signature?:{r?:unknown;s?:unknown;v?:unknown}}
   if(endpoint!=='exchange'||submitted||!signed||stable(b.action)!==stable(expectedAction(p,chain))||b.nonce!==p.nonce||stable(Object.keys(b).sort())!==stable(['action','nonce','signature'])||!b.signature||`${b.signature.r}${String(b.signature.s).slice(2)}${Number(b.signature.v).toString(16)}`.toLowerCase()!==signed.toLowerCase())throw Error('Actual SDK approval payload differs from reviewed candidate')
   submitted=true;return http.request<T>(endpoint,payload,signal)
  }}
  const sdk=new ExchangeClient({transport,wallet,signatureChainId:chain,nonceManager:()=>p.nonce})
  await sdk.approveAgent({agentAddress:p.agentAddress as `0x${string}`,agentName:p.agentName})
 }catch(e){throw new AgentApprovalError(submitted?'Agent approval outcome unknown. Verify the native grant; no automatic retry.':(guardError as Error|null)?.message??(e instanceof Error?e.message:'Owner approval incomplete'),submitted,e)}
}
