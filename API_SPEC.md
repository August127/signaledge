# API Contract

## `GET /api/scanner`

Query: `confirmationBars=1..10`.

Returns `{ items, total, sync }`, where `items` contains ranked assets with price, score, classification, direction, Crystal state, bars to confirm, and D1/H4 alignment. Payload is wrapped in a signed evidence envelope.

## `GET /api/chart/:symbol`

Query: `timeframe=D1|H4`, `confirmationBars=1..10`.

Returns OHLCV, Crystal HA candles, EMA 20/50/200, ATR, confirmed pivots, BOS/CHOCH, Crystal events, current order block, MTF state, score components, sync metadata, and auditable evidence.

## `GET /api/workspace/:symbol`

Query: `timeframe=D1|H4`, `confirmationBars=1..10`.

Atomic reader endpoint used by the cockpit. It returns scanner snapshot, selected chart analysis, selected scanner row, and a server-side consistency verdict under one calculation version. Responses support `ETag`/`If-None-Match`; unchanged candle snapshots return `304 Not Modified`.

Every market-data response includes `snapshotId`, `calculationVersion`, source, last closed-bar time, row count, generated time, and `executionBlocked`. Score payloads expose the raw score, final gated score, gate results, and failed gate names. The browser uses request cancellation and sequence checks so an older response cannot overwrite a newer symbol/timeframe selection.

Signed scanner/chart/workspace envelopes use Ed25519. `GET /api/evidence/public-key` returns the public JWK and key ID; the browser verifies each network response before caching or rendering it. ETags include the signing key ID, so key rotation cannot produce a `304` against an envelope signed by an obsolete key.

## `GET /api/system/status`

Returns provider identity, connection mode, data-quality score, checked feed count, invalid/gap/duplicate/stale totals, cache telemetry, persisted operation counts, and server time.

In hybrid mode the response includes separate Binance and SSI provider telemetry, bootstrap status/live/fallback counts, composite revision, executable series, open circuit count, last refresh result, credential/configuration state, and per-series issues. Status is `warming`, `operational`, `degraded`, or `blocked`.

## `GET /api/health/live` and `GET /api/health/ready`

`live` confirms that the Node process and HTTP event loop can respond. `ready` additionally evaluates provider bootstrap and aggregate data quality. It returns HTTP `503` while warming or blocked, and HTTP `200` for operational or partially degraded service. This separation is intended for container liveness/readiness probes.

The compatibility endpoint `GET /api/health` returns the same operational state plus cache and persistence summaries.

## `GET /api/metrics`

Returns bounded in-memory request telemetry by normalized Express route: request count, 5xx count/error rate, p50/p95/p99 latency, current in-flight requests, uptime, cache counters, and persisted operation counts. Per-route latency storage is capped to prevent monitoring memory growth. When `METRICS_TOKEN` is configured, callers must send `Authorization: Bearer <token>`.

## `GET /api/data/series`

Optional query: `symbol`, `timeframe=D1|H4`.

Returns operational telemetry for each requested symbol/timeframe: selected provider, actual source, live/fallback/circuit state, cached row count, last closed candle, current error, and the required D1/H4 gates. `seriesExecutable` describes the requested series alone; `executable` requires the complete scanner MTF set.

## `GET /api/quotes`

Returns display-only market quotes. Binance quotes use the official 24-hour ticker endpoint and a five-second server cache. VN stock quotes come from the 24HMoney screener layer and validated D1/H4 history from the selected OHLCV provider; indices are daily-close unless streaming is configured. The endpoint never returns deterministic fixture values.

## TradingView UDF endpoints

The read-only `/udf` namespace implements the TradingView UDF adapter contract:

- `GET /udf/config`
- `GET /udf/search?query=&type=&exchange=&limit=`
- `GET /udf/symbols?symbol=`
- `GET /udf/history?symbol=&resolution=240|1D|D&from=&to=&countback=`
- `GET /udf/time`
- `GET /udf/quotes?symbols=`

These endpoints expose only real provider-backed D1/H4 data. If history is unavailable, `/udf/history` returns `s: "no_data"` instead of generating replacement candles.

## Chart history

`GET /api/chart/:symbol` and `GET /api/workspace/:symbol` ensure the selected D1/H4 timeframe has enough real closed candles before analysis. If the required live history is unavailable, the API returns `503 market_data_unavailable` instead of generating replacement candles.

## `POST /api/alerts`

```json
{
  "symbol": "BTCUSDT",
  "mode": "confirmed",
  "channels": ["app", "telegram"]
}
```

`watch` arms a Circle-only informational alert. `confirmed` requires the production policy `ARROW+BOS+ATR+MTF` before dispatch.

Writes support `Idempotency-Key`. Replaying the same key returns the original alert and sets `Idempotency-Replayed: true`. Single-node file persistence uses a serialized asynchronous queue and atomic replacement so request handling does not call synchronous disk writes.

All business API routes require `Authorization: Bearer <token>` when `SCANNER_API_TOKEN` is configured; production startup fails if it is absent. Health probes and the evidence public key remain public. Mutation routes additionally have a separate 30 requests/minute limiter.

## `GET /api/alerts` and `DELETE /api/alerts/:id`

Lists persisted alerts or disables a specific alert without deleting its audit history.

## `GET|POST|DELETE /api/journal`

Lists entries, writes an evidence snapshot, or clears the prototype journal. Journal writes support `Idempotency-Key`; the server persists the signal snapshot ID, score, classification, notes, and creation time.

## Production extensions

- OAuth/OIDC identity and tenant context.
- Cursor pagination and universe filters.
- WebSocket/SSE signal stream with replay cursor.
- Idempotency keys for alert and trade mutations.
- Versioned endpoints, OpenAPI schema, exchange-calendar metadata, feed freshness, and calculation-version fields.
