import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const KEY_BYTES = 32

function loadMasterKey() {
  if (process.env.CREDENTIALS_ENCRYPTION_KEY) {
    const key = Buffer.from(process.env.CREDENTIALS_ENCRYPTION_KEY, 'base64')
    if (key.length !== KEY_BYTES) throw new Error('CREDENTIALS_ENCRYPTION_KEY must be a base64-encoded 32-byte key')
    return key
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('CREDENTIALS_ENCRYPTION_KEY is required in production')
  }

  if (process.env.NODE_ENV === 'test') return Buffer.alloc(KEY_BYTES, 7)

  const keyPath = resolve(process.cwd(), 'data/.credential-key')
  if (existsSync(keyPath)) {
    const key = Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'base64')
    if (key.length !== KEY_BYTES) throw new Error(`Invalid local credential key at ${keyPath}`)
    return key
  }

  mkdirSync(dirname(keyPath), { recursive: true })
  const key = randomBytes(KEY_BYTES)
  writeFileSync(keyPath, key.toString('base64'), { mode: 0o600 })
  chmodSync(keyPath, 0o600)
  return key
}

const masterKey = loadMasterKey()

export function encryptCredential(value: string, context: string) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', masterKey, nonce)
  cipher.setAAD(Buffer.from(context, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return ['v1', nonce.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.')
}

export function decryptCredential(payload: string, context: string) {
  const [version, nonceRaw, tagRaw, ciphertextRaw] = payload.split('.')
  if (version !== 'v1' || !nonceRaw || !tagRaw || !ciphertextRaw) throw new Error('Stored exchange credential is invalid')
  const decipher = createDecipheriv('aes-256-gcm', masterKey, Buffer.from(nonceRaw, 'base64url'))
  decipher.setAAD(Buffer.from(context, 'utf8'))
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextRaw, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}
