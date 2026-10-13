import './environment'
import type { Server } from 'node:http'
import { app } from './index'
import { closeDatabase, initializeDatabase } from './postgres'
import { closeRedis, initializeRedis } from './redis'

const port = Number(process.env.PORT || process.env.API_PORT || 8787)
const host = process.env.API_HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1')
const liveTradingEnabled = process.env.ALLOW_LIVE_TRADING === 'true'
const liveRiskAutomationEnabled = liveTradingEnabled && (
  process.env.ALLOW_LIVE_RM_AUTOMATION === 'true'
  || process.env.ALLOW_LIVE_RM_AUTOCLOSE === 'true'
)

let server: Server | undefined
let stopping = false

async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  console.log(`[api] ${signal} received; draining HTTP requests`)
  if (server) {
    server.closeIdleConnections()
    await new Promise<void>((resolve) => server!.close(() => resolve()))
  }
  await Promise.allSettled([closeRedis(), closeDatabase()])
  console.log('[api] shutdown complete')
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void shutdown(signal)
      .then(() => { process.exitCode = 0 })
      .catch((error) => {
        console.error('[api] shutdown failed:', error instanceof Error ? error.message : error)
        process.exitCode = 1
      })
  })
}

void Promise.all([initializeDatabase(), initializeRedis()])
  .then(() => {
    server = app.listen(port, host, () => {
      console.log(`ANTYTILT API and frontend listening on http://${host}:${port}`)
      console.log(`BingX live trading: ${liveTradingEnabled ? 'ENABLED' : 'disabled'}`)
      console.log(`Live RM automation policy: ${liveRiskAutomationEnabled ? 'ENABLED' : 'disabled'}`)
    })
  })
  .catch((error) => {
    console.error('[api] startup failed:', error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
