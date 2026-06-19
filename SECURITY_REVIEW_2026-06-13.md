# Security Review Verification - 2026-06-13

This document verifies the external report `LỖI VÀ ĐIỂM HỎA HẠNG (CRITICAL) ngày 12.6.txt` against the current codebase.

| # | Claim | Verdict | Action |
| --- | --- | --- | --- |
| 1 | Random HMAC key is unsafe for horizontal production | Valid production gap | Replaced envelopes with Ed25519. Production requires a stable vault-supplied private key; the browser verifies signatures. |
| 2, 10 | Concurrent requests lose file mutations | False for the current single process | `OperationsStore` already serializes every mutation through `mutationQueue`; the concurrent durable-write test proves six simultaneous writes persist. Multi-instance file storage remains unsupported. |
| 3 | No authentication/authorization | Partially valid production gap | The service binds to loopback by default. Production now fails without `SCANNER_API_TOKEN`; all business API routes enforce Bearer access behind a trusted identity gateway. Full OIDC/RBAC remains a deployment requirement. |
| 4 | Rate limit is global and too weak | Incorrect mechanism, valid hardening request | `express-rate-limit` is per client IP by default, not one global bucket. Added a separate 30/min mutation limiter. |
| 5 | Fixture can appear executable | Core claim false, UI warning valid | Market-data gates already cap fixture results below A+ and expose `executionBlocked`. UI now shows `RESEARCH DATA / NON-EXECUTABLE` and disables confirmed alerts. |
| 6 | ETag hashes the signature and breaks after restart | False for the old code | The old ETag hashed the unsigned payload. New Ed25519 ETags additionally include key ID so a rotated key always forces a fresh `200` envelope. |
| 7 | SSI secret may leak through errors | Not reproduced, hardened defensively | Fetch errors do not normally contain request bodies. Provider error telemetry now redacts configured secrets, access tokens, and credential-like fields. |
| 8 | No market-data execution gate | False | `SnapshotStore` applies the `marketData` gate; composite execution requires live D1/H4/H1 plus selected timeframe. Stale/error/circuit/fallback states are non-executable. |
| 9 | Overnight Vietnam gap is treated as an error | False | `nextDay > previousDay` already permits overnight gaps. An explicit overnight regression test was added. |
| 11 | Cache invalidation can return partial snapshots | False | Cache clear is atomic in the Node event loop; analyses are created synchronously from a provider revision and workspace consistency is verified. |
| 12 | Provider revision is absent from cache/signature | False | Provider revision is in scanner/analysis cache keys and sync payloads. Calculation version is `scanner-core-2026.06.13.2`. |
| 13 | `z.coerce.number()` silently defaults invalid input | False | URL query values are strings; coercion is required. `foo` becomes `NaN` and fails Zod validation with HTTP 400 rather than using the default. |
| 14, 18 | JSON storage is not multi-instance production persistence | Valid limitation, not a current race | Atomic rename and serialized writes protect the single-node prototype. PostgreSQL/outbox remains mandatory before horizontal scaling. |
| 15 | No exponential retry backoff | Reclassified | Browser retry is a single 250 ms retry, not an unbounded loop. Provider refresh is candle-aware, concurrency-bounded, and circuit-broken. Jittered backoff is future scale hardening. |
| 16 | Vietnam timezone should be configurable | Rejected | Exchange timestamps must use the exchange timezone. Making it operator-configurable would permit incorrect candle boundaries. |
| 17 | Test coverage is absent | False | The suite now contains 44 focused tests covering indicators, gates, providers, concurrency, signing, key rotation, redaction, caching, and operational controls. |

## Remaining production requirements

- OIDC/MFA/RBAC and immutable user audit events.
- PostgreSQL/Timescale plus an outbox before multiple API instances.
- Vault/KMS-managed Ed25519 rotation and gateway-managed mutation authorization.
- Complete Vietnam exchange holiday/calendar service and licensed SSI production entitlement.

## Verification

- Automated tests: 44 passing.
- Production build: passing.
- Edge runtime: Ed25519 envelope verified before rendering; fixture state visibly marked `RESEARCH DATA / NON-EXECUTABLE`.
- Production access check: liveness and public key remain public; business API without Bearer token returns `401`; valid token returns the signed workspace.
- Cache validation: initial workspace request returns `200`, unchanged request returns `304`, invalid `confirmationBars=foo` returns `400`.
- Post-hardening load test: 120 requests at concurrency 24, p95 98.27 ms, zero failures.
