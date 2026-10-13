-- Independent manual terminal signer; protection signer/budget are untouched.
CREATE TABLE hl_terminal_agents (
 id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 network TEXT NOT NULL CHECK(network='testnet'), account TEXT NOT NULL CHECK(account=lower(account)),
 agent_address TEXT NOT NULL, agent_name TEXT NOT NULL, expires_at BIGINT NOT NULL,
 signer_ciphertext TEXT, confirmed BOOLEAN NOT NULL DEFAULT FALSE,
 nonce BIGINT NOT NULL DEFAULT 0, busy_packet TEXT, approval JSONB NOT NULL,
 UNIQUE(user_id,network,account), UNIQUE(network,agent_address)
);
CREATE TABLE hl_terminal_executions (
 packet_id TEXT PRIMARY KEY, agent_id UUID NOT NULL REFERENCES hl_terminal_agents(id),
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, account TEXT NOT NULL,
 packet JSONB NOT NULL, payload_hash TEXT NOT NULL, nonce BIGINT NOT NULL,
 state TEXT NOT NULL, result JSONB, created_at BIGINT NOT NULL,
 CHECK(state IN ('SUBMITTING','UNKNOWN','PARTIAL','REJECTED','ACKNOWLEDGED','CONFIRMED'))
);
