import { useCallback, useEffect, useRef, useState } from 'react'
import type { RiskEvent, RiskProfile, RiskRuntimeStatus } from '../types'

export const defaultRiskProfile: RiskProfile = {
  active: false,
  timezone: 'UTC',
  externalViolationPolicy: 'BLOCK_NEW_ENTRIES',
  breachAction: 'BLOCK_NEW_ENTRIES',
  closeExternalEntriesOnBreach: true,
  automationConsent: false,
  fixedStopLoss: { enabled: false, value: 2, workingType: 'MARK_PRICE' },
  breakEven: { enabled: false, triggerMode: 'PERCENT', triggerValue: 2, offsetPercent: 0.05 },
  riskPerTrade: { enabled: true, value: 1 },
  dailyLossLimit: { enabled: true, value: 3, unit: 'PERCENT' },
  maxLeverage: { enabled: true, value: 10 },
  maxTradesPerDay: { enabled: true, value: 6 },
  maxConsecutiveLosses: { enabled: false, value: 3 },
  cooldownMinutes: { enabled: false, value: 30 },
  maxExposurePercent: { enabled: false, value: 100 },
  maxOpenPositions: { enabled: false, value: 3 },
  updatedAt: 0,
}

async function riskRequest<T>(path: string, options?: RequestInit) {
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: options?.body ? { 'Content-Type': 'application/json', ...options.headers } : options?.headers,
  })
  const body = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`)
  return body
}

export const neutralRiskProfile: RiskProfile = {
  ...defaultRiskProfile,
  active: false,
  fixedStopLoss: { ...defaultRiskProfile.fixedStopLoss, enabled: false },
  breakEven: { ...defaultRiskProfile.breakEven, enabled: false },
  riskPerTrade: { ...defaultRiskProfile.riskPerTrade, enabled: false },
  dailyLossLimit: { ...defaultRiskProfile.dailyLossLimit, enabled: false },
  maxLeverage: { ...defaultRiskProfile.maxLeverage, enabled: false },
  maxTradesPerDay: { ...defaultRiskProfile.maxTradesPerDay, enabled: false },
  maxConsecutiveLosses: { ...defaultRiskProfile.maxConsecutiveLosses, enabled: false },
  cooldownMinutes: { ...defaultRiskProfile.cooldownMinutes, enabled: false },
  maxExposurePercent: { ...defaultRiskProfile.maxExposurePercent, enabled: false },
  maxOpenPositions: { ...defaultRiskProfile.maxOpenPositions, enabled: false },
}
export function useRiskProfile(enabled = true) {
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const requestEpoch = useRef(0)
  const [profile, setProfile] = useState<RiskProfile>(defaultRiskProfile)
  const [runtime, setRuntime] = useState<RiskRuntimeStatus>({ workerStatus: 'DISCONNECTED' })
  const [events, setEvents] = useState<RiskEvent[]>([])
  const [status, setStatus] = useState<'loading' | 'idle' | 'saving'>('loading')
  const [error, setError] = useState<string | null>(null)

  const refreshRuntime = useCallback(async () => {
    if (!enabledRef.current) return
    const epoch = requestEpoch.current
    const [statusResult, eventsResult] = await Promise.allSettled([
      riskRequest<RiskRuntimeStatus>('/api/risk/status'),
      riskRequest<RiskEvent[] | { events: RiskEvent[] }>('/api/risk/events'),
    ])
    if (!enabledRef.current || epoch !== requestEpoch.current) return
    if (statusResult.status === 'fulfilled') setRuntime(statusResult.value)
    if (eventsResult.status === 'fulfilled') {
      const next = Array.isArray(eventsResult.value) ? eventsResult.value : eventsResult.value.events
      setEvents(Array.isArray(next) ? next : [])
    }
  }, [])

  useEffect(() => {
    let active = true
    requestEpoch.current += 1
    if (!enabled) {
      setProfile(neutralRiskProfile); setRuntime({ workerStatus: 'DISCONNECTED' }); setEvents([]); setStatus('idle'); setError(null)
      return
    }
    setStatus('loading')
    riskRequest<RiskProfile>('/api/risk/profile')
      .then((next) => {
        if (active) setProfile(next)
      })
      .catch((requestError) => {
        if (active) setError(requestError instanceof Error ? requestError.message : 'Could not load the risk profile')
      })
      .finally(() => {
        if (active) setStatus('idle')
      })
    void refreshRuntime()
    const timer = window.setInterval(() => void refreshRuntime(), 5_000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [refreshRuntime, enabled])

  const save = useCallback(async (next: RiskProfile) => {
    if (!enabledRef.current) throw new Error('BingX risk profile is not enabled for this venue')
    const epoch = requestEpoch.current
    setStatus('saving')
    setError(null)
    try {
      const { updatedAt: _updatedAt, ...input } = next
      const stored = await riskRequest<RiskProfile>('/api/risk/profile', {
        method: 'PUT',
        body: JSON.stringify(input),
      })
      if (enabledRef.current && epoch === requestEpoch.current) { setProfile(stored); await refreshRuntime() }
      return stored
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'Could not save the risk profile'
      setError(message)
      throw requestError
    } finally {
      if (enabledRef.current && epoch === requestEpoch.current) setStatus('idle')
    }
  }, [refreshRuntime])

  return enabled ? { profile, runtime, events, status, error, save, refreshRuntime } : { profile: neutralRiskProfile, runtime: { workerStatus: 'DISCONNECTED' as const }, events: [], status: 'idle' as const, error: null, save, refreshRuntime }
}
