import 'dotenv/config'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { closeDatabase, initializeDatabase, queryDatabase, withDatabaseTransaction } from '../server/postgres'

type TablePlan = {
  table: string
  columns: string[]
  booleans?: string[]
  json?: string[]
}

const plans: TablePlan[] = [
  { table: 'users', columns: ['id', 'email', 'password_hash', 'created_at'] },
  { table: 'auth_sessions', columns: ['token_hash', 'user_id', 'created_at', 'last_seen_at', 'expires_at'] },
  {
    table: 'exchange_connections',
    columns: ['user_id', 'exchange', 'environment', 'api_key_ciphertext', 'secret_key_ciphertext', 'api_key_mask', 'connected_at', 'updated_at'],
  },
  {
    table: 'order_history',
    columns: ['user_id', 'environment', 'order_id', 'symbol', 'side', 'position_side', 'type', 'price', 'avg_price', 'quantity', 'executed_qty', 'status', 'realized_pnl', 'fee', 'created_at', 'updated_at', 'raw_json'],
    json: ['raw_json'],
  },
  {
    table: 'trade_history',
    columns: ['user_id', 'environment', 'trade_id', 'order_id', 'symbol', 'side', 'position_side', 'price', 'quantity', 'realized_pnl', 'fee', 'created_at', 'raw_json'],
    json: ['raw_json'],
  },
  {
    table: 'audit_events',
    columns: ['id', 'user_id', 'action', 'resource_type', 'resource_id', 'metadata_json', 'created_at'],
    json: ['metadata_json'],
  },
  {
    table: 'risk_profiles',
    columns: ['user_id', 'active', 'profile_json', 'created_at', 'updated_at'],
    booleans: ['active'],
    json: ['profile_json'],
  },
  {
    table: 'risk_daily_state',
    columns: ['user_id', 'environment', 'trading_day', 'timezone', 'trade_count', 'opening_equity_micros', 'last_equity_micros', 'initialized', 'created_at', 'updated_at'],
    booleans: ['initialized'],
  },
  {
    table: 'risk_position_state',
    columns: ['user_id', 'environment', 'position_key', 'position_id', 'symbol', 'side', 'quantity', 'status', 'origin', 'missed_snapshots', 'enforcement_status', 'opened_at', 'last_seen_at', 'created_at', 'updated_at'],
  },
  {
    table: 'risk_entry_reservations',
    columns: ['id', 'user_id', 'environment', 'trading_day', 'request_id', 'symbol', 'side', 'status', 'order_id', 'created_at', 'updated_at', 'resolved_at'],
  },
  {
    table: 'risk_events',
    columns: ['id', 'user_id', 'environment', 'trading_day', 'event_key', 'rule_name', 'action', 'source', 'result', 'metadata_json', 'created_at'],
    json: ['metadata_json'],
  },
  {
    table: 'risk_protection_state',
    columns: ['user_id', 'environment', 'position_key', 'position_id', 'symbol', 'direction', 'entry_price', 'best_price', 'triggered', 'active', 'missing_count', 'managed_order_id', 'managed_stop_price', 'managed_quantity', 'managed_placed_at', 'failure_count', 'retry_at', 'last_action_at', 'created_at', 'updated_at'],
    booleans: ['triggered', 'active'],
  },
  {
    table: 'risk_streak_state',
    columns: ['user_id', 'environment', 'trading_day', 'timezone', 'consecutive_losses', 'cooldown_until', 'last_outcome_at', 'created_at', 'updated_at'],
  },
  {
    table: 'risk_trade_outcomes',
    columns: ['user_id', 'environment', 'trading_day', 'outcome_key', 'order_id', 'net_pnl_micros', 'outcome', 'closed_at', 'created_at'],
  },
]

const sourceArgument = process.argv.find((argument) => argument.startsWith('--source='))?.slice('--source='.length)
const sourcePath = resolve(process.cwd(), sourceArgument || process.env.SQLITE_SOURCE_PATH || 'data/antytilt.sqlite')
const allowExisting = process.argv.includes('--allow-existing')

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must point to the target PostgreSQL database')
if (!existsSync(sourcePath)) throw new Error(`SQLite source does not exist: ${sourcePath}`)

const sqlite = new DatabaseSync(sourcePath, { readOnly: true })

try {
  await initializeDatabase()
  if (!allowExisting) {
    const populated: string[] = []
    for (const plan of plans) {
      const count = Number((await queryDatabase<{ count: number }>(`SELECT COUNT(*)::int AS count FROM ${plan.table}`)).rows[0]?.count ?? 0)
      if (count > 0) populated.push(`${plan.table} (${count})`)
    }
    if (populated.length) {
      throw new Error(`Target PostgreSQL database is not empty: ${populated.join(', ')}. Use --allow-existing only for an intentional idempotent merge.`)
    }
  }

  const report = await withDatabaseTransaction(async (client) => {
    const imported: Record<string, number> = {}
    for (const plan of plans) {
      const rows = sqlite.prepare(`SELECT ${plan.columns.join(', ')} FROM ${plan.table}`).all() as Array<Record<string, unknown>>
      let count = 0
      for (const row of rows) {
        const values = plan.columns.map((column) => plan.booleans?.includes(column) ? Boolean(row[column]) : row[column])
        const placeholders = plan.columns.map((column, index) => `$${index + 1}${plan.json?.includes(column) ? '::jsonb' : ''}`)
        const result = await queryDatabase(`
          INSERT INTO ${plan.table} (${plan.columns.join(', ')})
          VALUES (${placeholders.join(', ')})
          ON CONFLICT DO NOTHING
        `, values, client)
        count += result.rowCount ?? 0
      }
      imported[plan.table] = count
    }
    return imported
  })

  console.log(JSON.stringify({ source: sourcePath, imported: report }, null, 2))
} finally {
  sqlite.close()
  await closeDatabase()
}
