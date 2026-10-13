export type Status =
  | 'PREPARED'
  | 'ARMED'
  | 'SUBMITTING'
  | 'UNKNOWN'
  | 'REQUEST_PENDING'
  | 'FAILED_CONSUMED'
  | 'INVALIDATED'
  | 'DISABLED'
  | 'REVOKED'
  | 'CLOSED'
export interface Binding {
  genesis: string
  owner: string
  position: string
  pool: string
  custody: string
  collateralCustody: string
  side: 'Long'
  mint: string
  recipient: string
  nonce: string
  nonceAuthority: string
  nonceValue: string
  counter: string
  absolutePriceBound: string
  maxFeeLamports: string
  maxRentLamports: string
  triggerEvent: string
  programDeployment: string
  positionHash: string
  sizeUsd: string
  collateralUsd: string
  openTime: string
  observedSlot: number
}
export interface Prepared {
  version: 1 | 2
  binding: Binding
  messageHash: string
  unsignedPacket: string
  request: string
  requestAta: string
}
export interface SignedReceipt {
  signature: string
  packetHash: string
}
export interface Ticket {
  id: string
  prepared: Prepared
  ciphertext: string
  signature: string
  packetHash: string
  status: Status
  intentEvent: string | null
  intentAt: string | null
  detail: string | null
}
export class OperatorError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}
