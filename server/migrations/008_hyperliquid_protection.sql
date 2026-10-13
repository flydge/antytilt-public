CREATE TABLE hl_connections (
 id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 network TEXT NOT NULL CHECK(network='testnet'), account TEXT NOT NULL CHECK(account=lower(account)),
 data JSONB NOT NULL, signer_ciphertext TEXT, nonce BIGINT NOT NULL DEFAULT 0,
 claim_token TEXT, claim_epoch BIGINT NOT NULL DEFAULT 0, claim_until BIGINT NOT NULL DEFAULT 0,
 consent_version INTEGER, created_at BIGINT NOT NULL,
 UNIQUE(network,account), UNIQUE(user_id)
);
CREATE TABLE hl_challenges (
 id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 account TEXT NOT NULL, network TEXT NOT NULL CHECK(network='testnet'), session_hash TEXT NOT NULL,
 origin TEXT NOT NULL, message TEXT NOT NULL, expires_at BIGINT NOT NULL, consumed_at BIGINT
);
CREATE TABLE hl_fills (
 connection_id UUID NOT NULL REFERENCES hl_connections(id) ON DELETE CASCADE,
 fill_id TEXT NOT NULL, occurred_at BIGINT NOT NULL, data JSONB NOT NULL,
 PRIMARY KEY(connection_id,fill_id)
);
CREATE TABLE hl_days (
 connection_id UUID NOT NULL REFERENCES hl_connections(id) ON DELETE CASCADE,
 timezone TEXT NOT NULL, day TEXT NOT NULL, entry_count INTEGER NOT NULL,
 cursor_at BIGINT NOT NULL, history_complete BOOLEAN NOT NULL,
 PRIMARY KEY(connection_id,timezone,day)
);
CREATE TABLE hl_intents (
 id UUID PRIMARY KEY, connection_id UUID NOT NULL REFERENCES hl_connections(id) ON DELETE CASCADE,
 episode_id TEXT NOT NULL, policy_version INTEGER NOT NULL, day TEXT NOT NULL,
 target_size TEXT NOT NULL, opened_at BIGINT NOT NULL, outcome TEXT NOT NULL,
 UNIQUE(connection_id,episode_id,policy_version)
);
CREATE TABLE hl_attempts (
 id UUID PRIMARY KEY, intent_id UUID NOT NULL REFERENCES hl_intents(id) ON DELETE CASCADE,
 ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 3), cloid TEXT NOT NULL UNIQUE,
 payload_hash TEXT NOT NULL, payload JSONB NOT NULL, nonce BIGINT NOT NULL,
 claim_epoch BIGINT NOT NULL, status TEXT NOT NULL,
 submitted_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, provider_oid TEXT,
 UNIQUE(intent_id,ordinal)
);
CREATE TABLE hl_events (
 id UUID PRIMARY KEY, connection_id UUID NOT NULL REFERENCES hl_connections(id) ON DELETE CASCADE,
 event_key TEXT NOT NULL, data JSONB NOT NULL, UNIQUE(connection_id,event_key)
);
CREATE INDEX hl_fills_time ON hl_fills(connection_id,occurred_at);
CREATE INDEX hl_attempts_status ON hl_attempts(status);
