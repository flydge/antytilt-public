import bs58 from 'bs58'
import { PublicKey } from '@solana/web3.js'
import {
  PROGRAM,
  TOKEN,
  WSOL,
  discriminator,
  positionAddress,
} from '../jupiterCloseTicket/builder.js'
import {
  accountBytes,
  decodeAccount,
  fieldOffset,
  type ReadOnlyRpc,
} from '../jupiterCloseTicket/reader.js'
export interface PositionSummary {
  position: string
  owner: string
  pool: string
  custody: string
  collateralCustody: string
  sizeUsd: string
  collateralUsd: string
  openTime: string
  observedSlot: number
}
export async function deployment(rpc: ReadOnlyRpc) {
  const program = (
    await rpc.call('getAccountInfo', [
      PROGRAM.toBase58(),
      { encoding: 'base64', commitment: 'finalized' },
    ])
  ).value
  if (
    !program?.executable ||
    program.owner !== 'BPFLoaderUpgradeab1e11111111111111111111111'
  )
    throw new Error('Jupiter executable unavailable')
  const raw = accountBytes(program, 64)
  if (raw.length !== 36 || raw.readUInt32LE() !== 2)
    throw new Error('Program identity mismatch')
  const pd = (
    await rpc.call('getAccountInfo', [
      new PublicKey(raw.subarray(4)).toBase58(),
      {
        encoding: 'base64',
        commitment: 'finalized',
        dataSlice: { offset: 0, length: 13 },
      },
    ])
  ).value
  const bytes = accountBytes(pd, 13)
  if (
    pd.owner !== program.owner ||
    bytes.length !== 13 ||
    bytes.readUInt32LE() !== 3
  )
    throw new Error('Deployment identity mismatch')
  return bytes.readBigUInt64LE(4).toString()
}
export async function discoverPositions(
  rpc: ReadOnlyRpc,
  owner: string,
  genesis: string,
): Promise<PositionSummary[]> {
  if ((await rpc.call('getGenesisHash', [])) !== genesis)
    throw new Error('Genesis mismatch')
  const result = await rpc.call('getProgramAccounts', [
    PROGRAM.toBase58(),
    {
      encoding: 'base64',
      commitment: 'finalized',
      withContext: true,
      filters: [
        {
          memcmp: {
            offset: 0,
            bytes: bs58.encode(discriminator('account', 'Position')),
          },
        },
        { memcmp: { offset: fieldOffset('Position', 'owner'), bytes: owner } },
      ],
    },
  ])
  if (!result || !Array.isArray(result.value) || result.value.length > 32)
    throw new Error('Position discovery coverage unavailable or exceeds bound')
  const positions: PositionSummary[] = []
  for (const row of result.value) {
    if (row.account.owner !== PROGRAM.toBase58() || row.account.executable)
      throw new Error('Position account identity mismatch')
    const p = decodeAccount('Position', accountBytes(row.account))
    if (p.owner !== owner) throw new Error('Owner discovery mismatch')
    if (
      p.side !== 'Long' ||
      p.custody !== p.collateralCustody ||
      BigInt(p.sizeUsd) <= 0n
    )
      continue
    if (positionAddress(p) !== row.pubkey)
      throw new Error('Position PDA mismatch')
    const accounts = await rpc.call('getMultipleAccounts', [
      [p.pool, p.custody, WSOL],
      {
        encoding: 'base64',
        commitment: 'finalized',
        minContextSlot: result.context.slot,
      },
    ])
    const [pool, custody, mint] = accounts.value
    if (
      pool?.owner !== PROGRAM.toBase58() ||
      custody?.owner !== PROGRAM.toBase58() ||
      pool.executable ||
      custody.executable
    )
      throw new Error('Pool/custody identity unavailable')
    const po = decodeAccount('Pool', accountBytes(pool)),
      c = decodeAccount('Custody', accountBytes(custody))
    if (c.pool !== p.pool || !po.custodies.includes(p.custody))
      throw new Error('Pool/custody binding mismatch')
    if (c.mint !== WSOL) continue
    const m = accountBytes(mint, 82)
    if (
      mint.owner !== TOKEN.toBase58() ||
      m.length !== 82 ||
      m[44] !== 9 ||
      m[45] !== 1
    )
      throw new Error('Pinned wSOL mint identity mismatch')
    positions.push({
      position: row.pubkey,
      owner,
      pool: p.pool,
      custody: p.custody,
      collateralCustody: p.collateralCustody,
      sizeUsd: p.sizeUsd,
      collateralUsd: p.collateralUsd,
      openTime: p.openTime,
      observedSlot: result.context.slot,
    })
  }
  return positions
}
