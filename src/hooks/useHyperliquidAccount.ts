import {HL_LEGACY_RECOVERY_ACCOUNT,HL_LEGACY_RECOVERY_CLOID,type HlLegacyRecoveryReview,type HlLegacyRecoveryReceipt,type HlLegacyRecoveryJournal} from '../../shared/hyperliquidLegacyRecovery'
import { authRequestEpoch, expireAuthSession } from '../authEvents'
import type { HlTerminalAgentApproval, HlTerminalAgentExecution, HlTerminalAgentStatus } from '../../shared/hyperliquidTerminalAgent'
import { AgentApprovalError, approveTerminalAgent, validateAgentApproval } from '../hyperliquid/ownerAgentApproval'
import { useEffect, useRef, useState } from 'react'
import { HL_TERMINAL_API, validateTerminalPacket, type HlTerminalHistory, type HlTerminalInput, type HlTerminalKind, type HlTerminalNetwork, type HlTerminalPacket, type HlTerminalReconcile, type HlTerminalResult, type HlTerminalSnapshot, type HlTerminalStatus, type HlTerminalValidation } from '../../shared/hyperliquidTerminal'
import { submitTerminalAction, ownerSigningIssue, TerminalSubmissionError, type OwnerWallet } from '../hyperliquid/ownerTerminal'
import { emptyHyperliquidHistory, mapHyperliquidHistory, mapHyperliquidPreview, mapHyperliquidSnapshot, toHyperliquidOrderInput } from '../hyperliquid/terminalView'
import { readExactRecoveryEvidence, restoreExactCanonicalRecoveryInDoubt, retireLegacyPending, clearTerminalPending, makeTerminalPending, pendingCanResolve, persistTerminalPending, readTerminalPending, withTerminalReceipt, type TerminalPending, type PendingStorage } from '../hyperliquid/terminalPending'
import type { AccountHistory, AdvancedOrderInput, ExchangeMarginType, ExchangeSessionState, PositionDirection, PositionProtectionInput } from '../types'
export type HyperliquidActionReview = { signingMode?: 'owner'|'agent'; packet: HlTerminalPacket; confirm: () => Promise<void>; cancel: () => void }
type AccountStatus = 'checking' | 'idle' | 'connecting' | 'previewing' | 'executing' | 'updating'
type Context = { network: HlTerminalNetwork; generation: number; account: string | null }
const messageOf = (error: unknown) => error instanceof Error ? error.message : 'Hyperliquid operation unavailable'
export function terminalWritesReady(data: HlTerminalStatus | null, now: number, pending: TerminalPending | null, enabled: boolean) {
 const s = data?.snapshot
 return Boolean(enabled && data?.network === 'testnet' && data.writesEnabled && s && s.network === data.network && s.coin === 'BTC' && /^0x[0-9a-fA-F]{40}$/.test(s.account) && s.masterRole === 'user' && ['disabled','unifiedAccount'].includes(s.mode) && Number.isFinite(s.checkedAt) && now-s.checkedAt <=30000 && s.checkedAt<=now+5000 && !pending)
}
export function terminalAgentReady(agent:HlTerminalAgentStatus|null,network:HlTerminalNetwork,account:string|null,now:number):boolean { return Boolean(agent&&network==='testnet'&&agent.network===network&&account&&agent.account.toLowerCase()===account.toLowerCase()&&agent.phase==='ACTIVE'&&agent.id&&agent.agentAddress&&agent.expiresAt&&agent.expiresAt>now&&Number.isFinite(agent.checkedAt)&&now-agent.checkedAt<=30000&&agent.checkedAt<=now+5000) }
class TerminalSessionExpiredError extends Error { constructor(){super('Session unavailable. Sign in again before an owner action.')} }
async function terminalApi<T>(network: HlTerminalNetwork, path: string, method='GET', body?: object, externalSignal?:AbortSignal): Promise<T> {
 const controller = new AbortController(), timeout = window.setTimeout(()=>controller.abort(),30000)
 const abort=()=>controller.abort();externalSignal?.addEventListener('abort',abort,{once:true});if(externalSignal?.aborted)controller.abort()
 try {
  const response = await fetch(`${HL_TERMINAL_API}${path}${method==='GET' ? `${path.includes('?') ? '&' : '?'}network=${network}` : ''}`, {method,credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify({...body,network}):undefined,signal:controller.signal})
  const value = await response.json().catch(()=>null)
  if (response.status===401) throw new TerminalSessionExpiredError()
  if (!response.ok || !value) throw Error(typeof value?.error==='string'?value.error:`Hyperliquid request unavailable (${response.status})`)
  if ((value.network??value.approval?.network)!==network || (value.snapshot && value.snapshot.network!==network)) throw Error('Hyperliquid response network mismatch')
  return value as T
 } finally {window.clearTimeout(timeout);externalSignal?.removeEventListener('abort',abort)}
}
function availableOwnerWallet(): OwnerWallet | undefined {
 if (typeof window === 'undefined') return undefined
 const host = window as Window & {ethereum?:OwnerWallet;phantom?:{ethereum?:OwnerWallet}}
 return host.ethereum ?? host.phantom?.ethereum
}
function ownerWallet(): OwnerWallet {
 const wallet=availableOwnerWallet()
 if (!wallet || typeof wallet.request!=='function') throw Error('An injected EVM wallet is required. Select the linked master EOA before confirming.')
 return wallet
}
type LegacyRecoveryRequest = (path: string, body: object) => Promise<unknown>
export async function requestLegacyRecoveryReview(
  storage: PendingStorage,
  network: HlTerminalNetwork,
  account: string,
  request: LegacyRecoveryRequest,
  selected: () => boolean,
): Promise<HlLegacyRecoveryReview> {
  if (!selected())
    throw Error('Legacy recovery account/network selection changed')
  await restoreExactCanonicalRecoveryInDoubt(
    storage,
    network,
    account,
    selected,
  )
  if (!selected()) throw Error('Recovery account/network selection changed')
  const old = readExactRecoveryEvidence(storage, network, account)
  const review = (await request('/legacy-recovery/preview', {
    storageKey: old.storageKey,
    raw: old.raw,
    ...(old.format === 'CANONICAL_CLIENT_ONLY'
      ? { mirrorStorageKey: old.mirrorStorageKey, mirrorRaw: old.mirrorRaw }
      : {}),
  })) as HlLegacyRecoveryReview
  if (!selected())
    throw Error('Legacy recovery account/network selection changed')
  const current = readExactRecoveryEvidence(storage, network, account)
  if (
    !review ||
    review.network !== network ||
    review.account !== old.account ||
    review.cloid !== old.cloid ||
    review.storageKey !== old.storageKey ||
    review.raw !== old.raw ||
    current.raw !== old.raw ||
    current.format !== old.format ||
    (old.format === 'CANONICAL_CLIENT_ONLY' &&
      (current.format !== 'CANONICAL_CLIENT_ONLY' ||
        current.mirrorRaw !== old.mirrorRaw ||
        review.format !== old.format ||
        review.packetId !== old.packetId ||
        review.mirrorStorageKey !== old.mirrorStorageKey ||
        review.mirrorRaw !== old.mirrorRaw ||
        !/^[0-9a-f]{64}$/.test(review.mirrorHash ?? '') ||
        !/^[0-9a-f]{64}$/.test(review.evidenceHash ?? ''))) ||
    review.outcome !== 'UNKNOWN' ||
    !/^([0-9a-f]{64})$/.test(review.rawHash) ||
    !/^([0-9a-f]{64})$/.test(review.seal) ||
    review.expiresAfter <= Date.now()
  )
    throw Error('Exact current legacy recovery review required')
  return review
}
export async function confirmLegacyRecoveryRequest(
  storage: PendingStorage,
  review: HlLegacyRecoveryReview,
  acknowledgments: { uncertainty: boolean; stoppedPrompts: boolean },
  request: LegacyRecoveryRequest,
  selected: () => boolean,
): Promise<HlLegacyRecoveryReceipt> {
  if (!selected())
    throw Error('Legacy recovery account/network selection changed')
  if (
    acknowledgments.uncertainty !== true ||
    acknowledgments.stoppedPrompts !== true
  )
    throw Error('Review both uncertainty and stopped-prompts acknowledgments')
  const old = readExactRecoveryEvidence(storage, review.network, review.account)
  if (
    old.raw !== review.raw ||
    old.storageKey !== review.storageKey ||
    old.cloid !== review.cloid ||
    (old.format === 'CANONICAL_CLIENT_ONLY' &&
      (review.format !== old.format ||
        old.mirrorRaw !== review.mirrorRaw ||
        old.mirrorStorageKey !== review.mirrorStorageKey))
  )
    throw Error('Legacy pending changed; review again')
  const receipt = (await request('/legacy-recovery/confirm', {
    review,
    acknowledgments,
  })) as HlLegacyRecoveryReceipt
  if (!selected())
    throw Error('Legacy recovery account/network selection changed')
  return retireLegacyPending(storage, review, receipt, selected)
}
export function useHyperliquidAccount(enabled:boolean,network:HlTerminalNetwork) {
 const [data,setData]=useState<HlTerminalStatus|null>(null),[history,setHistory]=useState<AccountHistory>(emptyHyperliquidHistory),[historyLoading,setHistoryLoading]=useState(false),[status,setStatus]=useState<AccountStatus>(enabled?'checking':'idle'),[error,setError]=useState<string|null>(null),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[pending,setPending]=useState<TerminalPending|null>(null),[review,setReview]=useState<HyperliquidActionReview|null>(null),[now,setNow]=useState(Date.now)
 const [agentStatus,setAgentStatus]=useState<HlTerminalAgentStatus|null>(null),[agentApproval,setAgentApproval]=useState<HlTerminalAgentApproval|null>(null),[agentBusy,setAgentBusy]=useState(false),[agentMessage,setAgentMessage]=useState('')
 const [legacyRecoveryReview,setLegacyRecoveryReview]=useState<HlLegacyRecoveryReview|null>(null),[legacyRecoveryReceipts,setLegacyRecoveryReceipts]=useState<HlLegacyRecoveryReceipt[]>([]),[legacyRecoveryMessage,setLegacyRecoveryMessage]=useState('')
 const legacyReviewRef=useRef<{review:HlLegacyRecoveryReview;context:Context}|null>(null)
 const agentRef=useRef<HlTerminalAgentStatus|null>(null),approvalRef=useRef<HlTerminalAgentApproval|null>(null),agentOperation=useRef<object|null>(null)
 const enabledRef=useRef(enabled),networkRef=useRef(network),generation=useRef(0),alive=useRef(false),dataRef=useRef<HlTerminalStatus|null>(null),pendingRef=useRef<TerminalPending|null>(null),operation=useRef<object|null>(null),statusFlight=useRef<Promise<HlTerminalStatus|null>|null>(null),historyFlight=useRef(false),historyLastAttempt=useRef(0),statusAbort=useRef<AbortController|null>(null),reviewReject=useRef<((error:Error)=>void)|null>(null),packets=useRef(new Map<string,{packet:HlTerminalPacket;signingMode:'owner'|'agent'}>())
 enabledRef.current=enabled; networkRef.current=network
 const context=():Context=>({network:networkRef.current,generation:generation.current,account:dataRef.current?.snapshot?.account.toLowerCase()??null})
 const selected=(c:Context)=>alive.current&&enabledRef.current&&networkRef.current===c.network&&generation.current===c.generation&&(dataRef.current?.snapshot?.account.toLowerCase()??null)===c.account
 const assertSelected=(c:Context)=>{if(!selected(c))throw Error('Execution account/network selection changed. Discard the previous review.')}
 const api=async<T,>(requestNetwork:HlTerminalNetwork,path:string,method='GET',body?:object,signal?:AbortSignal):Promise<T>=>{const c=context(),epoch=authRequestEpoch();try{return await terminalApi<T>(requestNetwork,path,method,body,signal)}catch(e){if(e instanceof TerminalSessionExpiredError&&requestNetwork===c.network&&selected(c))expireAuthSession(epoch);throw e}}
 const cancelReview=(reason='Owner review cancelled')=>{reviewReject.current?.(new Error(reason));reviewReject.current=null;setReview(null)}
 const applyData=(next:HlTerminalStatus)=>{dataRef.current=next;setData(next)}
 const applyPending=(next:TerminalPending|null)=>{pendingRef.current=next;setPending(next)}
 const scopedSnapshot=(s:HlTerminalSnapshot,c:Context)=>{assertSelected(c);if(s.network!==c.network||s.account.toLowerCase()!==c.account||s.coin!=='BTC')throw Error('Native snapshot master/network mismatch')}
 const refresh=async():Promise<HlTerminalStatus|null>=>{
  if(!enabledRef.current||!alive.current)return null
  if(statusFlight.current)return statusFlight.current
  const requestNetwork=networkRef.current,requestGeneration=generation.current,requestController=new AbortController();statusAbort.current=requestController
  const promise=(async()=>{
   try{
    const next=await api<HlTerminalStatus>(requestNetwork,'/status','GET',undefined,requestController.signal)
    if(!alive.current||!enabledRef.current||networkRef.current!==requestNetwork||generation.current!==requestGeneration)return null
    if(next.snapshot && (!/^0x[0-9a-fA-F]{40}$/.test(next.snapshot.account)||next.snapshot.coin!=='BTC'))throw Error('Unsupported native account snapshot')
    if(next.snapshot)mapHyperliquidSnapshot(next.snapshot) // Validate before changing generation.
    const previous=dataRef.current?.snapshot?.account.toLowerCase()??null,nextAccount=next.snapshot?.account.toLowerCase()??null
    if(previous!==nextAccount){generation.current++;packets.current.clear();cancelReview('Linked master changed; previous review cancelled')}
    if(previous!==nextAccount){legacyReviewRef.current=null;setLegacyRecoveryReview(null);setLegacyRecoveryReceipts([]);setLegacyRecoveryMessage('');agentRef.current=null;approvalRef.current=null;setAgentStatus(null);setAgentApproval(null);setAgentBusy(false);setBusy(false)}
    applyData(next);applyPending(next.snapshot?readTerminalPending(localStorage,requestNetwork,next.snapshot.account):null)
    if(!operation.current){setStatus('idle');setError(null)}
    return next
   }catch(e){if(alive.current&&networkRef.current===requestNetwork&&generation.current===requestGeneration){setError(messageOf(e));if(dataRef.current)applyData({...dataRef.current,writesEnabled:false});else setStatus('idle')}throw e}
  })()
  statusFlight.current=promise
  try{return await promise}finally{if(statusFlight.current===promise){statusFlight.current=null;statusAbort.current=null}}
 }
 const applyAgent=(next:HlTerminalAgentStatus,c:Context)=>{
  assertSelected(c);if(next.network!=='testnet'||next.account.toLowerCase()!==c.account)throw Error('Agent master/network mismatch')
  if(!Number.isFinite(next.checkedAt)||Date.now()-next.checkedAt>30000||next.checkedAt>Date.now()+5000)throw Error('Native agent status is stale. Verify again before an action.')
  if(next.phase==='ACTIVE'&&next.id&&next.expiresAt&&next.expiresAt>Date.now()){
   const key=`antytilt:hl:agent-approval-attempt:testnet:${c.account}:${next.id}`,raw=localStorage.getItem(key)
   if(raw){try{const p=(JSON.parse(raw) as {approval?:HlTerminalAgentApproval}).approval;if(p&&p.network===next.network&&p.account.toLowerCase()===c.account&&p.id===next.id&&p.agentAddress.toLowerCase()===next.agentAddress?.toLowerCase()&&p.agentName===next.agentName&&p.expiresAt===next.expiresAt)localStorage.removeItem(key)}catch{/* Unreadable attempt evidence stays blocked. */}}
  }
  agentRef.current=next;setAgentStatus(next);if(next.phase!=='PREPARED'){approvalRef.current=null;setAgentApproval(null)}
 }
 const refreshAgent=async():Promise<void>=>{
  if(!enabledRef.current||networkRef.current!=='testnet'||!dataRef.current?.snapshot)return
  const c=context()
  try{
   let next=await api<HlTerminalAgentStatus>('testnet','/agent/status'),nextMessage=''
   applyAgent(next,c) // Keep the fresh public candidate visible even if confirmation is still absent.
   if(next.id&&next.phase==='PREPARED'){
    const raw=localStorage.getItem(`antytilt:hl:agent-approval-attempt:testnet:${c.account}:${next.id}`)
    if(raw){
     const marker=JSON.parse(raw)
     if(marker.state==='no-send')nextMessage=typeof marker.failureMessage==='string'?marker.failureMessage:'Approval was not sent. Use Prepare Testnet API wallet to refresh the 60-second confirmation window.'
     else if(marker.approval){
      const p=marker.approval as HlTerminalAgentApproval
      if(p.id!==next.id||p.network!=='testnet'||p.account.toLowerCase()!==c.account)throw Error('Stored approval recovery mismatch')
      try{next=await api<HlTerminalAgentStatus>('testnet','/agent/confirm','POST',{approval:p})}catch{nextMessage='Approval outcome unresolved. Verify native grant or disable locally; no repeat signature.'}
      if(next.phase==='PREPARED')nextMessage='Approval outcome unresolved. Verify native grant or disable locally; no repeat signature.'
     }
    }
   }
   applyAgent(next,c);setAgentMessage(nextMessage)
  }catch(e){if(selected(c)){agentRef.current=null;setAgentStatus(null);setAgentMessage(messageOf(e))}throw e}
 }
 const agentRun=async(action:(c:Context)=>Promise<void>)=>{if(agentOperation.current||operation.current)throw Error('An owner action or approval is already in progress');const c=context();assertSelected(c);if(c.network!=='testnet'||!c.account)throw Error('Link the Testnet master before API-wallet approval');const token={};agentOperation.current=token;setAgentBusy(true);setAgentMessage('');try{await action(c)}catch(e){if(selected(c))setAgentMessage(messageOf(e));throw e}finally{if(agentOperation.current===token)agentOperation.current=null;if(selected(c))setAgentBusy(false)}}
 const prepareAgent=()=>agentRun(async c=>{await refreshAgent();assertSelected(c);if(agentRef.current&&!['MISSING','PREPARED','DISABLED','EXPIRED','REVOKED'].includes(agentRef.current.phase))throw Error('Verify or disable the existing API wallet before preparing another');if(agentRef.current?.id){const marker=localStorage.getItem(`antytilt:hl:agent-approval-attempt:testnet:${c.account}:${agentRef.current.id}`);if(marker&&JSON.parse(marker).state!=='no-send')throw Error('Approval outcome unresolved. Verify native grant or disable locally; no repeat signature.');}const approval=await api<HlTerminalAgentApproval>('testnet','/agent/prepare','POST',{});assertSelected(c);validateAgentApproval(approval,Date.now());if(approval.account.toLowerCase()!==c.account)throw Error('Agent approval master mismatch');approvalRef.current=approval;setAgentApproval(approval);agentRef.current={...approval,phase:'PREPARED',reason:'Review the exact authority before approving'};setAgentStatus(agentRef.current)})
 const approveAgent=()=>agentRun(async c=>{
  const approval=approvalRef.current;if(!approval)throw Error('Verify the native grant before preparing another approval');validateAgentApproval(approval,Date.now());if(approval.account.toLowerCase()!==c.account)throw Error('Agent approval master mismatch')
  const key=`antytilt:hl:agent-approval-attempt:testnet:${c.account}:${approval.id}`;const previous=localStorage.getItem(key);if(previous){const marker=JSON.parse(previous);if(marker.state!=='no-send'||marker.nonce===approval.nonce)throw Error('Approval already attempted. Wait for the 60-second confirmation window to expire, then use Prepare Testnet API wallet. Verify any unknown outcome first.')}localStorage.setItem(key,JSON.stringify({nonce:approval.nonce,state:'attempted',approval}))
  const authorize=async()=>{assertSelected(c);validateAgentApproval(approval,Date.now());const checked=await api<{valid:true;approval:HlTerminalAgentApproval}>('testnet','/agent/validate','POST',{approval});assertSelected(c);if(checked.valid!==true||Object.keys(approval).some(k=>checked.approval[k as keyof HlTerminalAgentApproval]!==approval[k as keyof HlTerminalAgentApproval]))throw Error('Approval no longer matches the prepared candidate')}
  let failure:unknown=null
  try{await approveTerminalAgent(approval,ownerWallet(),authorize,()=>selected(c))}catch(e){failure=e;localStorage.setItem(key,JSON.stringify({nonce:approval.nonce,state:e instanceof AgentApprovalError&&e.uncertain?'unknown':'no-send',approval,failureMessage:messageOf(e).slice(0,300)}))}
  finally{if(selected(c)){approvalRef.current=null;setAgentApproval(null)}}
  if(selected(c)){try{const verified=await api<HlTerminalAgentStatus>('testnet','/agent/confirm','POST',{approval});applyAgent(verified,c);setAgentMessage(verified.phase==='ACTIVE'?'Native Testnet API wallet verified. Each action still requires manual confirmation.':failure?messageOf(failure):verified.reason)}catch(e){await api<HlTerminalAgentStatus>('testnet','/agent/status').then(next=>applyAgent(next,c)).catch(()=>undefined);throw failure??new Error('Approval outcome unresolved. Verify native grant or disable locally; no repeat signature.',{cause:e})}}
  if(failure&&agentRef.current?.phase!=='ACTIVE')throw failure
 })
 const disableAgent=()=>agentRun(async c=>{const id=agentRef.current?.id??approvalRef.current?.id;if(!id)throw Error('Verify the existing API wallet first');const next=await api<HlTerminalAgentStatus>('testnet','/agent/disable','POST',{id});applyAgent(next,c);approvalRef.current=null;setAgentApproval(null);setAgentMessage('Local key destroyed. Native grant remains until expiry; it was not revoked.')})
 const refreshHistory=async(quiet=false)=>{
  if(!enabledRef.current||!dataRef.current?.snapshot||historyFlight.current)return
  const c=context();historyFlight.current=true;historyLastAttempt.current=Date.now();if(!quiet)setHistoryLoading(true)
  try{const next=await api<HlTerminalHistory>(c.network,'/history');assertSelected(c);if(next.account.toLowerCase()!==c.account)throw Error('Native history master mismatch');setHistory(mapHyperliquidHistory(next))}catch(e){if(selected(c)&&!quiet)setError(messageOf(e));if(!quiet)throw e}finally{historyFlight.current=false;if(selected(c))setHistoryLoading(false)}
 }
 const refreshLegacyJournal = async () => {
   const c = context()
   if (c.network !== 'testnet' || c.account !== HL_LEGACY_RECOVERY_ACCOUNT)
     return
   const journal = await api<HlLegacyRecoveryJournal>(
     'testnet',
     '/legacy-recovery/journal',
   )
   assertSelected(c)
   if (
     journal.account !== c.account ||
     !Array.isArray(journal.receipts) ||
     journal.receipts.some(
       (r) =>
         r.account !== c.account ||
         r.network !== 'testnet' ||
         r.cloid !== HL_LEGACY_RECOVERY_CLOID ||
         r.outcome !== 'UNKNOWN',
     )
   )
     throw Error('Legacy archive journal scope mismatch')
   setLegacyRecoveryReceipts(journal.receipts)
 }
 const reconcile=async()=>{
  const c=context();let p=c.account?readTerminalPending(localStorage,c.network,c.account):null
  if(!p)return
  if(p.invalid)throw Error(p.message)
  const query=`/reconcile?ids=${encodeURIComponent(p.ids.join(','))}${p.packetId?`&packetId=${encodeURIComponent(p.packetId)}`:''}`
  const result=await api<HlTerminalReconcile&{agentExecution?:HlTerminalAgentExecution|null}>(c.network,query);scopedSnapshot(result.snapshot,c)
  if(dataRef.current)applyData({...dataRef.current,snapshot:result.snapshot})
  const execution=result.agentExecution,matchingExecution=Boolean(p.packetId&&execution?.packetId===p.packetId&&execution?.network===c.network)
  const settledResult=matchingExecution&&execution&&!['UNKNOWN','SUBMITTING'].includes(execution.state)?execution.result:null
  if(settledResult&&!p.legacy){p=withTerminalReceipt(p,settledResult);if(settledResult.kind==='PARTIAL'||settledResult.protection==='REJECTED')p={...p,message:`Native result ${settledResult.kind}; protection ${settledResult.protection}. Inspect native position and stops before another action.`};persistTerminalPending(localStorage,p);applyPending(p)}
  const protectionWarning=settledResult&&(settledResult.kind==='PARTIAL'||settledResult.protection==='REJECTED')?`Native result ${settledResult.kind}; protection ${settledResult.protection}. Inspect native position and stops before another action.`:null
  const agentRejected=matchingExecution&&execution?.state==='REJECTED'
  if(agentRejected||pendingCanResolve(p,result)){
   clearTerminalPending(localStorage,p);applyPending(readTerminalPending(localStorage,c.network,p.account))
   setMessage(protectionWarning??(agentRejected?'Agent action definitively rejected; no retry was sent.':p.action?.type==='updateLeverage'?'Native leverage/margin now match the reviewed setting. This snapshot does not attribute who changed it.':`Provider order state verified: ${result.orders.map(o=>`${o.id}: ${o.status}`).join(', ')}. Open/triggered status is not a fill or installed-stop guarantee.`))
  }else{const next={...p,message:`Unresolved action: ${result.orders.map(o=>`${o.id}: ${o.status}`).join(', ')||'native setting not confirmed'}. No automatic retry.`};if(!p.legacy)persistTerminalPending(localStorage,next);applyPending(next);setMessage(next.message)}
 }
 useEffect(()=>{
  alive.current=true;generation.current++;statusAbort.current?.abort();statusAbort.current=null;statusFlight.current=null;historyLastAttempt.current=0;setHistoryLoading(false);dataRef.current=null;pendingRef.current=null;packets.current.clear();setData(null);setPending(null);setHistory(emptyHyperliquidHistory);setError(null);setMessage('');setStatus(enabled?'checking':'idle');setBusy(false);agentRef.current=null;approvalRef.current=null;agentOperation.current=null;setAgentStatus(null);setAgentApproval(null);setAgentBusy(false);setAgentMessage('');legacyReviewRef.current=null;setLegacyRecoveryReview(null);setLegacyRecoveryReceipts([]);setLegacyRecoveryMessage('')
  let stopped=false,polling=false
  const poll=async()=>{if(stopped||!enabledRef.current||polling)return;polling=true;try{await refresh();if(stopped)return;if(networkRef.current==='testnet')await refreshAgent().catch(()=>undefined);if(stopped)return;await refreshLegacyJournal().catch(()=>undefined);if(stopped)return;if(pendingRef.current&&!operation.current)await reconcile();if(Date.now()-historyLastAttempt.current>=60000)await refreshHistory(true)}catch(e){if(!stopped&&alive.current&&networkRef.current===network)setError(messageOf(e))}finally{polling=false}}
  if(enabled)void poll();const timer=window.setInterval(()=>void poll(),15000),clock=window.setInterval(()=>setNow(Date.now()),1000)
  return()=>{stopped=true;alive.current=false;generation.current++;statusAbort.current?.abort();statusAbort.current=null;statusFlight.current=null;reviewReject.current?.(new Error('Execution selection changed; owner review cancelled'));reviewReject.current=null;operation.current=null;window.clearInterval(timer);window.clearInterval(clock)}
 },[enabled,network])
 const ensureReady=()=>{const c=context();assertSelected(c);const durable=c.account?readTerminalPending(localStorage,c.network,c.account):null;applyPending(durable);const incompatible=terminalAgentReady(agentRef.current,c.network,c.account,Date.now())?null:ownerSigningIssue(availableOwnerWallet());if(incompatible)throw Error(incompatible);if(!terminalWritesReady(dataRef.current,Date.now(),durable,enabledRef.current))throw Error(durable?.message??'Native testnet account/actions are unavailable or stale. Refresh before reviewing.');return c}
 const run=async<T,>(nextStatus:AccountStatus,action:()=>Promise<T>):Promise<T>=>{
  if(operation.current||agentOperation.current)throw Error('An owner action or review is already in progress')
  const token={},c=context();operation.current=token;setBusy(true);setStatus(nextStatus);setError(null)
  try{return await action()}catch(e){if(selected(c))setError(messageOf(e));throw e}finally{if(operation.current===token)operation.current=null;if(selected(c)){setBusy(false);setStatus('idle')}}
 }
 const reviewLegacyRequest = () =>
   run('updating', async () => {
     if (reviewReject.current)
       throw Error('Finish or cancel the current owner action review first')
     const c = context()
     assertSelected(c)
     if (c.network !== 'testnet' || !c.account)
       throw Error('Select the approved Testnet master before recovery')
     setLegacyRecoveryMessage('')
     const recovery = await requestLegacyRecoveryReview(
       localStorage,
       c.network,
       c.account,
       (path, body) => api<unknown>(c.network, path, 'POST', body),
       () => selected(c),
     )
     assertSelected(c)
     legacyReviewRef.current = { review: recovery, context: c }
     setLegacyRecoveryReview(recovery)
   })
 const archiveLegacyRequest = (acknowledgments: {
   uncertainty: boolean
   stoppedPrompts: boolean
 }) =>
   run('updating', async () => {
     if (reviewReject.current)
       throw Error('Finish or cancel the current owner action review first')
     const prepared = legacyReviewRef.current
     if (!prepared)
       throw Error('Review the old Testnet request before archiving')
     const c = prepared.context
     assertSelected(c)
     const receipt = await confirmLegacyRecoveryRequest(
       localStorage,
       prepared.review,
       acknowledgments,
       (path, body) => api<unknown>(c.network, path, 'POST', body),
       () => selected(c),
     )
     assertSelected(c)
     legacyReviewRef.current = null
     setLegacyRecoveryReview(null)
     setLegacyRecoveryReceipts((old) => [
       receipt,
       ...old.filter((r) => r.id !== receipt.id),
     ])
     applyPending(readTerminalPending(localStorage, c.network, c.account!))
     setLegacyRecoveryMessage(
       'Old request archived as UNKNOWN. The old request was not retried. Verify the API-wallet grant before a separately reviewed Testnet action.',
     )
     await refreshLegacyJournal().catch(() => undefined)
   })
 const prepare=async(kind:HlTerminalKind,input:HlTerminalInput)=>{
  const c=ensureReady(),packet=await api<HlTerminalPacket>(c.network,'/preview','POST',{kind,coin:'BTC',input});assertSelected(c);if(packet.account.toLowerCase()!==c.account)throw Error('Prepared owner master mismatch');validateTerminalPacket(packet,Date.now());return{packet,c,signingMode:terminalAgentReady(agentRef.current,c.network,c.account,Date.now())?'agent' as const:'owner' as const}
 }
 const submitPacket=async(packet:HlTerminalPacket,c:Context,signingMode:'owner'|'agent')=>{
  assertSelected(c);ensureReady();validateTerminalPacket(packet,Date.now());if(signingMode==='agent'&&!terminalAgentReady(agentRef.current,c.network,c.account,Date.now()))throw Error('Testnet API wallet expired or unavailable. Verify it before another action.');let record=makeTerminalPending(packet)
  persistTerminalPending(localStorage,record);applyPending(record)
  const guarded=()=>{try{return selected(c)&&readTerminalPending(localStorage,c.network,packet.account)?.packetId===packet.id}catch{return false}}
  let result:HlTerminalResult
  try{
   if(signingMode==='agent'){
    if(!guarded())throw Error('Owner action selection changed');const executed=await api<HlTerminalAgentExecution>(c.network,'/agent/execute','POST',{packet});if(executed.packetId!==packet.id)throw Error('Agent execution packet mismatch');if(executed.state==='REJECTED'&&!executed.result){clearTerminalPending(localStorage,record);if(selected(c))applyPending(null);throw new TerminalSubmissionError(executed.reason??'Agent action rejected before submission',false)}if(['UNKNOWN','SUBMITTING'].includes(executed.state)||!executed.result)throw Error(executed.reason??'Agent execution unresolved. Reconcile before another action.');result=executed.result
   }else result=await submitTerminalAction(packet,ownerWallet(),async()=>{if(!guarded())throw Error('Owner action selection changed');const validated=await api<HlTerminalValidation>(c.network,'/validate','POST',{packet});if(validated.valid!==true)throw Error('Native action authorization unavailable');scopedSnapshot(validated.snapshot,c)},guarded)
   record=withTerminalReceipt(record,result)
   if(result.kind==='REJECTED'){clearTerminalPending(localStorage,record);if(selected(c))applyPending(null);throw new Error(`Native action rejected: ${result.orders.map(o=>o.reason).filter(Boolean).join('; ')||result.reason||'Provider rejected the reviewed action'}`)}
   if(result.kind==='UNKNOWN'){const next={...record,message:'Native action result unknown. Reconcile public IDs/settings before another action; no retry.'};persistTerminalPending(localStorage,next);if(selected(c))applyPending(next)}
   else{const next={...record,message:`Provider response ${result.kind}; protection ${result.protection}. Reconcile before another action. ACK is not a fill or installed stop.`};persistTerminalPending(localStorage,next);if(selected(c)){applyPending(next);setMessage(next.message)}}
  }catch(e){
   if(e instanceof TerminalSubmissionError&&!e.uncertain){clearTerminalPending(localStorage,record);if(selected(c))applyPending(null)}
   else if(readTerminalPending(localStorage,c.network,packet.account)?.packetId===packet.id){const next={...record,message:'Native result unresolved. Reconcile before another signature; no automatic retry.'};persistTerminalPending(localStorage,next);if(selected(c))applyPending(next)}
   throw e
  }
  if(selected(c)){await reconcile().catch(e=>setError(messageOf(e)));await refresh().catch(()=>null);await refreshHistory(true)}
  if(result.kind==='UNKNOWN'||result.protection==='UNKNOWN')throw Error('Unknown native result/protection. Reconciliation is required; no automatic retry.')
  if(result.kind==='PARTIAL'||result.protection==='REJECTED'){if(selected(c))setMessage(`PARTIAL: ${result.orders.map(o=>`${o.role} ${o.kind}${o.reason?`: ${o.reason}`:''}`).join('; ')}. Native position/stop installation must be inspected.`);throw Error('Native action partially completed or protection rejected. Inspect refreshed position/orders before another action.')}
  return result
 }
 const reviewed=async(kind:HlTerminalKind,input:HlTerminalInput)=>{
  const {packet,c,signingMode}=await prepare(kind,input);setBusy(false);setStatus('idle')
  return await new Promise<HlTerminalResult>((resolve,reject)=>{
   let settled=false,submitting=false
   const cancel=()=>{if(settled||submitting)return;settled=true;reviewReject.current=null;setReview(null);reject(new Error('Owner review cancelled'))}
   reviewReject.current=e=>{if(settled)return;settled=true;setReview(null);reject(e)}
   const confirm=async()=>{if(settled||submitting)return;submitting=true;setBusy(true);setStatus('executing');try{const result=await submitPacket(packet,c,signingMode);if(!settled){settled=true;resolve(result)}}catch(e){if(!settled){settled=true;reject(e)}}finally{reviewReject.current=null;if(selected(c))setReview(null)}}
   setReview({packet,signingMode,confirm,cancel})
  })
 }
 const previewOrder=(input:AdvancedOrderInput)=>run('previewing',async()=>{const {packet,signingMode}=await prepare('order',toHyperliquidOrderInput(input));const s=dataRef.current?.snapshot;if(!s)throw Error('Native settings unavailable');for(const[id,p]of packets.current)if(p.packet.expiresAfter<=Date.now())packets.current.delete(id);packets.current.set(packet.id,{packet,signingMode});return mapHyperliquidPreview(packet,input,mapHyperliquidSnapshot(s).settings)})
 const executeOrder=(input:{previewId:string;confirmation?:string})=>run('executing',async()=>{const p=packets.current.get(input.previewId);if(!p)throw Error('Owner preview expired or selection changed; review again');packets.current.delete(input.previewId);return submitPacket(p.packet,ensureReady(),p.signingMode)})
 const settingsAction=(leverage:number,marginType:ExchangeMarginType)=>run('updating',async()=>{await reviewed('settings',{leverage,marginType:marginType==='CROSSED'?'cross':'isolated'});const s=dataRef.current?.snapshot;if(!s||s.leverage!==leverage||s.marginType!==(marginType==='CROSSED'?'cross':'isolated'))throw Error('Settings acknowledged but native value is not confirmed; reconcile before another action.');return mapHyperliquidSnapshot(s).settings})
 const changeLeverage=(input:{direction:PositionDirection;leverage:number;confirmation?:string})=>settingsAction(input.leverage,dataRef.current?.snapshot?.marginType==='isolated'?'ISOLATED':'CROSSED')
 const changeMarginType=(input:{marginType:ExchangeMarginType;confirmation?:string})=>{const s=dataRef.current?.snapshot;if(!s)return Promise.reject(new Error('Native leverage unavailable'));return settingsAction(s.leverage,input.marginType)}
 const requirePosition=(id:string)=>{const s=dataRef.current?.snapshot;if(!s||id!==`${s.network}:BTC`||Number(s.position)===0)throw Error('Selected native BTC position is no longer available');return s}
 const closePosition=(id:string,input:{quantity?:number;confirmation?:string})=>run('executing',async()=>{requirePosition(id);return reviewed('close',{...(input.quantity!==undefined?{size:String(input.quantity)}:{}),maxSlippageBps:25})})
 const cancelOrder=(id:string,input:{symbol:string;clientOrderId?:string;confirmation?:string})=>run('executing',async()=>{if(input.symbol!=='BTC-USD')throw Error('Unsupported cancellation instrument');return reviewed('cancel',{oid:id})})
 const amendOrder=(id:string,input:{symbol:string;clientOrderId?:string;quantity:number;confirmation?:string})=>run('executing',async()=>{const order=dataRef.current?.snapshot?.openOrders.find(o=>String(o.oid)===id&&o.coin==='BTC');if(input.symbol!=='BTC-USD'||!order)throw Error('Native order unavailable');if(order.isTrigger)throw Error('Amending an existing native trigger is unsupported. Cancel it separately before reviewing new protection.');return reviewed('amend',{oid:id,price:order.limitPx,size:String(input.quantity)})})
 const updatePositionProtection=(id:string,input:PositionProtectionInput)=>run('executing',async()=>{requirePosition(id);if(input.workingType!=='MARK_PRICE')throw Error('Native protection requires Mark price');if(input.orderId)throw Error('Amending an existing native trigger is unsupported. Cancel it separately before reviewing new protection.');return reviewed('protection',{[input.kind==='STOP_LOSS'?'stopLoss':'takeProfit']:String(input.stopPrice),triggerSource:'MARK_PRICE',maxSlippageBps:25})})
 const snapshot=enabled?data?.snapshot??null:null,mapped=snapshot?mapHyperliquidSnapshot(snapshot):null
 const session:ExchangeSessionState={connected:Boolean(snapshot),liveTradingEnabled:false,liveTriggerOrdersEnabled:false,snapshot:mapped?.snapshot}
 const signingIssue=enabled&&network==='testnet'&&!terminalAgentReady(agentStatus,network,snapshot?.account??null,now)&&ownerSigningIssue(availableOwnerWallet())?'Connect a Testnet API wallet in the execution account chooser to enable trading with Phantom.':null
 const writesEnabled=terminalWritesReady(enabled?data:null,now,pending,enabled)&&!busy&&!agentBusy&&!review&&!signingIssue
 return{legacyRecoveryReview:enabled&&network==='testnet'?legacyRecoveryReview:null,legacyRecoveryReceipts:enabled&&network==='testnet'?legacyRecoveryReceipts:[],legacyRecoveryMessage:enabled?legacyRecoveryMessage:'',reviewLegacyRequest,archiveLegacyRequest,agentStatus:enabled&&network==='testnet'?agentStatus:null,agentApproval:enabled&&network==='testnet'?agentApproval:null,agentBusy:enabled&&agentBusy,agentMessage:enabled?agentMessage:'',prepareAgent,approveAgent,refreshAgent,disableAgent,data:enabled?data:null,snapshot,session,tradingSettings:mapped?.settings??null,settings:mapped?.settings??null,contract:mapped?.contract??null,contracts:mapped?[mapped.contract]:[],availableMargin:mapped?.availableMargin??0,equity:mapped?.equity??0,history,historyLoading,settingsLoading:status==='checking'||Boolean(snapshot&&!mapped),status:enabled?status:'idle' as AccountStatus,error:enabled?signingIssue||error:null,message:enabled?signingIssue||message:'',writesEnabled,busy:enabled&&busy,pending:enabled?pending:null,review:enabled?review:null,refresh,refreshHistory,previewOrder,executeOrder,changeLeverage,changeMarginType,closePosition,cancelOrder,amendOrder,updatePositionProtection,reconcile}
}
