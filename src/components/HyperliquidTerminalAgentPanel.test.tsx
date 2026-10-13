import React from 'react'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {renderToStaticMarkup} from 'react-dom/server'
import {HyperliquidTerminalAgentPanel} from './HyperliquidTerminalAgentPanel'
import type {HlTerminalAgentApproval,HlTerminalAgentStatus} from '../../shared/hyperliquidTerminalAgent'
const now=Date.now(),approval:HlTerminalAgentApproval={network:'testnet',account:'0x'+'1'.repeat(40),id:'one',agentAddress:'0x'+'2'.repeat(40),agentName:`AntyTILT-Trade valid_until ${now+1800000}`,expiresAt:now+1800000,nonce:now,reviewExpiresAt:now+60000,checkedAt:now}
const props={busy:false,message:'',onPrepare:async()=>{},onApprove:async()=>{},onRefresh:async()=>{},onDisable:async()=>{}}
test('candidate makes exact native authority, custody, expiry and addresses visible before owner approval',()=>{const html=renderToStaticMarkup(<HyperliquidTerminalAgentPanel {...props} status={null} approval={approval}/>);for(const x of[approval.account,approval.agentAddress,approval.agentName,'30 minutes','encrypted','broader','Confirm in Phantom','signing domain'])assert.ok(html.includes(x),x)})
test('active signer offers local disable and explains native grant remains',()=>{const status:HlTerminalAgentStatus={...approval,phase:'ACTIVE',reason:'Verified',checkedAt:now};const html=renderToStaticMarkup(<HyperliquidTerminalAgentPanel {...props} status={status} approval={null}/>);assert.match(html,/Active/);assert.match(html,/Disable locally/);assert.match(html,/does not revoke/);assert.doesNotMatch(html,/Confirm in Phantom/)})
test('expired approval cannot be signed',()=>{const html=renderToStaticMarkup(<HyperliquidTerminalAgentPanel {...props} status={null} approval={{...approval,reviewExpiresAt:now-1}}/>);assert.match(html,/<button[^>]+disabled=""[^>]*>Confirm in Phantom/);assert.match(html,/Verify native grant/)})
