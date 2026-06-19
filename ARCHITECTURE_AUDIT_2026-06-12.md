# Architecture Audit - 2026-06-12

## Executive result

The external review identified several real production risks, but it also mixed current defects with future-scale requirements and made some inaccurate claims about the implemented cache. This pass changed backend behavior only; no UI components, layout, or styling were modified.

## Verified findings

| Review claim | Verdict | Evidence and action |
| --- | --- | --- |
| Scoring caps are distributed | Valid | Trend, volatility, Crystal, structure, MTF, and market-data gates now pass through one auditable `applyExecutabilityGates()` function. Raw score is preserved. |
| Workspace recomputes the selected H4 analysis | Partially valid | The selected symbol was calculated twice, not 15 times. H4 rows are now reused inside MTF and scanner analyses prewarm the analysis cache. Cold row-source calls fell from 68 to 48. |
| Hybrid cache can hide a fallback transition | Valid | Feed failure now increments provider revision, invalidates snapshots, bypasses the old live cache, and exposes fallback immediately. |
| No circuit breaker | Valid | Binance and SSI open a circuit after repeated failures. A recovery probe closes it only after a successful validated response. |
| Fixture fallback could remain tradeable | Valid safety issue | Crypto fallback sets `marketData=false`, `executionBlocked=true`, and caps the final score at 79. |
| JSON persistence blocks the API thread | Valid for write load | `writeFileSync`/`renameSync` were replaced with a serialized asynchronous mutation queue and atomic replacement. PostgreSQL is still required for multi-process production. |
| Hybrid bootstrap blocks server readiness | Additional verified issue | Bootstrap now runs in the background. `/api/system/status` reports `warming` while the API remains available. |

## Claims rejected or reclassified

| Review claim | Verdict | Reason |
| --- | --- | --- |
| Crystal O(n) is an engine defect | Rejected | The engine operates on a bounded 180-220 candle window. O(n) is expected and currently below the latency budget. Incremental compute is a scale optimization, not a correctness fix. |
| `confirmedAt` is redundant | Rejected | It prevents look-ahead bias and is consumed by BOS, Spartan, and structure logic. Removing it would make historical signal evidence unreliable. |
| Snapshot cache invalidation is unclear/missing | Rejected | Keys already contain candle close, provider revision, confirmation window, and calculation version. Explicit invalidation also runs after provider updates. |
| Cache needs arbitrary 1-5 minute TTLs | Rejected as specified | Candle-aware expiry is more correct than TTL for D1/H4/H1/M15. A 90-second post-close grace, quality checks, provider revision, and circuit breaker now enforce freshness. |
| Workspace causes 15x redundant computation | Rejected | Measured overhead was one duplicate selected analysis. The optimization is still worthwhile but the stated multiplier was incorrect. |
| Pagination, WebSocket, multi-select, export are current bugs | Reclassified | These are product/scale features. They are not correctness failures in the current bounded universe. |

## Deliberately deferred production work

1. PostgreSQL/Timescale plus an outbox replaces the single-node JSON store before multi-tenant deployment.
2. OIDC/RBAC, tenant isolation, and immutable audit events are required before external users or execution features.
3. WebSocket/SSE is added after a durable event stream exists; polling closed candles is correct for the current scanner.
4. Embedded backtesting was removed by product decision; signal calibration belongs in a separate research pipeline with point-in-time datasets.
5. SSI FastConnect credentials and a complete Vietnam exchange holiday calendar are required before Vietnam signals are used operationally.
6. Incremental indicator state and worker partitioning are introduced when measured p95 CPU or universe size requires them.

## Verification

- Calculation version: `scanner-core-2026.06.13.2`
- Automated tests: 44 passing
- Production build: passing
- Indicator reference checks: EMA, Wilder ATR, full-array finiteness/alignment, Heikin Ashi invariants, Crystal confirmation, pivot confirmation, MTF gates, and 40/30/30 score budgets
- Market-data checks: Binance closed-candle filtering, SSI normalization/token cache, OHLCV aggregation, session gaps, stale/fallback gates, and provider recovery
- Live Binance adapter check: 60 closed M15 candles, source `binance-rest-v3`, quality `healthy`, executable `true`
- Hybrid runtime check: 32 Binance series live; SSI without credentials isolated to fallback and non-executable
- Local concurrency check: 60/60 workspace responses, p95 approximately 316 ms
- Vietnam closed-candle check: M15/H1/H4/D1 follow session-specific close times; the H1 11:00 bar closes at 11:30 and H4 closes at 15:00
- Cold fixture workspace benchmark: approximately 55 ms after optimization versus approximately 122 ms before
- Warm workspace benchmark: approximately 0.02 ms
- API fail-safe check: fallback source, `executionBlocked=true`, score capped at 79, ETag `304`, and idempotent replay `200`

## Continuation verification - 2026-06-13

- Provider telemetry is sampled once after scanner validation rather than once per asset. Cached scanner reads do not repeat the provider-status call.
- Deterministic fixture benchmark, 40 engine runs: min 27.26 ms, p50 30.85 ms, p95 37.73 ms, max 40.78 ms.
- HTTP concurrency benchmark, 120 requests at concurrency 24: min 31.64 ms, p50 54.01 ms, p95 78.38 ms, max 86.57 ms, zero failures.
- Scanner endpoint returned 16 ranked assets with a healthy Q100 data-quality snapshot; the current calculation version is `scanner-core-2026.06.13.2`.
- Evidence envelopes now use browser-verified Ed25519 signatures. Production requires a stable private key and business-API service token; key ID participates in ETag generation.
- Static performance claims were removed from the UI. The lower drawer now derives score buckets, signal states, MTF alignment, market coverage, and ranking directly from the synchronized scanner response.
- Responsive QA passed at 1440 x 1024, 1024 x 900, and 700 x 900 without changing the desktop visual direction.
- Added separate liveness/readiness probes and bounded per-route latency/error telemetry. Metrics support optional Bearer protection through `METRICS_TOKEN`.
- Post-telemetry benchmark, 120 requests at concurrency 24: client-observed p95 80.34 ms, zero failures; server-observed cached workspace p95 4 ms.
- Post-Ed25519 benchmark, 120 requests at concurrency 24: p95 98.27 ms, zero failures. The additional signing and key-aware envelope path remains well below the one-second refresh budget.
