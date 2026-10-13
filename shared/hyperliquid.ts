/** Wire contract: decimal values are strings; protection readiness and event outcome differ. */
export type HlNetwork = 'testnet'
export type HlProtectionStatus =
  | 'LINKED_READ_ONLY'
  | 'AWAITING_GRANT'
  | 'SYNCING'
  | 'ARMED'
  | 'BREACH_DETECTED'
  | 'CLOSING'
  | 'DATA_GAP'
  | 'DEGRADED'
  | 'UNSUPPORTED_MODE'
  | 'REVOKED'
  | 'EXPIRED'
  | 'DISABLED'
  | 'UNCERTAIN'
  | 'ACTION_FAILED'
export type HlOutcome =
  | 'BREACH_DETECTED'
  | 'CLOSING'
  | 'CONFIRMED_CLOSED'
  | 'MIXED_RESOLUTION'
  | 'RESOLVED_EXTERNALLY'
  | 'PARTIAL'
  | 'UNCERTAIN'
  | 'ACTION_FAILED'
  | 'INFO'
export interface HlPolicy {
  version: number
  dailyEntryLimit: number
  timezone: string
  slippageBps: number
  maxCloseNotionalUsd: string
  consentExpiresAt: number
}
export interface HlConnection {
  id: string
  network: HlNetwork
  account: string
  mode: string | null
  coin: 'BTC'
  status: HlProtectionStatus
  reason: string
  policy: HlPolicy
  day: string
  entryCount: number
  remainingSize: string
  historyComplete: boolean
  agentAddress: string | null
  agentName: string | null
  grantExpiresAt: number | null
  lastCheckedAt: number | null
  workerLastSeenAt: number | null
  enabled: boolean
}
export interface HlEvent {
  id: string
  occurredAt: number
  outcome: HlOutcome
  reason: string
  episodeId: string | null
  intentId: string | null
  providerOrderIds: string[]
  fillIds: string[]
  remainingSize: string
  agentClosedSize: string
  externalClosedSize: string
}
export interface HlStatusResponse {
  connection: HlConnection | null
  events: HlEvent[]
  realActionsEnabled: boolean
  nativeUrl: string
}
export interface HlChallengeResponse {
  id: string
  message: string
  expiresAt: number
}
export interface HlAgentResponse {
  agentAddress: string
  agentName: string
  grantExpiresAt: number
}
export interface HlPolicyInput {
  connectionId: string
  dailyEntryLimit: number
  timezone: string
  slippageBps: number
  maxCloseNotionalUsd: string
  consentExpiresAt: number
}
export const HL_API = '/api/hyperliquid-protection'
export const HL_CONSENT = 'BTC_CURRENT_RESIDUAL_REPLACEMENT_RACE_BROAD_AGENT_NO_CANCEL_V1'
