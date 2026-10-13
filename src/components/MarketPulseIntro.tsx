import { useEffect, useRef } from 'react'

type Props = {
  onComplete: () => void
}

export function MarketPulseIntro({ onComplete }: Props) {
  const completionRef = useRef(onComplete)

  useEffect(() => {
    completionRef.current = onComplete
  }, [onComplete])

  useEffect(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const timer = window.setTimeout(() => completionRef.current(), reducedMotion ? 260 : 1_980)
    return () => window.clearTimeout(timer)
  }, [])

  return (
    <div className="login-market-pulse" role="status" aria-live="polite" aria-label="Opening the AntyTILT trading terminal">
      <div className="market-pulse-stage" aria-hidden="true">
        <svg className="market-pulse-trace" viewBox="0 0 420 72" preserveAspectRatio="none">
          <path d="M2 38 H72 L86 24 L101 49 L118 17 L135 38 H191 L204 30 L217 42 H270 L284 27 L297 38 H418" />
        </svg>
        <div className="market-pulse-lockup">
          <svg className="market-pulse-symbol" viewBox="0 0 68 58">
            <path className="market-pulse-mark market-pulse-mark-top" d="M8 18 H48" />
            <path className="market-pulse-mark market-pulse-mark-bottom" d="M4 38 H44" />
            <path className="market-pulse-mark market-pulse-mark-stem" d="M55 8 L47 50" />
          </svg>
          <span className="market-pulse-wordmark"><span>ANTY</span><strong>TILT</strong></span>
        </div>
        <span className="market-pulse-baseline" />
      </div>
      <span className="visually-hidden">Authentication complete. Loading your trading workspace.</span>
    </div>
  )
}
