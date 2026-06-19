CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS subscription_plans (
  id text PRIMARY KEY CHECK (id IN ('free', 'pro', 'admin')),
  name text NOT NULL,
  rank smallint NOT NULL CHECK (rank BETWEEN 0 AND 9),
  capacity integer NOT NULL CHECK (capacity > 0),
  broker_code_required boolean NOT NULL DEFAULT false,
  nav_required numeric,
  entitlements text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DELETE FROM subscription_plans WHERE id IN ('signal', 'desk');
ALTER TABLE subscription_plans DROP CONSTRAINT IF EXISTS subscription_plans_id_check;
ALTER TABLE subscription_plans ADD CONSTRAINT subscription_plans_id_check CHECK (id IN ('free', 'pro', 'admin'));

INSERT INTO subscription_plans (id, name, rank, capacity, broker_code_required, nav_required, entitlements)
VALUES
  ('free', 'SignalEdge Free Signal', 0, 3500, false, null, ARRAY['app_access','vn_universe','basic_chart','plans_view']),
  ('pro', 'SignalEdge Pro', 1, 1479, true, 0, ARRAY['app_access','vn_universe','crypto_universe','basic_chart','scanner_watch','a_plus_signal','performance_view','app_alert','telegram_alert','journal','advanced_filters','risk_tools','security_view','settings_view','desk_support','plans_view']),
  ('admin', 'SignalEdge Admin', 2, 1, false, null, ARRAY['app_access','vn_universe','crypto_universe','basic_chart','scanner_watch','a_plus_signal','performance_view','app_alert','telegram_alert','journal','advanced_filters','risk_tools','security_view','settings_view','desk_support','plans_view','admin_console','subscription_admin','feature_admin'])
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  rank = EXCLUDED.rank,
  capacity = EXCLUDED.capacity,
  broker_code_required = EXCLUDED.broker_code_required,
  nav_required = EXCLUDED.nav_required,
  entitlements = EXCLUDED.entitlements,
  updated_at = now();

CREATE TABLE IF NOT EXISTS app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext UNIQUE,
  phone text UNIQUE,
  display_name text NOT NULL,
  password_hash text,
  oauth_provider text,
  oauth_subject text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (email IS NOT NULL OR phone IS NOT NULL OR oauth_subject IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS app_users_oauth_idx ON app_users (oauth_provider, oauth_subject) WHERE oauth_subject IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  plan_id text NOT NULL REFERENCES subscription_plans(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('trialing', 'active', 'pending_broker', 'past_due', 'cancelled', 'expired')),
  broker_code text,
  broker_account_id text,
  broker_verified_at timestamptz,
  nav_verified numeric,
  starts_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_subscriptions_user_active_idx
  ON user_subscriptions (user_id, status, starts_at DESC);

CREATE TABLE IF NOT EXISTS broker_conversion_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  requested_plan_id text NOT NULL REFERENCES subscription_plans(id),
  broker_name text,
  broker_code text,
  account_identifier text,
  proof_url text,
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'reviewing', 'approved', 'rejected', 'needs_more_info')),
  admin_note text,
  reviewed_by uuid REFERENCES app_users(id),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS broker_conversion_status_idx
  ON broker_conversion_requests (status, created_at DESC);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  jwt_id text NOT NULL UNIQUE,
  refresh_token_hash text NOT NULL UNIQUE,
  user_agent_hash text,
  ip_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions (user_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS role_audit_log (
  id bigserial PRIMARY KEY,
  actor_user_id uuid REFERENCES app_users(id),
  target_user_id uuid REFERENCES app_users(id),
  action text NOT NULL,
  before_payload jsonb NOT NULL DEFAULT '{}',
  after_payload jsonb NOT NULL DEFAULT '{}',
  request_id text,
  ip_hash text,
  user_agent_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS role_audit_target_time_idx ON role_audit_log (target_user_id, created_at DESC);
