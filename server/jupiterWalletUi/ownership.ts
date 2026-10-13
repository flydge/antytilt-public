import {
  createPublicKey,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import bs58 from 'bs58'

export type Scope = { userId: string; sessionId: string; origin: string }
type Database = Pick<Pool, 'query' | 'connect'>
type SessionRow = {
  csrf: string
  csrf_expires_at: string | number
  wallet_owner: string | null
  verified_expires_at: string | number | null
}
const sessionTTL = 24 * 60 * 60 * 1000
const challengeTTL = 5 * 60 * 1000
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const keyPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex')

export class OwnershipError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'OwnershipError'
  }
}

export class WalletOwnership {
  constructor(
    private readonly pool: Database,
    readonly genesis: string,
    readonly trustedOrigin: string,
    private readonly now: () => number = Date.now,
  ) {
    const parsed = new URL(trustedOrigin)
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.origin !== trustedOrigin ||
      !keyPattern.test(genesis)
    )
      throw new OwnershipError(500, 'Wallet ownership configuration invalid')
  }

  private binding(scope: Scope) {
    if (!scope || scope.origin !== this.trustedOrigin)
      throw new OwnershipError(403, 'Origin refused')
    if (
      typeof scope.userId !== 'string' ||
      !scope.userId ||
      scope.userId.length > 128 ||
      /[\x00-\x1f\x7f]/.test(scope.userId) ||
      typeof scope.sessionId !== 'string' ||
      !/^[0-9a-f]{64}$/.test(scope.sessionId)
    )
      throw new OwnershipError(401, 'App session unavailable')
    return [scope.userId, scope.sessionId, scope.origin, this.genesis]
  }

  private async transaction<T>(
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    let client: PoolClient | undefined
    try {
      client = await this.pool.connect()
      await client.query('BEGIN')
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {})
      if (error instanceof OwnershipError) throw error
      throw new OwnershipError(503, 'Wallet verification unavailable')
    } finally {
      client?.release()
    }
  }

  private async row(
    client: PoolClient,
    binding: string[],
    lock = false,
  ): Promise<SessionRow | undefined> {
    return (
      await client.query(
        `SELECT csrf,csrf_expires_at,wallet_owner,verified_expires_at FROM jupiter_ui_sessions WHERE user_id=$1 AND session_id=$2 AND origin=$3 AND genesis=$4${lock ? ' FOR UPDATE' : ''}`,
        binding,
      )
    ).rows[0]
  }

  private verified(row: SessionRow | undefined, now: number): string | null {
    return row &&
      Number(row.csrf_expires_at) > now &&
      Number(row.verified_expires_at) > now
      ? row.wallet_owner
      : null
  }

  async session(scope: Scope): Promise<{
    csrf: string
    owner: string | null
    genesis: string
    origin: string
  }> {
    const binding = this.binding(scope)
    return this.transaction(async (client) => {
      const now = this.now()
      await client.query(
        'INSERT INTO jupiter_ui_sessions (user_id,session_id,origin,genesis,csrf,csrf_expires_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id,session_id,origin,genesis) DO NOTHING',
        [...binding, randomBytes(32).toString('hex'), now + sessionTTL],
      )
      let row = (await this.row(client, binding, true))!
      if (Number(row.csrf_expires_at) <= this.now()) {
        const csrf = randomBytes(32).toString('hex'),
          expires = this.now() + sessionTTL
        await client.query(
          'UPDATE jupiter_ui_sessions SET csrf=$5,csrf_expires_at=$6,wallet_owner=NULL,verified_expires_at=NULL WHERE user_id=$1 AND session_id=$2 AND origin=$3 AND genesis=$4',
          [...binding, csrf, expires],
        )
        await client.query(
          'UPDATE jupiter_ui_challenges SET consumed=TRUE WHERE user_id=$1 AND session_id=$2 AND origin=$3 AND genesis=$4 AND consumed=FALSE',
          binding,
        )
        row = {
          csrf,
          csrf_expires_at: expires,
          wallet_owner: null,
          verified_expires_at: null,
        }
      }
      return {
        csrf: row.csrf,
        owner: this.verified(row, this.now()),
        genesis: this.genesis,
        origin: this.trustedOrigin,
      }
    })
  }

  async requireMutation(scope: Scope, csrf: string): Promise<void> {
    const binding = this.binding(scope)
    if (typeof csrf !== 'string' || !/^[0-9a-f]{64}$/.test(csrf))
      throw new OwnershipError(403, 'Request verification failed')
    await this.transaction(async (client) => {
      const row = await this.row(client, binding)
      if (
        !row ||
        Number(row.csrf_expires_at) <= this.now() ||
        !timingSafeEqual(Buffer.from(row.csrf), Buffer.from(csrf))
      )
        throw new OwnershipError(403, 'Request verification failed')
    })
  }

  async challenge(
    scope: Scope,
    owner: string,
  ): Promise<{
    id: string
    message: string
    expiresAt: number
    owner: string
    genesis: string
  }> {
    const binding = this.binding(scope)
    this.publicKey(owner, 400)
    return this.transaction(async (client) => {
      const row = await this.row(client, binding, true),
        issuedAt = this.now()
      if (!row || Number(row.csrf_expires_at) <= issuedAt)
        throw new OwnershipError(401, 'App session unavailable')
      const id = randomUUID(),
        expiresAt = Math.min(
          issuedAt + challengeTTL,
          Number(row.csrf_expires_at),
        ),
        nonce = randomBytes(32).toString('hex')
      // This UI supports mainnet and isolated native rehearsal. Phantom SIWS
      // accepts named networks in Chain ID, not a CAIP-prefixed genesis hash.
      // Keep the exact chain binding in both the signed resource and DB scope.
      const chainId = this.genesis === '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
        ? 'mainnet' : 'localnet'
      const message = `${new URL(this.trustedOrigin).host} wants you to sign in with your Solana account:\n${owner}\n\nSign in to AntyTILT to verify wallet ownership. This does not authorize any transaction.\n\nURI: ${this.trustedOrigin}\nVersion: 1\nChain ID: ${chainId}\nNonce: ${nonce}\nIssued At: ${new Date(issuedAt).toISOString()}\nExpiration Time: ${new Date(expiresAt).toISOString()}\nRequest ID: ${id}\nResources:\n- urn:solana:genesis:${this.genesis}`
      await client.query(
        'UPDATE jupiter_ui_sessions SET wallet_owner=NULL,verified_expires_at=NULL WHERE user_id=$1 AND session_id=$2 AND origin=$3 AND genesis=$4',
        binding,
      )
      await client.query(
        'UPDATE jupiter_ui_challenges SET consumed=TRUE WHERE user_id=$1 AND session_id=$2 AND origin=$3 AND genesis=$4 AND consumed=FALSE',
        binding,
      )
      await client.query(
        'INSERT INTO jupiter_ui_challenges (id,user_id,session_id,origin,genesis,owner_key,message,issued_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [id, ...binding, owner, message, issuedAt, expiresAt],
      )
      return { id, message, expiresAt, owner, genesis: this.genesis }
    })
  }

  private publicKey(owner: string, status: number) {
    try {
      if (typeof owner !== 'string' || !keyPattern.test(owner))
        throw new Error()
      const bytes = bs58.decode(owner)
      if (bytes.length !== 32 || bs58.encode(bytes) !== owner) throw new Error()
      return createPublicKey({
        key: Buffer.concat([spkiPrefix, bytes]),
        type: 'spki',
        format: 'der',
      })
    } catch {
      throw new OwnershipError(status, 'Wallet public key invalid')
    }
  }

  async verify(
    scope: Scope,
    id: string,
    signatureBase64: string,
  ): Promise<string> {
    const binding = this.binding(scope)
    if (
      typeof id !== 'string' ||
      !uuid.test(id) ||
      typeof signatureBase64 !== 'string' ||
      !/^[A-Za-z0-9+/]{86}==$/.test(signatureBase64)
    )
      throw new OwnershipError(401, 'Wallet proof refused')
    const signature = Buffer.from(signatureBase64, 'base64')
    if (
      signature.length !== 64 ||
      signature.toString('base64') !== signatureBase64
    )
      throw new OwnershipError(401, 'Wallet proof refused')
    return this.transaction(async (client) => {
      const session = await this.row(client, binding, true),
        now = this.now()
      if (!session || Number(session.csrf_expires_at) <= now)
        throw new OwnershipError(401, 'Wallet proof refused')
      const challenge = (
        await client.query(
          'UPDATE jupiter_ui_challenges SET consumed=TRUE WHERE id=$1 AND user_id=$2 AND session_id=$3 AND origin=$4 AND genesis=$5 AND consumed=FALSE AND expires_at>$6 RETURNING owner_key,message',
          [id, ...binding, now],
        )
      ).rows[0]
      if (
        !challenge ||
        !verifySignature(
          null,
          Buffer.from(challenge.message, 'utf8'),
          this.publicKey(challenge.owner_key, 401),
          signature,
        )
      )
        throw new OwnershipError(401, 'Wallet proof refused')
      const expires = Math.min(
        now + sessionTTL,
        Number(session.csrf_expires_at),
      )
      await client.query(
        'UPDATE jupiter_ui_sessions SET wallet_owner=$5,verified_expires_at=$6 WHERE user_id=$1 AND session_id=$2 AND origin=$3 AND genesis=$4',
        [...binding, challenge.owner_key, expires],
      )
      return challenge.owner_key
    })
  }

  async owner(scope: Scope): Promise<string> {
    const binding = this.binding(scope)
    return this.transaction(async (client) => {
      const owner = this.verified(await this.row(client, binding), this.now())
      if (!owner) throw new OwnershipError(401, 'Wallet verification required')
      return owner
    })
  }

  async disconnect(scope: Scope): Promise<void> {
    const binding = this.binding(scope)
    await this.transaction(async (client) => {
      await this.row(client, binding, true)
      await client.query(
        'UPDATE jupiter_ui_sessions SET wallet_owner=NULL,verified_expires_at=NULL WHERE user_id=$1 AND session_id=$2 AND origin=$3 AND genesis=$4',
        binding,
      )
      await client.query(
        'UPDATE jupiter_ui_challenges SET consumed=TRUE WHERE user_id=$1 AND session_id=$2 AND origin=$3 AND genesis=$4 AND consumed=FALSE',
        binding,
      )
    })
  }
}
