CREATE TABLE users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id);
CREATE INDEX auth_sessions_expiry_idx ON auth_sessions(expires_at);

CREATE TABLE exchange_connections (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  exchange TEXT NOT NULL CHECK (exchange IN ('bingx')),
  environment TEXT NOT NULL CHECK (environment IN ('prod-vst', 'prod-live')),
  api_key_ciphertext TEXT NOT NULL,
  secret_key_ciphertext TEXT NOT NULL,
  api_key_mask TEXT NOT NULL,
  connected_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX exchange_connections_environment_idx ON exchange_connections(environment, updated_at DESC);

CREATE TABLE order_history (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  environment TEXT NOT NULL CHECK (environment IN ('prod-vst', 'prod-live')),
  order_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  position_side TEXT NOT NULL,
  type TEXT NOT NULL,
  price TEXT NOT NULL,
  avg_price TEXT NOT NULL,
  quantity TEXT NOT NULL,
  executed_qty TEXT NOT NULL,
  status TEXT NOT NULL,
  realized_pnl TEXT NOT NULL,
  fee TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  raw_json JSONB NOT NULL,
  PRIMARY KEY (user_id, environment, order_id)
);
CREATE INDEX order_history_user_time_idx ON order_history(user_id, environment, created_at DESC);

CREATE TABLE trade_history (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  environment TEXT NOT NULL CHECK (environment IN ('prod-vst', 'prod-live')),
  trade_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  position_side TEXT NOT NULL,
  price TEXT NOT NULL,
  quantity TEXT NOT NULL,
  realized_pnl TEXT NOT NULL,
  fee TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  raw_json JSONB NOT NULL,
  PRIMARY KEY (user_id, environment, trade_id)
);
CREATE INDEX trade_history_user_time_idx ON trade_history(user_id, environment, created_at DESC);

CREATE TABLE audit_events (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  metadata_json JSONB NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX audit_events_user_time_idx ON audit_events(user_id, created_at DESC);

CREATE TABLE risk_profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  active BOOLEAN NOT NULL,
  profile_json JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE risk_daily_state (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  environment TEXT NOT NULL CHECK (environment IN ('prod-vst', 'prod-live')),
  trading_day TEXT NOT NULL CHECK (char_length(trading_day) = 10),
  timezone TEXT NOT NULL,
  trade_count INTEGER NOT NULL DEFAULT 0 CHECK (trade_count >= 0),
  opening_equity_micros BIGINT NOT NULL DEFAULT 0,
  last_equity_micros BIGINT NOT NULL DEFAULT 0,
  initialized BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, environment, trading_day)
);
CREATE INDEX risk_daily_state_user_time_idx ON risk_daily_state(user_id, environment, trading_day DESC);

CREATE TABLE risk_position_state (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  environment TEXT NOT NULL CHECK (environment IN ('prod-vst', 'prod-live')),
  position_key TEXT NOT NULL,
  position_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  quantity TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'MISSING', 'CLOSED')),
  origin TEXT NOT NULL CHECK (origin IN ('TERMINAL', 'EXTERNAL', 'UNKNOWN')),
  missed_snapshots INTEGER NOT NULL DEFAULT 0 CHECK (missed_snapshots >= 0),
  enforcement_status TEXT NOT NULL DEFAULT 'NONE'
    CHECK (enforcement_status IN ('NONE', 'PENDING', 'SUCCEEDED', 'FAILED')),
  opened_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, environment, position_key)
);
CREATE INDEX risk_position_state_user_status_idx
  ON risk_position_state(user_id, environment, status, updated_at DESC);

CREATE TABLE risk_entry_reservations (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  environment TEXT NOT NULL CHECK (environment IN ('prod-vst', 'prod-live')),
  trading_day TEXT NOT NULL CHECK (char_length(trading_day) = 10),
  request_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'ATTACHED', 'CONSUMED', 'RELEASED', 'BLOCKED')),
  order_id TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  resolved_at BIGINT,
  UNIQUE (user_id, environment, trading_day, request_id),
  FOREIGN KEY (user_id, environment, trading_day)
    REFERENCES risk_daily_state(user_id, environment, trading_day) ON DELETE CASCADE
);
CREATE INDEX risk_entry_reservations_active_idx
  ON risk_entry_reservations(user_id, environment, trading_day, status);

CREATE TABLE risk_events (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  environment TEXT NOT NULL CHECK (environment IN ('prod-vst', 'prod-live')),
  trading_day TEXT CHECK (trading_day IS NULL OR char_length(trading_day) = 10),
  event_key TEXT NOT NULL,
  rule_name TEXT NOT NULL,
  action TEXT NOT NULL,
  source TEXT NOT NULL,
  result TEXT NOT NULL,
  metadata_json JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE (user_id, environment, event_key)
);
CREATE INDEX risk_events_user_time_idx ON risk_events(user_id, environment, created_at DESC);

CREATE TABLE risk_protection_state (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  environment TEXT NOT NULL CHECK (environment IN ('prod-vst', 'prod-live')),
  position_key TEXT NOT NULL,
  position_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
  entry_price TEXT NOT NULL,
  best_price TEXT NOT NULL,
  triggered BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  missing_count INTEGER NOT NULL DEFAULT 0 CHECK (missing_count >= 0),
  managed_order_id TEXT NOT NULL DEFAULT '',
  managed_stop_price TEXT,
  managed_quantity TEXT NOT NULL DEFAULT '0',
  managed_placed_at BIGINT,
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  retry_at BIGINT NOT NULL DEFAULT 0,
  last_action_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, environment, position_key)
);
CREATE INDEX risk_protection_active_idx
  ON risk_protection_state(user_id, environment, active, updated_at DESC);

CREATE TABLE risk_streak_state (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  environment TEXT NOT NULL CHECK (environment IN ('prod-vst', 'prod-live')),
  trading_day TEXT NOT NULL CHECK (char_length(trading_day) = 10),
  timezone TEXT NOT NULL,
  consecutive_losses INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_losses >= 0),
  cooldown_until BIGINT NOT NULL DEFAULT 0,
  last_outcome_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, environment, trading_day)
);

CREATE TABLE risk_trade_outcomes (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  environment TEXT NOT NULL CHECK (environment IN ('prod-vst', 'prod-live')),
  trading_day TEXT NOT NULL CHECK (char_length(trading_day) = 10),
  outcome_key TEXT NOT NULL,
  order_id TEXT NOT NULL,
  net_pnl_micros BIGINT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('WIN', 'LOSS', 'BREAKEVEN')),
  closed_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, environment, outcome_key)
);
CREATE INDEX risk_trade_outcomes_day_idx
  ON risk_trade_outcomes(user_id, environment, trading_day, closed_at);
