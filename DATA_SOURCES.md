# Market Data Source Policy

## Selected production path

### Crypto: Binance Spot

- Official REST source: `GET /api/v3/klines`.
- Used for closed D1/H4 scanner candles. Lower intraday normalization remains available only inside provider tests/on-demand adapters.
- Current unclosed candles are excluded before indicator calculation.
- The adapter applies timeout, quality validation, revision invalidation, fallback isolation, and a circuit breaker.
- Documentation: https://developers.binance.com/docs/binance-spot-api-docs/rest-api/market-data-endpoints

### Vietnam equities: SSI FastConnect FCData

- Official REST base: `https://fc-data.ssi.com.vn/`.
- Authentication: `POST api/v2/Market/AccessToken`; access tokens are cached below the documented eight-hour lifetime.
- Historical endpoints: `api/v2/Market/DailyOhlc` and `api/v2/Market/IntradayOhlc`.
- Credentials are obtained from SSI iBoard API Service Management and stay server-side.
- Intraday records are normalized in `Asia/Ho_Chi_Minh`; H4 combines the complete Vietnam trading session across the lunch break into one candle.
- In-progress candles are excluded; the session H4/D1 candle closes at 15:00 Vietnam time.
- Repeated failures open a per-series circuit; expired circuits retry and return to executable state only after OHLCV validation succeeds.
- Official SDK: https://github.com/SSI-Securities-Corporation/node-fcdata
- Credential management: https://iboard.ssi.com.vn/support/api-service/management

## Sources not selected

### TCBS

No supported public developer contract comparable to SSI FastConnect was verified. Undocumented web endpoints may change without notice and are not used in the scanner core.

### TradingView UDF

TradingView Advanced Charts defines UDF as a simple HTTP datafeed protocol. It is a chart/datafeed interface, not a general market-data license or a free TradingView upstream feed.

The application now exposes a read-only UDF-compatible local datafeed at `/udf`:

- `/udf/config`
- `/udf/search`
- `/udf/symbols`
- `/udf/history`
- `/udf/time`
- `/udf/quotes`

TradingView Charting Library can use it with:

```js
new Datafeeds.UDFCompatibleDatafeed("/udf")
```

For an externally licensed UDF upstream, configure `TRADINGVIEW_UDF_URL`. The upstream adapter validates `/config`, resolves `/symbols`, then requests `/history` with `countback` and normalized `D`/`240` resolutions.

Documentation: https://www.tradingview.com/charting-library-docs/latest/connecting_data/UDF/

### Investing.com

No official public quote/OHLC developer API was verified for this integration. HTML scraping or reverse-engineered endpoints are excluded for stability, licensing, and operational-risk reasons.

## Fail-safe policy

- Missing credentials, stale feeds, insufficient history, invalid OHLC, gaps outside scheduled sessions, and provider errors are visible in `/api/system/status`.
- Fixture data may keep research screens available, but any affected asset fails the `marketData` execution gate and cannot be classified A+.
- A scanner result becomes executable only when D1 and H4 are both live and validated from the selected official provider.
- `/api/data/series` exposes the actual source and every required timeframe gate for operations and incident diagnosis.
