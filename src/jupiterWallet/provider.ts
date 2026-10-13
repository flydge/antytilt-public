import { Transaction, type PublicKey } from '@solana/web3.js'
import { Buffer } from 'buffer'
export interface WalletProvider {
  isPhantom?: boolean
  publicKey?: PublicKey | null
  connect(): Promise<{ publicKey: PublicKey }>
  disconnect?(): Promise<void>
  signMessage(
    message: Uint8Array,
    display?: string,
  ): Promise<{ signature: Uint8Array; publicKey?: PublicKey }>
  signTransaction(transaction: Transaction): Promise<Transaction>
  on?(event: string, listener: (key?: PublicKey | null) => void): void
  removeListener?(
    event: string,
    listener: (key?: PublicKey | null) => void,
  ): void
}
export function capability(provider?: Partial<WalletProvider> | null) {
  return {
    available:
      provider?.isPhantom === true &&
      ['connect', 'signMessage', 'signTransaction'].every(
        (key) => typeof (provider as any)[key] === 'function',
      ),
    detected: !!provider,
  }
}
export function canResumeVerified(
  provider: Partial<WalletProvider> | undefined,
  owner: string,
) {
  return (
    capability(provider).available && provider?.publicKey?.toBase58() === owner
  )
}
export function phantom(): WalletProvider | undefined {
  return (window as unknown as { phantom?: { solana?: WalletProvider } })
    .phantom?.solana
}
export function bytesToBase64(value: Uint8Array) {
  return Buffer.from(value).toString('base64')
}
export async function signExact(
  provider: Pick<WalletProvider, 'publicKey' | 'signTransaction'>,
  packet: string,
  owner: string,
) {
  if (provider.publicKey?.toBase58() !== owner)
    throw new Error('Wallet account changed; verify this account first')
  const tx = Transaction.from(Buffer.from(packet, 'base64')),
    message = bytesToBase64(tx.serializeMessage())
  const signed = await provider.signTransaction(tx)
  if (provider.publicKey?.toBase58() !== owner)
    throw new Error('Wallet account changed during signing')
  if (bytesToBase64(signed.serializeMessage()) !== message)
    throw new Error(
      'Wallet modified the exact reviewed message. Signing stopped.',
    )
  if (
    signed.signatures.length !== 1 ||
    signed.signatures[0].publicKey.toBase58() !== owner ||
    !signed.verifySignatures(true)
  )
    throw new Error('Owner signature missing or invalid')
  return bytesToBase64(signed.serialize())
}
