import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import {
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  realpathSync,
  lstatSync,
} from 'node:fs'
import { constants } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
function strict(path: string, mode: number) {
  const s = lstatSync(path)
  if (
    s.isSymbolicLink() ||
    (s.mode & 0o777) !== mode ||
    s.uid !== process.getuid?.()
  )
    throw new Error(`Strict ${mode.toString(8)} permissions required`)
}
export function privateExternalFile(
  path: string,
  repo: string,
  max = 16384,
): Buffer {
  const real = realpathSync(path),
    root = realpathSync(repo),
    rel = relative(root, real)
  if (
    rel === '' ||
    (rel !== '..' && !rel.startsWith('../') && !rel.startsWith('/'))
  )
    throw new Error('Sensitive file must be outside repository')
  strict(dirname(real), 0o700)
  strict(path, 0o600)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const s = fstatSync(fd)
    if (!s.isFile() || s.size > max || (s.mode & 0o777) !== 0o600)
      throw new Error('Unsafe sensitive file')
    return readFileSync(fd)
  } finally {
    closeSync(fd)
  }
}
export class PacketVault {
  private readonly key: Buffer
  constructor(keyPath: string, repo: string) {
    this.key = privateExternalFile(resolve(keyPath), repo, 32)
    if (this.key.length !== 32) throw new Error('Raw 32-byte key file required')
  }
  encrypt(packet: Uint8Array, context: string): string {
    const iv = randomBytes(12),
      c = createCipheriv('aes-256-gcm', this.key, iv)
    c.setAAD(Buffer.from(context))
    const out = Buffer.concat([c.update(packet), c.final()])
    return [
      'v1',
      iv.toString('base64url'),
      c.getAuthTag().toString('base64url'),
      out.toString('base64url'),
    ].join('.')
  }
  decrypt(payload: string, context: string): Buffer {
    const parts = payload.split('.')
    if (parts.length !== 4 || parts[0] !== 'v1')
      throw new Error('Invalid encrypted packet')
    const [, iv, tag, bytes] = parts
    const d = createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(iv, 'base64url'),
    )
    d.setAAD(Buffer.from(context))
    d.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([d.update(Buffer.from(bytes, 'base64url')), d.final()])
  }
}
