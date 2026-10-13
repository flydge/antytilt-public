-- Public evidence journal only; native outcomes and existing broker locks are untouched.
CREATE TABLE hl_legacy_recovery_journal (
 id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 network TEXT NOT NULL CHECK(network='testnet'), account TEXT NOT NULL,
 cloid TEXT NOT NULL, raw_hash TEXT NOT NULL, data JSONB NOT NULL, retired_at BIGINT NOT NULL,
 UNIQUE(user_id,network,account,cloid,raw_hash)
);
