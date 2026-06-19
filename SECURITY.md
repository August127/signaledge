# Security And Intellectual Property Model

## Practical position

Client-side code cannot be made impossible to copy. Obfuscation only increases effort and must not be treated as the security boundary. The defensible design keeps proprietary rules, weights, model calibration, and exchange credentials outside the browser.

## Architecture controls

- Execute scanner, scoring, and risk policy in private backend workers. The web client receives only normalized results and signed evidence.
- Put ingestion and execution services on private networks. Expose a narrow API gateway with authentication, authorization, schema validation, quotas, and audit logging.
- Use short-lived access tokens, secure HTTP-only refresh cookies, MFA, session/device revocation, and RBAC for analyst, trader, risk, and administrator roles.
- Encrypt in transit and at rest. Store exchange/API credentials in a managed secrets vault with rotation and least privilege. Never allow withdrawal permission on market-data/trading keys.
- Sign signal payloads with an asymmetric service key in production. Verify signatures before execution and record immutable calculation IDs.
- Apply per-user and per-tenant rate limits, anomaly detection, IP/device risk signals, replay protection, request nonces, and websocket authorization.
- Separate research, paper, and live execution environments. A risk service must independently approve position size, exposure, daily loss, and kill-switch rules.

## IP protection

- Ship no indicator source, weights, feature engineering, or model artifacts to the frontend.
- Compile sensitive services into private containers and restrict production shell, registry, artifact, and log access.
- Use tenant-specific feature entitlements, watermark exported reports, and embed traceable canary fields in high-value data exports.
- Keep rules versioned in a private repository with signed releases, protected branches, mandatory reviews, and dependency/SBOM scans.
- Minification and obfuscation may be added as defense in depth, but licensing, access control, server-side execution, monitoring, and legal agreements provide the real protection.

## Application controls in this prototype

- Helmet security headers, disabled framework banner, bounded JSON body, Zod input validation, per-IP rate limiting, stricter mutation limits, private cache directives, request IDs, and Ed25519-signed evidence envelopes.
- The browser retrieves the public JWK and verifies scanner/chart/workspace evidence before rendering. ETags include the signing key ID to prevent stale signatures surviving key rotation.
- Development may generate an ephemeral Ed25519 key. Production fails closed unless `EVIDENCE_PRIVATE_KEY` or `EVIDENCE_PRIVATE_KEY_B64` and `SCANNER_API_TOKEN` are configured from a secrets vault.
- Health probes and the evidence public key remain public; scanner, chart, status, alerts, and journal APIs require the service Bearer token in production. A trusted OIDC gateway injects it after user authentication so the token is never shipped to browser JavaScript.
- Full production identity still requires OIDC/RBAC at the gateway or application session layer. The service token is an interim boundary, not a replacement for user identity, MFA, or tenant authorization.
- Liveness and readiness probes expose no credentials. Runtime metrics can be protected with `METRICS_TOKEN` and should additionally be restricted to the private monitoring network at the gateway.
