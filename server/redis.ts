import crypto from 'node:crypto'
import os from 'node:os'
import IORedis from 'ioredis'

const redisUrl = process.env.REDIS_URL?.trim()
const redisPrefix = process.env.REDIS_PREFIX?.trim() || 'antytilt'
const testMode = process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'database-test'
export const workerInstanceId = process.env.RM_WORKER_INSTANCE_ID?.trim()
  || `${os.hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`

let redisClient: IORedis | undefined

export type RmAccountWorkerState = {
  status: 'RUNNING' | 'IDLE' | 'STALE' | 'ERROR' | 'DISCONNECTED'
  workerInstanceId?: string
  lastCheckedAt?: number
  lastActionAt?: number
  lastError?: string
  failureCount?: number
  retryAt?: number
  updatedAt: number
}

function key(value: string) {
  return `${redisPrefix}:${value}`
}

export function redisConfigured() {
  return Boolean(redisUrl)
}

export function redisConnection() {
  if (!redisUrl) {
    if (testMode) return undefined
    throw new Error('REDIS_URL is required for the RM queue and distributed account locks')
  }
  if (!redisClient) {
    redisClient = new IORedis(redisUrl, {
      lazyConnect: true,
      enableReadyCheck: true,
      maxRetriesPerRequest: null,
    })
    redisClient.on('error', (error) => {
      console.error('[redis]', error.message)
    })
  }
  return redisClient
}

export async function initializeRedis() {
  const client = redisConnection()
  if (!client) return { enabled: false as const }
  if (client.status === 'wait') await client.connect()
  await client.ping()
  return { enabled: true as const }
}

export async function redisHealth() {
  const startedAt = Date.now()
  const client = redisConnection()
  if (!client) return { ok: true as const, enabled: false as const, latencyMs: 0 }
  if (client.status === 'wait') await client.connect()
  await client.ping()
  return { ok: true as const, enabled: true as const, latencyMs: Date.now() - startedAt }
}

const renewLockScript = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('PEXPIRE', KEYS[1], ARGV[2])
  end
  return 0
`

const releaseLockScript = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`

export async function withAccountLock<T>(
  exchangeAccountId: string,
  callback: () => Promise<T>,
  ttlMs = Number(process.env.RM_LOCK_TTL_MS || 30_000),
): Promise<{ acquired: boolean; value?: T }> {
  const client = redisConnection()
  if (!client) return { acquired: true, value: await callback() }
  if (client.status === 'wait') await client.connect()
  const lockKey = key(`lock:rm-account:${exchangeAccountId}`)
  const token = crypto.randomUUID()
  const acquired = await client.set(lockKey, token, 'PX', ttlMs, 'NX')
  if (acquired !== 'OK') return { acquired: false }

  let lockLost = false
  const renewal = setInterval(() => {
    void client.eval(renewLockScript, 1, lockKey, token, String(ttlMs))
      .then((result) => { if (Number(result) !== 1) lockLost = true })
      .catch(() => { lockLost = true })
  }, Math.max(1_000, Math.floor(ttlMs / 3)))
  renewal.unref()

  try {
    const value = await callback()
    if (lockLost) throw new Error(`Distributed RM lock was lost for exchange account ${exchangeAccountId}`)
    return { acquired: true, value }
  } finally {
    clearInterval(renewal)
    await client.eval(releaseLockScript, 1, lockKey, token).catch(() => undefined)
  }
}

export async function setRmAccountWorkerState(exchangeAccountId: string, state: RmAccountWorkerState) {
  const client = redisConnection()
  if (!client) return
  if (client.status === 'wait') await client.connect()
  await client.set(key(`rm-account:${exchangeAccountId}:state`), JSON.stringify(state), 'PX', 15 * 60_000)
}

export async function getRmAccountWorkerState(exchangeAccountId: string) {
  const client = redisConnection()
  if (!client) return undefined
  if (client.status === 'wait') await client.connect()
  const raw = await client.get(key(`rm-account:${exchangeAccountId}:state`))
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as RmAccountWorkerState
  } catch {
    return undefined
  }
}

export async function setWorkerHeartbeat(instanceId: string, payload: Record<string, unknown>) {
  const client = redisConnection()
  if (!client) return
  if (client.status === 'wait') await client.connect()
  await client.set(key(`rm-worker:${instanceId}:heartbeat`), JSON.stringify({ ...payload, instanceId }), 'PX', 60_000)
  await client.set(key('rm-worker:latest'), instanceId, 'PX', 60_000)
}

export async function getLatestWorkerHeartbeat() {
  const client = redisConnection()
  if (!client) return undefined
  if (client.status === 'wait') await client.connect()
  const instanceId = await client.get(key('rm-worker:latest'))
  if (!instanceId) return undefined
  const raw = await client.get(key(`rm-worker:${instanceId}:heartbeat`))
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return undefined
  }
}

export function bullMqConnection() {
  if (!redisUrl) throw new Error('REDIS_URL is required for BullMQ')
  return new IORedis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true })
}

export function bullMqPrefix() {
  return `${redisPrefix}:bull`
}

export async function closeRedis() {
  if (!redisClient) return
  const client = redisClient
  redisClient = undefined
  await client.quit().catch(() => client.disconnect())
}
