-- Finalize the multi-account cut-over. Trading and RM state is owned by an
-- exchange account, not by the legacy user + environment pair.

ALTER TABLE risk_entry_reservations
  DROP CONSTRAINT IF EXISTS risk_entry_reservations_user_id_environment_trading_day_fkey;
ALTER TABLE risk_entry_reservations
  DROP CONSTRAINT IF EXISTS "risk_entry_reservations_environment|trading_day|user_id_fk";
ALTER TABLE risk_entry_reservations
  DROP CONSTRAINT IF EXISTS risk_entry_reservations_user_id_environment_trading_day_req_key;
ALTER TABLE risk_entry_reservations
  DROP CONSTRAINT IF EXISTS "risk_entry_reservations_environment|request_id|trading_day|user_id_idx";

ALTER TABLE exchange_accounts
  DROP CONSTRAINT IF EXISTS exchange_accounts_user_id_exchange_environment_key;
ALTER TABLE exchange_accounts
  DROP CONSTRAINT IF EXISTS "exchange_accounts_environment|exchange|user_id_idx";

ALTER TABLE order_history DROP CONSTRAINT order_history_pkey;
ALTER TABLE trade_history DROP CONSTRAINT trade_history_pkey;
ALTER TABLE risk_daily_state DROP CONSTRAINT risk_daily_state_pkey;
ALTER TABLE risk_position_state DROP CONSTRAINT risk_position_state_pkey;
ALTER TABLE risk_protection_state DROP CONSTRAINT risk_protection_state_pkey;
ALTER TABLE risk_streak_state DROP CONSTRAINT risk_streak_state_pkey;
ALTER TABLE risk_trade_outcomes DROP CONSTRAINT risk_trade_outcomes_pkey;
ALTER TABLE risk_events DROP CONSTRAINT IF EXISTS risk_events_user_id_environment_event_key_key;
ALTER TABLE risk_events DROP CONSTRAINT IF EXISTS "risk_events_environment|event_key|user_id_idx";

ALTER TABLE order_history ALTER COLUMN exchange_account_id SET NOT NULL;
ALTER TABLE trade_history ALTER COLUMN exchange_account_id SET NOT NULL;
ALTER TABLE risk_daily_state ALTER COLUMN exchange_account_id SET NOT NULL;
ALTER TABLE risk_position_state ALTER COLUMN exchange_account_id SET NOT NULL;
ALTER TABLE risk_entry_reservations ALTER COLUMN exchange_account_id SET NOT NULL;
ALTER TABLE risk_events ALTER COLUMN exchange_account_id SET NOT NULL;
ALTER TABLE risk_protection_state ALTER COLUMN exchange_account_id SET NOT NULL;
ALTER TABLE risk_streak_state ALTER COLUMN exchange_account_id SET NOT NULL;
ALTER TABLE risk_trade_outcomes ALTER COLUMN exchange_account_id SET NOT NULL;

ALTER TABLE order_history ADD PRIMARY KEY (exchange_account_id, order_id);
ALTER TABLE trade_history ADD PRIMARY KEY (exchange_account_id, trade_id);
ALTER TABLE risk_daily_state ADD PRIMARY KEY (exchange_account_id, trading_day);
ALTER TABLE risk_position_state ADD PRIMARY KEY (exchange_account_id, position_key);
ALTER TABLE risk_protection_state ADD PRIMARY KEY (exchange_account_id, position_key);
ALTER TABLE risk_streak_state ADD PRIMARY KEY (exchange_account_id, trading_day);
ALTER TABLE risk_trade_outcomes ADD PRIMARY KEY (exchange_account_id, outcome_key);
ALTER TABLE risk_entry_reservations
  ADD UNIQUE (exchange_account_id, trading_day, request_id);
ALTER TABLE risk_entry_reservations
  ADD FOREIGN KEY (exchange_account_id, trading_day)
  REFERENCES risk_daily_state(exchange_account_id, trading_day) ON DELETE CASCADE;
ALTER TABLE risk_events ADD UNIQUE (exchange_account_id, event_key);
