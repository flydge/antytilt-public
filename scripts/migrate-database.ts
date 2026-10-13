import 'dotenv/config'
import { closeDatabase, initializeDatabase } from '../server/postgres'

try {
  await initializeDatabase()
  console.log('PostgreSQL migrations are up to date')
} finally {
  await closeDatabase()
}
