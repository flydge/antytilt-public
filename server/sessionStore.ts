import { randomBytes } from 'node:crypto'
import type { BingxCredentials, BingxEnvironment, PreparedOrder } from './bingxClient'

export type ExchangeSession = {
  id: string
  accountId: string
  exchange: 'bingx'
  environment: BingxEnvironment
  label: string
  credentials: BingxCredentials
  apiKeyMask: string
  connectedAt: number
  lastAccessAt: number
  writeTimestamps: number[]
  idempotency: Map<string, unknown>
  preparedOrders: Map<string, { expiresAt: number; order: PreparedOrder }>
}

const SESSION_TTL = 12 * 60 * 60 * 1_000
const PREPARED_ORDER_TTL = 90_000
const sessions = new Map<string, ExchangeSession>()

export function connectSession(
  id: string,
  environment: BingxEnvironment,
  credentials: BingxCredentials,
  persisted?: { accountId?: string; label?: string; apiKeyMask?: string; connectedAt?: number },
) {
  const session: ExchangeSession = {
    id,
    accountId: persisted?.accountId ?? id,
    exchange: 'bingx',
    environment,
    label: persisted?.label ?? (environment === 'prod-live' ? 'BingX Live' : 'BingX VST'),
    credentials,
    apiKeyMask: persisted?.apiKeyMask ?? `••••${credentials.apiKey.slice(-4)}`,
    connectedAt: persisted?.connectedAt ?? Date.now(),
    lastAccessAt: Date.now(),
    writeTimestamps: [],
    idempotency: new Map(),
    preparedOrders: new Map(),
  }
  sessions.set(id, session)
  return session
}

export function storePreparedOrder(session: ExchangeSession, order: PreparedOrder) {
  const id = randomBytes(24).toString('base64url')
  const now = Date.now()
  for (const [key, prepared] of session.preparedOrders) {
    if (prepared.expiresAt <= now) session.preparedOrders.delete(key)
  }
  if (session.preparedOrders.size >= 20) {
    const oldest = session.preparedOrders.keys().next().value
    if (oldest) session.preparedOrders.delete(oldest)
  }
  const expiresAt = now + PREPARED_ORDER_TTL
  session.preparedOrders.set(id, { expiresAt, order })
  return { id, expiresAt }
}

export function consumePreparedOrder(session: ExchangeSession, id: string) {
  const prepared = session.preparedOrders.get(id)
  session.preparedOrders.delete(id)
  if (!prepared || prepared.expiresAt <= Date.now()) throw new Error('Order preview expired. Review the order again.')
  return prepared.order
}

export function getSession(id: string | undefined) {
  if (!id) return undefined
  const session = sessions.get(id)
  if (!session) return undefined
  if (Date.now() - session.lastAccessAt > SESSION_TTL) {
    sessions.delete(id)
    return undefined
  }
  session.lastAccessAt = Date.now()
  return session
}

export function disconnectSession(id: string | undefined) {
  if (id) sessions.delete(id)
}

export function consumeWriteCapacity(session: ExchangeSession) {
  const cutoff = Date.now() - 60_000
  session.writeTimestamps = session.writeTimestamps.filter((timestamp) => timestamp > cutoff)
  if (session.writeTimestamps.length >= 20) throw new Error('Too many trading actions. Wait before trying again.')
  session.writeTimestamps.push(Date.now())
}

const cleanup = setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL
  for (const [id, session] of sessions) {
    if (session.lastAccessAt < cutoff) sessions.delete(id)
  }
}, 30 * 60 * 1_000)
cleanup.unref()
