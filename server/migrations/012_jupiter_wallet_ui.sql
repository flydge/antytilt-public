-- App sessions and wallet proofs have their own authority boundary.
CREATE TABLE IF NOT EXISTS jupiter_ui_sessions (
 user_id TEXT NOT NULL,
 session_id TEXT NOT NULL,
 origin TEXT NOT NULL,
 genesis TEXT NOT NULL,
 csrf TEXT NOT NULL,
 csrf_expires_at BIGINT NOT NULL,
 wallet_owner TEXT,
 verified_expires_at BIGINT,
 PRIMARY KEY (user_id, session_id, origin, genesis),
 CHECK ((wallet_owner IS NULL) = (verified_expires_at IS NULL))
);
CREATE TABLE IF NOT EXISTS jupiter_ui_challenges (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL,
 session_id TEXT NOT NULL,
 origin TEXT NOT NULL,
 genesis TEXT NOT NULL,
 owner_key TEXT NOT NULL,
 message TEXT NOT NULL,
 issued_at BIGINT NOT NULL,
 expires_at BIGINT NOT NULL,
 consumed BOOLEAN NOT NULL DEFAULT FALSE,
 FOREIGN KEY (user_id, session_id, origin, genesis)
 REFERENCES jupiter_ui_sessions (user_id, session_id, origin, genesis),
 CHECK (expires_at > issued_at)
);
CREATE INDEX IF NOT EXISTS jupiter_ui_challenges_session
 ON jupiter_ui_challenges (user_id, session_id, origin, genesis);
CREATE TABLE IF NOT EXISTS jupiter_ui_tickets (
 ticket_id TEXT PRIMARY KEY REFERENCES jupiter_close_tickets(id),
 user_id TEXT NOT NULL,
 wallet_owner TEXT NOT NULL,
 client_request_id TEXT NOT NULL,
 review_json TEXT NOT NULL,
 authorization_ciphertext TEXT,
 UNIQUE (user_id, client_request_id)
);
CREATE TABLE IF NOT EXISTS jupiter_ui_setups (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL,
 wallet_owner TEXT NOT NULL,
 genesis TEXT NOT NULL,
 nonce_key TEXT NOT NULL,
 seed TEXT NOT NULL,
 prepared_json TEXT,
 signature TEXT,
 status TEXT NOT NULL,
 created_at BIGINT NOT NULL,
 UNIQUE (genesis, wallet_owner)
);
CREATE TABLE IF NOT EXISTS jupiter_ui_actions (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL,
 wallet_owner TEXT NOT NULL,
 genesis TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('SETUP','REVOKE')),
 ticket_id TEXT REFERENCES jupiter_close_tickets(id),
 prepared_json TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('PREPARED','EXPIRED','SUBMITTING','UNKNOWN','FINALIZED','FAILED')),
 signature TEXT,
 created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS jupiter_ui_one_pending_action
 ON jupiter_ui_actions(genesis,wallet_owner,kind)
 WHERE status IN ('PREPARED','SUBMITTING','UNKNOWN');
