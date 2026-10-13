// Ephemeral, unfunded keys only. Never import into production CLI.
import { Keypair, PublicKey } from '@solana/web3.js'
import { prepareTicket, positionAddress, associated } from './builder.js'
export function fixture() {
  const owner = Keypair.generate(),
    key = (n: number) => new PublicKey(Buffer.alloc(32, n)).toBase58()
  const b: any = {
    genesis: key(4),
    owner: owner.publicKey.toBase58(),
    pool: key(9),
    custody: key(10),
    collateralCustody: key(10),
    side: 'Long',
    mint: 'So11111111111111111111111111111111111111112',
    nonce: Keypair.generate().publicKey.toBase58(),
    nonceAuthority: owner.publicKey.toBase58(),
    nonceValue: key(7),
    counter: '9007199254740993',
    absolutePriceBound: '150000000',
    maxFeeLamports: '5000',
    maxRentLamports: '8000000',
    triggerEvent: 'event',
    programDeployment: '123',
    positionHash: 'a'.repeat(64),
    sizeUsd: '200000000',
    collateralUsd: '10000000',
    openTime: '123',
    observedSlot: 10,
  }
  b.position = positionAddress(b)
  b.recipient = associated(b.owner, b.mint)
  return { owner, prepared: prepareTicket(b) }
}
