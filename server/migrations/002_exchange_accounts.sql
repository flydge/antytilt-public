CREATE TABLE exchange_accounts (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exchange TEXT NOT NULL CHECK (exchange IN ('bingx', 'binance', 'bybit')),
  environment TEXT NOT NULL CHECK (environment IN ('prod-vst', 'prod-live', 'testnet')),
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  api_key_ciphertext TEXT NOT NULL,
  secret_key_ciphertext TEXT NOT NULL,
  api_key_mask TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED', 'ARCHIVED')),
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  connected_at BIGINT NOT NULL,
  last_verified_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  archived_at BIGINT,
  UNIQUE (user_id, exchange, environment)
);

CREATE INDEX exchange_accounts_user_status_idx
  ON exchange_accounts(user_id, status, updated_at DESC);
CREATE INDEX exchange_accounts_monitor_idx
  ON exchange_accounts(exchange, status, environment, updated_at DESC);

INSERT INTO exchange_accounts (
  id, user_id, exchange, environment, label,
  api_key_ciphertext, secret_key_ciphertext, api_key_mask,
  status, is_default, connected_at, last_verified_at, created_at, updated_at
)
SELECT
  user_id, user_id, exchange, environment,
  CASE WHEN environment = 'prod-live' THEN 'BingX Live' ELSE 'BingX VST' END,
  api_key_ciphertext, secret_key_ciphertext, api_key_mask,
  'ACTIVE', TRUE, connected_at, updated_at, connected_at, updated_at
FROM exchange_connections
ON CONFLICT (user_id, exchange, environment) DO NOTHING;
