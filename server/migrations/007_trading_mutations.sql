CREATE TABLE trading_mutations (
  exchange_account_id UUID NOT NULL REFERENCES exchange_accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation TEXT NOT NULL CHECK (char_length(operation) BETWEEN 1 AND 80),
  request_id TEXT NOT NULL CHECK (char_length(request_id) BETWEEN 1 AND 128),
  request_hash TEXT NOT NULL CHECK (char_length(request_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED', 'UNCERTAIN')),
  response_json JSONB,
  error_json JSONB,
  exchange_order_id TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  completed_at BIGINT,
  PRIMARY KEY (exchange_account_id, operation, request_id)
);

CREATE INDEX trading_mutations_user_time_idx
  ON trading_mutations(user_id, created_at DESC);
CREATE INDEX trading_mutations_pending_idx
  ON trading_mutations(status, updated_at)
  WHERE status IN ('PENDING', 'UNCERTAIN');
