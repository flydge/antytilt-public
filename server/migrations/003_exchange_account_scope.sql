ALTER TABLE risk_profiles ADD COLUMN exchange_account_id UUID REFERENCES exchange_accounts(id) ON DELETE CASCADE;
ALTER TABLE order_history ADD COLUMN exchange_account_id UUID REFERENCES exchange_accounts(id) ON DELETE CASCADE;
ALTER TABLE trade_history ADD COLUMN exchange_account_id UUID REFERENCES exchange_accounts(id) ON DELETE CASCADE;
ALTER TABLE audit_events ADD COLUMN exchange_account_id UUID REFERENCES exchange_accounts(id) ON DELETE SET NULL;
ALTER TABLE risk_daily_state ADD COLUMN exchange_account_id UUID REFERENCES exchange_accounts(id) ON DELETE CASCADE;
ALTER TABLE risk_position_state ADD COLUMN exchange_account_id UUID REFERENCES exchange_accounts(id) ON DELETE CASCADE;
ALTER TABLE risk_entry_reservations ADD COLUMN exchange_account_id UUID REFERENCES exchange_accounts(id) ON DELETE CASCADE;
ALTER TABLE risk_events ADD COLUMN exchange_account_id UUID REFERENCES exchange_accounts(id) ON DELETE CASCADE;
ALTER TABLE risk_protection_state ADD COLUMN exchange_account_id UUID REFERENCES exchange_accounts(id) ON DELETE CASCADE;
ALTER TABLE risk_streak_state ADD COLUMN exchange_account_id UUID REFERENCES exchange_accounts(id) ON DELETE CASCADE;
ALTER TABLE risk_trade_outcomes ADD COLUMN exchange_account_id UUID REFERENCES exchange_accounts(id) ON DELETE CASCADE;

UPDATE risk_profiles
SET exchange_account_id = account.id
FROM exchange_accounts AS account
WHERE account.user_id = risk_profiles.user_id AND account.status = 'ACTIVE' AND account.is_default = TRUE;

UPDATE order_history SET exchange_account_id = account.id FROM exchange_accounts AS account
WHERE account.user_id = order_history.user_id AND account.environment = order_history.environment;
UPDATE trade_history SET exchange_account_id = account.id FROM exchange_accounts AS account
WHERE account.user_id = trade_history.user_id AND account.environment = trade_history.environment;
UPDATE risk_daily_state SET exchange_account_id = account.id FROM exchange_accounts AS account
WHERE account.user_id = risk_daily_state.user_id AND account.environment = risk_daily_state.environment;
UPDATE risk_position_state SET exchange_account_id = account.id FROM exchange_accounts AS account
WHERE account.user_id = risk_position_state.user_id AND account.environment = risk_position_state.environment;
UPDATE risk_entry_reservations SET exchange_account_id = account.id FROM exchange_accounts AS account
WHERE account.user_id = risk_entry_reservations.user_id AND account.environment = risk_entry_reservations.environment;
UPDATE risk_events SET exchange_account_id = account.id FROM exchange_accounts AS account
WHERE account.user_id = risk_events.user_id AND account.environment = risk_events.environment;
UPDATE risk_protection_state SET exchange_account_id = account.id FROM exchange_accounts AS account
WHERE account.user_id = risk_protection_state.user_id AND account.environment = risk_protection_state.environment;
UPDATE risk_streak_state SET exchange_account_id = account.id FROM exchange_accounts AS account
WHERE account.user_id = risk_streak_state.user_id AND account.environment = risk_streak_state.environment;
UPDATE risk_trade_outcomes SET exchange_account_id = account.id FROM exchange_accounts AS account
WHERE account.user_id = risk_trade_outcomes.user_id AND account.environment = risk_trade_outcomes.environment;

CREATE INDEX risk_profiles_account_idx ON risk_profiles(exchange_account_id);
CREATE INDEX order_history_account_time_idx ON order_history(exchange_account_id, created_at DESC);
CREATE INDEX trade_history_account_time_idx ON trade_history(exchange_account_id, created_at DESC);
CREATE INDEX audit_events_account_time_idx ON audit_events(exchange_account_id, created_at DESC);
CREATE INDEX risk_daily_state_account_day_idx ON risk_daily_state(exchange_account_id, trading_day DESC);
CREATE INDEX risk_position_state_account_status_idx ON risk_position_state(exchange_account_id, status, updated_at DESC);
CREATE INDEX risk_entry_reservations_account_idx ON risk_entry_reservations(exchange_account_id, trading_day, status);
CREATE INDEX risk_events_account_time_idx ON risk_events(exchange_account_id, created_at DESC);
CREATE INDEX risk_protection_account_active_idx ON risk_protection_state(exchange_account_id, active, updated_at DESC);
CREATE INDEX risk_streak_account_day_idx ON risk_streak_state(exchange_account_id, trading_day DESC);
CREATE INDEX risk_trade_outcomes_account_day_idx ON risk_trade_outcomes(exchange_account_id, trading_day, closed_at);
