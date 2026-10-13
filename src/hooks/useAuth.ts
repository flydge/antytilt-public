import { useCallback, useEffect, useRef, useState } from 'react'
import { advanceAuthEpoch, onSessionExpired, SESSION_EXPIRED_MESSAGE } from '../authEvents'
import type { AuthSessionState } from '../types'

async function authRequest(path: string, options?: RequestInit) {
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: options?.body ? { 'Content-Type': 'application/json', ...options.headers } : options?.headers,
  })
  if (response.status === 204) return undefined
  const body = await response.json().catch(() => ({})) as AuthSessionState & { error?: string }
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`)
  return body
}

export function useAuth() {
  const [session, setSession] = useState<AuthSessionState>({ authenticated: false })
  const [status, setStatus] = useState<'checking' | 'idle' | 'submitting'>('checking')
  const [error, setError] = useState<string | null>(null)
  const [manualAuthSequence, setManualAuthSequence] = useState(0)

  const alive=useRef(false),revision=useRef(0),sessionRef=useRef(session)
  sessionRef.current=session
  const applySession=(next:AuthSessionState)=>{sessionRef.current=next;setSession(next)}

  useEffect(() => {
    let active = true
    alive.current=true;advanceAuthEpoch();const started=++revision.current
    const unsubscribe=onSessionExpired(()=>{
      if(!active||!alive.current||!sessionRef.current.authenticated)return
      revision.current++;advanceAuthEpoch();applySession({authenticated:false});setStatus('idle');setError(SESSION_EXPIRED_MESSAGE)
    })
    authRequest('/api/auth/session')
      .then((next) => { if (active && revision.current===started && next) applySession(next) })
      .catch((requestError) => { if (active && revision.current===started) setError(requestError instanceof Error ? requestError.message : 'Authentication is unavailable') })
      .finally(() => { if (active && revision.current===started) setStatus('idle') })
    return () => { active = false;alive.current=false;revision.current++;advanceAuthEpoch();unsubscribe() }
  }, [])

  const submit = useCallback(async (mode: 'login' | 'register', email: string, password: string) => {
    const started=++revision.current;advanceAuthEpoch()
    setStatus('submitting')
    setError(null)
    try {
      const next = await authRequest(`/api/auth/${mode}`, {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      })
      if (alive.current && revision.current===started && next?.authenticated) {
        advanceAuthEpoch()
        setManualAuthSequence((current) => current + 1)
        applySession(next)
      }
      return next
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'Could not sign in'
      if(alive.current && revision.current===started)setError(message)
      throw requestError
    } finally {
      if(alive.current && revision.current===started)setStatus('idle')
    }
  }, [])

  const logout = useCallback(async () => {
    const started=++revision.current;advanceAuthEpoch()
    await authRequest('/api/auth/logout', { method: 'DELETE' })
    if(alive.current && revision.current===started){applySession({ authenticated: false });setError(null)}
  }, [])

  return { session, status, error, manualAuthSequence, submit, logout }
}
