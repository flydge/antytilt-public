/// <reference types="node" />
import React from "react"

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { HyperliquidProtectionView, projectHlReadiness } from './HyperliquidProtectionPanel'
import type { HlStatusResponse, HlOutcome } from '../../shared/hyperliquid'

const now = 1_800_000_000_000
const fixture = (): HlStatusResponse => ({ realActionsEnabled: true, nativeUrl: 'https://app.hyperliquid-testnet.xyz', events: [], connection: {
 id: 'connection', network: 'testnet', account: '0x123', coin: 'BTC', mode: 'disabled', status: 'ARMED', reason: 'History verified', enabled: true,
 policy: { version: 2, dailyEntryLimit: 1, timezone: 'Europe/Warsaw', slippageBps: 25, maxCloseNotionalUsd: '20', consentExpiresAt: now + 3600000 },
 day: '2027-01-15', entryCount: 2, remainingSize: '0', historyComplete: true, agentAddress: '0x456', agentName: 'AntyTILT BTC', grantExpiresAt: now + 3600000, lastCheckedAt: now, workerLastSeenAt: now,
} })
test('fresh supported connection projects ARMED readiness separately from event outcome', () => {
 assert.equal(projectHlReadiness(fixture(), now, true), 'ARMED')
})
test('offline, stale, missing data, unsupported mode and preapproval cannot project ARMED', () => {
 assert.equal(projectHlReadiness(fixture(), now, false), 'OFFLINE')
 assert.equal(projectHlReadiness(fixture(), now + 15001, true), 'STALE')
 const data = fixture(); data.connection!.workerLastSeenAt = null
 assert.notEqual(projectHlReadiness(data, now, true), 'ARMED')
 data.connection!.workerLastSeenAt = now; data.connection!.mode = 'unknown'
 assert.notEqual(projectHlReadiness(data, now, true), 'ARMED')
 data.connection!.mode = 'disabled'; data.realActionsEnabled = false
 assert.notEqual(projectHlReadiness(data, now, true), 'ARMED')
})
test('preapproval rendering disables wallet and exposes scope and broad rights disclosure', () => {
 const data = fixture(); data.realActionsEnabled = false; data.connection = null
 const html = renderToStaticMarkup(<HyperliquidProtectionView data={data} now={now} online={true} />)
 assert.match(html, /No wallet linked, no rights granted, no orders sent/)
 assert.match(html, /disabled=""[^>]*>Link Wallet/)
 assert.match(html, /broader protocol trading rights/)
 assert.match(html, /does not limit position size/)
})
test('risky event outcomes preserve attribution, residual, timestamps and provider IDs', () => {
 for (const outcome of ['CLOSING','PARTIAL','UNCERTAIN','ACTION_FAILED','MIXED_RESOLUTION','RESOLVED_EXTERNALLY','CONFIRMED_CLOSED'] as HlOutcome[]) {
 const data = fixture(); data.events = [{ id: 'event', occurredAt: now, outcome, reason: 'Provider ACK is not a fill', episodeId: 'episode', intentId: 'intent', providerOrderIds: ['order-42'], fillIds: ['fill-17'], remainingSize: '0.001', agentClosedSize: '0.002', externalClosedSize: '0.003' }]
 const html = renderToStaticMarkup(<HyperliquidProtectionView data={data} now={now} online={true} />)
 assert.match(html, new RegExp(outcome)); assert.match(html, /order-42/); assert.match(html, /fill-17/); assert.match(html, /0\.001/)
 assert.match(html, /Agent closed/); assert.match(html, /External closed/); assert.match(html, /dateTime=/)
 }
})

test('unresolved provider default mode cannot be armed', () => {
 const data = fixture(); data.connection!.mode = 'default'
 assert.equal(projectHlReadiness(data, now, true), 'UNSUPPORTED_MODE')
})
test('stale SYNCING connection cannot enable Arm', () => {
 const data = fixture(); data.connection!.status = 'SYNCING'; data.connection!.workerLastSeenAt = now - 15001
 const html = renderToStaticMarkup(<HyperliquidProtectionView data={data} now={now} online={true} consent={true} />)
 assert.match(html, /disabled=""[^>]*>Arm BTC Protection/)
})
