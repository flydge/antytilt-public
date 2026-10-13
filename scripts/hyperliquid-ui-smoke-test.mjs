import assert from 'node:assert/strict'
import puppeteer from 'puppeteer-core'
import { mkdir } from 'node:fs/promises'
const port = process.argv[2] || '15173'
const artifacts = process.env.HL_EVIDENCE_DIR
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--no-sandbox']
})
const page = await browser.newPage()
const errors = []
let payload = {
  connection: null,
  events: [],
  realActionsEnabled: false,
  nativeUrl: 'https://app.hyperliquid-testnet.xyz'
}
let hlWrites = 0
page.on('pageerror', (e) => errors.push(e.message))
await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
await page.evaluateOnNewDocument(() => {
  window.__walletCalls = 0
  window.ethereum = {
    request: async () => {
      window.__walletCalls++
      throw new Error('Wallet forbidden in offline smoke')
    }
  }
})
await page.setRequestInterception(true)
page.on('request', (request) => {
  const path = new URL(request.url()).pathname
  let body
  if (path === '/api/auth/session')
    body = {
      authenticated: true,
      user: {
        id: '00000000-0000-4000-8000-000000000001',
        email: 'offline-fixture@example.com',
        createdAt: Date.now()
      }
    }
  if (path === '/api/exchange/session')
    body = { connected: false, liveTradingEnabled: false, liveTriggerOrdersEnabled: false }
  if (path === '/api/exchange/accounts') body = { accounts: [] }
  if (path.startsWith('/api/hyperliquid-protection')) {
    if (request.method() !== 'GET') hlWrites++
    body = payload
  }
  if (body)
    void request.respond({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body)
    })
  else void request.continue()
})
async function refresh() {
  await page.evaluate(() =>
    [...document.querySelectorAll('.hl-protection button')]
      .find((b) => b.textContent === 'Refresh Status')
      .click()
  )
}
async function text() {
  return page.$eval('.hl-protection', (e) => e.textContent)
}
try {
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.rm-nav')
  await page.setViewport({ width: 900, height: 900, deviceScaleFactor: 1 })
  assert.notEqual(
    await page.$eval('.rm-nav', (e) => getComputedStyle(e).display),
    'none',
    'protection navigation must be reachable in the desktop side panel'
  )
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
  await page.click('.rm-nav')
  await page.waitForSelector('.hl-protection')
  await page.waitForFunction(() =>
    document.querySelector('.hl-protection')?.textContent.includes('PREAPPROVAL')
  )
  assert.doesNotMatch(
    await page.$eval('.status-bar', (e) => e.textContent),
    /All systems operational/,
    'risk footer must not contradict unknown protection readiness'
  )
  assert.equal(await page.$eval('.hl-actions button', (b) => b.disabled), true)
  assert.match(await text(), /broader protocol trading rights/)
  assert.match(await text(), /not cancelled/)
  if (artifacts) {
    await mkdir(artifacts, { recursive: true })
    const panel = await page.$('.hl-protection')
    await page.evaluate(() => window.scrollTo(0, 0))
    const bounds = await panel.boundingBox()
    await page.screenshot({
      path: `${artifacts}/panel-preapproval.png`,
      clip: bounds,
      captureBeyondViewport: true
    })
  }
  const now = Date.now()
  payload = {
    realActionsEnabled: true,
    nativeUrl: 'https://app.hyperliquid-testnet.xyz',
    events: [],
    connection: {
      id: '00000000-0000-4000-8000-000000000002',
      network: 'testnet',
      account: '0x0000000000000000000000000000000000000001',
      mode: 'disabled',
      coin: 'BTC',
      status: 'ARMED',
      reason: 'Offline fixture only',
      policy: {
        version: 1,
        dailyEntryLimit: 1,
        timezone: 'Europe/Warsaw',
        slippageBps: 25,
        maxCloseNotionalUsd: '20',
        consentExpiresAt: now + 3600000
      },
      day: '2026-10-12',
      entryCount: 2,
      remainingSize: '0',
      historyComplete: true,
      agentAddress: '0x0000000000000000000000000000000000000002',
      agentName: 'offline-fixture',
      grantExpiresAt: now + 3600000,
      lastCheckedAt: now,
      workerLastSeenAt: now,
      enabled: true
    }
  }
  await refresh()
  await page.waitForFunction(
    () => document.querySelector('.hl-readiness strong')?.textContent === 'Readiness: ARMED'
  )
  payload.connection.workerLastSeenAt = Date.now() - 30000
  await refresh()
  await page.waitForFunction(() =>
    /STALE|DEGRADED/.test(document.querySelector('.hl-readiness')?.textContent)
  )
  payload.connection.workerLastSeenAt = Date.now()
  payload.connection.lastCheckedAt = Date.now()
  payload.connection.mode = 'default'
  await refresh()
  await page.waitForFunction(() =>
    document.querySelector('.hl-readiness')?.textContent.includes('UNSUPPORTED_MODE')
  )
  payload.connection.mode = 'disabled'
  payload.connection.status = 'UNCERTAIN'
  payload.events = [
    {
      id: 'event-fixture',
      occurredAt: Date.now(),
      outcome: 'MIXED_RESOLUTION',
      reason: 'Agent partial plus external remainder',
      episodeId: 'episode-fixture',
      intentId: 'intent-fixture',
      providerOrderIds: ['oid-fixture'],
      fillIds: ['tid-fixture'],
      remainingSize: '0',
      agentClosedSize: '0.0001',
      externalClosedSize: '0.0001'
    }
  ]
  await refresh()
  await page.waitForFunction(() =>
    document.querySelector('.hl-events')?.textContent.includes('MIXED_RESOLUTION')
  )
  assert.match(await text(), /Autonomous demo success is not established/)
  assert.match(await text(), /oid-fixture/)
  assert.match(await text(), /tid-fixture/)
  if (artifacts) {
    await mkdir(artifacts, { recursive: true })
    await page.$eval('.hl-protection', (el) => el.scrollIntoView())
    await page.screenshot({ path: `${artifacts}/panel-desktop.png`, fullPage: true })
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 })
    await page.$eval('.hl-protection', (el) => el.scrollIntoView())
    await page.screenshot({ path: `${artifacts}/panel-mobile.png`, fullPage: true })
  }
  await page.setOfflineMode(true)
  await page.waitForFunction(() =>
    document.querySelector('.hl-readiness')?.textContent.includes('OFFLINE')
  )
  assert.equal(await page.evaluate(() => window.__walletCalls), 0)
  assert.equal(hlWrites, 0)
  assert.deepEqual(errors, [])
  console.log(
    'Hyperliquid browser fixtures passed: preapproval, native mode/default rejection, stale/offline, mixed attribution; zero wallet calls/writes.'
  )
} finally {
  await browser.close()
}
