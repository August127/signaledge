# SignalEdge

**Where Signals Become Edge.**

Institutional-style Vietnam equity, US stock, and crypto scanner combining Spartan 1-2-3, confirmed pivots, BOS/CHOCH, liquidity sweeps, Order Blocks, ATR volatility, and Crystal Heikin Ashi early/confirmed signals.

## Run

```powershell
npm.cmd install
npm.cmd run dev
```

Production build and local API serving:

```powershell
npm.cmd run build
npm.cmd start
```

Open `http://127.0.0.1:8787` for the production build. Development Vite runs on its printed local port and proxies `/api` to port `8787`.

## Subscription Access

SignalEdge now starts with a subscription access gateway before the scanner cockpit loads. The beta model is intentionally simple and can be configured from `.env`:

```powershell
$env:SIGNALEDGE_MAX_USERS='4980'
$env:SIGNALEDGE_SIGNAL_PASS='your-signal-pass'
$env:SIGNALEDGE_PRO_PASS='your-pro-pass'
$env:SIGNALEDGE_DESK_PASS='your-desk-pass'
```

Development fallback passes are `FREE`, `SIGNAL`, `PRO`, and `DESK` when no pass is configured. Do not use those defaults in production. The current entitlement model:

- `Free`: VN universe, basic chart, watch scanner, plans page.
- `Signal`: Free + crypto universe, A+/A signals, performance, app/Telegram alerts.
- `Pro`: Signal + US stocks, journal, advanced filters, risk tools.
- `Desk`: Pro + security/reliability and settings panels.

For a real deployment under 5000 users, replace the beta access pass with OTP/Zalo/Google login, JWT session cookies, PostgreSQL-backed users/subscriptions, admin approval for broker-code conversion, and audit logs for role changes. Keep scanner APIs behind a trusted gateway; do not expose service tokens to browser JavaScript.

Production auth/subscription groundwork is documented in `AUTH_DEPLOYMENT.md`. The PostgreSQL schema for users, subscription plans, broker-code conversion requests, sessions, and audit logs is in `database/subscription-auth.sql`.

To keep the production server running in the background on Windows without an open terminal:

```powershell
wscript.exe start-server-hidden.vbs
```

An optional port and provider can be supplied, for example `wscript.exe start-server-hidden.vbs 8790 hybrid`.

To bootstrap official Binance closed candles for crypto and SSI FastConnect FCData for Vietnam equities:

```powershell
$env:DATA_PROVIDER='hybrid'
$env:SSI_CONSUMER_ID='your-consumer-id'
$env:SSI_CONSUMER_SECRET='your-consumer-secret'
npm.cmd start
```

`hybrid` is the default and opens the API immediately with bootstrap status `warming`. Crypto candles use Binance `GET /api/v3/klines`; the display quote layer uses the official batched `GET /api/v3/ticker/24hr` endpoint with a five-second cache. Vietnam equities use 24HMoney for quote/screener fields and KBS/SSI/TradingView-compatible providers for validated D1/H4 OHLCV. Both providers validate every series and invalidate scanner snapshots when live/fallback state changes. SSI credentials, when configured, are issued through SSI iBoard and are never sent to the browser.

The crypto universe uses `POLUSDT` rather than the stale `MATICUSDT` market. Provider telemetry reports per-symbol fallback and stale-series issues instead of treating them as valid live data.

The composite provider checks Binance candles once per minute, refreshes display quotes every five seconds, and throttles SSI candle refreshes to at least five minutes. A changed series or feed-state transition increments provider revision and invalidates signed scanner/chart snapshots. Hybrid mode is fail-closed: missing credentials, insufficient history, stale data, or provider errors remove the affected symbol from executable scanner output. Synthetic fixture values are never returned by `/api/quotes` or substituted into hybrid scanner results; missing VN data is displayed as unavailable. SSI `DailyIndex` is explicitly labelled daily-close. True VN tick streaming requires an SSI FastConnect account and the SSI `X-QUOTE` streaming channel.

The chart defaults to a 30-day visible window and supports `7D` and `1M` ranges across the scanner timeframes D1/H4. Selected charts request enough closed candles from the live provider; unavailable history returns a provider error instead of generated replacement candles.

The scanner universe is configurable without code changes:

```powershell
$env:CRYPTO_SYMBOLS='BTCUSDT,ETHUSDT,SOLUSDT'
$env:VN30_SYMBOLS='FPT,VCB,HPG'
$env:MIDCAP_SYMBOLS='DIG,PNJ'
```

## Verification

```powershell
npm.cmd test
npm.cmd run build
npm.cmd run benchmark -- --iterations 40
```

To include API concurrency measurements against a running server:

```powershell
npm.cmd run benchmark -- --iterations 40 --url http://127.0.0.1:8787 --requests 120 --concurrency 24
```

Container probes and protected metrics:

```text
GET /api/health/live
GET /api/health/ready
GET /api/metrics
```

Set `METRICS_TOKEN` to require `Authorization: Bearer <token>` on the metrics endpoint.

Production also requires a stable Ed25519 PKCS#8 private key in `EVIDENCE_PRIVATE_KEY` or base64-encoded in `EVIDENCE_PRIVATE_KEY_B64`, plus `SCANNER_API_TOKEN` for business API access. A trusted OIDC gateway should inject the Bearer token after authenticating the user; do not expose the service token to browser JavaScript. Development on loopback allows an empty token and creates an ephemeral signing key automatically.

## Current scope

- React 19 cockpit with Lightweight Charts and Phosphor icons.
- Express scanner API with fail-closed Binance/SSI adapters, closed-candle calculations, rate limits, schema validation, signed evidence envelopes, candle-aware LRU snapshots, and ETag revalidation. Deterministic OHLCV is restricted to explicit research/test mode.
- Separate liveness/readiness probes and bounded per-route runtime metrics support container deployment and latency/error monitoring without external APM dependencies.
- Atomic workspace synchronization keeps scanner, selected chart, calculation version, and as-of metadata in one response. The client aborts stale requests, retries transient failures, polls safely, and reports online/sync/latency state.
- Market-data access is isolated behind a provider contract. Every OHLCV batch is checked for invalid bars, timestamp order, duplicates, gaps, and staleness before calculations run; `/api/system/status` exposes provider and quality telemetry.
- Functional scanner, Structure Map, local journal, persisted notes, timeframe and signal-mode controls, chart layers, alert creation, realtime scanner analytics, and risk display.
- The analytics drawer is calculated from the current signed scanner snapshot. It reports score distribution, signal state, MTF alignment, market coverage, and ranked assets without presenting synthetic win-rate or equity-curve claims.
- Signed evidence is verified in the browser before use. Fixture/fallback charts are explicitly labeled `RESEARCH DATA` and `NON-EXECUTABLE`; confirmed trade alerts are disabled until validated live data is available.
- The desktop prop-desk layout remains primary, with responsive monitoring states that remove secondary rails at 1180 px and the watchlist at 900 px while preserving chart and signal controls.
- Alerts and journal records are persisted server-side through a serialized asynchronous mutation queue, atomic file replacement, and idempotency keys in this single-node prototype. PostgreSQL remains the production target.
- Scanner hard caps are consolidated into one auditable executability gate. H4 multi-timeframe rows and the selected workspace analysis are reused instead of recomputed.
- Unit tests cover EMA/Wilder ATR reference values, full indicator-array finiteness, HA integrity, Crystal confirmation timing, pivot confirmation, executability gates, score budgets, deterministic scanner ordering, Vietnam-session H4 aggregation and closed-candle timing, scanner/chart synchronization, provider-status sampling, Binance retry/circuit breaking, SSI token/OHLC normalization and recovery, data-source telemetry, non-blocking bootstrap, and durable concurrent operation writes.
- `GET /api/data/series` provides per-symbol/timeframe provider, source, last candle, fallback state, and full MTF gate telemetry.

The fixture provider implements the normalized row contract only for explicit research and automated tests. Production adapters must fail closed and must not move proprietary calculations into the browser.

## Documents

- `SCANNER_SPEC.md`: non-repainting rules, framework conditions, scoring, and hard gates.
- `SECURITY.md`: application security and IP-protection architecture.
- `API_SPEC.md`: current API contract and production extensions.
- `design-qa.md`: final visual QA evidence and result.
- `ARCHITECTURE_AUDIT_2026-06-12.md`: verification of the external engineering review, accepted fixes, rejected claims, and production backlog.
- `DATA_SOURCES.md`: approved market-data sources, rejected alternatives, credentials, and operating policy.
- `SUBSCRIPTION_MODEL.md`: SignalEdge membership tiers, broker-code conversion funnel, and community channel placeholders.

SignalEdge is scanner research infrastructure, not investment advice. Live deployment requires active market-data permission, a licensed Vietnam-market agreement where applicable, full exchange-calendar handling, identity, audit persistence, and independent signal validation.
