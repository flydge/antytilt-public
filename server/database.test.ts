import assert from 'node:assert/strict'

process.env.NODE_ENV = 'test'
process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64')

const database = await import('./database')
const { executeDurableTradingMutation } = await import('./mutationService')
const { closeDatabase, queryDatabase } = await import('./postgres')

try {
  const first = await database.createUser('first@example.com', 'correct-horse-battery-staple')
  const second = await database.createUser('second@example.com', 'another-correct-horse-password')
  const credentials = {
    apiKey: 'api-key-that-must-be-encrypted',
    secretKey: 'secret-that-must-never-be-plaintext',
  }
  const firstConnection = await database.saveExchangeConnection(first.id, 'prod-vst', credentials)
  const restored = await database.loadExchangeConnection(first.id)
  assert.deepEqual(restored?.credentials, credentials)
  assert.equal(await database.loadExchangeConnection(second.id), undefined)

  const ciphertext = (await queryDatabase<{ api_key_ciphertext: string; secret_key_ciphertext: string }>(`
    SELECT api_key_ciphertext, secret_key_ciphertext FROM exchange_accounts WHERE user_id = $1
  `, [first.id])).rows[0]
  assert.ok(ciphertext)
  assert.equal(ciphertext.api_key_ciphertext.includes(credentials.apiKey), false)
  assert.equal(ciphertext.secret_key_ciphertext.includes(credentials.secretKey), false)

  const riskProfile = {
    active: true,
    timezone: 'Europe/Warsaw',
    externalViolationPolicy: 'BLOCK_AND_CLOSE_EXTERNAL' as const,
    breachAction: 'CLOSE_VIOLATING_POSITION' as const,
    closeExternalEntriesOnBreach: true,
    automationConsent: true,
    fixedStopLoss: { enabled: true, value: 2, workingType: 'MARK_PRICE' as const },
    breakEven: { enabled: true, triggerMode: 'PERCENT' as const, triggerValue: 1.5, offsetPercent: 0.05 },
    riskPerTrade: { enabled: true, value: 1 },
    dailyLossLimit: { enabled: true, value: 3, unit: 'PERCENT' as const },
    maxLeverage: { enabled: true, value: 10 },
    maxTradesPerDay: { enabled: true, value: 6 },
    maxConsecutiveLosses: { enabled: true, value: 3 },
    cooldownMinutes: { enabled: true, value: 30 },
    maxExposurePercent: { enabled: false, value: 100 },
    maxOpenPositions: { enabled: true, value: 3 },
  }
  const storedRiskProfile = await database.saveRiskProfile(first.id, riskProfile)
  assert.deepEqual(await database.loadRiskProfile(first.id), storedRiskProfile)
  assert.equal(await database.loadRiskProfile(second.id), undefined)

  const legacyProfile = { ...riskProfile } as Record<string, unknown>
  delete legacyProfile.timezone
  delete legacyProfile.externalViolationPolicy
  delete legacyProfile.breachAction
  delete legacyProfile.closeExternalEntriesOnBreach
  delete legacyProfile.automationConsent
  legacyProfile.fixedStopLoss = { enabled: true, value: 2 }
  await queryDatabase('UPDATE account_risk_profiles SET profile_json = $1::jsonb WHERE user_id = $2', [JSON.stringify(legacyProfile), first.id])
  const normalizedLegacyProfile = await database.loadRiskProfile(first.id)
  assert.equal(normalizedLegacyProfile?.timezone, 'UTC')
  assert.equal(normalizedLegacyProfile?.externalViolationPolicy, 'BLOCK_NEW_ENTRIES')
  assert.equal(normalizedLegacyProfile?.breachAction, 'BLOCK_NEW_ENTRIES')
  assert.equal(normalizedLegacyProfile?.closeExternalEntriesOnBreach, false)
  assert.equal(normalizedLegacyProfile?.automationConsent, false)
  assert.equal(normalizedLegacyProfile?.fixedStopLoss.workingType, 'MARK_PRICE')

  const tradingDay = '2026-09-26'
  const dailyInput = {
    userId: first.id,
    environment: 'prod-vst' as const,
    tradingDay,
    timezone: 'Europe/Warsaw',
    openingEquityMicros: 1_000_000_000,
    lastEquityMicros: 1_000_000_000,
    initialized: true,
  }
  const initialDailyState = await database.getOrCreateRiskDailyState(dailyInput)
  assert.equal(initialDailyState.exchangeAccountId, firstConnection.account.id)
  assert.equal(initialDailyState.tradeCount, 0)
  assert.equal(initialDailyState.openingEquityMicros, 1_000_000_000)
  const updatedEquity = await database.updateRiskDailyEquity({ ...dailyInput, lastEquityMicros: 975_000_000 })
  assert.equal(updatedEquity.openingEquityMicros, 1_000_000_000)
  assert.equal(updatedEquity.lastEquityMicros, 975_000_000)

  const firstReservation = await database.reserveRiskEntry({
    ...dailyInput, requestId: 'request-1', symbol: 'BTC-USDT', side: 'LONG', maxTradesPerDay: 2,
  })
  assert.equal(firstReservation.allowed, true)
  const duplicateReservation = await database.reserveRiskEntry({
    ...dailyInput, requestId: 'request-1', symbol: 'BTC-USDT', side: 'LONG', maxTradesPerDay: 2,
  })
  assert.equal(duplicateReservation.idempotent, true)
  assert.equal(duplicateReservation.reservation.id, firstReservation.reservation.id)

  const secondReservation = await database.reserveRiskEntry({
    ...dailyInput, requestId: 'request-2', symbol: 'ETH-USDT', side: 'SHORT', maxTradesPerDay: 2,
  })
  const blockedReservation = await database.reserveRiskEntry({
    ...dailyInput, requestId: 'request-3', symbol: 'SOL-USDT', side: 'LONG', maxTradesPerDay: 2,
  })
  assert.equal(secondReservation.allowed, true)
  assert.equal(blockedReservation.allowed, false)
  assert.equal(blockedReservation.reservation.status, 'BLOCKED')

  const released = await database.releaseRiskEntryReservation({
    userId: first.id, environment: 'prod-vst', reservationId: firstReservation.reservation.id,
  })
  assert.equal(released.changed, true)
  assert.equal((await database.releaseRiskEntryReservation({
    userId: first.id, environment: 'prod-vst', reservationId: firstReservation.reservation.id,
  })).changed, false)

  const replacement = await database.reserveRiskEntry({
    ...dailyInput, requestId: 'request-4', symbol: 'SOL-USDT', side: 'LONG', maxTradesPerDay: 2,
  })
  assert.equal(replacement.allowed, true)
  const attached = await database.attachRiskEntryReservation({
    userId: first.id, environment: 'prod-vst', reservationId: secondReservation.reservation.id, orderId: 'exchange-order-1',
  })
  assert.equal(attached?.status, 'ATTACHED')
  const consumed = await database.consumeRiskEntryReservation({
    userId: first.id, environment: 'prod-vst', reservationId: secondReservation.reservation.id,
  })
  assert.equal(consumed.incremented, true)
  assert.equal(consumed.dailyState?.tradeCount, 1)
  assert.equal((await database.consumeRiskEntryReservation({
    userId: first.id, environment: 'prod-vst', reservationId: secondReservation.reservation.id,
  })).incremented, false)

  const incremented = await database.incrementRiskTradeCount({ ...dailyInput, amount: 2 })
  assert.equal(incremented.tradeCount, 3)
  assert.equal((await database.getRiskDailyState(first.id, 'prod-vst', tradingDay))?.tradeCount, 3)

  const parallelDay = '2026-09-27'
  await database.saveExchangeConnection(second.id, 'prod-vst', {
    apiKey: 'second-account-api-key',
    secretKey: 'second-account-secret-key',
  })
  const parallelInputs = Array.from({ length: 8 }, (_, index) => ({
    userId: second.id,
    environment: 'prod-vst' as const,
    tradingDay: parallelDay,
    timezone: 'UTC',
    requestId: `parallel-${index}`,
    symbol: 'BTC-USDT',
    side: 'LONG',
    maxTradesPerDay: 3,
  }))
  const parallel = process.env.DATABASE_URL
    ? await Promise.all(parallelInputs.map((input) => database.reserveRiskEntry(input)))
    : await parallelInputs.reduce<Promise<Array<Awaited<ReturnType<typeof database.reserveRiskEntry>>>>>(async (promise, input) => {
        const accumulated = await promise
        accumulated.push(await database.reserveRiskEntry(input))
        return accumulated
      }, Promise.resolve([]))
  assert.equal(parallel.filter((entry) => entry.allowed).length, 3, 'row locking must prevent concurrent overbooking')

  const position = await database.initializeRiskPositionState({
    userId: first.id,
    environment: 'prod-vst',
    positionKey: 'BTC-USDT:LONG',
    positionId: 'position-1',
    symbol: 'BTC-USDT',
    side: 'LONG',
    quantity: '0.010',
    origin: 'EXTERNAL',
  })
  assert.equal(position.origin, 'EXTERNAL')
  const unchanged = await database.initializeRiskPositionState({
    userId: first.id,
    environment: 'prod-vst',
    positionKey: 'BTC-USDT:LONG',
    positionId: 'position-1',
    symbol: 'BTC-USDT',
    side: 'LONG',
    quantity: '0.020',
  })
  assert.equal(unchanged.quantity, '0.010')
  const reconciled = await database.reconcileRiskPositionState({
    userId: first.id,
    environment: 'prod-vst',
    positionKey: 'BTC-USDT:LONG',
    positionId: 'position-1',
    symbol: 'BTC-USDT',
    side: 'LONG',
    quantity: '0.020',
    status: 'MISSING',
    origin: 'EXTERNAL',
    missedSnapshots: 1,
    enforcementStatus: 'PENDING',
  })
  assert.equal(reconciled.missedSnapshots, 1)

  const event = await database.recordRiskEvent({
    userId: first.id,
    environment: 'prod-vst',
    tradingDay,
    eventKey: 'entry:request-3:blocked',
    rule: 'maxTradesPerDay',
    action: 'BLOCK_NEW_ENTRIES',
    source: 'pre_trade',
    result: 'BLOCKED',
    metadata: { limit: 2, used: 2 },
  })
  const duplicateEvent = await database.recordRiskEvent({
    userId: first.id,
    environment: 'prod-vst',
    tradingDay,
    eventKey: 'entry:request-3:blocked',
    rule: 'maxTradesPerDay',
    action: 'BLOCK_NEW_ENTRIES',
    source: 'retry',
    result: 'IGNORED',
  })
  assert.equal(event.inserted, true)
  assert.equal(duplicateEvent.inserted, false)
  assert.equal(duplicateEvent.event.source, 'pre_trade')

  const protection = await database.reconcileRiskProtectionState({
    userId: first.id,
    environment: 'prod-vst',
    positionKey: 'BTC-USDT:LONG',
    positionId: 'position-1',
    symbol: 'BTC-USDT',
    direction: 'LONG',
    entryPrice: '60000',
    bestPrice: '61200',
    triggered: true,
    managedOrderId: 'stop-1',
    managedStopPrice: '60030',
    managedQuantity: '0.02',
  })
  assert.equal(protection.managedStopPrice, '60030')

  const outcomeTime = Date.now()
  const lossStreak = await database.processRiskTradeOutcomes({
    userId: first.id,
    environment: 'prod-vst',
    tradingDay,
    timezone: 'Europe/Warsaw',
    outcomes: [
      { outcomeKey: 'close-1', orderId: 'close-1', netPnlMicros: -10_000_000, closedAt: outcomeTime - 1_000 },
      { outcomeKey: 'close-2', orderId: 'close-2', netPnlMicros: -5_000_000, closedAt: outcomeTime },
    ],
    maxConsecutiveLosses: 2,
    cooldownMinutes: 30,
  })
  assert.equal(lossStreak.state.consecutiveLosses, 2)
  assert.equal(lossStreak.state.cooldownUntil, outcomeTime + 30 * 60_000)
  const resetStreak = await database.processRiskTradeOutcomes({
    userId: first.id,
    environment: 'prod-vst',
    tradingDay,
    timezone: 'Europe/Warsaw',
    outcomes: [{ outcomeKey: 'close-3', orderId: 'close-3', netPnlMicros: 1_000_000, closedAt: outcomeTime + 1_000 }],
    maxConsecutiveLosses: 2,
    cooldownMinutes: 30,
  })
  assert.equal(resetStreak.state.consecutiveLosses, 0)

  const runtime = await database.getRiskRuntimeStatus(first.id, 'prod-vst', tradingDay)
  assert.equal(runtime.dailyState?.tradeCount, 3)
  assert.equal(runtime.externalOpenPositions, 1)
  assert.equal(runtime.pendingEnforcements, 1)
  assert.equal(runtime.managedProtections, 1)
  assert.equal(runtime.lastEvent?.eventKey, 'entry:request-3:blocked')

  const sameConnection = await database.saveExchangeConnection(first.id, 'prod-vst', credentials)
  assert.equal(sameConnection.accountChanged, false)
  assert.equal((await database.getRiskDailyState(first.id, 'prod-vst', tradingDay))?.tradeCount, 3)
  const replacementCredentials = { apiKey: 'a-different-api-account-key', secretKey: 'a-different-api-account-secret' }
  const replacedConnection = await database.saveExchangeConnection(first.id, 'prod-vst', replacementCredentials)
  assert.equal(replacedConnection.accountChanged, false)
  assert.notEqual(replacedConnection.account.id, firstConnection.account.id)
  assert.equal(await database.getRiskDailyState(first.id, 'prod-vst', tradingDay), undefined)
  assert.equal((await database.listRiskPositionStates(first.id, 'prod-vst')).length, 0)
  assert.equal((await database.getRiskDailyState(first.id, 'prod-vst', tradingDay, firstConnection.account.id))?.tradeCount, 3)
  assert.equal((await database.listRiskPositionStates(first.id, 'prod-vst', firstConnection.account.id)).length, 1)
  const clonedProfile = await database.loadRiskProfile(first.id)
  assert.deepEqual(
    clonedProfile && { ...clonedProfile, updatedAt: normalizedLegacyProfile?.updatedAt },
    normalizedLegacyProfile,
  )

  const liveCredentials = { apiKey: 'live-api-account-key', secretKey: 'live-api-account-secret' }
  const liveConnection = await database.saveExchangeConnection(first.id, 'prod-live', liveCredentials, { label: 'Live test account' })
  assert.equal(liveConnection.accountChanged, false)
  assert.equal(liveConnection.account.label, 'Live test account')
  const accounts = await database.listExchangeAccounts(first.id)
  assert.equal(accounts.length, 3)
  assert.equal(accounts.filter((account) => account.isDefault).length, 1)
  assert.equal(accounts.find((account) => account.isDefault)?.id, liveConnection.account.id)
  assert.equal((await database.loadExchangeConnection(first.id))?.accountId, liveConnection.account.id)
  assert.equal((await database.loadRiskProfile(first.id, liveConnection.account.id))?.timezone, normalizedLegacyProfile?.timezone)
  const liveRiskProfile = await database.saveRiskProfile(first.id, {
    ...riskProfile,
    timezone: 'America/New_York',
    maxTradesPerDay: { enabled: true, value: 2 },
  }, liveConnection.account.id)
  assert.equal(liveRiskProfile.timezone, 'America/New_York')
  assert.equal((await database.loadRiskProfile(first.id, liveConnection.account.id))?.maxTradesPerDay.value, 2)
  assert.equal((await database.loadRiskProfile(first.id, replacedConnection.account.id))?.timezone, 'UTC')
  const monitoringTargets = (await database.listRiskMonitoringTargets()).filter((target) => target.userId === first.id)
  assert.equal(monitoringTargets.length, 3)
  assert.equal(monitoringTargets.find((target) => target.accountId === liveConnection.account.id)?.profile.maxTradesPerDay.value, 2)
  assert.equal(monitoringTargets.find((target) => target.accountId === replacedConnection.account.id)?.profile.timezone, 'UTC')

  const mutationScope = {
    userId: first.id,
    exchangeAccountId: firstConnection.account.id,
    operation: 'order.market.place',
    requestId: '5757960c-ce5d-4b4a-856c-182ecacde805',
    requestHash: 'a'.repeat(64),
  }
  const mutation = await database.beginTradingMutation(mutationScope)
  assert.equal(mutation.created, true)
  assert.equal((await database.beginTradingMutation(mutationScope)).mutation.status, 'PENDING')
  await database.completeTradingMutation({
    ...mutationScope,
    response: { order: { orderId: 'durable-order-1' }, snapshot: { positions: [] } },
    exchangeOrderId: 'durable-order-1',
  })
  const replay = await database.beginTradingMutation(mutationScope)
  assert.equal(replay.created, false)
  assert.equal(replay.mutation.status, 'SUCCEEDED')
  assert.deepEqual(replay.mutation.response, { order: { orderId: 'durable-order-1' }, snapshot: { positions: [] } })
  await assert.rejects(
    () => database.beginTradingMutation({ ...mutationScope, requestHash: 'b'.repeat(64) }),
    /already used with different trading parameters/,
  )
  const sameRequestOtherAccount = await database.beginTradingMutation({
    ...mutationScope,
    exchangeAccountId: replacedConnection.account.id,
  })
  assert.equal(sameRequestOtherAccount.created, true)
  await database.failTradingMutation({
    ...mutationScope,
    exchangeAccountId: replacedConnection.account.id,
    error: { message: 'simulated failure', status: 502 },
  })
  assert.equal((await database.beginTradingMutation({
    ...mutationScope,
    exchangeAccountId: replacedConnection.account.id,
  })).mutation.status, 'FAILED')

  let exchangeExecutions = 0
  const durableExecution = {
    userId: first.id,
    exchangeAccountId: firstConnection.account.id,
    operation: 'position.close',
    requestId: 'b33c043f-8e73-4b06-8c0b-077df61305f6',
    requestPayload: { positionId: 'position-1', quantity: 'all' },
    execute: async () => {
      exchangeExecutions += 1
      return { order: { orderId: 'close-1' } }
    },
  }
  assert.equal((await executeDurableTradingMutation(durableExecution)).replayed, false)
  assert.equal((await executeDurableTradingMutation(durableExecution)).replayed, true)
  assert.equal(exchangeExecutions, 1, 'a durable retry must not call the exchange twice')

  await database.selectExchangeAccount(first.id, replacedConnection.account.id)
  const selectedVst = await database.loadExchangeConnection(first.id)
  assert.equal(selectedVst?.accountId, replacedConnection.account.id)
  assert.equal(selectedVst?.environment, 'prod-vst')
  assert.deepEqual(selectedVst?.credentials, replacementCredentials)

  await database.deleteExchangeConnection(first.id, liveConnection.account.id)
  assert.equal((await database.listExchangeAccounts(first.id)).length, 2)
  const archivedAccounts = await database.listExchangeAccounts(first.id, true)
  assert.equal(archivedAccounts.length, 3)
  assert.equal(archivedAccounts.find((account) => account.id === liveConnection.account.id)?.status, 'ARCHIVED')

  console.log('PostgreSQL user isolation, encryption and durable RM state tests passed')
} finally {
  await closeDatabase()
}
