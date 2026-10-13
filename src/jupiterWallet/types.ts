export interface WalletSession {
  csrf: string
  owner: string | null
  genesis: string
  origin: string
  mode: 'native-rehearsal' | 'live'
  network: string
  senderAvailable: boolean
}
export interface Position {
  position: string
  owner: string
  sizeUsd: string
  collateralUsd: string
  openTime: string
  observedSlot: number
}
export interface TicketView {
  id: string
  status: string
  owner: string
  position: string
  recipient: string
  mint: string
  genesis: string
  floorUsd: string
  maxFeeSol: string
  maxRentSol: string
  sizeUsd: string
  collateralUsd: string
  messageHash: string
  nonce: string
  request: string
  requestAta: string
  signature: string | null
  intentAt: string | null
  detail: string | null
  expiresAt: string
  reviewHash: string
}
export interface Budget {
  feeSol: string
  rentSol: string
  quotedAt: string
  priceQuote: null
  payoutEstimate: null
}
export interface SetupState {
  nonceReady: boolean
  recipientReady: boolean
  nonceValue: string | null
  recipient: string
  nonce: string
}
export interface Action {
  id: string | null
  status: string
  signature: string | null
  preview?: {
    owner: string
    genesis: string
    nonce: string
    recipient: string
    unsignedPacket: string
    messageHash: string
    feeLamports: string
    rentLamports: string
    kind: 'SETUP' | 'REVOKE'
  }
}
