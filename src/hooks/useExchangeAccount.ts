import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AccountHistory,
  AdvancedOrderInput,
  ExchangeContractCatalog,
  ExchangeAccountSummary,
  ExchangeEnvironment,
  ExchangeSessionState,
  MarketOrderInput,
  OrderPreviewResponse,
  PositionDirection,
  PositionProtectionInput,
  TradingSettings,
} from '../types'

const disconnectedState: ExchangeSessionState = {
  connected: false,
  liveTradingEnabled: false,
  liveTriggerOrdersEnabled: false,
}

async function apiRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: options?.body
      ? { 'Content-Type': 'application/json', ...options.headers }
      : options?.headers,
  })
  if (response.status === 204) return undefined as T
  const body = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`)
  return body as T
}

export function useExchangeAccount(symbol?: string) {
  const [session, setSession] = useState<ExchangeSessionState>(disconnectedState)
  const [accounts, setAccounts] = useState<ExchangeAccountSummary[]>([])
  const [status, setStatus] = useState<'checking' | 'idle' | 'connecting' | 'previewing' | 'executing' | 'updating'>('checking')
  const [error, setError] = useState<string | null>(null)
  const [tradingSettings, setTradingSettings] = useState<TradingSettings | null>(null)
  const [contractCatalog, setContractCatalog] = useState<ExchangeContractCatalog | null>(null)
  const [settingsLoading, setSettingsLoading] = useState(false)
  const [history, setHistory] = useState<AccountHistory>({ orderHistory: [], tradeHistory: [], synchronizedAt: 0, warnings: [] })
  const [historyLoading, setHistoryLoading] = useState(false)
  const refreshInFlight = useRef(false)

  const refresh = useCallback(async (quiet = false) => {
    if (refreshInFlight.current) return
    refreshInFlight.current = true
    try {
      const next = await apiRequest<ExchangeSessionState>('/api/exchange/account')
      setSession(next)
      setError(null)
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'Could not refresh BingX account'
      if (message === 'Connect your BingX account first') setSession(disconnectedState)
      if (!quiet) setError(message)
    } finally {
      refreshInFlight.current = false
    }
  }, [])

  const refreshAccounts = useCallback(async () => {
    const result = await apiRequest<{ accounts: ExchangeAccountSummary[] }>('/api/exchange/accounts')
    setAccounts(result.accounts)
    return result.accounts
  }, [])

  useEffect(() => {
    let active = true
    Promise.all([
      apiRequest<ExchangeSessionState>('/api/exchange/session'),
      apiRequest<{ accounts: ExchangeAccountSummary[] }>('/api/exchange/accounts'),
    ])
      .then(([next, accountResult]) => {
        if (active) {
          setSession(next)
          setAccounts(accountResult.accounts)
        }
      })
      .catch((requestError) => {
        if (active) setError(requestError instanceof Error ? requestError.message : 'Exchange API is unavailable')
      })
      .finally(() => {
        if (active) setStatus('idle')
      })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!session.connected) return
    const timer = window.setInterval(() => refresh(true), 5_000)
    return () => window.clearInterval(timer)
  }, [refresh, session.connected])

  useEffect(() => {
    if (!session.connected) {
      setContractCatalog(null)
      return
    }
    let active = true
    apiRequest<ExchangeContractCatalog>('/api/exchange/contracts')
      .then((catalog) => {
        if (active) setContractCatalog(catalog)
      })
      .catch((requestError) => {
        if (active) setError(requestError instanceof Error ? requestError.message : 'Could not load BingX contracts')
      })
    return () => { active = false }
  }, [session.connected, session.environment])

  const refreshTradingSettings = useCallback(async (quiet = false) => {
    const supported = Boolean(symbol && contractCatalog?.contracts.some((contract) => contract.symbol === symbol))
    if (!session.connected || !symbol || !contractCatalog || !supported) {
      setTradingSettings(null)
      return null
    }
    if (!quiet) setSettingsLoading(true)
    try {
      const next = await apiRequest<TradingSettings>(`/api/exchange/contracts/${encodeURIComponent(symbol)}/settings`)
      setTradingSettings(next)
      if (!quiet) setError(null)
      return next
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'Could not load BingX contract settings'
      if (!quiet) setError(message)
      throw requestError
    } finally {
      if (!quiet) setSettingsLoading(false)
    }
  }, [contractCatalog, session.connected, symbol])

  useEffect(() => {
    const supported = Boolean(symbol && contractCatalog?.contracts.some((contract) => contract.symbol === symbol))
    if (!session.connected || !symbol || !contractCatalog || !supported) {
      setTradingSettings(null)
      return
    }
    refreshTradingSettings().catch(() => undefined)
    const timer = window.setInterval(() => refreshTradingSettings(true).catch(() => undefined), 15_000)
    return () => window.clearInterval(timer)
  }, [contractCatalog, refreshTradingSettings, session.connected, symbol])

  const refreshHistory = useCallback(async (quiet = false) => {
    if (!session.connected) return null
    if (!quiet) setHistoryLoading(true)
    try {
      const next = await apiRequest<AccountHistory>('/api/account/history')
      setHistory(next)
      return next
    } catch (requestError) {
      if (!quiet) setError(requestError instanceof Error ? requestError.message : 'Could not synchronize account history')
      throw requestError
    } finally {
      if (!quiet) setHistoryLoading(false)
    }
  }, [session.connected])

  useEffect(() => {
    if (!session.connected) {
      setHistory({ orderHistory: [], tradeHistory: [], synchronizedAt: 0, warnings: [] })
      return
    }
    refreshHistory().catch(() => undefined)
    const timer = window.setInterval(() => refreshHistory(true).catch(() => undefined), 60_000)
    return () => window.clearInterval(timer)
  }, [refreshHistory, session.connected])

  const connect = useCallback(async (input: {
    apiKey: string
    secretKey: string
    environment: ExchangeEnvironment
    label?: string
  }) => {
    setStatus('connecting')
    setError(null)
    try {
      const next = await apiRequest<ExchangeSessionState>('/api/exchange/bingx/connect', {
        method: 'POST',
        body: JSON.stringify(input),
      })
      setSession(next)
      setTradingSettings(null)
      setContractCatalog(null)
      setHistory({ orderHistory: [], tradeHistory: [], synchronizedAt: 0, warnings: [] })
      await refreshAccounts()
      return next
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'Could not connect BingX'
      setError(message)
      throw requestError
    } finally {
      setStatus('idle')
    }
  }, [refreshAccounts])

  const selectAccount = useCallback(async (accountId: string) => {
    setStatus('connecting')
    setError(null)
    try {
      const next = await apiRequest<ExchangeSessionState>(`/api/exchange/accounts/${encodeURIComponent(accountId)}/select`, {
        method: 'POST',
      })
      setSession(next)
      setTradingSettings(null)
      setContractCatalog(null)
      setHistory({ orderHistory: [], tradeHistory: [], synchronizedAt: 0, warnings: [] })
      await refreshAccounts()
      return next
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'Could not select exchange account'
      setError(message)
      throw requestError
    } finally {
      setStatus('idle')
    }
  }, [refreshAccounts])

  const disconnect = useCallback(async () => {
    await apiRequest<void>('/api/exchange/disconnect', { method: 'DELETE' })
    setSession(disconnectedState)
    setTradingSettings(null)
    setContractCatalog(null)
    setHistory({ orderHistory: [], tradeHistory: [], synchronizedAt: 0, warnings: [] })
    await refreshAccounts()
    setError(null)
  }, [refreshAccounts])

  const changeMarginType = useCallback(async (input: { marginType: 'CROSSED' | 'ISOLATED'; confirmation?: string }) => {
    if (!symbol) throw new Error('Choose a contract first')
    setStatus('updating')
    setError(null)
    try {
      const next = await apiRequest<TradingSettings>(`/api/exchange/contracts/${encodeURIComponent(symbol)}/margin`, {
        method: 'POST',
        body: JSON.stringify({ ...input, clientRequestId: crypto.randomUUID() }),
      })
      setTradingSettings(next)
      return next
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'BingX rejected the margin mode change'
      setError(message)
      throw requestError
    } finally {
      setStatus('idle')
    }
  }, [symbol])

  const changeLeverage = useCallback(async (input: { direction: PositionDirection; leverage: number; confirmation?: string }) => {
    if (!symbol) throw new Error('Choose a contract first')
    setStatus('updating')
    setError(null)
    try {
      const next = await apiRequest<TradingSettings>(`/api/exchange/contracts/${encodeURIComponent(symbol)}/leverage`, {
        method: 'POST',
        body: JSON.stringify({ ...input, clientRequestId: crypto.randomUUID() }),
      })
      setTradingSettings(next)
      return next
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'BingX rejected the leverage change'
      setError(message)
      throw requestError
    } finally {
      setStatus('idle')
    }
  }, [symbol])

  const previewOrder = useCallback(async (input: AdvancedOrderInput) => {
    setStatus('previewing')
    setError(null)
    try {
      return await apiRequest<OrderPreviewResponse>('/api/exchange/orders/preview', {
        method: 'POST',
        body: JSON.stringify(input),
      })
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'Could not calculate the order preview'
      setError(message)
      throw requestError
    } finally {
      setStatus('idle')
    }
  }, [])

  const executeOrder = useCallback(async (input: { previewId: string; confirmation?: string }) => {
    setStatus('executing')
    setError(null)
    try {
      const result = await apiRequest<{ order: Record<string, unknown>; snapshot: NonNullable<ExchangeSessionState['snapshot']> }>(
        '/api/exchange/orders',
        {
          method: 'POST',
          body: JSON.stringify({ ...input, clientRequestId: crypto.randomUUID() }),
        },
      )
      setSession((current) => ({ ...current, snapshot: result.snapshot }))
      return result.order
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'BingX rejected the order'
      setError(message)
      throw requestError
    } finally {
      setStatus('idle')
    }
  }, [])

  const cancelOrder = useCallback(async (orderId: string, input: { symbol: string; clientOrderId?: string; confirmation?: string }) => {
    setStatus('executing')
    setError(null)
    try {
      const result = await apiRequest<{ order: Record<string, unknown>; snapshot: NonNullable<ExchangeSessionState['snapshot']> }>(
        `/api/exchange/orders/${encodeURIComponent(orderId)}`,
        {
          method: 'DELETE',
          body: JSON.stringify({ ...input, clientRequestId: crypto.randomUUID() }),
        },
      )
      setSession((current) => ({ ...current, snapshot: result.snapshot }))
      return result.order
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'BingX rejected the cancel request'
      setError(message)
      throw requestError
    } finally {
      setStatus('idle')
    }
  }, [])

  const amendOrder = useCallback(async (orderId: string, input: { symbol: string; clientOrderId?: string; quantity: number; confirmation?: string }) => {
    setStatus('executing')
    setError(null)
    try {
      const result = await apiRequest<{ order: Record<string, unknown>; snapshot: NonNullable<ExchangeSessionState['snapshot']> }>(
        `/api/exchange/orders/${encodeURIComponent(orderId)}/amend`,
        {
          method: 'POST',
          body: JSON.stringify({ ...input, clientRequestId: crypto.randomUUID() }),
        },
      )
      setSession((current) => ({ ...current, snapshot: result.snapshot }))
      return result.order
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'BingX rejected the order change'
      setError(message)
      throw requestError
    } finally {
      setStatus('idle')
    }
  }, [])

  const placeMarketOrder = useCallback(async (input: MarketOrderInput) => {
    setStatus('executing')
    setError(null)
    try {
      const result = await apiRequest<{ order: Record<string, unknown>; snapshot: NonNullable<ExchangeSessionState['snapshot']> }>(
        '/api/exchange/orders/market',
        {
          method: 'POST',
          body: JSON.stringify({ ...input, clientRequestId: crypto.randomUUID() }),
        },
      )
      setSession((current) => ({ ...current, snapshot: result.snapshot }))
      return result.order
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'BingX rejected the order'
      setError(message)
      throw requestError
    } finally {
      setStatus('idle')
    }
  }, [])

  const closePosition = useCallback(async (positionId: string, input: { quantity?: number; confirmation?: string }) => {
    setStatus('executing')
    setError(null)
    try {
      const result = await apiRequest<{ order: Record<string, unknown>; snapshot: NonNullable<ExchangeSessionState['snapshot']> }>(
        `/api/exchange/positions/${encodeURIComponent(positionId)}/close`,
        {
          method: 'POST',
          body: JSON.stringify({ ...input, clientRequestId: crypto.randomUUID() }),
        },
      )
      setSession((current) => ({ ...current, snapshot: result.snapshot }))
      return result.order
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'BingX rejected the close request'
      setError(message)
      throw requestError
    } finally {
      setStatus('idle')
    }
  }, [])

  const updatePositionProtection = useCallback(async (positionId: string, input: PositionProtectionInput) => {
    setStatus('executing')
    setError(null)
    try {
      const result = await apiRequest<{ order: Record<string, unknown>; snapshot: NonNullable<ExchangeSessionState['snapshot']> }>(
        `/api/exchange/positions/${encodeURIComponent(positionId)}/protection`,
        {
          method: 'POST',
          body: JSON.stringify({
            ...input,
            clientRequestId: crypto.randomUUID(),
            confirmation: session.environment === 'prod-live' ? 'CONFIRM' : undefined,
          }),
        },
      )
      setSession((current) => ({ ...current, snapshot: result.snapshot }))
      window.setTimeout(() => refreshHistory(true).catch(() => undefined), 1_000)
      return result.order
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'BingX rejected the protection change'
      setError(message)
      throw requestError
    } finally {
      setStatus('idle')
    }
  }, [refreshHistory, session.environment])

  return {
    session,
    accounts,
    status,
    error,
    tradingSettings,
    contractCatalog,
    settingsLoading: settingsLoading || (session.connected && !contractCatalog),
    history,
    historyLoading,
    connect,
    selectAccount,
    disconnect,
    refresh,
    placeMarketOrder,
    closePosition,
    refreshTradingSettings,
    changeMarginType,
    changeLeverage,
    previewOrder,
    executeOrder,
    cancelOrder,
    amendOrder,
    refreshHistory,
    updatePositionProtection,
  }
}
