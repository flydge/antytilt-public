CREATE TABLE account_risk_profiles (
  exchange_account_id UUID PRIMARY KEY REFERENCES exchange_accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  active BOOLEAN NOT NULL,
  profile_json JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX account_risk_profiles_user_idx ON account_risk_profiles(user_id, updated_at DESC);

INSERT INTO account_risk_profiles (
  exchange_account_id, user_id, active, profile_json, created_at, updated_at
)
SELECT account.id, account.user_id, profile.active, profile.profile_json, profile.created_at, profile.updated_at
FROM exchange_accounts AS account
JOIN risk_profiles AS profile ON profile.user_id = account.user_id
ON CONFLICT (exchange_account_id) DO NOTHING;
