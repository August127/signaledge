import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  aggregateOhlcv,
  BinanceRestMarketDataProvider,
  CompositeMarketDataProvider,
  createMarketDataProvider,
  DataQualityMonitor,
  EquityFailoverMarketDataProvider,
  filterClosedSsiRows,
  FixtureMarketDataProvider,
  KbsMarketDataProvider,
  normalizeBinanceKlines,
  normalizeBinanceTickers,
  normalize24HMoneyScreener,
  normalizeKbsOhlcv,
  normalizeSsiIndex,
  normalizeSsiOhlcv,
  normalizeUdfOhlcv,
  sanitizeProviderError,
  SsiFastConnectMarketDataProvider,
  TwentyFourHMoneyScreenerProvider,
  TradingViewUdfMarketDataProvider,
} from "./market-data.js";
import { OperationsStore } from "./operations-store.js";
import { SnapshotStore } from "./snapshot-store.js";
import { analysisRowCount, generateOhlcv } from "./engine.js";

const row = (time, overrides = {}) => ({ time, open: 10, high: 12, low: 9, close: 11, volume: 100, ...overrides });

test("provider errors redact credentials before telemetry persistence", () => {
  const message = sanitizeProviderError(new Error("request failed consumerSecret=top-secret accessToken:abc-token"), ["top-secret", "abc-token"]);
  assert.equal(message.includes("top-secret"), false);
  assert.equal(message.includes("abc-token"), false);
  assert.match(message, /REDACTED/);
});

test("fixture provider never exposes synthetic rows as realtime quotes", async () => {
  const quotes = await new FixtureMarketDataProvider({ now: () => 1_750_000_000_000 }).getQuotes();
  assert.equal(quotes.status, "unavailable");
  assert.deepEqual(quotes.items, []);
  assert.deepEqual(quotes.indices, []);
});

test("Binance ticker normalization preserves official 24h price and timestamp", () => {
  const [quote] = normalizeBinanceTickers({
    symbol: "BTCUSDT",
    lastPrice: "63804.00",
    priceChange: "386.09",
    priceChangePercent: "0.609",
    closeTime: 1781315805006,
  });
  assert.deepEqual(quote, {
    symbol: "BTCUSDT",
    price: 63804,
    change: 0.609,
    absoluteChange: 386.09,
    quotedAt: "2026-06-13T01:56:45.006Z",
    source: "binance-rest-v3-ticker",
    live: true,
  });
});

test("Binance realtime quotes are batched and cached for the configured TTL", async () => {
  let nowMs = 1_750_000_000_000;
  let calls = 0;
  const provider = new BinanceRestMarketDataProvider({
    now: () => nowMs,
    fetcher: async (url) => {
      calls += 1;
      assert.match(String(url), /api\/v3\/ticker\/24hr/);
      return { ok: true, json: async () => [
        { symbol: "BTCUSDT", lastPrice: "63804", priceChange: "386", priceChangePercent: "0.609", closeTime: nowMs },
        { symbol: "ETHUSDT", lastPrice: "1673.85", priceChange: "7.99", priceChangePercent: "0.480", closeTime: nowMs },
      ] };
    },
  });
  const symbols = [
    { symbol: "BTCUSDT", market: "CRYPTO" },
    { symbol: "ETHUSDT", market: "CRYPTO" },
  ];
  const first = await provider.getQuotes(symbols);
  const second = await provider.getQuotes(symbols);
  assert.equal(first.status, "live");
  assert.equal(first.items[0].price, 63804);
  assert.equal(second.items[1].price, 1673.85);
  assert.equal(calls, 1);
  nowMs += 5001;
  await provider.getQuotes(symbols);
  assert.equal(calls, 2);
});

test("three-month chart windows request enough closed candles for each market", () => {
  assert.equal(analysisRowCount({ market: "CRYPTO" }, "H4"), 560);
  assert.equal(analysisRowCount({ market: "VN30" }, "H4"), 560);
  assert.equal(analysisRowCount({ market: "VN30" }, "D1"), 260);
});

test("Binance history pagination loads a complete one-month M15 window", async () => {
  const nowMs = 1_750_000_000_000;
  const interval = 900_000;
  const latestClosedOpen = Math.floor(nowMs / interval) * interval - interval;
  let calls = 0;
  const provider = new BinanceRestMarketDataProvider({
    now: () => nowMs,
    fetcher: async (url) => {
      calls += 1;
      const parsed = new URL(url);
      const limit = Number(parsed.searchParams.get("limit"));
      const endTime = Number(parsed.searchParams.get("endTime") ?? latestClosedOpen + interval - 1);
      const lastOpen = Math.min(latestClosedOpen, Math.floor(endTime / interval) * interval);
      const payload = Array.from({ length: limit }, (_, index) => {
        const openTime = lastOpen - (limit - 1 - index) * interval;
        const price = 100 + index / 100;
        return [openTime, String(price), String(price + 1), String(price - 1), String(price + 0.2), "1000", openTime + interval - 1];
      });
      return { ok: true, json: async () => payload };
    },
  });
  const rows = await provider.fetchRows({ symbol: "BTCUSDT", market: "CRYPTO" }, "M15", 3000);
  assert.equal(rows.length, 3000);
  assert.equal(calls, 3);
  assert.equal(rows.at(-1).time, latestClosedOpen / 1000);
  assert.equal(new Set(rows.map((item) => item.time)).size, 3000);
});

test("SSI daily index normalization derives percent change without inventing missing values", () => {
  const quote = normalizeSsiIndex({ data: [{
    TradingDate: "13/06/2026",
    IndexValue: "1791.65",
    ReferenceIndex: "1798.61",
    Change: "-6.96",
  }] }, "VNINDEX");
  assert.equal(quote.symbol, "VNINDEX");
  assert.equal(quote.price, 1791.65);
  assert.equal(Number(quote.change.toFixed(2)), -0.39);
  assert.equal(quote.absoluteChange, -6.96);
  assert.equal(quote.live, false);
  assert.equal(normalizeSsiIndex({ data: [{ IndexValue: "1944.36" }] }, "VN30").change, null);
});

test("data quality monitor detects gaps, duplicates, invalid OHLC and stale feeds", () => {
  const monitor = new DataQualityMonitor({ now: () => 10_000_000 });
  const healthy = monitor.inspect("BTCUSDT", "M15", [row(8200), row(9100), row(10000)]);
  assert.equal(healthy.status, "healthy");
  assert.equal(healthy.score, 100);

  const degraded = monitor.inspect("ETHUSDT", "M15", [row(100), row(100), row(1900, { high: 9 })]);
  assert.equal(degraded.faults.duplicate, 1);
  assert.equal(degraded.faults.gap, 1);
  assert.equal(degraded.faults.invalid, 1);
  assert.equal(degraded.stale, true);
  assert.equal(degraded.status, "blocked");
});

test("Vietnam session quality accepts the scheduled lunch and overnight gaps", () => {
  const epoch = (iso) => Math.floor(Date.parse(iso) / 1000);
  const monitor = new DataQualityMonitor({ now: () => Date.parse("2026-06-12T06:30:00Z") });
  const rows = [
    row(epoch("2026-06-12T04:15:00Z")),
    row(epoch("2026-06-12T04:30:00Z")),
    row(epoch("2026-06-12T06:00:00Z")),
    row(epoch("2026-06-12T06:15:00Z")),
  ];
  const quality = monitor.inspect("FPT", "M15", rows, { market: "VN30" });
  assert.equal(quality.faults.gap, 0);
  assert.equal(quality.status, "healthy");

  const overnight = monitor.inspect("VCB", "M15", [
    row(epoch("2026-06-11T07:45:00Z")),
    row(epoch("2026-06-12T02:00:00Z")),
  ], { market: "VN30" });
  assert.equal(overnight.faults.gap, 0);
});

test("SSI OHLC normalization handles official field names and aggregates Vietnam-local candles", () => {
  const payload = { status: 200, data: [
    { TradingDate: "12/06/2026", Time: "09:00:00", Open: "100", High: "103", Low: "99", Close: "102", Volume: "1000" },
    { TradingDate: "12/06/2026", Time: "09:15:00", Open: "102", High: "104", Low: "101", Close: "103", Volume: "1200" },
    { TradingDate: "12/06/2026", Time: "09:30:00", Open: "103", High: "105", Low: "102", Close: "104", Volume: "900" },
    { TradingDate: "12/06/2026", Time: "09:45:00", Open: "104", High: "106", Low: "103", Close: "105", Volume: "1100" },
  ] };
  const rows = normalizeSsiOhlcv(payload);
  assert.equal(rows.length, 4);
  const hourly = aggregateOhlcv(rows, "H1");
  assert.equal(hourly.length, 1);
  assert.deepEqual(hourly[0], { time: Math.floor(Date.parse("2026-06-12T02:00:00Z") / 1000), open: 100, high: 106, low: 99, close: 105, volume: 4200 });
});

test("KBS OHLC normalization scales Vietnam stock prices and sorts bars", () => {
  const rows = normalizeKbsOhlcv({ data_15P: [
    { t: "2026-06-12 09:15", o: 73500, h: 74200, l: 73400, c: 74000, v: 1200 },
    { t: "2026-06-12 09:00", o: 73000, h: 73600, l: 72900, c: 73500, v: 900 },
  ] }, "15P");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].open, 73);
  assert.equal(rows[1].close, 74);
  assert.equal(rows[1].time - rows[0].time, 900);
});

test("KBS index series keeps point units for VNINDEX chart and scanner", async () => {
  const provider = new KbsMarketDataProvider({
    now: () => Date.parse("2026-06-18T10:00:00+07:00"),
    fetcher: async () => ({
      ok: true,
      json: async () => ({ data_day: [
        { t: "2026-06-17", o: 1780.5, h: 1798.2, l: 1772.1, c: 1791.65, v: 640000000 },
      ] }),
    }),
  });
  const rows = await provider.fetchSeries("VNINDEX", "day", 1, { index: true, daily: true });
  assert.equal(rows.at(-1).close, 1791.65);
});

test("24HMoney screener normalization maps quote and relative-strength fields", () => {
  const rows = normalize24HMoneyScreener({
    data: {
      data: [{
        symbol: " fpt ",
        match_price: 73.5,
        change_percent: 1.25,
        change_price: 0.9,
        accumylated_vol: 123456,
        market_cap: 150000,
        pe4Q: 15.2,
        pb4Q: 3.1,
        eps4Q: 4800,
        roe: 22,
        roa: 9,
        rs1m: 70,
        rs3m: 75,
        rs52w: 82,
        floor: "HOSE",
        index_code: "VN30",
      }],
    },
  }, "2026-06-16T08:00:00.000Z");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, "FPT");
  assert.equal(rows[0].price, 73.5);
  assert.equal(rows[0].change, 1.25);
  assert.equal(rows[0].rs52w, 82);
  assert.equal(rows[0].source, "24hmoney-technical-filter-v1");
});

test("24HMoney provider supplies quotes without claiming OHLCV execution", async () => {
  const payload = {
    status: 200,
    data: {
      total_page: 1,
      data: [
        { symbol: "FPT", match_price: 73.5, change_percent: 0.5, change_price: 0.4, accumylated_vol: 1000, rs1m: 70, rs3m: 74, rs52w: 80 },
        { symbol: "VCB", match_price: 61.6, change_percent: -0.2, change_price: -0.1, accumylated_vol: 2000, rs1m: 50, rs3m: 55, rs52w: 60 },
      ],
    },
  };
  const requests = [];
  const provider = new TwentyFourHMoneyScreenerProvider({
    now: () => Date.parse("2026-06-16T08:00:00Z"),
    fetcher: async (url) => {
      requests.push(String(url));
      return { ok: true, json: async () => payload };
    },
  });
  const symbols = [{ symbol: "FPT", market: "VN30" }, { symbol: "VCB", market: "VN30" }];
  await provider.initialize(symbols, ["D1", "H4"]);
  const quotes = await provider.getQuotes(symbols);
  assert.equal(requests.length, 1);
  assert.equal(quotes.items.length, 2);
  assert.equal(quotes.items[0].source, "24hmoney-technical-filter-v1");
  assert.equal(provider.isExecutable(symbols[0], "D1"), false);
  assert.throws(() => provider.getRows(symbols[0], "D1", 10), /quote_only/);
  assert.equal(provider.status().quoteRows, 2);
});

test("TradingView-compatible UDF normalization accepts only numeric OHLCV rows", () => {
  const rows = normalizeUdfOhlcv({ s: "ok", t: [100, 200], o: [10, 11], h: [12, 13], l: [9, 10], c: [11, 12], v: [1000, 1200] });
  assert.deepEqual(rows.at(-1), { time: 200, open: 11, high: 13, low: 10, close: 12, volume: 1200 });
  assert.deepEqual(normalizeUdfOhlcv({ s: "no_data" }), []);
  assert.throws(() => normalizeUdfOhlcv({ s: "error", errmsg: "bad symbol" }), /udf_error:bad symbol/);
});

test("TradingView-compatible UDF provider validates config, resolves symbols, and requests countback history", async () => {
  const nowMs = Date.parse("2026-06-16T08:00:00Z");
  const requests = [];
  const firstBarTime = Math.floor((nowMs - 259 * 86400_000) / 1000);
  const bars = Array.from({ length: 260 }, (_, index) => {
    const time = firstBarTime + index * 86400;
    const price = 70 + index * 0.05;
    return { time, price };
  });
  const provider = new TradingViewUdfMarketDataProvider({
    now: () => nowMs,
    baseUrl: "https://udf.example.test",
    symbolTemplate: "{exchange}:{symbol}",
    exchange: "HOSE",
    fetcher: async (url) => {
      const parsed = new URL(url);
      requests.push(`${parsed.pathname}?${parsed.searchParams.toString()}`);
      if (parsed.pathname === "/config") return { ok: true, json: async () => ({ supports_search: true, supports_group_request: false, supported_resolutions: ["240", "1D"] }) };
      if (parsed.pathname === "/symbols") return { ok: true, json: async () => ({ name: "FPT", ticker: "HOSE:FPT" }) };
      if (parsed.pathname === "/history") {
        assert.equal(parsed.searchParams.get("symbol"), "HOSE:FPT");
        assert.equal(parsed.searchParams.get("resolution"), "D");
        assert.equal(parsed.searchParams.get("countback"), "260");
        return { ok: true, json: async () => ({
          s: "ok",
          t: bars.map((bar) => bar.time),
          o: bars.map((bar) => bar.price),
          h: bars.map((bar) => bar.price + 1),
          l: bars.map((bar) => bar.price - 1),
          c: bars.map((bar) => bar.price + 0.2),
          v: bars.map(() => 1000),
        }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    },
  });
  const meta = { symbol: "FPT", venue: "HOSE", market: "VN30" };
  const result = await provider.initialize([meta], ["D1"]);
  assert.equal(result.liveSeries, 1);
  assert.equal(provider.isExecutable(meta, "D1"), true);
  assert.equal(provider.sourceFor(meta, "D1"), "tradingview-compatible-udf-v1");
  assert.ok(requests[0].startsWith("/config?"));
  assert.ok(requests.some((item) => item.startsWith("/symbols?symbol=HOSE%3AFPT")));
  assert.ok(requests.some((item) => item.startsWith("/history?")));
});

test("equity failover selects the first executable real provider", () => {
  const meta = { symbol: "FPT", market: "VN30" };
  const makeProvider = (id, live) => ({ id, isExecutable: () => live, getRevision: () => 1 });
  const provider = new EquityFailoverMarketDataProvider({ providers: [makeProvider("ssi", false), makeProvider("kbs", true), makeProvider("udf", true)] });
  assert.equal(provider.sourceFor(meta, "D1"), "kbs");
  assert.equal(provider.isExecutable(meta, "D1"), true);
});

test("OHLC aggregation preserves first open, last close, extremes and total volume", () => {
  const start = Math.floor(Date.parse("2026-06-12T02:00:00Z") / 1000);
  const rows = [
    row(start, { open: 100, high: 103, low: 99, close: 102, volume: 100 }),
    row(start + 900, { open: 102, high: 106, low: 101, close: 104, volume: 200 }),
    row(start + 1800, { open: 104, high: 105, low: 98, close: 99, volume: 300 }),
    row(start + 2700, { open: 99, high: 102, low: 97, close: 101, volume: 400 }),
  ];
  const [hour] = aggregateOhlcv(rows, "H1");
  assert.deepEqual(hour, { time: start, open: 100, high: 106, low: 97, close: 101, volume: 1000 });
});

test("SSI H4 aggregation combines the full Vietnam trading session across lunch", () => {
  const epoch = (localTime) => Math.floor(Date.parse(`2026-06-12T${localTime}+07:00`) / 1000);
  const rows = [
    row(epoch("09:00:00"), { open: 100, high: 102, low: 99, close: 101, volume: 100 }),
    row(epoch("11:15:00"), { open: 101, high: 104, low: 100, close: 103, volume: 200 }),
    row(epoch("13:00:00"), { open: 103, high: 105, low: 102, close: 104, volume: 300 }),
    row(epoch("14:45:00"), { open: 104, high: 106, low: 101, close: 102, volume: 400 }),
  ];
  const h4 = aggregateOhlcv(rows, "H4");
  assert.equal(h4.length, 1);
  assert.deepEqual(h4[0], { time: epoch("09:00:00"), open: 100, high: 106, low: 99, close: 102, volume: 1000 });
});

test("SSI closed-candle filter follows Vietnam lunch and session close times", () => {
  const epoch = (localTime) => Math.floor(Date.parse(`2026-06-12T${localTime}+07:00`) / 1000);
  const h1 = [row(epoch("10:00:00")), row(epoch("11:00:00")), row(epoch("13:00:00"))];
  assert.deepEqual(filterClosedSsiRows(h1, "H1", epoch("11:29:59")).map((item) => item.time), [epoch("10:00:00")]);
  assert.deepEqual(filterClosedSsiRows(h1, "H1", epoch("11:30:00")).map((item) => item.time), [epoch("10:00:00"), epoch("11:00:00")]);

  const h4 = [row(epoch("09:00:00"))];
  assert.equal(filterClosedSsiRows(h4, "H4", epoch("14:59:59")).length, 0);
  assert.equal(filterClosedSsiRows(h4, "H4", epoch("15:00:00")).length, 1);

  const m15 = [row(epoch("14:45:00"))];
  assert.equal(filterClosedSsiRows(m15, "M15", epoch("14:59:59")).length, 0);
  assert.equal(filterClosedSsiRows(m15, "M15", epoch("15:00:00")).length, 1);
});

test("SSI provider caches the eight-hour access token and serves validated daily candles", async () => {
  const nowMs = Date.parse("2026-06-12T10:00:00Z");
  let tokenCalls = 0;
  let dailyCalls = 0;
  const dailyRows = Array.from({ length: 260 }, (_, index) => {
    const date = new Date(nowMs - (259 - index) * 86400_000);
    const tradingDate = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh" }).format(date);
    return { TradingDate: tradingDate, Open: 100 + index, High: 102 + index, Low: 99 + index, Close: 101 + index, Volume: 1000 + index };
  });
  const fetcher = async (input) => {
    const url = String(input);
    if (url.includes("AccessToken")) {
      tokenCalls += 1;
      return { ok: true, json: async () => ({ status: 200, data: { accessToken: "ssi-token" } }) };
    }
    dailyCalls += 1;
    return { ok: true, json: async () => ({ status: 200, data: dailyRows }) };
  };
  const provider = new SsiFastConnectMarketDataProvider({
    now: () => nowMs,
    fetcher,
    consumerId: "consumer",
    consumerSecret: "secret",
    pageSize: 1000,
  });
  const meta = { symbol: "FPT", market: "VN30", base: 100, drift: 0, vol: 0.01 };
  await provider.warmSymbol(meta, ["D1"]);
  await provider.accessToken();
  assert.equal(tokenCalls, 1);
  assert.equal(dailyCalls, 1);
  assert.equal(provider.getRows(meta, "D1", 180).length, 180);
  assert.equal(provider.sourceFor(meta, "D1"), "ssi-fastconnect-fcdata-v2");
});

test("SSI provider retries failed series, opens a circuit, then recovers after cooldown", async () => {
  let nowMs = Date.parse("2026-06-12T10:00:00Z");
  let failing = true;
  let dailyCalls = 0;
  const dailyRows = Array.from({ length: 260 }, (_, index) => {
    const date = new Date(nowMs - (259 - index) * 86400_000);
    return {
      TradingDate: new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh" }).format(date),
      Open: 100 + index,
      High: 102 + index,
      Low: 99 + index,
      Close: 101 + index,
      Volume: 1000 + index,
    };
  });
  const fetcher = async (input) => {
    if (String(input).includes("AccessToken")) return { ok: true, json: async () => ({ status: 200, data: { accessToken: "ssi-token" } }) };
    dailyCalls += 1;
    return failing
      ? { ok: false, status: 503, json: async () => ({}) }
      : { ok: true, json: async () => ({ status: 200, data: dailyRows }) };
  };
  const provider = new SsiFastConnectMarketDataProvider({
    now: () => nowMs,
    fetcher,
    consumerId: "consumer",
    consumerSecret: "secret",
    failureThreshold: 2,
    circuitCooldownMs: 60_000,
  });
  const meta = { symbol: "FPT", market: "VN30", base: 100, drift: 0, vol: 0.01 };
  provider.symbols = [meta];
  provider.timeframes = ["D1"];

  await provider.warmSymbol(meta, ["D1"]);
  await provider.refreshDue();
  assert.equal(dailyCalls, 2);
  assert.equal(provider.status().openCircuits, 1);

  await provider.refreshDue();
  assert.equal(dailyCalls, 2);

  nowMs += 60_001;
  failing = false;
  await provider.refreshDue();
  assert.equal(dailyCalls, 3);
  assert.equal(provider.isExecutable(meta, "D1"), true);
  assert.equal(provider.status().openCircuits, 0);
});

test("unconfigured SSI falls back for display and remains non-executable", async () => {
  const now = () => Date.parse("2026-06-12T10:00:00Z");
  const fallback = new FixtureMarketDataProvider({ now });
  const provider = new SsiFastConnectMarketDataProvider({ now, fallback, consumerId: "", consumerSecret: "" });
  const meta = { symbol: "FPT", market: "VN30", base: 100, drift: 0, vol: 0.01 };
  await provider.initialize([meta], ["D1", "H4"]);
  assert.equal(provider.getRows(meta, "H4", 180).length, 180);
  assert.equal(provider.isExecutable(meta, "H4"), false);
  assert.equal(provider.sourceFor(meta, "H4"), fallback.id);
  assert.equal(provider.status().quality.status, "degraded");
});

test("composite provider requires D1 and H4 data before a scanner result is executable", () => {
  const states = new Map([["D1", true], ["H4", false]]);
  const stub = { isExecutable: (_meta, timeframe) => states.get(timeframe), getRevision: () => 1 };
  const composite = new CompositeMarketDataProvider({ crypto: stub, equities: stub });
  assert.equal(composite.isExecutable({ market: "VN30" }, "H4"), false);
  states.set("H4", true);
  assert.equal(composite.isExecutable({ market: "VN30" }, "H4"), true);
});

test("composite series telemetry exposes selected source and every required MTF gate", () => {
  const states = new Map([["D1", true], ["H4", false]]);
  const stub = {
    id: "test-provider",
    isExecutable: (_meta, timeframe) => states.get(timeframe),
    sourceFor: (_meta, timeframe) => states.get(timeframe) ? "live-source" : "fixture-source",
    seriesStatus: (meta, timeframe) => ({
      symbol: meta.symbol,
      market: meta.market,
      timeframe,
      provider: "test-provider",
      source: states.get(timeframe) ? "live-source" : "fixture-source",
      live: states.get(timeframe),
      state: states.get(timeframe) ? "live" : "fallback",
      lastBarTime: timeframe === "H4" ? null : 100,
    }),
    getRevision: () => 1,
  };
  const composite = new CompositeMarketDataProvider({ crypto: stub, equities: stub });
  const status = composite.seriesStatus({ symbol: "FPT", market: "VN30" }, "H4");
  assert.equal(status.seriesExecutable, false);
  assert.equal(status.executable, false);
  assert.deepEqual(status.required.map((item) => [item.timeframe, item.live]), [["D1", true], ["H4", false]]);
});

test("operations store provides idempotent alerts and journal writes", async () => {
  let sequence = 0;
  const store = new OperationsStore({ now: () => new Date("2026-06-11T00:00:00Z"), id: () => `id-${++sequence}` });
  const payload = { symbol: "BTCUSDT", mode: "confirmed", channels: ["app"], policy: "ARROW+BOS+ATR+MTF" };
  const first = await store.createAlert(payload, "alert-key");
  const replay = await store.createAlert(payload, "alert-key");
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(store.listAlerts().length, 1);
  assert.equal((await store.disableAlert(first.item.id)).status, "disabled");

  const journal = { symbol: "BTCUSDT", timeframe: "H4", score: 83, classification: "A+", signal: "ARROW BULL" };
  await store.createJournalEntry(journal, "journal-key");
  await store.createJournalEntry(journal, "journal-key");
  assert.equal(store.listJournal().length, 1);
  assert.equal(await store.clearJournal(), 1);
});

test("operations store serializes concurrent mutations to an atomic durable file", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scanner-operations-"));
  const filePath = path.join(directory, "operations.json");
  let sequence = 0;
  try {
    const store = new OperationsStore({ filePath, id: () => `id-${++sequence}` });
    await Promise.all(Array.from({ length: 6 }, (_, index) => store.createAlert({
      symbol: `ASSET${index}`,
      mode: "watch",
      channels: ["app"],
      policy: "CIRCLE_ONLY_WATCH",
    }, `key-${index}`)));
    await store.flush();

    const persisted = JSON.parse(await fs.readFile(filePath, "utf8"));
    assert.equal(persisted.alerts.length, 6);
    assert.equal(Object.keys(persisted.idempotency).length, 6);
    assert.deepEqual((await fs.readdir(directory)).sort(), ["operations.json"]);

    const restored = new OperationsStore({ filePath });
    assert.equal(restored.listAlerts().length, 6);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("snapshot metadata exposes provider data quality", () => {
  const now = () => 1_750_000_000_000;
  const provider = new FixtureMarketDataProvider({ now });
  const store = new SnapshotStore({ now, provider });
  const workspace = store.getWorkspace("BTCUSDT", "H4", 3);
  assert.equal(workspace.chart.sync.dataQuality.status, "healthy");
  assert.equal(workspace.chart.sync.dataQuality.totalFaults, 0);
  assert.equal(store.stats().provider.id, "deterministic-fixture-v1");
});

test("Binance kline normalization excludes the current unclosed candle", () => {
  const now = 10_000;
  const payload = [
    [8_200_000, "10", "12", "9", "11", "100", 9_099_999],
    [9_100_000, "11", "13", "10", "12", "120", 9_999_999],
    [10_000_000, "12", "14", "11", "13", "140", 10_899_999],
  ];
  const rows = normalizeBinanceKlines(payload, now);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.at(-1), { time: 9100, open: 11, high: 13, low: 10, close: 12, volume: 120 });
});

test("Binance provider warms and serves validated closed-candle cache", async () => {
  const nowMs = 1_750_000_000_000;
  const interval = 900_000;
  const aligned = Math.floor(nowMs / interval) * interval;
  const payload = Array.from({ length: 62 }, (_, index) => {
    const openTime = aligned - (62 - index) * interval;
    const price = 100 + index;
    return [openTime, String(price), String(price + 2), String(price - 2), String(price + 1), "1000", openTime + interval - 1];
  });
  const fetcher = async () => ({ ok: true, json: async () => payload });
  const provider = new BinanceRestMarketDataProvider({ now: () => nowMs, fetcher });
  const meta = { symbol: "BTCUSDT", market: "CRYPTO" };
  const rows = await provider.fetchRows(meta, "M15", 60);
  assert.equal(rows.length, 60);
  assert.equal(provider.getRows(meta, "M15", 50).length, 50);
  assert.equal(provider.status().quality.status, "healthy");
  assert.equal(provider.status().errors, 0);
});

test("Binance refresh runs only after a new candle closes and advances revision", async () => {
  let nowMs = 1_750_000_000_000;
  let calls = 0;
  const interval = 900_000;
  const payloadAtNow = () => {
    const aligned = Math.floor(nowMs / interval) * interval;
    return Array.from({ length: 62 }, (_, index) => {
      const openTime = aligned - (62 - index) * interval;
      const price = 100 + index + calls;
      return [openTime, String(price), String(price + 2), String(price - 2), String(price + 1), "1000", openTime + interval - 1];
    });
  };
  const fetcher = async () => { calls += 1; return { ok: true, json: async () => payloadAtNow() }; };
  const provider = new BinanceRestMarketDataProvider({ now: () => nowMs, fetcher });
  const meta = { symbol: "BTCUSDT", market: "CRYPTO" };
  await provider.initialize([meta], ["M15"]);
  const initialRevision = provider.getRevision();
  const idle = await provider.refreshDue();
  assert.equal(idle.due, 0);
  assert.equal(calls, 1);

  nowMs += interval;
  const refreshed = await provider.refreshDue();
  assert.equal(refreshed.due, 1);
  assert.equal(refreshed.changed, true);
  assert.equal(calls, 2);
  assert.ok(provider.getRevision() > initialRevision);
});

test("Binance refresh retries a failed current series before the next candle closes", async () => {
  const nowMs = 1_750_000_000_000;
  let calls = 0;
  let failing = true;
  const interval = 900_000;
  const aligned = Math.floor(nowMs / interval) * interval;
  const payload = Array.from({ length: 62 }, (_, index) => {
    const openTime = aligned - (62 - index) * interval;
    const price = 100 + index;
    return [openTime, String(price), String(price + 2), String(price - 2), String(price + 1), "1000", openTime + interval - 1];
  });
  const fallback = new FixtureMarketDataProvider({ now: () => nowMs });
  const provider = new BinanceRestMarketDataProvider({
    now: () => nowMs,
    fallback,
    fetcher: async () => {
      calls += 1;
      return failing ? { ok: false, status: 503, json: async () => [] } : { ok: true, json: async () => payload };
    },
  });
  const meta = { symbol: "BTCUSDT", market: "CRYPTO", base: 100, drift: 0, vol: 0.01 };
  provider.symbols = [meta];
  provider.timeframes = ["M15"];

  await provider.fetchRows(meta, "M15", 60);
  failing = false;
  const refreshed = await provider.refreshDue();
  assert.equal(calls, 2);
  assert.equal(refreshed.due, 1);
  assert.equal(provider.isExecutable(meta, "M15"), true);
});

test("Binance provider reports degraded health when live refresh falls back", async () => {
  const nowMs = 1_750_000_000_000;
  const fallback = new FixtureMarketDataProvider({ now: () => nowMs });
  const provider = new BinanceRestMarketDataProvider({
    now: () => nowMs,
    fallback,
    fetcher: async () => ({ ok: false, status: 503, json: async () => [] }),
  });
  const meta = { symbol: "BTCUSDT", market: "CRYPTO", base: 100, drift: 0, vol: 0.01 };
  await provider.fetchRows(meta, "H4", 60);
  assert.equal(provider.status().quality.status, "degraded");
  assert.equal(provider.status().errors, 1);
  assert.equal(provider.sourceFor(meta, "H4"), "deterministic-fixture-v1");
});

test("hybrid provider creation returns while bootstrap continues in the background", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const created = await createMarketDataProvider({
    mode: "hybrid",
    symbols: [{ symbol: "BTCUSDT", market: "CRYPTO", base: 100, drift: 0, vol: 0.01 }],
    providerOptions: {
      fetcher: async () => {
        await gate;
        return { ok: false, status: 503, json: async () => [] };
      },
    },
  });
  assert.equal(created.bootstrap.status, "warming");
  assert.equal(created.bootstrap.total, 2);
  release();
  await created.ready;
  assert.equal(created.bootstrap.status, "degraded");
  assert.equal(created.bootstrap.fallbackSeries, 2);
  assert.equal(created.provider.crypto.fallback, null);
  assert.equal(created.provider.equities.providers.find((provider) => provider.id === "ssi-fastconnect-fcdata-v2").fallback, null);
});

test("hybrid scanner omits unavailable VN feeds instead of emitting synthetic scores", () => {
  const now = () => 1_750_000_000_000;
  const fixture = new FixtureMarketDataProvider({ now });
  const provider = {
    id: "live-only-test",
    getRows(meta, timeframe, count, asOf) {
      if (meta.market !== "CRYPTO") throw new Error("provider_cache_miss");
      return fixture.getRows(meta, timeframe, count, asOf);
    },
    status: () => ({ id: "live-only-test", quality: { status: "degraded", score: 80, checkedFeeds: 1 } }),
    sourceFor: () => "live-only-test",
    isExecutable: (meta) => meta.market === "CRYPTO",
    getRevision: () => 1,
  };
  const scanner = new SnapshotStore({ now, provider }).getScanner(3);
  assert.equal(scanner.items.every((item) => item.market === "CRYPTO"), true);
  assert.equal(scanner.unavailable.length, scanner.universeTotal - scanner.total);
  assert.equal(scanner.total + scanner.unavailable.length, scanner.universeTotal);
});

test("Binance circuit breaker invalidates live state, bypasses failed cache, and recovers", async () => {
  let nowMs = 1_750_000_000_000;
  let failing = false;
  let calls = 0;
  const interval = 900_000;
  const payload = () => {
    const aligned = Math.floor(nowMs / interval) * interval;
    return Array.from({ length: 62 }, (_, index) => {
      const openTime = aligned - (62 - index) * interval;
      const price = 100 + index;
      return [openTime, String(price), String(price + 2), String(price - 2), String(price + 1), "1000", openTime + interval - 1];
    });
  };
  const fallback = new FixtureMarketDataProvider({ now: () => nowMs });
  const provider = new BinanceRestMarketDataProvider({
    now: () => nowMs,
    fallback,
    failureThreshold: 2,
    circuitCooldownMs: 60_000,
    fetcher: async () => {
      calls += 1;
      return failing ? { ok: false, status: 503, json: async () => [] } : { ok: true, json: async () => payload() };
    },
  });
  const meta = { symbol: "BTCUSDT", market: "CRYPTO", base: 100, drift: 0, vol: 0.01 };
  await provider.fetchRows(meta, "M15", 60);
  const liveRevision = provider.getRevision();
  failing = true;
  await provider.fetchRows(meta, "M15", 60);
  await provider.fetchRows(meta, "M15", 60);
  assert.equal(provider.isExecutable(meta, "M15"), false);
  assert.equal(provider.sourceFor(meta, "M15"), "deterministic-fixture-v1");
  assert.equal(provider.status().openCircuits, 1);
  assert.ok(provider.getRevision() > liveRevision);

  const callsBeforeOpenCircuitRead = calls;
  await provider.fetchRows(meta, "M15", 60);
  assert.equal(calls, callsBeforeOpenCircuitRead);

  nowMs += 60_001;
  failing = false;
  await provider.fetchRows(meta, "M15", 60);
  assert.equal(provider.isExecutable(meta, "M15"), true);
  assert.equal(provider.sourceFor(meta, "M15"), "binance-rest-v3");
  assert.equal(provider.status().openCircuits, 0);
});

test("snapshot caps crypto execution when the provider is on fallback", () => {
  const now = () => 1_750_000_000_000;
  const fixture = new FixtureMarketDataProvider({ now });
  const provider = {
    id: "hybrid-test",
    getRows: fixture.getRows.bind(fixture),
    status: () => fixture.status(),
    sourceFor: (meta) => meta.market === "CRYPTO" ? fixture.id : "hybrid-test",
    isExecutable: (meta) => meta.market !== "CRYPTO",
    getRevision: () => 1,
  };
  const workspace = new SnapshotStore({ now, provider }).getWorkspace("BTCUSDT", "H4", 3);
  assert.ok(workspace.chart.score.total <= 79);
  assert.equal(workspace.chart.score.executability.gates.marketData, false);
  assert.equal(workspace.chart.sync.executionBlocked, true);
});

test("chart can display available D1 rows while missing H4 keeps trade execution blocked", () => {
  const now = () => 1_750_000_000_000;
  const provider = {
    id: "partial-real-provider",
    getRows(meta, timeframe, count, asOfSeconds) {
      if (meta.symbol === "FPT" && timeframe === "H4") throw new Error("equity_market_data_unavailable:FPT:H4");
      return generateOhlcv(meta, timeframe, count, asOfSeconds);
    },
    status: () => ({ id: "partial-real-provider", quality: { status: "degraded", score: 70, checkedFeeds: 3, blocked: 1, issues: [] } }),
    sourceFor: () => "partial-real-provider",
    isExecutable: (meta) => meta.symbol !== "FPT",
    getRevision: () => 1,
  };
  const workspace = new SnapshotStore({ now, provider }).getWorkspace("FPT", "D1", 3);
  assert.ok(workspace.chart.rows.length > 0);
  assert.equal(workspace.chart.mtf.find((item) => item.timeframe === "H4").available, false);
  assert.equal(workspace.chart.score.executability.gates.mtf, false);
  assert.equal(workspace.chart.score.executability.gates.marketData, false);
  assert.equal(workspace.chart.sync.executionBlocked, true);
  assert.equal(workspace.selectedScanner, null);
});

test("fixture-only snapshots are research data and never executable", () => {
  const now = () => 1_750_000_000_000;
  const workspace = new SnapshotStore({ now, provider: new FixtureMarketDataProvider({ now }) }).getWorkspace("FPT", "H4", 3);
  assert.equal(workspace.chart.score.executability.gates.marketData, false);
  assert.equal(workspace.chart.sync.executionBlocked, true);
  assert.equal(workspace.chart.sync.source, "deterministic-fixture-v1");
});
