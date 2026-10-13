import { Queue, Worker, type Job } from 'bullmq'
import { listRiskMonitoringTargets } from './database'
import { runRiskMonitorAccount } from './riskService'
import {
  bullMqConnection,
  bullMqPrefix,
  initializeRedis,
  setWorkerHeartbeat,
  workerInstanceId,
} from './redis'

type RiskMonitorJob = {
  exchangeAccountId: string
  allowLiveAutomation: boolean
  scheduledAt: number
}

const queueName = 'risk-monitor'
let queue: Queue<RiskMonitorJob> | undefined
let worker: Worker<RiskMonitorJob> | undefined
let schedulerTimer: ReturnType<typeof setInterval> | undefined
let heartbeatTimer: ReturnType<typeof setInterval> | undefined
let lastScheduledAt = 0

async function heartbeat(status: 'STARTING' | 'RUNNING' | 'ERROR', error?: unknown) {
  const counts = queue ? await queue.getJobCounts('waiting', 'active', 'delayed', 'failed') : undefined
  await setWorkerHeartbeat(workerInstanceId, {
    status,
    checkedAt: Date.now(),
    lastScheduledAt,
    releaseSha: process.env.RENDER_GIT_COMMIT || process.env.RELEASE_SHA || 'local',
    queue: counts,
    ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
  })
}

async function enqueueActiveAccounts(allowLiveAutomation: boolean, intervalMs: number) {
  if (!queue) return
  const scheduledAt = Date.now()
  const slot = Math.floor(scheduledAt / intervalMs)
  const targets = await listRiskMonitoringTargets()
  await Promise.all(targets.map((target) => queue!.add('reconcile-account', {
    exchangeAccountId: target.accountId,
    allowLiveAutomation,
    scheduledAt,
  }, {
    jobId: `account-${target.accountId}-${slot}`,
    attempts: 7,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { age: 3_600, count: 1_000 },
    removeOnFail: { age: 86_400, count: 5_000 },
  })))
  lastScheduledAt = scheduledAt
}

export async function startRiskQueue(allowLiveAutomation: boolean, intervalMs = 5_000) {
  if (queue || worker) return
  await initializeRedis()
  const normalizedInterval = Math.max(1_000, intervalMs)
  queue = new Queue<RiskMonitorJob>(queueName, {
    connection: bullMqConnection(),
    prefix: bullMqPrefix(),
    defaultJobOptions: { attempts: 7, backoff: { type: 'exponential', delay: 5_000 } },
  })
  worker = new Worker<RiskMonitorJob>(queueName, async (job: Job<RiskMonitorJob>) => {
    const result = await runRiskMonitorAccount(job.data.exchangeAccountId, job.data.allowLiveAutomation)
    if (result.reason === 'LOCKED') return { skipped: true, reason: result.reason }
    return result
  }, {
    connection: bullMqConnection(),
    prefix: bullMqPrefix(),
    concurrency: Math.max(1, Number(process.env.RM_WORKER_CONCURRENCY || 4)),
    lockDuration: Math.max(30_000, Number(process.env.RM_LOCK_TTL_MS || 30_000) * 2),
  })
  worker.on('failed', (job, error) => {
    console.error('[rm-queue]', job?.data.exchangeAccountId ?? 'unknown-account', error.message)
  })
  worker.on('error', (error) => {
    console.error('[rm-queue]', error.message)
    void heartbeat('ERROR', error).catch(() => undefined)
  })

  await heartbeat('STARTING')
  await enqueueActiveAccounts(allowLiveAutomation, normalizedInterval)
  schedulerTimer = setInterval(() => {
    void enqueueActiveAccounts(allowLiveAutomation, normalizedInterval)
      .then(() => heartbeat('RUNNING'))
      .catch((error) => heartbeat('ERROR', error).catch(() => undefined))
  }, normalizedInterval)
  schedulerTimer.unref()
  heartbeatTimer = setInterval(() => void heartbeat('RUNNING').catch(() => undefined), 10_000)
  heartbeatTimer.unref()
}

export async function stopRiskQueue() {
  if (schedulerTimer) clearInterval(schedulerTimer)
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  schedulerTimer = undefined
  heartbeatTimer = undefined
  await worker?.close()
  await queue?.close()
  worker = undefined
  queue = undefined
}
