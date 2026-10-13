import { PublicKey, Transaction } from '@solana/web3.js'
import { Buffer } from 'buffer'
import { jupiterRequest } from './client'
import type { WalletProvider } from './provider'
// Signing endpoints of the isolated local-validator harness; never mounted by the production API. No live keys.
export async function rehearsalProvider(csrf: string): Promise<WalletProvider> {
  const info = await jupiterRequest<{ owner: string }>('/rehearsal/wallet')
  const publicKey = new PublicKey(info.owner)
  return {
    publicKey,
    isPhantom: false,
    async connect() {
      return { publicKey }
    },
    async disconnect() {},
    async signMessage(message) {
      const r = await jupiterRequest<{ signature: string }>(
        '/rehearsal/sign-message',
        csrf,
        { message: Buffer.from(message).toString('base64') },
      )
      return { signature: Buffer.from(r.signature, 'base64'), publicKey }
    },
    async signTransaction(tx) {
      const r = await jupiterRequest<{ packet: string }>(
        '/rehearsal/sign-transaction',
        csrf,
        {
          unsignedPacket: tx
            .serialize({ requireAllSignatures: false, verifySignatures: false })
            .toString('base64'),
        },
      )
      return Transaction.from(Buffer.from(r.packet, 'base64'))
    },
  }
}
