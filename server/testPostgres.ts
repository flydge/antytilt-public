import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const candidates = [
  '/opt/homebrew/opt/postgresql@17/bin',
  '/usr/local/opt/postgresql@17/bin',
  '/usr/lib/postgresql/17/bin',
]

/**
 * Directory containing PostgreSQL 17 `initdb`, `pg_ctl` and `postgres`, with a trailing slash.
 * Set POSTGRES_BIN_DIR to choose one explicitly; otherwise `pg_config --bindir` and common
 * install locations are tried. Returns undefined when no server binaries are available.
 */
export function postgresBinDir(): string | undefined {
  const configured = process.env.POSTGRES_BIN_DIR
  const found = [configured, pgConfigBinDir(), ...candidates]
    .filter((dir): dir is string => Boolean(dir))
    .find((dir) => existsSync(join(dir, 'initdb')) && existsSync(join(dir, 'pg_ctl')))
  return found ? join(found, '/') : undefined
}

function pgConfigBinDir() {
  try {
    return execFileSync('pg_config', ['--bindir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return undefined
  }
}

export const postgresSkipReason = 'PostgreSQL 17 server binaries not found; set POSTGRES_BIN_DIR'
