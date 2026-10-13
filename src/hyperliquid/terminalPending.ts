import {
  parseExactLegacyRaw,
  parseExactCanonicalClientOnlyEvidence, canonicalRecoveryIdentityText, HL_CANONICAL_RECOVERY_PACKET, HL_LEGACY_RECOVERY_ACCOUNT, HL_LEGACY_RECOVERY_CLOID,
  type HlLegacyRecoveryReview,
  type HlLegacyRecoveryReceipt,
} from '../../shared/hyperliquidLegacyRecovery'
import type { HlTerminalAction, HlTerminalNetwork, HlTerminalPacket, HlTerminalReconcile, HlTerminalResult } from '../../shared/hyperliquidTerminal'
export type PendingStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export type TerminalPending = { version: 1; network: HlTerminalNetwork; account: string; packetId?: string; action: HlTerminalAction | null; ids: string[]; createdAt: number; expiresAfter?: number; message: string; legacy: boolean; invalid?: boolean; knownIds?: string[]; recoveryInDoubt?: boolean }
export const manualPendingStorageKey = (account: string, network: HlTerminalNetwork) => `antytilt:hl:manual-pending:${network}:${account.toLowerCase()}`
export const terminalPendingStorageKey = (account: string, network: HlTerminalNetwork) => `antytilt:hl:terminal-pending:${network}:${account.toLowerCase()}`
const validId = (id: unknown): id is string => typeof id === 'string' && (/^0x[0-9a-f]{32}$/.test(id) || /^\d+$/.test(id))
export function makeTerminalPending(p: HlTerminalPacket): TerminalPending {
 const a = p.action
 const ids = a.type === 'order' ? a.orders.map(o => o.c) : a.type === 'batchModify' ? a.modifies.flatMap(m => [m.order.c, String(m.oid)]) : a.type === 'cancel' ? a.cancels.map(c => String(c.o)) : []
 return { version: 1, network: p.network, account: p.account.toLowerCase(), packetId: p.id, action: structuredClone(a), ids: [...new Set(ids)], createdAt: p.createdAt, expiresAfter: p.expiresAfter, message: 'Owner signing/submission pending. Reconcile before another action.', legacy: false }
}
export function readTerminalPending(s: PendingStorage, network: HlTerminalNetwork, account: string): TerminalPending | null {
 const marker = s.getItem(canonicalRecoveryInDoubtStorageKey(account,network))
 if(marker!==null){
  let saved:TerminalPending|null=null
  try{const m=exactMarker(marker,network,account);parseExactCanonicalClientOnlyEvidence(m.receipt.raw,m.receipt.storageKey,m.receipt.mirrorRaw,m.receipt.mirrorStorageKey,network,account);saved=JSON.parse(m.receipt.raw)}catch{/* Preserve malformed marker as a blocker. */}
  return {...(saved??{version:1,network,account:account.toLowerCase(),action:null,ids:account.toLowerCase()===HL_LEGACY_RECOVERY_ACCOUNT?[HL_LEGACY_RECOVERY_CLOID]:[],createdAt:0,legacy:false}),invalid:true,recoveryInDoubt:true,message:'Local archive retirement is in doubt. New signatures remain blocked; explicitly review exact recovery evidence.'}
 }
 const canonical = s.getItem(terminalPendingStorageKey(account,network)), legacy = s.getItem(manualPendingStorageKey(account,network))
 const invalid = (): TerminalPending => ({ version:1,network,account:account.toLowerCase(),action:null,ids:[],createdAt:0,message:'Stored action is unreadable. New signatures remain blocked; inspect native account and recover pending evidence.',legacy:!canonical,invalid:true })
 if (!canonical && !legacy) return null
 try {
  if (canonical) {
   const p = JSON.parse(canonical) as TerminalPending
   if (Object.prototype.hasOwnProperty.call(p,'recoveryInDoubt') || p.version !== 1 || p.network !== network || p.account?.toLowerCase() !== account.toLowerCase() || !Array.isArray(p.ids) || p.ids.length > 8 || !p.ids.every(validId) || !p.packetId || typeof p.message !== 'string' || (p.knownIds && (!Array.isArray(p.knownIds) || !p.knownIds.every(id => p.ids.includes(id)))) || !p.action || !['order','cancel','batchModify','updateLeverage'].includes(p.action.type)) return invalid()
   return p
  }
  const value = JSON.parse(legacy!)
  if (value.terminalPacketId) return invalid() // A terminal mirror without its canonical record is not safe to forget.
  if (!validId(value.cloid)) return invalid()
  return { version:1,network,account:account.toLowerCase(),action:null,ids:[value.cloid],createdAt:0,message:typeof value.message === 'string' ? value.message : 'Legacy manual action unresolved; reconcile before another action.',legacy:true }
 } catch { return invalid() }
}
export function persistTerminalPending(s: PendingStorage,p: TerminalPending) {
 const existing = readTerminalPending(s,p.network,p.account)
 if (existing && (existing.invalid || existing.legacy || existing.packetId !== p.packetId)) throw Error('An existing action requires reconciliation before another signature')
 s.setItem(terminalPendingStorageKey(p.account,p.network),JSON.stringify(p))
 // The old panel's raw-key gate must also remain occupied, including settings that have no cloid.
 s.setItem(manualPendingStorageKey(p.account,p.network),JSON.stringify({ cloid:p.ids.find(id=>id.startsWith('0x')) ?? null, unknown:true, message:p.message, terminalPacketId:p.packetId }))
}
export function clearTerminalPending(s: PendingStorage,p: TerminalPending) {
 const current = readTerminalPending(s,p.network,p.account)
 if (!current || current.invalid || (p.legacy ? !current.legacy || current.ids.join(',') !== p.ids.join(',') : current.packetId !== p.packetId)) return
 if (!p.legacy) s.removeItem(terminalPendingStorageKey(p.account,p.network))
 const raw = s.getItem(manualPendingStorageKey(p.account,p.network))
 if (raw) { try { const mirror = JSON.parse(raw); if (p.legacy ? mirror.cloid === p.ids[0] : mirror.terminalPacketId === p.packetId) s.removeItem(manualPendingStorageKey(p.account,p.network)) } catch { /* Preserve unreadable evidence. */ } }
}
const observed = new Set(['open','filled','canceled','rejected','triggered'])
export function pendingCanResolve(p:TerminalPending,r:HlTerminalReconcile):boolean {
 if (p.invalid || r.network !== p.network || r.snapshot.network !== p.network || r.snapshot.account.toLowerCase() !== p.account.toLowerCase() || !Number.isFinite(r.snapshot.checkedAt) || Date.now()-r.snapshot.checkedAt>30000 || r.snapshot.checkedAt>Date.now()+5000) return false
 if (p.action?.type === 'updateLeverage') return r.snapshot.leverage === p.action.leverage && r.snapshot.marginType === (p.action.isCross ? 'cross' : 'isolated')
 if (!p.ids.length) return false
 if (p.action?.type === 'cancel') return p.ids.every(id => r.orders.some(o => o.id === id && (['filled','canceled','rejected'].includes(o.status) || o.status.endsWith('Canceled') || o.status.endsWith('Rejected'))))
 const known = (status:string) => observed.has(status) || status.endsWith('Canceled') || status.endsWith('Rejected')
 const receipt = (id:string) => Boolean(p.knownIds?.includes(id))
 if (p.action?.type === 'batchModify') return p.action.modifies.every(m => receipt(m.order.c) || r.orders.some(o => o.id === m.order.c && known(o.status)))
 return p.ids.every(id => receipt(id) || r.orders.some(o => o.id === id && known(o.status)))
}

export function withTerminalReceipt(p: TerminalPending, result: HlTerminalResult): TerminalPending {
 const ids = result.orders.filter(o=>o.kind!=='UNKNOWN' && o.cloid && p.ids.includes(o.cloid)).map(o=>o.cloid!)
 return {...p,knownIds:[...new Set([...(p.knownIds??[]),...ids])]}
}

export function readLegacyRecoveryEvidence(
  s: PendingStorage,
  network: HlTerminalNetwork,
  account: string,
) {
  if (s.getItem(terminalPendingStorageKey(account, network)) !== null)
    throw Error(
      'Canonical terminal evidence exists; legacy retirement is unavailable',
    )
  const storageKey = manualPendingStorageKey(account, network),
    raw = s.getItem(storageKey)
  const value = parseExactLegacyRaw(raw, storageKey, network, account)
  return {
    network: 'testnet' as const,
    account: account.toLowerCase(),
    storageKey,
    raw: raw!,
    cloid: value.cloid,
  }
}
export const legacyArchiveStorageKey = (
  r: Pick<HlLegacyRecoveryReceipt, 'account' | 'cloid' | 'rawHash' | 'evidenceHash'>,
) => `antytilt:hl:legacy-archive:testnet:${r.account}:${r.cloid}:${r.evidenceHash??r.rawHash}`
export async function retireLegacyPending(
  s: PendingStorage,
  review: HlLegacyRecoveryReview,
  receipt: HlLegacyRecoveryReceipt,
  selected: () => boolean,
) {
  if(review.format==='CANONICAL_CLIENT_ONLY')return retireExactCanonicalPending(s,review,receipt,selected)
  const guard = () => {
    if (!selected())
      throw Error('Legacy recovery account/network selection changed')
  }
  guard()
  const old = readLegacyRecoveryEvidence(s, review.network, review.account)
  if (
    old.raw !== review.raw ||
    old.storageKey !== review.storageKey ||
    old.cloid !== review.cloid
  )
    throw Error('Legacy pending bytes changed; review again')
  const bytes = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(old.raw),
    ),
    hash = Array.from(new Uint8Array(bytes), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('')
  guard()
  const matches = (
    r: Pick<
      HlLegacyRecoveryReview,
      | 'network'
      | 'account'
      | 'storageKey'
      | 'raw'
      | 'rawHash'
      | 'cloid'
      | 'outcome'
    >,
  ) =>
    r &&
    r.network === 'testnet' &&
    r.account === old.account &&
    r.storageKey === old.storageKey &&
    r.raw === old.raw &&
    r.rawHash === hash &&
    r.cloid === old.cloid &&
    r.outcome === 'UNKNOWN'
  if (
    !matches(review) ||
    !receipt ||
    !matches(receipt) ||
    !matches(receipt.review) ||
    typeof receipt.id !== 'string' ||
    !receipt.id ||
    !Number.isFinite(receipt.retiredAt) ||
    receipt.acknowledgments?.uncertainty !== true ||
    receipt.acknowledgments?.stoppedPrompts !== true
  )
    throw Error(
      'Exact authenticated UNKNOWN archive receipt required; legacy blocker preserved',
    )
  const serialized = JSON.stringify(receipt),
    archiveKey = legacyArchiveStorageKey(receipt)
  const previous = s.getItem(archiveKey)
  if (previous !== null && previous !== serialized)
    throw Error(
      'Existing local archive differs; evidence cannot be overwritten',
    )
  guard()
  s.setItem(archiveKey, serialized)
  if (s.getItem(archiveKey) !== serialized)
    throw Error('Archive readback failed; legacy blocker preserved')
  guard()
  const current = readLegacyRecoveryEvidence(s, review.network, review.account)
  if (current.raw !== old.raw)
    throw Error('Legacy pending changed during archive; blocker preserved')
  // No await between this last compare and the exact-key retirement.
  s.removeItem(old.storageKey)
  return receipt
}

// This marker has only one authorized target; it never grants generic retirement.
export const canonicalRecoveryInDoubtStorageKey = (
  account: string,
  network: HlTerminalNetwork,
) =>
  `antytilt:hl:canonical-recovery-in-doubt:${network}:${account.toLowerCase()}:${HL_CANONICAL_RECOVERY_PACKET}`
export function readExactRecoveryEvidence(
  s: PendingStorage,
  network: HlTerminalNetwork,
  account: string,
) {
  const storageKey = terminalPendingStorageKey(account, network),
    raw = s.getItem(storageKey)
  if (raw === null)
    return {
      ...readLegacyRecoveryEvidence(s, network, account),
      format: 'LEGACY' as const,
    }
  const mirrorStorageKey = manualPendingStorageKey(account, network),
    mirrorRaw = s.getItem(mirrorStorageKey)
  parseExactCanonicalClientOnlyEvidence(
    raw,
    storageKey,
    mirrorRaw,
    mirrorStorageKey,
    network,
    account,
  )
  return {
    format: 'CANONICAL_CLIENT_ONLY' as const,
    network: 'testnet' as const,
    account,
    cloid: HL_LEGACY_RECOVERY_CLOID,
    packetId: HL_CANONICAL_RECOVERY_PACKET,
    storageKey,
    raw,
    mirrorStorageKey,
    mirrorRaw: mirrorRaw!,
  }
}
const recoverySha = async (raw: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('')
async function validateCanonicalReceipt(
  review: HlLegacyRecoveryReview,
  receipt: HlLegacyRecoveryReceipt,
) {
  if (!receipt || !review || review.format !== 'CANONICAL_CLIENT_ONLY')
    throw Error('Exact authenticated canonical UNKNOWN receipt required')
  parseExactCanonicalClientOnlyEvidence(
    review.raw,
    review.storageKey,
    review.mirrorRaw,
    review.mirrorStorageKey,
    review.network,
    review.account,
  )
  const rawHash = await recoverySha(review.raw),
    mirrorHash = await recoverySha(review.mirrorRaw!),
    evidenceHash = await recoverySha(canonicalRecoveryIdentityText(review))
  const matches = (r: HlLegacyRecoveryReview | HlLegacyRecoveryReceipt) =>
    r &&
    r.format === 'CANONICAL_CLIENT_ONLY' &&
    r.network === 'testnet' &&
    r.account === review.account &&
    r.cloid === HL_LEGACY_RECOVERY_CLOID &&
    r.packetId === HL_CANONICAL_RECOVERY_PACKET &&
    r.storageKey === review.storageKey &&
    r.raw === review.raw &&
    r.rawHash === rawHash &&
    r.mirrorStorageKey === review.mirrorStorageKey &&
    r.mirrorRaw === review.mirrorRaw &&
    r.mirrorHash === mirrorHash &&
    r.evidenceHash === evidenceHash &&
    r.outcome === 'UNKNOWN'
  if (
    !matches(review) ||
    !matches(receipt) ||
    !matches(receipt.review) ||
    typeof receipt.id !== 'string' ||
    !receipt.id ||
    !Number.isFinite(receipt.retiredAt) ||
    receipt.acknowledgments?.uncertainty !== true ||
    receipt.acknowledgments?.stoppedPrompts !== true ||
    !/^[0-9a-f]{64}$/.test(review.seal) ||
    !/^[0-9a-f]{64}$/.test(receipt.review.seal)
  )
    throw Error('Exact authenticated canonical UNKNOWN receipt required')
}
function exactMarker(raw: string, network: HlTerminalNetwork, account: string) {
  let m
  try {
    m = JSON.parse(raw)
  } catch {
    throw Error('Local archive marker is unreadable; blocker preserved')
  }
  if (
    !m ||
    Object.keys(m).sort().join(',') !==
      'account,network,packetId,receipt,state,version' ||
    m.version !== 1 ||
    m.state !== 'IN_DOUBT' ||
    m.network !== 'testnet' ||
    network !== 'testnet' ||
    m.account !== account ||
    account !== HL_LEGACY_RECOVERY_ACCOUNT ||
    m.packetId !== HL_CANONICAL_RECOVERY_PACKET
  )
    throw Error('Exact local archive marker required; blocker preserved')
  return m as {
    version: 1
    state: 'IN_DOUBT'
    network: 'testnet'
    account: string
    packetId: string
    receipt: HlLegacyRecoveryReceipt
  }
}
export async function restoreExactCanonicalRecoveryInDoubt(
  s: PendingStorage,
  network: HlTerminalNetwork,
  account: string,
  selected: () => boolean,
) {
  const key = canonicalRecoveryInDoubtStorageKey(account, network),
    raw = s.getItem(key)
  if (raw === null) return
  const m = exactMarker(raw, network, account),
    r = m.receipt
  await validateCanonicalReceipt(r.review, r)
  if (
    !selected() ||
    s.getItem(key) !== raw ||
    s.getItem(legacyArchiveStorageKey(r)) !== JSON.stringify(r)
  )
    throw Error('Local archive marker/selection changed; blocker preserved')
  const pairs = [
    [r.storageKey, r.raw],
    [r.mirrorStorageKey!, r.mirrorRaw!],
  ]
  // Compare every key before restoring any; a replacement is never overwritten.
  for (const [k, v] of pairs) {
    const current = s.getItem(k)
    if (current !== null && current !== v)
      throw Error('New pending evidence exists; local archive remains in doubt')
  }
  for (const [k, v] of pairs) {
    if (!selected() || s.getItem(key) !== raw)
      throw Error('Local archive selection changed; blocker preserved')
    const current = s.getItem(k)
    if (current === null) s.setItem(k, v)
    else if (current !== v)
      throw Error('Pending evidence changed; blocker preserved')
    if (s.getItem(k) !== v)
      throw Error(
        'Captured pending restoration failed; local archive remains in doubt',
      )
  }
  // The marker stays until a new explicit review and successful retirement.
}
async function retireExactCanonicalPending(
  s: PendingStorage,
  review: HlLegacyRecoveryReview,
  receipt: HlLegacyRecoveryReceipt,
  selected: () => boolean,
) {
  const guard = () => {
    if (!selected()) throw Error('Recovery account/network selection changed')
  }
  guard()
  const old = readExactRecoveryEvidence(s, review.network, review.account)
  if (
    old.format !== 'CANONICAL_CLIENT_ONLY' ||
    old.raw !== review.raw ||
    old.mirrorRaw !== review.mirrorRaw
  )
    throw Error('Canonical/mirror bytes changed; review again')
  await validateCanonicalReceipt(review, receipt)
  guard()
  const archiveKey = legacyArchiveStorageKey(receipt),
    serialized = JSON.stringify(receipt),
    previous = s.getItem(archiveKey)
  if (previous !== null && previous !== serialized)
    throw Error(
      'Existing local archive differs; evidence cannot be overwritten',
    )
  s.setItem(archiveKey, serialized)
  if (s.getItem(archiveKey) !== serialized)
    throw Error('Archive readback failed; blocker preserved')
  guard()
  const markerKey = canonicalRecoveryInDoubtStorageKey(
      review.account,
      review.network,
    ),
    existingMarker = s.getItem(markerKey)
  if (existingMarker !== null) {
    const m = exactMarker(existingMarker, review.network, review.account)
    await validateCanonicalReceipt(m.receipt.review, m.receipt)
    guard()
    if (
      s.getItem(markerKey) !== existingMarker ||
      s.getItem(legacyArchiveStorageKey(m.receipt)) !==
        JSON.stringify(m.receipt) ||
      m.receipt.raw !== review.raw ||
      m.receipt.mirrorRaw !== review.mirrorRaw
    )
      throw Error('Existing local archive marker differs; blocker preserved')
  }
  const marker = JSON.stringify({
    version: 1,
    state: 'IN_DOUBT',
    network: review.network,
    account: review.account,
    packetId: review.packetId,
    receipt,
  })
  // Durable local blocker precedes both removals, including on explicit retry.
  s.setItem(markerKey, marker)
  if (s.getItem(markerKey) !== marker)
    throw Error('Local archive marker readback failed; blocker preserved')
  const pairs = [
    [review.storageKey, review.raw],
    [review.mirrorStorageKey!, review.mirrorRaw!],
  ]
  try {
    guard()
    for (const [k, v] of pairs)
      if (s.getItem(k) !== v) throw Error('Canonical/mirror bytes changed')
    // No awaits from final comparisons through removals/readbacks/last marker cleanup.
    for (const [k, v] of pairs) {
      guard()
      if (s.getItem(k) !== v)
        throw Error('Pending evidence changed before removal')
      s.removeItem(k)
    }
    for (const [k] of pairs)
      if (s.getItem(k) !== null)
        throw Error('Pending-key removal readback failed')
    guard()
    if (s.getItem(markerKey) !== marker)
      throw Error('Local archive marker changed')
    s.removeItem(markerKey)
    if (s.getItem(markerKey) !== null)
      throw Error('Local archive marker cleanup failed')
  } catch (error) {
    try {
      if (s.getItem(markerKey) === null) s.setItem(markerKey, marker)
    } catch {
      /* Original records or surviving marker keep signing blocked. */
    }
    // Restore only missing captured records; never overwrite new evidence. Marker stays.
    if (selected())
      for (const [k, v] of pairs) {
        try {
          if (s.getItem(k) === null) s.setItem(k, v)
        } catch {
          /* The marker blocks reload even when rollback storage fails. */
        }
      }
    throw Error(
      `Local archive retirement is in doubt; new signatures remain blocked. ${error instanceof Error ? error.message : 'Storage failed'}`,
    )
  }
  return receipt
}
