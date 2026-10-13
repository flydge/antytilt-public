import { readFileSync } from 'node:fs'
import { Pool } from 'pg'
import { PacketVault } from './vault.js'
import { TicketStore } from './store.js'
const [file, id, event] = process.argv.slice(2),
  c = JSON.parse(readFileSync(file, 'utf8')),
  pool = new Pool(c.database),
  store = new TicketStore(pool, new PacketVault(c.keyFile, process.cwd()))
try {
  await store.claim(id, event)
  console.log('CLAIMED')
} catch {
  console.log('REFUSED')
} finally {
  await pool.end()
}
