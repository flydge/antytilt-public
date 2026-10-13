import type { ExchangeBalance, ExchangeEnvironment } from './types'

export function settlementAsset(environment: ExchangeEnvironment | undefined) {
  return environment === 'prod-vst' ? 'VST' : 'USDT'
}

export function selectSettlementBalance(
  environment: ExchangeEnvironment | undefined,
  balances: ExchangeBalance[] | undefined,
) {
  const rows = balances ?? []
  const preferredAsset = settlementAsset(environment)
  return rows.find((balance) => balance.asset.toUpperCase() === preferredAsset)
    ?? (rows.length === 1 ? rows[0] : undefined)
}
