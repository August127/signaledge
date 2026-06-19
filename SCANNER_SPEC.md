# Scanner Decision Specification

## Non-negotiable data rules

- Signals are calculated from closed OHLCV candles only. Live candles can be displayed but cannot create an executable signal.
- Every timeframe has an exchange-calendar-aware close timestamp. Vietnam equities and 24/7 crypto use separate session calendars.
- Corporate actions, missing candles, duplicate ticks, stale feeds, outliers, and timezone conversion are validated before indicator calculation.
- Scanner decisions must be validated independently before production use; this application no longer includes an embedded backtest engine.

## Framework conditions

### Spartan 1-2-3

- Point 1 is a confirmed pivot after both left and right windows close.
- Point 2 must create meaningful displacement: candle body and close beyond the level must exceed an ATR-normalized threshold.
- Point 3 must hold above/below the invalidation level and produce a rejection or continuation close.
- Break-retest-continuation expires after a configurable number of candles. A late retest becomes a new setup.

### Market structure

- BOS is a close beyond the latest confirmed swing plus an ATR buffer, not a wick touch.
- CHOCH is the first valid close against the active structural bias.
- The engine stores both pivot time and confirmation time to remove look-ahead bias.
- Equal highs/lows are clustered with an ATR tolerance and treated as liquidity, not multiple independent pivots.

### SMC

- Liquidity sweep requires penetration and a close back inside the prior range.
- An order block is the last opposing candle before displacement that caused a BOS. It is invalid after a close through its distal boundary.
- Supply/demand zones decay after repeated mitigations and expire after a configured age.
- Fair-value gaps and order blocks are confluence evidence, never automatic entries.

### ATR volatility

- ATR is Wilder RMA on true range and normalized as ATR/price.
- Thresholds use each asset/timeframe rolling percentile rather than one fixed absolute value.
- Low-volatility compression is allowed only when followed by confirmed expansion; extreme volatility invokes a risk haircut.
- Stops use structure first, then an ATR buffer. ATR alone does not define invalidation.

### Crystal Heikin Ashi

- HA values are derived from original OHLC and never recursively substituted back into market prices.
- Circle: emitted on a closed HA direction change. It is an early warning and can only create a Watch alert.
- The direction-change candle captures the reference high/low.
- Arrow: emitted only after a later candle closes beyond the reference plus an ATR buffer within 1–10 candles, default 3.
- Pending signals expire, opposite changes replace them, and a cooldown prevents duplicate arrows.
- Arrow prices, stops, targets, and P&L always use real OHLC, never synthetic HA prices.

## Multi-timeframe gate

- D1 defines regime and H4 defines setup/entry for the scanner. Data is joined only after each required candle closes.
- A+ requires directional agreement or an explicitly tested transition model; partial alignment is capped below A+.
- Crypto and Vietnam-equity thresholds are calibrated independently.

## Score 0–100

- Structure 40: trend/regime 8, pivot cleanliness 8, BOS/CHOCH quality 10, range/space 6, liquidity/order-block confluence 8.
- Momentum 30: volume percentile 8, displacement/body-to-ATR 7, EMA slope/stack 6, Crystal evidence 6, ATR percentile 3.
- Entry Quality 30: retest 10, rejection 6, confirmed reference break 6, reward/liquidity space 5, fake-break/cooldown gate 3.
- Crystal is nested inside Momentum and Entry Quality. It never adds points outside the 100-point model.
- Hard caps are applied once by `applyExecutabilityGates()`: trend, volatility, confirmed Crystal trigger, structure agreement, MTF alignment, and market-data executability must all pass for A+.
- Live-to-fallback transitions are execution gates, not scoring evidence. Crypto fixture fallback can remain visible for research but is capped at 79 and cannot produce an executable A+ signal.

## Classification

- A+ 80–100: executable only after all hard gates pass.
- A 60–79: Watch; no trade alert.
- B/C below 60: Ignore, but retain for model diagnostics.

Every output includes raw score, gated score, failed gate names, evidence, parameter version, candle timestamps, source freshness, and a deterministic calculation ID.
