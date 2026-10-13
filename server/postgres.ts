import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Pool, types, type PoolClient, type QueryResult, type QueryResultRow } from 'pg'

types.setTypeParser(20, (value) => Number(value))

type Queryable = {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>
}

type PoolLike = Queryable & {
  connect(): Promise<PoolClient>
  end(): Promise<void>
}

const useMemoryDatabase = (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'database-test')
  && !process.env.DATABASE_URL

async function createPool(): Promise<PoolLike> {
  if (useMemoryDatabase) {
    const { DataType, newDb } = await import('pg-mem')
    const memory = newDb({ autoCreateForeignKeyIndices: true })
    memory.public.registerFunction({
      name: 'char_length',
      args: [DataType.text],
      returns: DataType.integer,
      implementation: (value: string) => value.length,
    })
    const adapter = memory.adapters.createPg()
    return new adapter.Pool() as unknown as PoolLike
  }

  const connectionString = process.env.DATABASE_URL?.trim()
  if (!connectionString) {
    throw new Error('DATABASE_URL is required. Start the local PostgreSQL service and configure .env before launching the API.')
  }

  return new Pool({
    connectionString,
    max: Number(process.env.DATABASE_POOL_MAX || 10),
    idleTimeoutMillis: Number(process.env.DATABASE_IDLE_TIMEOUT_MS || 30_000),
    connectionTimeoutMillis: Number(process.env.DATABASE_CONNECT_TIMEOUT_MS || 10_000),
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    application_name: process.env.DATABASE_APPLICATION_NAME || 'antytilt-api',
  })
}

const poolPromise = createPool()
let readyPromise: Promise<void> | undefined

function migrationFiles() {
  const directory = fileURLToPath(new URL('./migrations', import.meta.url))
  return readdirSync(directory)
    .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
    .sort((left, right) => left.localeCompare(right))
    .map((name) => ({ name, sql: readFileSync(new URL(`./migrations/${name}`, import.meta.url), 'utf8') }))
}

async function migrate() {
  const pool = await poolPromise
  const client = await pool.connect()
  try {
    if (!useMemoryDatabase) await client.query('SELECT pg_advisory_lock($1)', [812_904_221])
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at BIGINT NOT NULL
      )
    `)

    for (const migration of migrationFiles()) {
      const applied = await client.query<{ name: string }>('SELECT name FROM schema_migrations WHERE name = $1', [migration.name])
      if (applied.rowCount) continue
      await client.query('BEGIN')
      try {
        await client.query(migration.sql)
        await client.query('INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)', [migration.name, Date.now()])
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    }
  } finally {
    if (!useMemoryDatabase) await client.query('SELECT pg_advisory_unlock($1)', [812_904_221]).catch(() => undefined)
    client.release()
  }
}

export function initializeDatabase() {
  readyPromise ??= migrate()
  return readyPromise
}
export async function applicationDatabasePool() {
  await initializeDatabase()
  return await poolPromise as Pool
}

export async function queryDatabase<R extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = [],
  connection?: Queryable,
) {
  await initializeDatabase()
  const target = connection ?? await poolPromise
  return target.query<R>(text, values)
}

export async function withDatabaseTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  await initializeDatabase()
  const pool = await poolPromise
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await callback(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function databaseHealth() {
  const startedAt = Date.now()
  await queryDatabase('SELECT 1 AS ok')
  return { ok: true as const, latencyMs: Date.now() - startedAt }
}

export async function closeDatabase() {
  const pool = await poolPromise
  await pool.end()
}
