import './environment'
import { closeDatabase, initializeDatabase } from './postgres'
import { closeRedis, initializeRedis, setWorkerHeartbeat, workerInstanceId } from './redis'
import { startRiskQueue, stopRiskQueue } from './riskQueue'
import { startHyperliquidQueue, stopHyperliquidQueue } from './hyperliquid/queue'

const liveTradingEnabled = process.env.ALLOW_LIVE_TRADING === 'true'
const liveRiskAutomationEnabled = liveTradingEnabled && (
  process.env.ALLOW_LIVE_RM_AUTOMATION === 'true'
  || process.env.ALLOW_LIVE_RM_AUTOCLOSE === 'true'
)
const monitorIntervalMs = Number(process.env.RM_MONITOR_INTERVAL_MS || 5_000)
let stopping = false

async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  console.log(`[rm-worker] ${signal} received; finishing active jobs`)
  await setWorkerHeartbeat(workerInstanceId, {
    status: 'STOPPING',
    checkedAt: Date.now(),
  }).catch(() => undefined)
  await stopRiskQueue()
  await stopHyperliquidQueue()
  await Promise.allSettled([closeRedis(), closeDatabase()])
  console.log('[rm-worker] shutdown complete')
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void shutdown(signal)
      .then(() => { process.exitCode = 0 })
      .catch((error) => {
        console.error('[rm-worker] shutdown failed:', error instanceof Error ? error.message : error)
        process.exitCode = 1
      })
  })
}

void Promise.all([initializeDatabase(), initializeRedis()])
  .then(() => startRiskQueue(liveRiskAutomationEnabled, monitorIntervalMs))
  .then(() => startHyperliquidQueue(Number(process.env.HL_MONITOR_INTERVAL_MS || 15_000)))
  .then(() => {
    console.log(`ANTYTILT RM worker started as ${workerInstanceId}`)
    console.log(`BingX live trading: ${liveTradingEnabled ? 'ENABLED' : 'disabled'}`)
    console.log(`Live RM automation: ${liveRiskAutomationEnabled ? 'ENABLED' : 'disabled'}`)
  })
  .catch((error) => {
    console.error('[rm-worker] startup failed:', error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
