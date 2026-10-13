import { useEffect, useRef, useState } from 'react'
import type { PublicKey } from '@solana/web3.js'
import { jupiterRequest as request } from '../jupiterWallet/client'
import {
  bytesToBase64,
  canResumeVerified,
  phantom,
  signExact,
  type WalletProvider,
} from '../jupiterWallet/provider'
import { rehearsalProvider } from '../jupiterWallet/rehearsal'
import type {
  Action,
  Budget,
  Position,
  SetupState,
  TicketView,
  WalletSession,
} from '../jupiterWallet/types'
export function useJupiterTicket() {
  const [session, setSession] = useState<WalletSession | null>(null),
    [positions, setPositions] = useState<Position[]>([]),
    [tickets, setTickets] = useState<TicketView[]>([]),
    [ticket, setTicket] = useState<TicketView | null>(null)
  const [budget, setBudget] = useState<Budget | null>(null),
    [setup, setSetup] = useState<SetupState | null>(null),
    [action, setAction] = useState<Action | null>(null)
  const [error, setError] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [connected, setConnected] = useState<string | null>(null)
  const provider = useRef<WalletProvider | undefined>(undefined),
    epoch = useRef(0),
    sessionRef = useRef<WalletSession | null>(null),
    prepareId = useRef<string | null>(null),
    inFlight = useRef(false)
  const saveSession = (s: WalletSession) => {
    sessionRef.current = s
    setSession(s)
  }
  const clear = () => {
    setPositions([])
    setTickets([])
    setTicket(null)
    setBudget(null)
    setSetup(null)
    setAction(null)
    prepareId.current = null
  }
  const refresh = async (expected = epoch.current) => {
    const s = await request<WalletSession>('/wallet/session')
    if (expected !== epoch.current) return
    saveSession(s)
    if (!s.owner) {
      provider.current = undefined
      setConnected(null)
      clear()
      return
    }
    const resumed =
      s.mode === 'native-rehearsal'
        ? await rehearsalProvider(s.csrf)
        : phantom()
    if (expected !== epoch.current) return
    if (
      resumed?.publicKey?.toBase58() === s.owner &&
      (s.mode === 'native-rehearsal' || canResumeVerified(resumed, s.owner))
    ) {
      provider.current = resumed
      setConnected(s.owner)
    }
    const [p, t, b, n] = await Promise.all([
      request<Position[]>('/positions'),
      request<TicketView[]>('/tickets'),
      request<Budget>('/budget'),
      request<SetupState>('/setup'),
    ])
    if (expected !== epoch.current) return
    if (
      t.some((v) =>
        [
          'PREPARED',
          'ARMED',
          'SUBMITTING',
          'UNKNOWN',
          'REQUEST_PENDING',
        ].includes(v.status),
      )
    )
      prepareId.current = null
    setPositions(p)
    setTickets(t)
    setBudget(b)
    setSetup(n)
    setTicket(
      (current) =>
        t.find((v) => v.id === current?.id) ??
        t.find((v) =>
          [
            'PREPARED',
            'ARMED',
            'SUBMITTING',
            'UNKNOWN',
            'REQUEST_PENDING',
          ].includes(v.status),
        ) ??
        t.at(-1) ??
        null,
    )
  }
  const run = async (fn: (expected: number) => Promise<void>) => {
    if (inFlight.current) return
    inFlight.current = true
    const expected = epoch.current
    setBusy(true)
    setError(null)
    try {
      await fn(expected)
    } catch (e) {
      if (expected === epoch.current)
        setError(e instanceof Error ? e.message : 'Jupiter action failed')
    } finally {
      inFlight.current = false
      if (expected === epoch.current) setBusy(false)
    }
  }
  useEffect(() => {
    let alive = true
    refresh()
      .catch((e) => {
        if (alive) setError(e.message)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
      epoch.current++
    }
  }, [])
  useEffect(() => {
    const p = phantom()
    const switched = (key?: PublicKey | null) => {
      if (sessionRef.current?.mode === 'native-rehearsal') return
      if (
        key &&
        (key.toBase58() === sessionRef.current?.owner ||
          (!sessionRef.current?.owner && !provider.current))
      )
        return
      epoch.current++
      setBusy(false)
      setConnected(null)
      provider.current = undefined
      clear()
      setError(
        'Wallet account changed or disconnected. Verify the current account before continuing.',
      )
      const s = sessionRef.current
      if (s) {
        saveSession({ ...s, owner: null })
        void request<WalletSession>('/wallet/disconnect', s.csrf, {}).catch(
          () => {},
        )
      }
    }
    p?.on?.('accountChanged', switched)
    p?.on?.('disconnect', switched)
    return () => {
      p?.removeListener?.('accountChanged', switched)
      p?.removeListener?.('disconnect', switched)
    }
  }, [])
  const requireProvider = () => {
    const p = provider.current,
      s = sessionRef.current
    if (!s?.owner || !p || p.publicKey?.toBase58() !== s.owner)
      throw new Error('Connect and verify the current wallet first')
    return p
  }
  const connect = () =>
    run(async (expected) => {
      let s = sessionRef.current
      if (!s) {
        s = await request<WalletSession>('/wallet/session')
        if (expected !== epoch.current) return
        saveSession(s)
      }
      const p =
        s.mode === 'native-rehearsal'
          ? await rehearsalProvider(s.csrf)
          : phantom()
      if (!p)
        throw new Error(
          'Phantom is unavailable. Unlock the installed wallet and reload this page.',
        )
      const result = await p.connect()
      if (expected !== epoch.current) return
      provider.current = p
      setConnected(result.publicKey.toBase58())
      clear()
      if (s.owner === result.publicKey.toBase58()) {
        await refresh(expected)
        return
      }
      const challenge = await request<{ id: string; message: string }>(
        '/wallet/challenge',
        s.csrf,
        { owner: result.publicKey.toBase58() },
      )
      if (expected !== epoch.current) return
      const proof = await p.signMessage(
        new TextEncoder().encode(challenge.message),
        'utf8',
      )
      if (
        expected !== epoch.current ||
        p.publicKey?.toBase58() !== result.publicKey.toBase58()
      )
        throw new Error('Wallet account changed during verification')
      const verified = await request<WalletSession>('/wallet/verify', s.csrf, {
        id: challenge.id,
        signature: bytesToBase64(proof.signature),
      })
      if (expected !== epoch.current) return
      saveSession(verified)
      await refresh(expected)
    })
  const disconnect = () =>
    run(async () => {
      epoch.current++
      provider.current = undefined
      setConnected(null)
      clear()
      const s = sessionRef.current
      if (s)
        saveSession(
          await request<WalletSession>('/wallet/disconnect', s.csrf, {}),
        )
      setBusy(false)
    })
  const prepare = (input: {
    position: string
    floorUsd: string
    maxFeeSol: string
    maxRentSol: string
    expiresMinutes: number
  }) =>
    run(async (expected) => {
      requireProvider()
      const s = sessionRef.current!
      prepareId.current ??= crypto.randomUUID()
      const t = await request<TicketView>('/tickets/prepare', s.csrf, {
        ...input,
        clientRequestId: prepareId.current,
      })
      if (expected !== epoch.current) return
      prepareId.current = null
      setTicket(t)
      await refresh(expected)
    })
  const arm = () =>
    run(async (expected) => {
      const p = requireProvider(),
        s = sessionRef.current!,
        t = ticket
      if (!t) throw new Error('Review a ticket first')
      const unsigned = await request<{ unsignedPacket: string }>(
        '/tickets/' + t.id + '/signing-message',
      )
      if (expected !== epoch.current) return
      let packet = await signExact(p, unsigned.unsignedPacket, s.owner!)
      try {
        if (expected !== epoch.current) return
        const armed = await request<TicketView>(
          '/tickets/' + t.id + '/arm',
          s.csrf,
          { packet, reviewHash: t.reviewHash, consent: true },
        )
        if (expected !== epoch.current) return
        setTicket(armed)
        prepareId.current = null
        await refresh(expected)
      } catch (e) {
        await refresh(expected).catch(() => {})
        throw e
      } finally {
        packet = ''
      }
    })
  const ticketAction = (
    name: 'trigger' | 'reconcile' | 'disable' | 'confirm-revoke',
  ) =>
    run(async (expected) => {
      const s = sessionRef.current!,
        t = ticket
      if (!t || !s?.owner) throw new Error('Verify the ticket wallet first')
      if (name === 'trigger') requireProvider()
      const next = await request<TicketView>(
        '/tickets/' + t.id + '/' + name,
        s.csrf,
        {
          consent: true,
          ...(name === 'trigger' ? { reviewHash: t.reviewHash } : {}),
        },
      )
      if (expected !== epoch.current) return
      if (
        [
          'DISABLED',
          'REVOKED',
          'INVALIDATED',
          'CLOSED',
          'FAILED_CONSUMED',
        ].includes(next.status)
      )
        prepareId.current = null
      setTicket(next)
      await refresh(expected)
    })
  const prepareAction = (kind: 'SETUP' | 'REVOKE') =>
    run(async (expected) => {
      requireProvider()
      const s = sessionRef.current!,
        a = await request<Action>(
          kind === 'SETUP'
            ? '/setup/prepare'
            : '/tickets/' + ticket!.id + '/revoke/prepare',
          s.csrf,
          {},
        )
      if (expected === epoch.current) setAction(a)
    })
  const submitAction = () =>
    run(async (expected) => {
      const p = requireProvider(),
        s = sessionRef.current!,
        a = action
      if (!a?.id || a.status !== 'PREPARED' || !a.preview)
        throw new Error('Review a prepared action first')
      let packet = await signExact(p, a.preview.unsignedPacket, s.owner!)
      try {
        if (expected !== epoch.current) return
        const next = await request<Action>(
          '/actions/' + a.id + '/submit',
          s.csrf,
          { packet, reviewHash: a.preview.messageHash, consent: true },
        )
        if (expected !== epoch.current) return
        setAction({ ...a, ...next })
        await refresh(expected)
      } finally {
        packet = ''
      }
    })
  const refreshAction = () =>
    run(async (expected) => {
      const a = action
      if (!a?.id) return
      const next = await request<Action>('/actions/' + a.id)
      if (expected !== epoch.current) return
      setAction({ ...a, ...next })
      await refresh(expected)
    })
  return {
    session,
    positions,
    tickets,
    ticket,
    budget,
    setup,
    action,
    error,
    loading,
    busy,
    connected,
    connect,
    disconnect,
    prepare,
    arm,
    ticketAction,
    prepareAction,
    submitAction,
    refreshAction,
    refresh: () => run(refresh),
    selectTicket: setTicket,
  }
}
