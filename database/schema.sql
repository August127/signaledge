CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  external_subject text NOT NULL,
  role text NOT NULL CHECK (role IN ('analyst', 'trader', 'risk', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, external_subject)
);

CREATE TABLE assets (
  id bigserial PRIMARY KEY,
  symbol text NOT NULL,
  venue text NOT NULL,
  market text NOT NULL,
  timezone text NOT NULL,
  price_scale integer NOT NULL DEFAULT 4,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (symbol, venue)
);

CREATE TABLE candles (
  asset_id bigint NOT NULL REFERENCES assets(id),
  timeframe text NOT NULL,
  open_time timestamptz NOT NULL,
  close_time timestamptz NOT NULL,
  open numeric NOT NULL,
  high numeric NOT NULL,
  low numeric NOT NULL,
  close numeric NOT NULL,
  volume numeric NOT NULL,
  source text NOT NULL,
  source_version text,
  is_final boolean NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (asset_id, timeframe, open_time)
);

CREATE INDEX candles_lookup_idx ON candles (asset_id, timeframe, open_time DESC);

CREATE TABLE market_data_quality (
  asset_id bigint NOT NULL REFERENCES assets(id),
  timeframe text NOT NULL,
  provider text NOT NULL,
  observed_at timestamptz NOT NULL,
  last_bar_time timestamptz,
  quality_score smallint NOT NULL CHECK (quality_score BETWEEN 0 AND 100),
  status text NOT NULL CHECK (status IN ('healthy', 'degraded', 'blocked', 'unknown')),
  invalid_bars integer NOT NULL DEFAULT 0,
  duplicate_bars integer NOT NULL DEFAULT 0,
  gap_count integer NOT NULL DEFAULT 0,
  out_of_order_bars integer NOT NULL DEFAULT 0,
  stale boolean NOT NULL DEFAULT false,
  details jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (asset_id, timeframe, provider, observed_at)
);

CREATE INDEX market_data_quality_latest_idx ON market_data_quality (provider, observed_at DESC);

CREATE TABLE strategy_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  semantic_version text NOT NULL,
  config_hash text NOT NULL,
  artifact_digest text NOT NULL,
  activated_at timestamptz,
  retired_at timestamptz,
  UNIQUE (name, semantic_version)
);

CREATE TABLE signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  asset_id bigint NOT NULL REFERENCES assets(id),
  strategy_version_id uuid NOT NULL REFERENCES strategy_versions(id),
  timeframe text NOT NULL,
  candle_close_time timestamptz NOT NULL,
  direction text NOT NULL CHECK (direction IN ('bull', 'bear')),
  classification text NOT NULL CHECK (classification IN ('A+', 'A', 'B', 'C')),
  score smallint NOT NULL CHECK (score BETWEEN 0 AND 100),
  execution_ready boolean NOT NULL,
  calculation_id text NOT NULL,
  evidence jsonb NOT NULL,
  signature text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, calculation_id)
);

CREATE INDEX signals_rank_idx ON signals (tenant_id, created_at DESC, score DESC);
CREATE INDEX signals_evidence_gin ON signals USING gin (evidence);

CREATE TABLE alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id),
  asset_id bigint REFERENCES assets(id),
  mode text NOT NULL CHECK (mode IN ('watch', 'confirmed')),
  channels text[] NOT NULL,
  policy jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX alerts_idempotency_idx ON alerts (tenant_id, user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  signal_id uuid REFERENCES signals(id),
  asset_id bigint NOT NULL REFERENCES assets(id),
  environment text NOT NULL CHECK (environment IN ('research', 'paper', 'live')),
  side text NOT NULL CHECK (side IN ('long', 'short')),
  entry numeric,
  stop_loss numeric,
  take_profit numeric,
  quantity numeric,
  fees numeric NOT NULL DEFAULT 0,
  slippage numeric NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('planned', 'open', 'closed', 'cancelled')),
  opened_at timestamptz,
  closed_at timestamptz,
  result_r numeric,
  mae_r numeric,
  mfe_r numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE journal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id),
  trade_id uuid REFERENCES trades(id),
  signal_id uuid REFERENCES signals(id),
  notes text,
  tags text[] NOT NULL DEFAULT '{}',
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX journal_idempotency_idx ON journal_entries (tenant_id, user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  tenant_id uuid REFERENCES tenants(id),
  actor_user_id uuid REFERENCES users(id),
  event_type text NOT NULL,
  object_type text NOT NULL,
  object_id text,
  request_id text,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_tenant_time_idx ON audit_events (tenant_id, created_at DESC);
