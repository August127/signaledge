# System Review - 2026-06-14 / Updated 2026-06-16

## Findings

| Reported issue | Verdict | Current action |
| --- | --- | --- |
| No VN stock API | Fixed with an explicit limitation | The runtime now has a three-layer priority chain: SSI FastConnect, KBS public market-data endpoints, then a licensed TradingView-compatible UDF feed. Hybrid mode fails closed and never substitutes fixture prices. |
| File persistence race / synchronous writes | Outdated | `OperationsStore` already serializes mutations and uses asynchronous temporary-file writes plus atomic rename. PostgreSQL is still required before horizontal multi-process deployment. |
| No job queue / worker | Valid scale limitation, not a current correctness bug | Market ingestion and refresh run outside request handlers. Scanner calculation is bounded and cached, but remains in the API process. Introduce partitioned workers only with the production Redis/PostgreSQL deployment; adding BullMQ without that infrastructure would add failure modes without providing durability. |
| Fixed 16-symbol universe | Valid | Universe can now be configured through `CRYPTO_SYMBOLS`, `VN30_SYMBOLS`, and `MIDCAP_SYMBOLS`. Automated exchange discovery and liquidity ranking remain the next scale phase. |
| Database initializer signature mismatch | Not present | This repository has no `db.js`, `initializeDatabase`, or PostgreSQL runtime import. The report refers to another revision or project. |
| Frontend monolith | Valid maintainability issue | Error handling and risk calculation were extracted first. Further component extraction remains incremental to avoid a broad visual regression. |
| No React Error Boundary | Valid, fixed | Root UI is wrapped in `ErrorBoundary` with a recoverable reload state. |
| Hardcoded position sizing | Valid, fixed | Account size and risk percentage are editable and persisted separately for crypto and VN markets. Position sizing uses ATR stop distance and the selected direction. |
| No logging framework | Valid, fixed | Backend uses Pino JSON logs with credential redaction and structured request/error/start events. Rotation is delegated to the service manager/container logging driver. |

## Data Policy

- `DATA_PROVIDER=hybrid` never uses deterministic fixture rows as market data.
- Missing SSI credentials or a failed feed produces unavailable symbols, not synthetic scores or prices.
- Fixture mode is rejected outside tests unless `ALLOW_FIXTURE_DATA=true` is explicitly set.
- Scanner decisions use closed candles. Realtime quotes are display-only and do not rewrite closed-candle signals.

## VN Equity Feed Priority

1. 24HMoney technical-filter is the quote/screener primary source. It supplies current quote fields, traded volume, RS 1M/3M/52W, and valuation/fundamental fields. It is not treated as OHLCV executable data.
2. SSI FastConnect remains the intended production OHLCV source for complete D1/H4/H1/M15 execution. It requires registered credentials.
3. KBS is the active public OHLCV fallback. It currently supplies real daily/session data and index closes without credentials. Because there is no contractual SLA and intraday history is limited, the app only treats its D1/H4 series as executable.
4. `TRADINGVIEW_UDF_URL` is the licensed UDF OHLCV layer. It must point to a licensed TradingView-compatible UDF datafeed supplied by the operator; the application does not scrape TradingView or claim that its chart widget is a free data API.

The previously referenced TCBS public history URL returned HTTP 404 during the 2026-06-14 review. The VNDirect community endpoint timed out. Neither is silently used as a production fallback.

## Runtime Verification

- Provider id: `binance-vn-failover-composite-v2`.
- Crypto quotes and candles: live Binance REST data.
- VN quote/index fallback: KBS daily close. Verified VN-Index `1,791.65`, VN30 `1,944.36`, FPT `73.5` for the latest completed trading session available on 2026-06-12.
- Without SSI/UDF credentials, VN H1/M15 remains unavailable and VN symbols are excluded from scanner output. This is expected fail-closed behavior.
- `/api/system/status` reports `syntheticAllowed=false`.
- 2026-06-16 API fix: chart/workspace requests now return structured `503 market_data_unavailable` when the scanner needs missing real VN intraday feeds. They no longer fall through as `500 internal_error`.
- 2026-06-16 24HMoney check: `api-finance-t19.24hmoney.vn/v1/ios/company/technical-filter` returned usable quote/screener JSON. A wide page-size-500 request completed successfully and runtime `/api/quotes?symbols=FPT,VCB,GAS` returned quote rows from `24hmoney-technical-filter-v1`.
- 2026-06-16 integration diagnostics: `/api/data/diagnostics` was added for operations. It reports quote coverage, quote sources, index coverage, and D1/H4/H1/M15 live/executable/unavailable counts. Security sidebar now surfaces the same diagnostics.
- 2026-06-16 source smoke test: Binance ticker, 24HMoney screener, and KBS daily endpoints each returned successfully in 3/3 direct checks. Observed latency was roughly 108-314 ms for Binance, 251-361 ms for 24HMoney, and 102-174 ms for KBS from this workstation.

## Scale Readiness

The current build is suitable for a controlled single-node deployment. It is not yet approved for 10,000 concurrent users. The status API and Security sidebar expose this truth rather than presenting an unsupported capacity claim.

Required before horizontal production scaling:

- Redis shared snapshot/cache and distributed rate limiting.
- PostgreSQL for alerts, journal, user settings, audit records, and idempotency keys.
- Dedicated ingestion/scanner workers using BullMQ, Kafka, or an equivalent durable queue.
- Shared realtime fanout using Redis Streams/PubSub, NATS, or Kafka.
- Stateless API replicas behind a load balancer with autoscaling and health checks.
- Per-provider quota budgets, circuit breakers, observability, and licensed data entitlements.

Local measurements are engineering checks, not a 10,000-user certification. Scanner engine p95 is typically tens of milliseconds on this workstation. On 2026-06-16, a cold local HTTP benchmark for executable crypto paths completed 150/150 requests successfully at concurrency 30; the warmed retry then hit the intentional local API rate limit (`429`) because the single-node limiter is process-local and capped for safety. A mixed API benchmark correctly returns 503 for VN intraday requests when no real H1/M15 provider is configured.

## Sidebar And Readability

- Cockpit, Charts, Scanner, Performance, Journal, Alerts, Security, and Settings now route to functional views/actions.
- Security displays provider priority, data policy, and scale blockers.
- Settings controls readable typography and refresh cadence with local persistence.
- The default readable mode increases key navigation, price, table, form, chart, and metric text without changing the dashboard structure. On 2026-06-16 the minimum readable overrides were raised again because 8-9px labels were still too small for sustained use.
