import type { HlTerminalResult } from './hyperliquidTerminal'

export type HlTerminalAgentPhase = 'MISSING' | 'PREPARED' | 'ACTIVE' | 'EXPIRED' | 'REVOKED' | 'DISABLED' | 'UNAVAILABLE'
export interface HlTerminalAgentStatus {
  network: 'testnet'
  account: string
  id: string | null
  phase: HlTerminalAgentPhase
  agentAddress: string | null
  agentName: string | null
  expiresAt: number | null
  checkedAt: number
  reason: string
}
export interface HlTerminalAgentApproval {
  network: 'testnet'
  account: string
  id: string
  agentAddress: string
  agentName: string
  expiresAt: number
  nonce: number
  reviewExpiresAt: number
  checkedAt: number
}
export interface HlTerminalAgentExecution {
  network: 'testnet'
  packetId: string
  state: 'CONFIRMED' | 'ACKNOWLEDGED' | 'REJECTED' | 'PARTIAL' | 'UNKNOWN' | 'SUBMITTING'
  result: HlTerminalResult | null
  reason?: string
}
