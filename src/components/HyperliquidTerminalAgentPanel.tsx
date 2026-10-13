import React,{useEffect,useState} from 'react'
import type {HlTerminalAgentApproval,HlTerminalAgentStatus} from '../../shared/hyperliquidTerminalAgent'
export type HyperliquidTerminalAgentPanelProps={status:HlTerminalAgentStatus|null;approval:HlTerminalAgentApproval|null;busy:boolean;message:string;onPrepare:()=>Promise<void>;onApprove:()=>Promise<void>;onRefresh:()=>Promise<void>;onDisable:()=>Promise<void>}
export function HyperliquidTerminalAgentPanel({status,approval,busy,message,onPrepare,onApprove,onRefresh,onDisable}:HyperliquidTerminalAgentPanelProps){
 const[now,setNow]=useState(Date.now),[error,setError]=useState('')
 useEffect(()=>{const timer=window.setInterval(()=>setNow(Date.now()),1000);return()=>window.clearInterval(timer)},[])
 const active=status?.phase==='ACTIVE'&&Boolean(status.expiresAt&&status.expiresAt>now),candidate=approval?.network==='testnet'?approval:null,shown=candidate??status
 const attempt=(fn:()=>Promise<void>)=>{setError('');void fn().catch(e=>setError(e instanceof Error?e.message:'Agent action unavailable'))}
 const canPrepare=!busy&&(!candidate||candidate.reviewExpiresAt<=now)&&(!status||['MISSING','PREPARED','DISABLED','EXPIRED','REVOKED'].includes(status.phase))
 return <section className="execution-network hl-grant" aria-label="Hyperliquid Testnet API wallet" aria-busy={busy}>
  <strong>Testnet API wallet · {active?'Active':candidate?'Review approval':status?.phase==='PREPARED'?'Verify approval':status?.phase==='UNAVAILABLE'?'Unavailable':'Not active'}</strong>
  {shown?.account&&<dl className="hl-facts"><div><dt>Master EOA</dt><dd style={{overflowWrap:'anywhere'}}>{shown.account}</dd></div>{shown.agentAddress&&<div><dt>API wallet</dt><dd style={{overflowWrap:'anywhere'}}>{shown.agentAddress}</dd></div>}{shown.agentName&&<div><dt>Native name</dt><dd style={{overflowWrap:'anywhere'}}>{shown.agentName}</dd></div>}{shown.expiresAt&&<div><dt>Native expiry</dt><dd>{new Date(shown.expiresAt).toLocaleString()} · {Math.max(0,Math.ceil((shown.expiresAt-now)/1000))}s remaining</dd></div>}</dl>}
  {candidate&&<><p>Fresh API wallet for 30 minutes. Its key stays encrypted in local server custody, separate from the protection signer.</p><p>Native Testnet trading authority is broader than the app’s BTC and size guards. Each order requires your manual confirmation.</p><p>Phantom signs an Ethereum signing domain (current supported chain, otherwise chain 1). The approval names Hyperliquid Testnet; this sends no Ethereum transaction.</p><p>{candidate.reviewExpiresAt>now?`Approval review expires in ${Math.ceil((candidate.reviewExpiresAt-now)/1000)}s.`:'The 60-second confirmation window expired. Use Prepare Testnet API wallet to refresh it. Native expiry is shown separately.'}</p></>}
  {active&&<p>Testnet actions are signed by this approved API wallet. Mainnet writes are blocked.</p>}
  {!candidate&&!active&&<p>{status?.reason||'Prepare a separate 30-minute Testnet signer, then review its authority before approving in Phantom.'}</p>}
  {(shown?.id)&&<p>Disable locally destroys the local key and does not revoke the native grant. It expires at the time shown above.</p>}
  {(message||error)&&<p className="exchange-error" role="status">{error||message}</p>}
  <div className="hl-actions"><button type="button" disabled={!canPrepare} onClick={()=>attempt(onPrepare)}>Prepare Testnet API wallet</button>{candidate&&!active&&<button type="button" disabled={busy||candidate.reviewExpiresAt<=now||candidate.expiresAt<=now} onClick={()=>attempt(onApprove)}>Confirm in Phantom</button>}<button type="button" disabled={busy} onClick={()=>attempt(onRefresh)}>Verify native grant</button>{shown?.id&&<button type="button" disabled={busy} onClick={()=>attempt(onDisable)}>Disable locally</button>}</div>
 </section>
}
