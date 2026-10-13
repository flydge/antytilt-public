-- Independent operator path. No changes to shared exchange/session credentials.
CREATE TABLE IF NOT EXISTS jupiter_close_tickets (
 id TEXT PRIMARY KEY,
 genesis TEXT NOT NULL,
 owner_key TEXT NOT NULL,
 position_key TEXT NOT NULL,
 nonce_key TEXT NOT NULL,
 nonce_value TEXT NOT NULL,
 prepared_ciphertext TEXT NOT NULL,
 packet_ciphertext TEXT,
 packet_hash TEXT,
 signature TEXT,
 status TEXT NOT NULL CHECK (status IN ('PREPARED','ARMED','SUBMITTING','UNKNOWN','REQUEST_PENDING','FAILED_CONSUMED','INVALIDATED','DISABLED','REVOKED','CLOSED')),
 intent_event TEXT,
 intent_at TEXT,
 detail TEXT,
 UNIQUE (genesis, nonce_key, nonce_value)
);
CREATE UNIQUE INDEX IF NOT EXISTS jupiter_close_ticket_one_active_position
 ON jupiter_close_tickets (genesis, owner_key, position_key)
 WHERE status IN ('PREPARED','ARMED','SUBMITTING','UNKNOWN','REQUEST_PENDING');
