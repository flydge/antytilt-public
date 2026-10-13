-- A user can have many exchange accounts, but exactly one active account may
-- be selected as the terminal default at a time.
CREATE UNIQUE INDEX exchange_accounts_one_active_default_idx
  ON exchange_accounts(user_id)
  WHERE is_default = TRUE AND status = 'ACTIVE';
