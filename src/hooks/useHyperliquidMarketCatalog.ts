import { useEffect, useState } from 'react'
import { loadHyperliquidMarketCatalog } from '../marketData/hyperliquidAdapter'
import type { HyperliquidMarketNetwork } from '../marketData'
import type { MarketInstrument } from '../types'

type CatalogState = {
  network: HyperliquidMarketNetwork
  markets: MarketInstrument[]
  status: 'loading' | 'live' | 'unavailable'
  error: string | null
}
export function useHyperliquidMarketCatalog(network: HyperliquidMarketNetwork = 'mainnet') {
  const [state, setState] = useState<CatalogState>({ network, markets: [], status: 'loading', error: null })
  useEffect(() => {
    const controller = new AbortController()
    setState({ network, markets: [], status: 'loading', error: null })
    void loadHyperliquidMarketCatalog(network, controller.signal).then(markets => {
      if (!controller.signal.aborted) setState({ network, markets, status: 'live', error: null })
    }).catch(error => {
      if (!controller.signal.aborted) setState({ network, markets: [], status: 'unavailable', error: error instanceof Error ? error.message : 'Hyperliquid market catalog unavailable' })
    })
    return () => controller.abort()
  }, [network])
  // Never show the other network's universe while the new request starts.
  return state.network === network ? state : { network, markets: [], status: 'loading' as const, error: null }
}
