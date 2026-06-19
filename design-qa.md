# Design QA

- Source visual truth: `design/quant-research-cockpit-reference.png`
- Implementation screenshot: `design/audit-2026-06-12/03-optimized-desktop.png`
- Viewport: 1440 x 1024 desktop
- State: BTCUSDT, H4, Confirmed mode, confirmation window 3, all chart layers enabled, synchronized fixture workspace, data quality Q100
- Full-view comparison evidence: source and implementation opened together at original resolution during the final QA pass
- Focused comparison evidence: responsive implementations were also inspected at `design/audit-2026-06-12/04-optimized-1024.png` and `design/audit-2026-06-12/05-optimized-700.png`

**Findings**

- No actionable P0, P1, or P2 findings remain.
- Header BTC/ETH prices, selected-instrument price, percentage change, scanner row, and chart now resolve from the same atomic workspace snapshot; negative change uses the red semantic state.
- The new `SYNCED` state, closed-bar timestamp, measured latency, and scanner total fit the existing terminal hierarchy without changing the selected visual direction.
- The added `Q100` data-quality indicator remains subordinate to the selected instrument and does not crowd the timeframe controls.
- The chart, scanner, score, evidence, risk rail, event timeline, and analytics drawer remain aligned and unclipped at 1440 x 1024.
- At 1024 px the thesis rail is removed and the chart remains dominant; at 700 px the watchlist and market strip are removed while the event timeline remains available through horizontal scrolling.
- Structure Map, Journal, notes, filters, timeframes, modes, confirmation bars, layers, and alerts have working states rather than static chrome.

**Required Fidelity Surfaces**

- Fonts and typography: passed. Segoe UI Variable and Cascadia Mono preserve the compact institutional hierarchy; sync telemetry remains readable without competing with price and score.
- Spacing and layout rhythm: passed. The three-column cockpit, dominant chart, right rail, timeline, and lower analytics grid retain the source proportions.
- Colors and visual tokens: passed. Graphite/navy surfaces and green, blue, orange, red, violet, and amber semantic states remain consistent; degraded sync uses amber rather than an unrelated token.
- Image quality and asset fidelity: passed. Phosphor supplies interface icons and Lightweight Charts renders the market visualization; no placeholder imagery or handcrafted SVG assets were introduced.
- Copy and content: passed. Closed-candle, calculation sync, Crystal signal, journal, score, and risk labels are operationally coherent.

**Intentional Deviations**

- The source mock is 1536 x 1024; implementation QA is 1440 x 1024 and compresses horizontal spacing while preserving hierarchy.
- ATR is rendered as price bands instead of a separate subplot to match the scanner specification.
- Scores and market events come from the deterministic server engine rather than fixed mock values.
- The source's backtest-derived performance drawer is intentionally replaced with current-snapshot scanner analytics because embedded backtesting was removed by product decision.

**Patches Made Since Previous QA Pass**

- Added atomic scanner/chart workspace synchronization and visible sync telemetry.
- Added stale-request cancellation, retry, offline handling, 15-second ETag revalidation, and error recovery.
- Replaced the placeholder Structure Map with engine-backed data.
- Added local signal journal and persisted per-symbol notes.
- Removed embedded backtesting to keep the product focused on scanner evaluation.
- Added provider boundary, OHLCV quality gate, server-persisted alerts/journal, and idempotent mutation handling.
- Added Binance Spot REST closed-candle ingestion, bounded refresh scheduling, provider revision cache invalidation, and deterministic VN fixture fallback.
- Removed static crypto quotes from the market strip and selected-instrument header.
- Replaced synthetic win-rate, expectancy, and equity-curve widgets with synchronized scanner analytics.
- Added responsive monitoring layouts and keyboard focus indicators without changing desktop styling.
- Reduced provider telemetry overhead and added a repeatable engine/API benchmark.

**Follow-up Polish**

- P3: replace fixture VN quotes with licensed SSI data and complete exchange-calendar handling before operational use.
- P3: the 700 px state is intended for monitoring, not full prop-desk operation.

final result: passed
