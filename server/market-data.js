import { analysisRowCount, generateOhlcv } from "./engine.js";

const timeframeSeconds = { D1: 86400, H4: 14400, H1: 3600, M15: 900 };

function latestClosedOpenTime(timeframe, nowSeconds) {
  const interval = timeframeSeconds[timeframe] ?? timeframeSeconds.H4;
  return Math.floor(nowSeconds / interval) * interval - interval;
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function sanitizeProviderError(error, secrets = []) {
  let message = String(error?.message ?? "provider_error").slice(0, 500);
  for (const secret of secrets.filter((value) => typeof value === "string" && value.length >= 4)) {
    message = message.replaceAll(secret, "[REDACTED]");
  }
  return message.replace(/(consumerSecret|accessToken|authorization)\s*[:=]\s*[^\s,}]+/gi, "$1=[REDACTED]");
}

function vietnamTradingGap(previousTime, nextTime, timeframe) {
  if (timeframe === "D1") return true;
  const offset = 7 * 3600;
  const previousDay = Math.floor((previousTime + offset) / 86400);
  const nextDay = Math.floor((nextTime + offset) / 86400);
  if (nextDay > previousDay) return true;
  const previousMinute = Math.floor(((previousTime + offset) % 86400) / 60);
  const nextMinute = Math.floor(((nextTime + offset) % 86400) / 60);
  return previousMinute < 720 && nextMinute >= 780;
}

function isVietnamEquity(meta) {
  return ["VN30", "MIDCAP", "VN"].includes(meta?.market);
}

function isVietnamIndex(meta) {
  return meta?.market === "VN_INDEX";
}

function isVietnamInstrument(meta) {
  return isVietnamEquity(meta) || isVietnamIndex(meta);
}

function staleThresholdSeconds(market, timeframe, interval) {
  if (market === "CRYPTO") return interval * 1.25;
  return timeframe === "D1" ? 4 * 86400 : 4 * 86400;
}

export class DataQualityMonitor {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.feeds = new Map();
  }

  inspect(symbol, timeframe, rows, { market = "CRYPTO" } = {}) {
    const key = `${symbol}:${timeframe}`;
    const interval = timeframeSeconds[timeframe] ?? timeframeSeconds.H4;
    const faults = { invalid: 0, duplicate: 0, gap: 0, outOfOrder: 0 };
    let previousTime = null;

    for (const row of rows) {
      const validNumbers = [row.time, row.open, row.high, row.low, row.close, row.volume].every(finite);
      const validOhlc = validNumbers && row.high >= Math.max(row.open, row.close) && row.low <= Math.min(row.open, row.close) && row.low >= 0 && row.volume >= 0;
      if (!validOhlc) faults.invalid += 1;
      if (previousTime != null) {
        const delta = row.time - previousTime;
        if (delta === 0) faults.duplicate += 1;
        else if (delta < 0) faults.outOfOrder += 1;
        else if (delta !== interval && !(isVietnamInstrument({ market }) && vietnamTradingGap(previousTime, row.time, timeframe))) {
          faults.gap += Math.max(1, Math.round(delta / interval) - 1);
        }
      }
      previousTime = row.time;
    }

    const lagSeconds = previousTime == null ? null : Math.max(0, Math.floor(this.now() / 1000) - (previousTime + interval));
    const stale = lagSeconds == null || lagSeconds > staleThresholdSeconds(market, timeframe, interval);
    const faultCount = Object.values(faults).reduce((sum, value) => sum + value, 0) + Number(stale);
    const score = Math.max(0, 100 - faults.invalid * 25 - faults.duplicate * 15 - faults.outOfOrder * 20 - faults.gap * 8 - Number(stale) * 30);
    const result = {
      symbol,
      timeframe,
      market,
      status: score >= 98 ? "healthy" : score >= 80 ? "degraded" : "blocked",
      score,
      rows: rows.length,
      firstBarTime: rows[0]?.time ?? null,
      lastBarTime: rows.at(-1)?.time ?? null,
      observedAt: new Date(this.now()).toISOString(),
      faults,
      stale,
      lagSeconds,
      faultCount,
    };
    this.feeds.set(key, result);
    return result;
  }

  summary() {
    const feeds = [...this.feeds.values()];
    const blocked = feeds.filter((feed) => feed.status === "blocked").length;
    const degraded = feeds.filter((feed) => feed.status === "degraded").length;
    const totalFaults = feeds.reduce((sum, feed) => sum + feed.faultCount, 0);
    const score = feeds.length ? Math.round(feeds.reduce((sum, feed) => sum + feed.score, 0) / feeds.length) : 0;
    return {
      status: !feeds.length ? "unknown" : blocked / feeds.length > 0.2 ? "blocked" : blocked || degraded ? "degraded" : "healthy",
      score,
      checkedFeeds: feeds.length,
      blocked,
      degraded,
      totalFaults,
      issues: feeds.filter((feed) => feed.faultCount > 0).map((feed) => ({
        symbol: feed.symbol,
        timeframe: feed.timeframe,
        status: feed.status,
        score: feed.score,
        faults: feed.faults,
        stale: feed.stale,
        lagSeconds: feed.lagSeconds,
      })).slice(0, 20),
      lastObservedAt: feeds.reduce((latest, feed) => feed.observedAt > latest ? feed.observedAt : latest, ""),
    };
  }
}

export class FixtureMarketDataProvider {
  constructor({ now = () => Date.now(), monitor = new DataQualityMonitor({ now }) } = {}) {
    this.id = "deterministic-fixture-v1";
    this.now = now;
    this.monitor = monitor;
  }

  getRows(meta, timeframe, count, asOfSeconds) {
    const rows = generateOhlcv(meta, timeframe, count, asOfSeconds);
    const quality = this.monitor.inspect(meta.symbol, timeframe, rows, { market: meta.market });
    if (quality.status === "blocked") throw new Error(`market_data_blocked:${meta.symbol}:${timeframe}`);
    return rows;
  }

  async ensureRows() {
    return false;
  }

  sourceFor() {
    return this.id;
  }

  isExecutable() {
    return false;
  }

  getRevision() {
    return 0;
  }

  async getQuotes() {
    return {
      items: [],
      indices: [],
      source: this.id,
      status: "unavailable",
      observedAt: new Date(this.now()).toISOString(),
    };
  }

  seriesStatus(meta, timeframe) {
    return {
      symbol: meta.symbol,
      market: meta.market,
      timeframe,
      provider: this.id,
      source: this.id,
      live: false,
      executable: false,
      state: "fixture",
      lastBarTime: null,
      error: null,
    };
  }

  seriesStatuses(symbols, timeframes = ["D1", "H4"]) {
    return symbols.flatMap((meta) => timeframes.map((timeframe) => this.seriesStatus(meta, timeframe)));
  }

  status() {
    return {
      id: this.id,
      mode: "fixture",
      connected: true,
      quality: this.monitor.summary(),
      checkedAt: new Date(this.now()).toISOString(),
    };
  }
}

const binanceIntervals = { D1: "1d", H4: "4h", H1: "1h", M15: "15m" };

export function normalizeBinanceKlines(payload, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!Array.isArray(payload)) throw new Error("binance_invalid_payload");
  return payload
    .filter((item) => Array.isArray(item) && Number(item[6]) / 1000 <= nowSeconds)
    .map((item) => ({
      time: Math.floor(Number(item[0]) / 1000),
      open: Number(item[1]),
      high: Number(item[2]),
      low: Number(item[3]),
      close: Number(item[4]),
      volume: Number(item[5]),
    }));
}

export function normalizeBinanceTickers(payload) {
  const items = Array.isArray(payload) ? payload : [payload];
  return items.map((item) => ({
    symbol: String(item?.symbol ?? "").toUpperCase(),
    price: Number(item?.lastPrice),
    change: Number(item?.priceChangePercent),
    absoluteChange: Number(item?.priceChange),
    quotedAt: Number.isFinite(Number(item?.closeTime)) ? new Date(Number(item.closeTime)).toISOString() : null,
    source: "binance-rest-v3-ticker",
    live: true,
  })).filter((item) => item.symbol && finite(item.price) && item.price > 0 && finite(item.change));
}

export class BinanceRestMarketDataProvider {
  constructor({
    now = () => Date.now(),
    fetcher = fetch,
    baseUrl = process.env.BINANCE_REST_URL ?? "https://api.binance.com",
    monitor = new DataQualityMonitor({ now }),
    fallback = null,
    failureThreshold = 3,
    circuitCooldownMs = 5 * 60_000,
    freshnessGraceMs = 90_000,
  } = {}) {
    this.id = "binance-rest-v3";
    this.now = now;
    this.fetcher = fetcher;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.monitor = monitor;
    this.fallback = fallback;
    this.failureThreshold = failureThreshold;
    this.circuitCooldownMs = circuitCooldownMs;
    this.freshnessGraceMs = freshnessGraceMs;
    this.cache = new Map();
    this.cacheMeta = new Map();
    this.errors = new Map();
    this.initializedAt = null;
    this.revision = 0;
    this.symbols = [];
    this.timeframes = ["D1", "H4"];
    this.refreshTimer = null;
    this.refreshing = false;
    this.lastRefresh = null;
    this.quoteCache = new Map();
    this.quoteFetchedAt = 0;
    this.quoteTtlMs = Number(process.env.QUOTE_REFRESH_MS ?? 5000);
    this.fetchQueues = new Map();
  }

  key(symbol, timeframe) {
    return `${symbol}:${timeframe}`;
  }

  circuitOpen(key) {
    const error = this.errors.get(key);
    return Boolean(error?.circuitOpenUntil && error.circuitOpenUntil > this.now());
  }

  cacheFresh(key, timeframe) {
    const rows = this.cache.get(key);
    if (!rows?.length) return false;
    const nowSeconds = Math.floor(this.now() / 1000);
    const expectedOpen = latestClosedOpenTime(timeframe, nowSeconds);
    if (rows.at(-1).time >= expectedOpen) return true;
    const latestExpectedCloseMs = (expectedOpen + timeframeSeconds[timeframe]) * 1000;
    return this.now() - latestExpectedCloseMs <= this.freshnessGraceMs;
  }

  recordFailure(key, error) {
    const previous = this.errors.get(key);
    const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
    const circuitOpenUntil = consecutiveFailures >= this.failureThreshold
      ? this.now() + this.circuitCooldownMs
      : null;
    this.errors.set(key, {
      message: sanitizeProviderError(error),
      at: new Date(this.now()).toISOString(),
      consecutiveFailures,
      circuitOpenUntil,
    });
    // Feed-state changes are part of the snapshot contract even if the last candle is unchanged.
    this.revision += 1;
  }

  isExecutable(meta, timeframe) {
    if (meta.market !== "CRYPTO") return true;
    const key = this.key(meta.symbol, timeframe);
    return !this.errors.has(key) && this.cacheFresh(key, timeframe);
  }

  async fetchRows(meta, timeframe, count = analysisRowCount(meta, timeframe)) {
    const key = this.key(meta.symbol, timeframe);
    const previous = this.fetchQueues.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => {
      if (this.cache.get(key)?.length > count && this.cacheFresh(key, timeframe) && !this.errors.has(key)) return this.cache.get(key).slice(-count);
      return this.fetchRowsUncoordinated(meta, timeframe, count);
    });
    this.fetchQueues.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.fetchQueues.get(key) === operation) this.fetchQueues.delete(key);
    }
  }

  async fetchRowsUncoordinated(meta, timeframe, count = analysisRowCount(meta, timeframe)) {
    if (meta.market !== "CRYPTO") {
      if (this.fallback) return this.fallback.getRows(meta, timeframe, count, Math.floor(this.now() / 1000));
      throw new Error(`provider_unsupported_market:${meta.market}`);
    }
    const interval = binanceIntervals[timeframe];
    if (!interval) throw new Error(`provider_unsupported_timeframe:${timeframe}`);
    const key = this.key(meta.symbol, timeframe);
    if (this.circuitOpen(key)) {
      if (this.fallback) return this.fallback.getRows(meta, timeframe, count, Math.floor(this.now() / 1000));
      throw new Error(`market_data_circuit_open:${key}`);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      let endTime = null;
      let rows = [];
      const pages = Math.ceil((count + 2) / 1000) + 1;
      for (let page = 0; page < pages && rows.length < count; page += 1) {
        const url = new URL("/api/v3/klines", this.baseUrl);
        url.searchParams.set("symbol", meta.symbol);
        url.searchParams.set("interval", interval);
        const requestedLimit = Math.min(1000, count + 2 - rows.length);
        url.searchParams.set("limit", String(requestedLimit));
        if (endTime != null) url.searchParams.set("endTime", String(endTime));
        const response = await this.fetcher(url, { signal: controller.signal, headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error(`binance_http_${response.status}`);
        const payload = await response.json();
        const pageRows = normalizeBinanceKlines(payload, Math.floor(this.now() / 1000));
        if (!pageRows.length) break;
        rows = [...new Map([...pageRows, ...rows].map((row) => [row.time, row])).values()].sort((a, b) => a.time - b.time);
        endTime = pageRows[0].time * 1000 - 1;
        if (!Array.isArray(payload) || payload.length < requestedLimit) break;
      }
      rows = rows.slice(-count);
      if (rows.length < Math.min(50, count)) throw new Error(`binance_insufficient_rows:${rows.length}`);
      const existing = this.cache.get(key) ?? [];
      const retainedCount = Math.max(count, existing.length);
      rows = [...new Map([...existing, ...rows].map((row) => [row.time, row])).values()]
        .sort((a, b) => a.time - b.time)
        .slice(-retainedCount);
      const quality = this.monitor.inspect(meta.symbol, timeframe, rows, { market: meta.market });
      if (quality.status === "blocked") throw new Error(`market_data_blocked:${meta.symbol}:${timeframe}`);
      const previous = existing;
      const previousLast = previous?.at(-1);
      const nextLast = rows.at(-1);
      const recovered = this.errors.has(key);
      const changed = !previousLast || previousLast.time !== nextLast.time || previousLast.close !== nextLast.close || previousLast.volume !== nextLast.volume;
      if (changed || recovered) this.revision += 1;
      this.cache.set(key, rows);
      this.cacheMeta.set(key, { fetchedAt: new Date(this.now()).toISOString(), lastBarTime: nextLast.time });
      this.errors.delete(key);
      return rows;
    } catch (error) {
      this.recordFailure(key, error);
      if (this.fallback) return this.fallback.getRows(meta, timeframe, count, Math.floor(this.now() / 1000));
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async ensureRows(meta, timeframe, count) {
    if (meta.market !== "CRYPTO") return false;
    const key = this.key(meta.symbol, timeframe);
    if (this.cache.get(key)?.length >= count && this.cacheFresh(key, timeframe) && !this.errors.has(key)) return false;
    await this.fetchRows(meta, timeframe, count);
    return true;
  }

  async getQuotes(symbols = this.symbols) {
    const requested = symbols
      .filter((meta) => meta.market === "CRYPTO")
      .map((meta) => meta.symbol);
    const cacheFresh = this.quoteCache.size && this.now() - this.quoteFetchedAt < this.quoteTtlMs;
    if (!cacheFresh && requested.length) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const url = new URL("/api/v3/ticker/24hr", this.baseUrl);
        url.searchParams.set("symbols", JSON.stringify(requested));
        const response = await this.fetcher(url, { signal: controller.signal, headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error(`binance_quote_http_${response.status}`);
        const quotes = normalizeBinanceTickers(await response.json());
        if (!quotes.length) throw new Error("binance_quote_empty");
        for (const quote of quotes) this.quoteCache.set(quote.symbol, quote);
        this.quoteFetchedAt = this.now();
      } finally {
        clearTimeout(timeout);
      }
    }
    const items = requested.map((symbol) => this.quoteCache.get(symbol)).filter(Boolean);
    return {
      items,
      indices: [],
      source: this.id,
      status: items.length === requested.length ? "live" : items.length ? "degraded" : "unavailable",
      observedAt: new Date(this.now()).toISOString(),
    };
  }

  async initialize(symbols, timeframes = ["D1", "H4"]) {
    this.symbols = symbols.filter((meta) => meta.market === "CRYPTO");
    this.timeframes = [...timeframes];
    const jobs = [];
    for (const meta of this.symbols) {
      for (const timeframe of timeframes) jobs.push(() => this.fetchRows(meta, timeframe, analysisRowCount(meta, timeframe)));
    }
    const settled = [];
    for (let cursor = 0; cursor < jobs.length; cursor += 4) {
      settled.push(...await Promise.allSettled(jobs.slice(cursor, cursor + 4).map((job) => job())));
    }
    this.initializedAt = new Date(this.now()).toISOString();
    return {
      total: settled.length,
      fulfilled: settled.filter((item) => item.status === "fulfilled").length,
      rejected: settled.filter((item) => item.status === "rejected").length,
      liveSeries: this.cache.size,
      fallbackSeries: this.errors.size,
    };
  }

  async refreshDue() {
    if (this.refreshing) return { status: "busy", refreshed: 0, due: 0 };
    this.refreshing = true;
    const startedAt = new Date(this.now()).toISOString();
    try {
      const nowSeconds = Math.floor(this.now() / 1000);
      const jobs = [];
      for (const meta of this.symbols) {
        for (const timeframe of this.timeframes) {
          const key = this.key(meta.symbol, timeframe);
          if (this.circuitOpen(key)) continue;
          const rows = this.cache.get(key);
          if (this.errors.has(key) || !rows?.length || rows.at(-1).time < latestClosedOpenTime(timeframe, nowSeconds)) {
            jobs.push(() => this.fetchRows(meta, timeframe, analysisRowCount(meta, timeframe)));
          }
        }
      }
      const beforeRevision = this.revision;
      const settled = [];
      for (let cursor = 0; cursor < jobs.length; cursor += 4) {
        settled.push(...await Promise.allSettled(jobs.slice(cursor, cursor + 4).map((job) => job())));
      }
      this.lastRefresh = {
        status: settled.some((item) => item.status === "rejected") || this.errors.size ? "degraded" : "ok",
        startedAt,
        completedAt: new Date(this.now()).toISOString(),
        due: jobs.length,
        refreshed: settled.filter((item) => item.status === "fulfilled").length,
        rejected: settled.filter((item) => item.status === "rejected").length,
        changed: this.revision !== beforeRevision,
      };
      return this.lastRefresh;
    } finally {
      this.refreshing = false;
    }
  }

  startAutoRefresh({ intervalMs = 60_000, onUpdate } = {}) {
    if (this.refreshTimer) return this.refreshTimer;
    this.refreshTimer = setInterval(async () => {
      const result = await this.refreshDue();
      if (result.changed) onUpdate?.(result);
    }, intervalMs);
    this.refreshTimer.unref?.();
    return this.refreshTimer;
  }

  stopAutoRefresh() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  getRows(meta, timeframe, count, asOfSeconds) {
    if (meta.market !== "CRYPTO" && this.fallback) return this.fallback.getRows(meta, timeframe, count, asOfSeconds);
    const key = this.key(meta.symbol, timeframe);
    if (this.errors.has(key) && this.fallback) return this.fallback.getRows(meta, timeframe, count, asOfSeconds);
    const rows = this.cache.get(key);
    if (rows?.length >= count) {
      const quality = this.monitor.inspect(meta.symbol, timeframe, rows, { market: meta.market });
      if (quality.status !== "blocked" && this.cacheFresh(key, timeframe)) return rows.slice(-count);
      this.recordFailure(key, new Error(quality.status === "blocked" ? `market_data_blocked:${meta.symbol}:${timeframe}` : `market_data_stale:${meta.symbol}:${timeframe}`));
    }
    if (this.fallback) return this.fallback.getRows(meta, timeframe, count, asOfSeconds);
    throw new Error(`provider_cache_miss:${meta.symbol}:${timeframe}`);
  }

  sourceFor(meta, timeframe) {
    return meta.market === "CRYPTO" && this.isExecutable(meta, timeframe)
      ? this.id
      : this.fallback?.id ?? this.id;
  }

  seriesStatus(meta, timeframe) {
    const key = this.key(meta.symbol, timeframe);
    const rows = this.cache.get(key);
    const error = this.errors.get(key);
    const live = this.isExecutable(meta, timeframe);
    return {
      symbol: meta.symbol,
      market: meta.market,
      timeframe,
      provider: this.id,
      source: this.sourceFor(meta, timeframe),
      live,
      executable: live,
      state: this.circuitOpen(key) ? "circuit-open" : live ? "live" : error ? "fallback" : "warming",
      cachedRows: rows?.length ?? 0,
      lastBarTime: rows?.at(-1)?.time ?? null,
      lastBarAt: rows?.length ? new Date(rows.at(-1).time * 1000).toISOString() : null,
      error: error ? { message: error.message, at: error.at, consecutiveFailures: error.consecutiveFailures } : null,
    };
  }

  getRevision() {
    return this.revision;
  }

  status() {
    const monitored = this.monitor.summary();
    const errorIssues = [...this.errors.entries()].map(([series, error]) => ({
      series,
      status: this.circuitOpen(series) ? "circuit-open" : "fallback",
      message: sanitizeProviderError(error, [this.consumerSecret, this.token]),
      at: error.at,
      consecutiveFailures: error.consecutiveFailures,
      circuitOpenUntil: error.circuitOpenUntil ? new Date(error.circuitOpenUntil).toISOString() : null,
    }));
    const quality = {
      ...monitored,
      status: this.errors.size && monitored.status !== "blocked" ? "degraded" : monitored.status,
      score: monitored.status === "unknown" && this.errors.size ? 70 : Math.max(0, monitored.score - Math.min(20, this.errors.size * 3)),
      issues: [...monitored.issues, ...errorIssues].slice(0, 20),
    };
    return {
      id: this.id,
      mode: this.fallback ? "hybrid" : "live",
      connected: this.cache.size > 0,
      baseUrl: this.baseUrl,
      cachedSeries: this.cache.size,
      executableSeries: [...this.cache.keys()].filter((key) => {
        const [symbol, timeframe] = key.split(":");
        return !this.errors.has(key) && this.cacheFresh(key, timeframe) && symbol;
      }).length,
      errors: this.errors.size,
      openCircuits: [...this.errors.keys()].filter((key) => this.circuitOpen(key)).length,
      revision: this.revision,
      initializedAt: this.initializedAt,
      lastRefresh: this.lastRefresh,
      quality,
      checkedAt: new Date(this.now()).toISOString(),
    };
  }
}

const SSI_ENDPOINTS = {
  token: "/api/v2/Market/AccessToken",
  daily: "/api/v2/Market/DailyOhlc",
  intraday: "/api/v2/Market/IntradayOhlc",
  dailyIndex: "/api/v2/Market/DailyIndex",
};

function pickValue(row, names) {
  for (const name of names) {
    if (row?.[name] != null && row[name] !== "") return row[name];
  }
  return null;
}

function optionalNumber(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  return finite(numeric) ? numeric : null;
}

function parseSsiTimestamp(row, daily = false) {
  const timestamp = pickValue(row, ["Timestamp", "timestamp", "Epoch", "epoch"]);
  if (timestamp != null && Number.isFinite(Number(timestamp))) {
    const numeric = Number(timestamp);
    return Math.floor(numeric > 10_000_000_000 ? numeric / 1000 : numeric);
  }
  const dateValue = String(pickValue(row, ["TradingDate", "tradingDate", "Date", "date", "TradingDay", "tradingDay"]) ?? "").trim();
  const timeValue = String(pickValue(row, ["Time", "time", "TradingTime", "tradingTime"]) ?? "").trim();
  if (!dateValue && timeValue && !Number.isNaN(Date.parse(timeValue))) return Math.floor(Date.parse(timeValue) / 1000);

  const dateMatch = dateValue.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/) ?? dateValue.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  let isoDate;
  if (dateMatch?.[1]?.length === 4) isoDate = `${dateMatch[1]}-${dateMatch[2].padStart(2, "0")}-${dateMatch[3].padStart(2, "0")}`;
  else if (dateMatch) isoDate = `${dateMatch[3]}-${dateMatch[2].padStart(2, "0")}-${dateMatch[1].padStart(2, "0")}`;
  else if (!Number.isNaN(Date.parse(dateValue))) isoDate = new Date(dateValue).toISOString().slice(0, 10);
  if (!isoDate) return null;

  const normalizedTime = daily ? "00:00:00" : (timeValue.match(/^\d{1,2}:\d{2}(:\d{2})?/)?.[0] ?? "00:00:00");
  const fullTime = normalizedTime.length === 5 ? `${normalizedTime}:00` : normalizedTime;
  const parsed = Date.parse(`${isoDate}T${fullTime}+07:00`);
  return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
}

function ssiItems(payload) {
  const data = payload?.data ?? payload?.Data ?? payload;
  if (Array.isArray(data)) return data;
  for (const key of ["items", "Items", "data", "Data", "records", "Records"]) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  return [];
}

export function normalizeSsiOhlcv(payload, { daily = false, priceScale = 1 } = {}) {
  const rows = ssiItems(payload).map((item) => ({
    time: parseSsiTimestamp(item, daily),
    open: Number(pickValue(item, ["Open", "open", "OpenPrice", "openPrice"])) / priceScale,
    high: Number(pickValue(item, ["High", "high", "Highest", "highest", "HighPrice", "highPrice"])) / priceScale,
    low: Number(pickValue(item, ["Low", "low", "Lowest", "lowest", "LowPrice", "lowPrice"])) / priceScale,
    close: Number(pickValue(item, ["Close", "close", "ClosePrice", "closePrice", "MatchPrice", "matchPrice"])) / priceScale,
    volume: Number(pickValue(item, ["Volume", "volume", "TotalVolume", "totalVolume", "MatchVolume", "matchVolume"]) ?? 0),
  })).filter((row) => row.time != null && [row.open, row.high, row.low, row.close, row.volume].every(finite));

  return [...new Map(rows.sort((a, b) => a.time - b.time).map((row) => [row.time, row])).values()];
}

export function normalizeSsiIndex(payload, requestedIndex) {
  const rows = ssiItems(payload).map((item) => {
    const symbol = String(requestedIndex ?? pickValue(item, ["IndexId", "indexId", "IndexCode", "indexCode", "Code", "code"]) ?? "").toUpperCase();
    const price = optionalNumber(pickValue(item, ["IndexValue", "indexValue", "CloseIndex", "closeIndex", "Close", "close", "Value", "value"]));
    const absoluteChange = optionalNumber(pickValue(item, ["Change", "change", "IndexChange", "indexChange", "ChangeValue", "changeValue"]));
    let change = optionalNumber(pickValue(item, ["PercentChange", "percentChange", "ChangePercent", "changePercent", "Percent", "percent"]));
    const reference = optionalNumber(pickValue(item, ["ReferenceIndex", "referenceIndex", "Reference", "reference", "PriorIndexValue", "priorIndexValue"]));
    if (!finite(change) && finite(reference) && reference > 0) change = (price - reference) / reference * 100;
    const timestamp = parseSsiTimestamp(item, true);
    return {
      symbol,
      price,
      change,
      absoluteChange: absoluteChange ?? (finite(reference) ? price - reference : null),
      quotedAt: timestamp ? new Date(timestamp * 1000).toISOString() : null,
      source: "ssi-fastconnect-daily-index",
      live: false,
      cadence: "daily-close",
    };
  }).filter((item) => item.symbol && finite(item.price) && item.price > 0);
  return rows.sort((a, b) => String(a.quotedAt).localeCompare(String(b.quotedAt))).at(-1) ?? null;
}

export function aggregateOhlcv(rows, timeframe) {
  if (timeframe === "D1") return rows;
  const interval = timeframeSeconds[timeframe];
  if (!interval) throw new Error(`provider_unsupported_timeframe:${timeframe}`);
  const offset = 7 * 3600;
  const buckets = new Map();
  for (const row of rows) {
    const localDay = Math.floor((row.time + offset) / 86400);
    const time = timeframe === "H4"
      ? localDay * 86400 + 9 * 3600 - offset
      : Math.floor((row.time + offset) / interval) * interval - offset;
    const current = buckets.get(time);
    if (!current) buckets.set(time, { ...row, time });
    else {
      current.high = Math.max(current.high, row.high);
      current.low = Math.min(current.low, row.low);
      current.close = row.close;
      current.volume += row.volume;
    }
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time);
}

function ssiBarCloseTime(openTime, timeframe) {
  const offset = 7 * 3600;
  const localTime = openTime + offset;
  const localDay = Math.floor(localTime / 86400);
  const localSecond = ((localTime % 86400) + 86400) % 86400;
  if (timeframe === "D1" || timeframe === "H4") return localDay * 86400 + 15 * 3600 - offset;
  if (timeframe === "H1") {
    const localHour = Math.floor(localSecond / 3600);
    const closeSecond = localHour === 11 ? 11 * 3600 + 30 * 60 : (localHour + 1) * 3600;
    return localDay * 86400 + closeSecond - offset;
  }
  return openTime + (timeframeSeconds[timeframe] ?? timeframeSeconds.M15);
}

export function filterClosedSsiRows(rows, timeframe, nowSeconds = Math.floor(Date.now() / 1000)) {
  return rows.filter((row) => ssiBarCloseTime(row.time, timeframe) <= nowSeconds);
}

function formatSsiDate(timestampMs) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", year: "numeric" }).formatToParts(new Date(timestampMs));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.day}/${values.month}/${values.year}`;
}

export class SsiFastConnectMarketDataProvider {
  constructor({
    now = () => Date.now(),
    fetcher = fetch,
    baseUrl = process.env.SSI_FCDATA_URL ?? "https://fc-data.ssi.com.vn",
    consumerId = process.env.SSI_CONSUMER_ID ?? "",
    consumerSecret = process.env.SSI_CONSUMER_SECRET ?? "",
    priceScale = Number(process.env.SSI_PRICE_SCALE ?? 1),
    pageSize = Number(process.env.SSI_PAGE_SIZE ?? 1000),
    maxPages = Number(process.env.SSI_MAX_PAGES ?? 32),
    failureThreshold = 3,
    circuitCooldownMs = 5 * 60_000,
    monitor = new DataQualityMonitor({ now }),
    fallback = null,
  } = {}) {
    this.id = "ssi-fastconnect-fcdata-v2";
    this.now = now;
    this.fetcher = fetcher;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.consumerId = consumerId;
    this.consumerSecret = consumerSecret;
    this.priceScale = priceScale > 0 ? priceScale : 1;
    this.pageSize = Math.max(100, pageSize);
    this.maxPages = Math.max(1, maxPages);
    this.failureThreshold = Math.max(1, failureThreshold);
    this.circuitCooldownMs = Math.max(30_000, circuitCooldownMs);
    this.monitor = monitor;
    this.fallback = fallback;
    this.cache = new Map();
    this.errors = new Map();
    this.token = null;
    this.tokenExpiresAt = 0;
    this.tokenPromise = null;
    this.revision = 0;
    this.symbols = [];
    this.timeframes = ["D1", "H4"];
    this.initializedAt = null;
    this.lastRefresh = null;
    this.refreshTimer = null;
    this.refreshing = false;
    this.indexCache = new Map();
    this.indexFetchedAt = 0;
  }

  key(symbol, timeframe) {
    return `${symbol}:${timeframe}`;
  }

  configured() {
    return Boolean(this.consumerId && this.consumerSecret);
  }

  async accessToken() {
    if (this.token && this.tokenExpiresAt > this.now() + 5 * 60_000) return this.token;
    if (this.tokenPromise) return this.tokenPromise;
    this.tokenPromise = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await this.fetcher(`${this.baseUrl}${SSI_ENDPOINTS.token}`, {
          method: "POST",
          signal: controller.signal,
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ consumerID: this.consumerId, consumerSecret: this.consumerSecret }),
        });
        if (!response.ok) throw new Error(`ssi_token_http_${response.status}`);
        const payload = await response.json();
        const token = payload?.data?.accessToken ?? payload?.Data?.AccessToken;
        if (Number(payload?.status ?? payload?.Status ?? 200) !== 200 || !token) throw new Error(`ssi_token_rejected:${payload?.message ?? "unknown"}`);
        this.token = token;
        this.tokenExpiresAt = this.now() + 7.75 * 3600_000;
        return token;
      } finally {
        clearTimeout(timeout);
        this.tokenPromise = null;
      }
    })();
    return this.tokenPromise;
  }

  async request(endpoint, params) {
    const token = await this.accessToken();
    const url = new URL(endpoint, this.baseUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(`lookupRequest.${key}`, String(value));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await this.fetcher(url, { signal: controller.signal, headers: { Accept: "application/json", Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`ssi_http_${response.status}`);
      const payload = await response.json();
      const status = Number(payload?.status ?? payload?.Status ?? 200);
      if (status !== 200) throw new Error(`ssi_rejected:${payload?.message ?? payload?.Message ?? status}`);
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }

  recordFailure(meta, timeframe, error) {
    const key = this.key(meta.symbol, timeframe);
    const previous = this.errors.get(key);
    const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
    this.errors.set(key, {
      message: error.message,
      at: new Date(this.now()).toISOString(),
      consecutiveFailures,
      circuitOpenUntil: consecutiveFailures >= this.failureThreshold ? this.now() + this.circuitCooldownMs : 0,
    });
    this.revision += 1;
  }

  circuitOpen(meta, timeframe) {
    return (this.errors.get(this.key(meta.symbol, timeframe))?.circuitOpenUntil ?? 0) > this.now();
  }

  cacheSeries(meta, timeframe, rows, count) {
    const key = this.key(meta.symbol, timeframe);
    const existingRows = this.cache.get(key) ?? [];
    const retainedCount = Math.max(count, existingRows.length);
    const normalized = [...new Map([...existingRows, ...rows].map((row) => [row.time, row])).values()]
      .sort((a, b) => a.time - b.time)
      .slice(-retainedCount);
    if (normalized.length < count) throw new Error(`ssi_insufficient_rows:${meta.symbol}:${timeframe}:${normalized.length}/${count}`);
    const quality = this.monitor.inspect(meta.symbol, timeframe, normalized, { market: meta.market });
    if (quality.status === "blocked") throw new Error(`market_data_blocked:${meta.symbol}:${timeframe}`);
    const previous = this.cache.get(key)?.at(-1);
    const next = normalized.at(-1);
    if (!previous || previous.time !== next.time || previous.close !== next.close || previous.volume !== next.volume || this.errors.has(key)) this.revision += 1;
    this.cache.set(key, normalized);
    this.errors.delete(key);
    return normalized;
  }

  async fetchPaged(endpoint, meta, { fromDate, toDate, daily = false, stopWhen } = {}) {
    const collected = [];
    for (let pageIndex = 1; pageIndex <= this.maxPages; pageIndex += 1) {
      const payload = await this.request(endpoint, {
        symbol: meta.symbol,
        fromDate,
        toDate,
        pageIndex,
        pageSize: this.pageSize,
        ascending: false,
      });
      const items = ssiItems(payload);
      collected.push(...normalizeSsiOhlcv(payload, { daily, priceScale: this.priceScale }));
      if (items.length < this.pageSize || stopWhen?.(collected)) break;
    }
    return [...new Map(collected.sort((a, b) => a.time - b.time).map((row) => [row.time, row])).values()];
  }

  async warmSymbol(meta, timeframes = this.timeframes, countOverrides = {}) {
    const eligibleTimeframes = timeframes.filter((timeframe) => !this.circuitOpen(meta, timeframe));
    if (!eligibleTimeframes.length) return;
    const counts = Object.fromEntries(eligibleTimeframes.map((timeframe) => [timeframe, countOverrides[timeframe] ?? analysisRowCount(meta, timeframe)]));
    const toDate = formatSsiDate(this.now());
    const fromDate = formatSsiDate(this.now() - 420 * 86400_000);

    if (eligibleTimeframes.includes("D1")) {
      try {
        const dailyRows = await this.fetchPaged(SSI_ENDPOINTS.daily, meta, {
          fromDate,
          toDate,
          daily: true,
          stopWhen: (rows) => filterClosedSsiRows(rows, "D1", Math.floor(this.now() / 1000)).length >= counts.D1,
        });
        this.cacheSeries(meta, "D1", filterClosedSsiRows(dailyRows, "D1", Math.floor(this.now() / 1000)), counts.D1);
      } catch (error) {
        this.recordFailure(meta, "D1", error);
      }
    }

    const intradayTimeframes = eligibleTimeframes.filter((timeframe) => timeframe !== "D1");
    if (intradayTimeframes.length) {
      try {
        const intradayRows = await this.fetchPaged(SSI_ENDPOINTS.intraday, meta, {
          fromDate,
          toDate,
          stopWhen: (rows) => intradayTimeframes.every((timeframe) =>
            filterClosedSsiRows(aggregateOhlcv(rows, timeframe), timeframe, Math.floor(this.now() / 1000)).length >= counts[timeframe]),
        });
        for (const timeframe of intradayTimeframes) {
          try {
            const closedRows = filterClosedSsiRows(aggregateOhlcv(intradayRows, timeframe), timeframe, Math.floor(this.now() / 1000));
            this.cacheSeries(meta, timeframe, closedRows, counts[timeframe]);
          } catch (error) {
            this.recordFailure(meta, timeframe, error);
          }
        }
      } catch (error) {
        for (const timeframe of intradayTimeframes) this.recordFailure(meta, timeframe, error);
      }
    }
  }

  async ensureRows(meta, timeframe, count) {
    if (!isVietnamEquity(meta) || !this.configured()) return false;
    const key = this.key(meta.symbol, timeframe);
    if (this.cache.get(key)?.length >= count && this.cacheFresh(meta, timeframe) && !this.errors.has(key)) return false;
    await this.warmSymbol(meta, [timeframe], { [timeframe]: count });
    if (this.cache.get(key)?.length < count || this.errors.has(key)) throw new Error(`provider_cache_miss:${meta.symbol}:${timeframe}`);
    return true;
  }

  async initialize(symbols, timeframes = ["D1", "H4"]) {
    this.symbols = symbols.filter(isVietnamEquity);
    this.timeframes = [...timeframes];
    if (!this.configured()) {
      for (const meta of this.symbols) for (const timeframe of timeframes) this.recordFailure(meta, timeframe, new Error("ssi_credentials_missing"));
    } else {
      for (let cursor = 0; cursor < this.symbols.length; cursor += 2) {
        await Promise.allSettled(this.symbols.slice(cursor, cursor + 2).map((meta) => this.warmSymbol(meta, timeframes)));
      }
    }
    this.initializedAt = new Date(this.now()).toISOString();
    const total = this.symbols.length * timeframes.length;
    return { total, fulfilled: total, rejected: 0, liveSeries: this.cache.size, fallbackSeries: this.errors.size };
  }

  quoteFromCache(meta) {
    const intraday = this.cache.get(this.key(meta.symbol, "H4"));
    const daily = this.cache.get(this.key(meta.symbol, "D1"));
    const latest = intraday?.at(-1) ?? daily?.at(-1);
    const previousClose = daily?.at(-2)?.close;
    if (!latest || !finite(previousClose) || previousClose <= 0) return null;
    return {
      symbol: meta.symbol,
      price: latest.close,
      change: (latest.close - previousClose) / previousClose * 100,
      absoluteChange: latest.close - previousClose,
      quotedAt: new Date((latest.time + (intraday?.length ? timeframeSeconds.H4 : timeframeSeconds.D1)) * 1000).toISOString(),
      source: this.id,
      live: Boolean(intraday?.length && this.isExecutable(meta, "H4")),
      cadence: intraday?.length ? "closed-15m" : "daily-close",
    };
  }

  async getIndexQuotes() {
    if (!this.configured()) return [];
    if (this.indexCache.size && this.now() - this.indexFetchedAt < 60_000) return [...this.indexCache.values()];
    const toDate = formatSsiDate(this.now());
    const fromDate = formatSsiDate(this.now() - 10 * 86400_000);
    const settled = await Promise.allSettled(["VNINDEX", "VN30"].map(async (indexId) => {
      const payload = await this.request(SSI_ENDPOINTS.dailyIndex, {
        indexId,
        fromDate,
        toDate,
        pageIndex: 1,
        pageSize: 10,
        ascending: false,
      });
      return normalizeSsiIndex(payload, indexId);
    }));
    for (const result of settled) {
      if (result.status === "fulfilled" && result.value) this.indexCache.set(result.value.symbol, result.value);
    }
    this.indexFetchedAt = this.now();
    return [...this.indexCache.values()];
  }

  async getQuotes(symbols = this.symbols) {
    const items = symbols.filter(isVietnamEquity).map((meta) => this.quoteFromCache(meta)).filter(Boolean);
    let indices = [];
    try {
      indices = await this.getIndexQuotes();
    } catch {
      indices = [...this.indexCache.values()];
    }
    return {
      items,
      indices,
      source: this.id,
      status: this.configured() && (items.length || indices.length) ? "delayed" : "unavailable",
      observedAt: new Date(this.now()).toISOString(),
    };
  }

  cacheFresh(meta, timeframe) {
    const rows = this.cache.get(this.key(meta.symbol, timeframe));
    if (!rows?.length) return false;
    const lag = Math.floor(this.now() / 1000) - (rows.at(-1).time + timeframeSeconds[timeframe]);
    return lag <= staleThresholdSeconds(meta.market, timeframe, timeframeSeconds[timeframe]);
  }

  isExecutable(meta, timeframe) {
    if (!isVietnamEquity(meta)) return false;
    const key = this.key(meta.symbol, timeframe);
    return !this.errors.has(key) && this.cacheFresh(meta, timeframe);
  }

  getRows(meta, timeframe, count, asOfSeconds) {
    const key = this.key(meta.symbol, timeframe);
    const rows = this.cache.get(key);
    if (!this.errors.has(key) && rows?.length >= count && this.cacheFresh(meta, timeframe)) return rows.slice(-count);
    if (this.fallback) return this.fallback.getRows(meta, timeframe, count, asOfSeconds);
    throw new Error(`provider_cache_miss:${meta.symbol}:${timeframe}`);
  }

  sourceFor(meta, timeframe) {
    return this.isExecutable(meta, timeframe) ? this.id : this.fallback?.id ?? this.id;
  }

  seriesStatus(meta, timeframe) {
    const key = this.key(meta.symbol, timeframe);
    const rows = this.cache.get(key);
    const error = this.errors.get(key);
    const live = this.isExecutable(meta, timeframe);
    return {
      symbol: meta.symbol,
      market: meta.market,
      timeframe,
      provider: this.id,
      source: this.sourceFor(meta, timeframe),
      live,
      executable: live,
      state: this.circuitOpen(meta, timeframe) ? "circuit-open" : live ? "live" : error ? "fallback" : "warming",
      cachedRows: rows?.length ?? 0,
      lastBarTime: rows?.at(-1)?.time ?? null,
      lastBarAt: rows?.length ? new Date(rows.at(-1).time * 1000).toISOString() : null,
      error: error ? { message: error.message, at: error.at, consecutiveFailures: error.consecutiveFailures } : null,
    };
  }

  async refreshDue() {
    if (this.refreshing || !this.configured()) return { status: this.configured() ? "busy" : "disabled", due: 0, refreshed: 0, changed: false };
    this.refreshing = true;
    const beforeRevision = this.revision;
    try {
      const dueSymbols = this.symbols.filter((meta) => this.timeframes.some((timeframe) =>
        !this.circuitOpen(meta, timeframe) && (this.errors.has(this.key(meta.symbol, timeframe)) || !this.cacheFresh(meta, timeframe))));
      for (const meta of dueSymbols) await this.warmSymbol(meta, this.timeframes);
      this.lastRefresh = {
        status: this.errors.size ? "degraded" : "ok",
        due: dueSymbols.length,
        refreshed: dueSymbols.length,
        changed: this.revision !== beforeRevision,
        completedAt: new Date(this.now()).toISOString(),
      };
      return this.lastRefresh;
    } finally {
      this.refreshing = false;
    }
  }

  startAutoRefresh({ intervalMs = 5 * 60_000, onUpdate } = {}) {
    if (this.refreshTimer) return this.refreshTimer;
    this.refreshTimer = setInterval(async () => {
      const result = await this.refreshDue();
      if (result.changed) onUpdate?.(result);
    }, Math.max(intervalMs, 5 * 60_000));
    this.refreshTimer.unref?.();
    return this.refreshTimer;
  }

  stopAutoRefresh() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  getRevision() {
    return this.revision;
  }

  status() {
    const monitored = this.monitor.summary();
    const issues = [...this.errors.entries()].map(([series, error]) => ({
      series,
      status: error.circuitOpenUntil > this.now() ? "circuit-open" : "fallback",
      message: error.message,
      at: error.at,
      consecutiveFailures: error.consecutiveFailures,
    }));
    return {
      id: this.id,
      mode: this.fallback ? "hybrid" : "live",
      configured: this.configured(),
      connected: this.cache.size > 0,
      baseUrl: this.baseUrl,
      cachedSeries: this.cache.size,
      executableSeries: [...this.cache.keys()].filter((key) => {
        const [symbol, timeframe] = key.split(":");
        const meta = this.symbols.find((item) => item.symbol === symbol);
        return meta && this.isExecutable(meta, timeframe);
      }).length,
      errors: this.errors.size,
      openCircuits: [...this.errors.values()].filter((error) => error.circuitOpenUntil > this.now()).length,
      revision: this.revision,
      initializedAt: this.initializedAt,
      lastRefresh: this.lastRefresh,
      quality: {
        ...monitored,
        status: this.errors.size ? "degraded" : monitored.status,
        score: monitored.status === "unknown" && this.errors.size ? 60 : Math.max(0, monitored.score - Math.min(30, this.errors.size * 2)),
        issues: [...monitored.issues, ...issues].slice(0, 20),
      },
      checkedAt: new Date(this.now()).toISOString(),
    };
  }
}

function parseVietnamTimestamp(value, { daily = false } = {}) {
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return null;
  const [, year, month, day, hour = "00", minute = "00", second = "00"] = match;
  const localTime = daily ? "00:00:00" : `${hour.padStart(2, "0")}:${minute}:${second}`;
  const timestamp = Date.parse(`${year}-${month}-${day}T${localTime}+07:00`);
  return Number.isNaN(timestamp) ? null : Math.floor(timestamp / 1000);
}

export function normalizeKbsOhlcv(payload, suffix, { daily = false, priceScale = 1000 } = {}) {
  const source = payload?.[`data_${suffix}`] ?? payload?.data ?? [];
  if (!Array.isArray(source)) throw new Error("kbs_invalid_payload");
  const rows = source.map((item) => ({
    time: parseVietnamTimestamp(item?.t ?? item?.time, { daily }),
    open: Number(item?.o ?? item?.open) / priceScale,
    high: Number(item?.h ?? item?.high) / priceScale,
    low: Number(item?.l ?? item?.low) / priceScale,
    close: Number(item?.c ?? item?.close) / priceScale,
    volume: Number(item?.v ?? item?.volume ?? 0),
  })).filter((row) => row.time != null && [row.open, row.high, row.low, row.close, row.volume].every(finite));
  return [...new Map(rows.sort((left, right) => left.time - right.time).map((row) => [row.time, row])).values()];
}

export function normalizeUdfOhlcv(payload) {
  if (payload?.s === "no_data") return [];
  if (payload?.s === "error") throw new Error(`udf_error:${String(payload.errmsg ?? "unknown").slice(0, 160)}`);
  const times = payload?.t;
  if (!Array.isArray(times)) throw new Error("udf_invalid_payload");
  return times.map((time, index) => ({
    time: Math.floor(Number(time)),
    open: Number(payload.o?.[index]),
    high: Number(payload.h?.[index]),
    low: Number(payload.l?.[index]),
    close: Number(payload.c?.[index]),
    volume: Number(payload.v?.[index] ?? 0),
  })).filter((row) => [row.time, row.open, row.high, row.low, row.close, row.volume].every(finite));
}

class CachedEquityMarketDataProvider {
  constructor({ id, now = () => Date.now(), monitor = new DataQualityMonitor({ now }), failureThreshold = 3, circuitCooldownMs = 5 * 60_000 } = {}) {
    this.id = id;
    this.now = now;
    this.monitor = monitor;
    this.failureThreshold = failureThreshold;
    this.circuitCooldownMs = circuitCooldownMs;
    this.cache = new Map();
    this.errors = new Map();
    this.symbols = [];
    this.timeframes = ["D1", "H4"];
    this.revision = 0;
    this.initializedAt = null;
    this.lastRefresh = null;
    this.refreshing = false;
  }

  key(symbol, timeframe) { return `${symbol}:${timeframe}`; }
  configured() { return true; }
  circuitOpen(meta, timeframe) { return (this.errors.get(this.key(meta.symbol, timeframe))?.circuitOpenUntil ?? 0) > this.now(); }

  recordFailure(meta, timeframe, error) {
    const key = this.key(meta.symbol, timeframe);
    const previous = this.errors.get(key);
    const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
    this.errors.set(key, {
      message: sanitizeProviderError(error),
      at: new Date(this.now()).toISOString(),
      consecutiveFailures,
      circuitOpenUntil: consecutiveFailures >= this.failureThreshold ? this.now() + this.circuitCooldownMs : 0,
    });
    this.revision += 1;
  }

  cacheFresh(meta, timeframe) {
    const rows = this.cache.get(this.key(meta.symbol, timeframe));
    if (!rows?.length) return false;
    const lag = Math.floor(this.now() / 1000) - (rows.at(-1).time + timeframeSeconds[timeframe]);
    return lag <= staleThresholdSeconds(meta.market, timeframe, timeframeSeconds[timeframe]);
  }

  cacheSeries(meta, timeframe, rows, count) {
    const key = this.key(meta.symbol, timeframe);
    const normalized = [...new Map(rows.map((row) => [row.time, row])).values()].sort((left, right) => left.time - right.time);
    if (normalized.length < count) throw new Error(`${this.id}_insufficient_rows:${meta.symbol}:${timeframe}:${normalized.length}/${count}`);
    const retained = normalized.slice(-Math.max(count, this.cache.get(key)?.length ?? 0));
    const quality = this.monitor.inspect(meta.symbol, timeframe, retained, { market: meta.market });
    if (quality.status === "blocked") throw new Error(`market_data_blocked:${meta.symbol}:${timeframe}`);
    const previous = this.cache.get(key)?.at(-1);
    const next = retained.at(-1);
    if (!previous || previous.time !== next.time || previous.close !== next.close || previous.volume !== next.volume || this.errors.has(key)) this.revision += 1;
    this.cache.set(key, retained);
    this.errors.delete(key);
    return retained;
  }

  async initialize(symbols, timeframes = this.timeframes) {
    this.symbols = symbols.filter((meta) => meta.market !== "CRYPTO");
    this.timeframes = [...timeframes];
    if (!this.configured()) {
      this.initializedAt = new Date(this.now()).toISOString();
      return { total: this.symbols.length * timeframes.length, fulfilled: 0, rejected: this.symbols.length * timeframes.length, liveSeries: 0, fallbackSeries: 0, configured: false };
    }
    const settled = [];
    for (let cursor = 0; cursor < this.symbols.length; cursor += 2) {
      settled.push(...await Promise.allSettled(this.symbols.slice(cursor, cursor + 2).map((meta) => this.warmSymbol(meta, timeframes))));
    }
    this.initializedAt = new Date(this.now()).toISOString();
    return {
      total: this.symbols.length * timeframes.length,
      fulfilled: this.cache.size,
      rejected: this.errors.size,
      liveSeries: this.cache.size,
      fallbackSeries: 0,
      configured: true,
      symbolJobs: settled.length,
    };
  }

  async ensureRows(meta, timeframe, count) {
    if (!this.configured() || this.circuitOpen(meta, timeframe)) throw new Error(`${this.id}_unavailable:${meta.symbol}:${timeframe}`);
    if (this.cache.get(this.key(meta.symbol, timeframe))?.length >= count && this.cacheFresh(meta, timeframe)) return false;
    await this.warmSymbol(meta, [timeframe], { [timeframe]: count });
    if (!this.isExecutable(meta, timeframe) || this.cache.get(this.key(meta.symbol, timeframe))?.length < count) throw new Error(`${this.id}_cache_miss:${meta.symbol}:${timeframe}`);
    return true;
  }

  getRows(meta, timeframe, count) {
    const rows = this.cache.get(this.key(meta.symbol, timeframe));
    if (!this.isExecutable(meta, timeframe) || rows?.length < count) throw new Error(`${this.id}_cache_miss:${meta.symbol}:${timeframe}`);
    return rows.slice(-count);
  }

  isExecutable(meta, timeframe) {
    const key = this.key(meta.symbol, timeframe);
    return meta.market !== "CRYPTO" && !this.errors.has(key) && this.cacheFresh(meta, timeframe);
  }

  sourceFor(meta, timeframe) { return this.isExecutable(meta, timeframe) ? this.id : null; }

  seriesStatus(meta, timeframe) {
    const rows = this.cache.get(this.key(meta.symbol, timeframe));
    const error = this.errors.get(this.key(meta.symbol, timeframe));
    const live = this.isExecutable(meta, timeframe);
    return {
      symbol: meta.symbol,
      market: meta.market,
      timeframe,
      provider: this.id,
      source: live ? this.id : null,
      live,
      executable: live,
      state: !this.configured() ? "disabled" : this.circuitOpen(meta, timeframe) ? "circuit-open" : live ? "live" : error ? "unavailable" : "warming",
      cachedRows: rows?.length ?? 0,
      lastBarTime: rows?.at(-1)?.time ?? null,
      lastBarAt: rows?.length ? new Date(rows.at(-1).time * 1000).toISOString() : null,
      error: error ? { message: error.message, at: error.at, consecutiveFailures: error.consecutiveFailures } : null,
    };
  }

  quoteFromCache(meta) {
    const intraday = this.cache.get(this.key(meta.symbol, "H4"));
    const daily = this.cache.get(this.key(meta.symbol, "D1"));
    const latest = intraday?.at(-1) ?? daily?.at(-1);
    const previousClose = daily?.at(-2)?.close;
    if (!latest || !finite(previousClose) || previousClose <= 0) return null;
    return {
      symbol: meta.symbol,
      price: latest.close,
      change: (latest.close - previousClose) / previousClose * 100,
      absoluteChange: latest.close - previousClose,
      quotedAt: new Date((latest.time + (intraday?.length ? timeframeSeconds.H4 : timeframeSeconds.D1)) * 1000).toISOString(),
      source: this.id,
      live: Boolean(intraday?.length && this.isExecutable(meta, "H4")),
      cadence: intraday?.length ? "closed-15m" : "daily-close",
    };
  }

  async getIndexQuotes() { return []; }

  async getQuotes(symbols = this.symbols) {
    const items = symbols.filter((meta) => meta.market !== "CRYPTO").map((meta) => this.quoteFromCache(meta)).filter(Boolean);
    let indices = [];
    try { indices = await this.getIndexQuotes(); } catch { indices = []; }
    return { items, indices, source: this.id, status: items.length || indices.length ? "delayed" : "unavailable", observedAt: new Date(this.now()).toISOString() };
  }

  async refreshDue() {
    if (this.refreshing || !this.configured()) return { status: this.configured() ? "busy" : "disabled", due: 0, refreshed: 0, changed: false };
    this.refreshing = true;
    const before = this.revision;
    try {
      const due = this.symbols.filter((meta) => this.timeframes.some((timeframe) => !this.circuitOpen(meta, timeframe) && !this.isExecutable(meta, timeframe)));
      for (const meta of due) await this.warmSymbol(meta, this.timeframes);
      this.lastRefresh = { status: this.errors.size ? "degraded" : "ok", due: due.length, refreshed: due.length, changed: before !== this.revision, completedAt: new Date(this.now()).toISOString() };
      return this.lastRefresh;
    } finally { this.refreshing = false; }
  }

  getRevision() { return this.revision; }

  status() {
    const quality = this.monitor.summary();
    return {
      id: this.id,
      mode: "live",
      configured: this.configured(),
      connected: this.cache.size > 0,
      cachedSeries: this.cache.size,
      executableSeries: this.symbols.reduce((sum, meta) => sum + this.timeframes.filter((timeframe) => this.isExecutable(meta, timeframe)).length, 0),
      errors: this.errors.size,
      openCircuits: [...this.errors.values()].filter((error) => error.circuitOpenUntil > this.now()).length,
      revision: this.revision,
      initializedAt: this.initializedAt,
      lastRefresh: this.lastRefresh,
      quality: { ...quality, status: this.cache.size ? quality.status : "unknown" },
      checkedAt: new Date(this.now()).toISOString(),
    };
  }
}

const KBS_SUFFIX = { D1: "day", H1: "60P", M15: "15P" };
const formatKbsDate = (timestampMs) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(timestampMs)).replaceAll("/", "-");

export function normalize24HMoneyScreener(payload, observedAt = new Date().toISOString()) {
  const rows = payload?.data?.data ?? payload?.data ?? [];
  if (!Array.isArray(rows)) return [];
  return rows.map((item) => {
    const price = Number(item?.match_price);
    const change = Number(item?.change_percent);
    const absoluteChange = Number(item?.change_price);
    return {
      symbol: String(item?.symbol ?? "").trim().toUpperCase(),
      price,
      change,
      absoluteChange,
      volume: Number(item?.accumylated_vol ?? 0),
      averageVolume5: Number(item?.avg_trading_vol_5 ?? 0),
      averageVolume10: Number(item?.avg_trading_vol_10 ?? 0),
      marketCap: Number(item?.market_cap ?? 0),
      pe4Q: Number(item?.pe4Q ?? item?.pe ?? 0),
      pb4Q: Number(item?.pb4Q ?? item?.pb ?? 0),
      eps4Q: Number(item?.eps4Q ?? item?.eps ?? 0),
      roe: Number(item?.roe ?? 0),
      roa: Number(item?.roa ?? 0),
      rs1m: Number(item?.rs1m ?? 0),
      rs3m: Number(item?.rs3m ?? 0),
      rs52w: Number(item?.rs52w ?? 0),
      floor: item?.floor ?? "",
      indexCode: item?.index_code ?? "",
      companyName: item?.company_name ?? "",
      quotedAt: observedAt,
      source: "24hmoney-technical-filter-v1",
      live: false,
      cadence: "screener-snapshot",
    };
  }).filter((item) => item.symbol && finite(item.price) && item.price > 0 && finite(item.change));
}

export class TwentyFourHMoneyScreenerProvider {
  constructor({
    now = () => Date.now(),
    fetcher = fetch,
    baseUrl = process.env.TWENTY_FOUR_HMONEY_URL ?? "https://api-finance-t19.24hmoney.vn/v1/ios/company/technical-filter",
    ttlMs = Number(process.env.TWENTY_FOUR_HMONEY_TTL_MS ?? 30_000),
    perPage = Number(process.env.TWENTY_FOUR_HMONEY_PER_PAGE ?? 500),
    maxPages = Number(process.env.TWENTY_FOUR_HMONEY_MAX_PAGES ?? 4),
    deviceId = process.env.TWENTY_FOUR_HMONEY_DEVICE_ID ?? "signaledge-device",
    browserId = process.env.TWENTY_FOUR_HMONEY_BROWSER_ID ?? "signaledge-browser",
  } = {}) {
    this.id = "24hmoney-technical-filter-v1";
    this.now = now;
    this.fetcher = fetcher;
    this.baseUrl = baseUrl;
    this.ttlMs = Math.max(10_000, ttlMs);
    this.perPage = Math.min(Math.max(20, perPage), 500);
    this.maxPages = Math.max(1, maxPages);
    this.deviceId = deviceId;
    this.browserId = browserId;
    this.symbols = [];
    this.cache = new Map();
    this.fetchedAt = 0;
    this.revision = 0;
    this.lastRefresh = null;
    this.lastError = null;
    this.initializedAt = null;
  }

  configured() { return Boolean(this.baseUrl); }
  isExecutable() { return false; }
  sourceFor() { return null; }
  getRevision() { return this.revision; }
  async ensureRows(meta, timeframe) { throw new Error(`${this.id}_quote_only:${meta.symbol}:${timeframe}`); }
  getRows(meta, timeframe) { throw new Error(`${this.id}_quote_only:${meta.symbol}:${timeframe}`); }

  requestUrl(page) {
    const url = new URL(this.baseUrl);
    url.searchParams.set("param", "match_price:0:1000000|accumylated_vol:0:1000000000|");
    url.searchParams.set("floor", "all");
    url.searchParams.set("group_id", "all");
    url.searchParams.set("key", "market_cap");
    url.searchParams.set("sort", "desc");
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", String(this.perPage));
    url.searchParams.set("device_id", this.deviceId);
    url.searchParams.set("browser_id", this.browserId);
    url.searchParams.set("os", "Chrome");
    return url;
  }

  async fetchPage(page) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await this.fetcher(this.requestUrl(page), {
        signal: controller.signal,
        headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 SignalEdge/1.0" },
      });
      if (!response.ok) throw new Error(`24hmoney_http_${response.status}`);
      const payload = await response.json();
      if (Number(payload?.status) !== 200) throw new Error(`24hmoney_status_${payload?.status ?? "unknown"}`);
      return payload;
    } finally { clearTimeout(timeout); }
  }

  async refreshQuotes(symbols = this.symbols) {
    if (!this.configured()) return { status: "disabled", refreshed: 0, changed: false };
    const wanted = new Set(symbols.filter(isVietnamEquity).map((meta) => meta.symbol));
    if (!wanted.size) return { status: "ok", refreshed: 0, changed: false };
    const observedAt = new Date(this.now()).toISOString();
    const before = this.revision;
    const found = new Set();
    let totalPages = this.maxPages;
    let fetched = 0;
    for (let page = 1; page <= Math.min(totalPages, this.maxPages); page += 1) {
      const payload = await this.fetchPage(page);
      fetched += 1;
      totalPages = Math.max(1, Number(payload?.data?.total_page ?? totalPages));
      for (const quote of normalize24HMoneyScreener(payload, observedAt)) {
        if (!wanted.has(quote.symbol)) continue;
        found.add(quote.symbol);
        this.cache.set(quote.symbol, quote);
      }
      if (found.size === wanted.size) break;
    }
    if (found.size) this.revision += 1;
    this.fetchedAt = this.now();
    this.lastError = null;
    this.lastRefresh = { status: found.size ? "ok" : "degraded", requested: wanted.size, found: found.size, pages: fetched, changed: before !== this.revision, completedAt: observedAt };
    return this.lastRefresh;
  }

  async initialize(symbols) {
    this.symbols = symbols.filter(isVietnamEquity);
    this.initializedAt = new Date(this.now()).toISOString();
    try {
      await this.refreshQuotes(this.symbols);
    } catch (error) {
      this.lastError = { message: sanitizeProviderError(error), at: new Date(this.now()).toISOString() };
      this.lastRefresh = { status: "degraded", requested: this.symbols.length, found: this.cache.size, pages: 0, changed: false, error: this.lastError.message, completedAt: this.lastError.at };
    }
    return { total: 0, fulfilled: 0, rejected: 0, liveSeries: 0, fallbackSeries: 0, configured: this.configured(), quoteRows: this.cache.size };
  }

  async getQuotes(symbols = this.symbols) {
    const wanted = symbols.filter(isVietnamEquity);
    if (this.now() - this.fetchedAt > this.ttlMs) {
      try { await this.refreshQuotes(wanted); }
      catch (error) {
        this.lastError = { message: sanitizeProviderError(error), at: new Date(this.now()).toISOString() };
      }
    }
    const items = wanted.map((meta) => this.cache.get(meta.symbol)).filter(Boolean);
    return { items, indices: [], source: this.id, status: items.length ? "delayed" : "unavailable", observedAt: new Date(this.now()).toISOString() };
  }

  async refreshDue() {
    try { return await this.refreshQuotes(this.symbols); }
    catch (error) {
      this.lastError = { message: sanitizeProviderError(error), at: new Date(this.now()).toISOString() };
      return { status: "degraded", changed: false, error: this.lastError.message };
    }
  }

  seriesStatus(meta, timeframe) {
    return {
      symbol: meta.symbol,
      market: meta.market,
      timeframe,
      provider: this.id,
      source: null,
      live: false,
      executable: false,
      state: this.configured() ? "quote-only" : "disabled",
      cachedRows: 0,
      lastBarTime: null,
      lastBarAt: null,
      error: this.lastError,
    };
  }

  status() {
    return {
      id: this.id,
      mode: "quote-screener",
      configured: this.configured(),
      connected: this.cache.size > 0,
      cachedSeries: 0,
      executableSeries: 0,
      quoteRows: this.cache.size,
      errors: this.lastError ? 1 : 0,
      openCircuits: 0,
      revision: this.revision,
      initializedAt: this.initializedAt,
      lastRefresh: this.lastRefresh,
      quality: { status: this.cache.size ? "healthy" : this.lastError ? "degraded" : "unknown", score: this.cache.size ? 90 : 0, checkedFeeds: this.cache.size, blocked: 0, degraded: this.lastError ? 1 : 0, totalFaults: this.lastError ? 1 : 0, issues: this.lastError ? [this.lastError] : [], lastObservedAt: this.lastRefresh?.completedAt ?? "" },
      checkedAt: new Date(this.now()).toISOString(),
    };
  }
}

export class KbsMarketDataProvider extends CachedEquityMarketDataProvider {
  constructor({ now = () => Date.now(), fetcher = fetch, baseUrl = process.env.KBS_MARKET_DATA_URL ?? "https://kbbuddywts.kbsec.com.vn/iis-server/investment", ...options } = {}) {
    super({ id: "kbs-iis-market-data-v1", now, ...options });
    this.fetcher = fetcher;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.indexCache = new Map();
    this.indexFetchedAt = 0;
  }

  async initialize(symbols, timeframes = this.timeframes) {
    return super.initialize(symbols.filter(isVietnamInstrument), timeframes);
  }

  async ensureRows(meta, timeframe, count) {
    if (!isVietnamInstrument(meta)) throw new Error(`${this.id}_unsupported_market:${meta.symbol}:${meta.market}`);
    return super.ensureRows(meta, timeframe, count);
  }

  isExecutable(meta, timeframe) {
    return isVietnamInstrument(meta) && super.isExecutable(meta, timeframe);
  }

  async fetchSeries(symbol, suffix, count, { index = false, daily = false } = {}) {
    const barsPerDay = daily ? 1 : suffix === "60P" ? 5 : 16;
    const lookbackDays = Math.max(45, Math.ceil(count / barsPerDay * 2.2) + 20);
    const url = new URL(`${this.baseUrl}/${index ? "index" : "stocks"}/${symbol}/data_${suffix}`);
    url.searchParams.set("sdate", formatKbsDate(this.now() - lookbackDays * 86400_000));
    url.searchParams.set("edate", formatKbsDate(this.now()));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await this.fetcher(url, { signal: controller.signal, headers: { Accept: "application/json", "User-Agent": "SignalEdge/1.0" } });
      if (!response.ok) throw new Error(`kbs_http_${response.status}`);
      return normalizeKbsOhlcv(await response.json(), suffix, { daily, priceScale: index ? 1 : 1000 });
    } finally { clearTimeout(timeout); }
  }

  async warmSymbol(meta, timeframes = this.timeframes, countOverrides = {}) {
    const counts = Object.fromEntries(timeframes.map((timeframe) => [timeframe, countOverrides[timeframe] ?? analysisRowCount(meta, timeframe)]));
    const dailyFrames = timeframes.filter((timeframe) => ["D1", "H4"].includes(timeframe) && !this.circuitOpen(meta, timeframe));
    if (dailyFrames.length) {
      try {
        const needed = Math.max(...dailyFrames.map((timeframe) => counts[timeframe]));
        const rows = filterClosedSsiRows(await this.fetchSeries(meta.symbol, KBS_SUFFIX.D1, needed, { daily: true, index: isVietnamIndex(meta) }), "D1", Math.floor(this.now() / 1000));
        for (const timeframe of dailyFrames) {
          try { this.cacheSeries(meta, timeframe, rows, counts[timeframe]); }
          catch (error) { this.recordFailure(meta, timeframe, error); }
        }
      } catch (error) { for (const timeframe of dailyFrames) this.recordFailure(meta, timeframe, error); }
    }
    const onDemand = Object.keys(countOverrides).length > 0;
    const hourlyFrames = onDemand ? timeframes.filter((timeframe) => timeframe === "H1" && !this.circuitOpen(meta, timeframe)) : [];
    if (hourlyFrames.length) {
      try {
        const needed = Math.max(...hourlyFrames.map((timeframe) => counts[timeframe]));
        const hourly = await this.fetchSeries(meta.symbol, KBS_SUFFIX.H1, needed);
        for (const timeframe of hourlyFrames) {
          try {
            const rows = filterClosedSsiRows(hourly, timeframe, Math.floor(this.now() / 1000));
            this.cacheSeries(meta, timeframe, rows, counts[timeframe]);
          } catch (error) { this.recordFailure(meta, timeframe, error); }
        }
      } catch (error) { for (const timeframe of hourlyFrames) this.recordFailure(meta, timeframe, error); }
    }
    if (onDemand && timeframes.includes("M15") && !this.circuitOpen(meta, "M15")) {
      try {
        const rows = filterClosedSsiRows(await this.fetchSeries(meta.symbol, KBS_SUFFIX.M15, counts.M15), "M15", Math.floor(this.now() / 1000));
        this.cacheSeries(meta, "M15", rows, counts.M15);
      } catch (error) { this.recordFailure(meta, "M15", error); }
    }
  }

  async getIndexQuotes() {
    if (this.indexCache.size && this.now() - this.indexFetchedAt < 60_000) return [...this.indexCache.values()];
    const settled = await Promise.allSettled(["VNINDEX", "VN30"].map(async (symbol) => {
      const rows = await this.fetchSeries(symbol, "day", 5, { index: true, daily: true });
      const latest = rows.at(-1);
      const previous = rows.at(-2);
      if (!latest || !previous) return null;
      return { symbol, price: latest.close, change: (latest.close - previous.close) / previous.close * 100, absoluteChange: latest.close - previous.close, quotedAt: new Date(latest.time * 1000).toISOString(), source: this.id, live: false, cadence: "daily-close" };
    }));
    for (const result of settled) if (result.status === "fulfilled" && result.value) this.indexCache.set(result.value.symbol, result.value);
    this.indexFetchedAt = this.now();
    return [...this.indexCache.values()];
  }
}

const UDF_RESOLUTION = { D1: "D", H4: "240", H1: "60", M15: "15" };

export class TradingViewUdfMarketDataProvider extends CachedEquityMarketDataProvider {
  constructor({
    now = () => Date.now(),
    fetcher = fetch,
    baseUrl = process.env.TRADINGVIEW_UDF_URL ?? "",
    token = process.env.TRADINGVIEW_UDF_TOKEN ?? "",
    symbolPrefix = process.env.TRADINGVIEW_UDF_SYMBOL_PREFIX ?? "",
    symbolTemplate = process.env.TRADINGVIEW_UDF_SYMBOL_TEMPLATE ?? "",
    exchange = process.env.TRADINGVIEW_UDF_EXCHANGE ?? "",
    timeoutMs = Number(process.env.TRADINGVIEW_UDF_TIMEOUT_MS ?? 10_000),
    strictSymbols = process.env.TRADINGVIEW_UDF_STRICT_SYMBOLS === "true",
    ...options
  } = {}) {
    super({ id: "tradingview-compatible-udf-v1", now, ...options });
    this.fetcher = fetcher;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    this.symbolPrefix = symbolPrefix;
    this.symbolTemplate = symbolTemplate;
    this.exchange = exchange;
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10_000;
    this.strictSymbols = strictSymbols;
    this.config = null;
    this.configError = null;
    this.symbolCache = new Map();
  }

  configured() { return Boolean(this.baseUrl); }

  udfSymbol(meta) {
    if (this.symbolTemplate) {
      return this.symbolTemplate
        .replaceAll("{symbol}", meta.symbol)
        .replaceAll("{exchange}", this.exchange || meta.venue || "")
        .replaceAll("{venue}", meta.venue || "")
        .replaceAll("{market}", meta.market || "");
    }
    return `${this.symbolPrefix}${meta.symbol}`;
  }

  async requestJson(pathname, params = {}) {
    const url = new URL(`${this.baseUrl}${pathname}`);
    for (const [key, value] of Object.entries(params)) {
      if (value != null && value !== "") url.searchParams.set(key, String(value));
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = { Accept: "application/json" };
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
      const response = await this.fetcher(url, { signal: controller.signal, headers });
      if (!response.ok) throw new Error(`udf_http_${response.status}`);
      return response.json();
    } finally { clearTimeout(timeout); }
  }

  async loadConfig() {
    const config = await this.requestJson("/config");
    if (!config || typeof config !== "object") throw new Error("udf_invalid_config");
    if (!config.supports_search && !config.supports_group_request) throw new Error("udf_config_missing_search_or_group");
    this.config = config;
    this.configError = null;
    return config;
  }

  async resolveTicker(meta) {
    const candidate = this.udfSymbol(meta);
    if (this.symbolCache.has(meta.symbol)) return this.symbolCache.get(meta.symbol);
    try {
      const resolved = await this.requestJson("/symbols", { symbol: candidate });
      const ticker = resolved?.ticker ?? resolved?.name ?? resolved?.symbol ?? candidate;
      this.symbolCache.set(meta.symbol, ticker);
      return ticker;
    } catch (error) {
      if (this.strictSymbols) throw error;
      this.symbolCache.set(meta.symbol, candidate);
      return candidate;
    }
  }

  async fetchRows(meta, timeframe, count) {
    const interval = timeframeSeconds[timeframe];
    if (!interval || !UDF_RESOLUTION[timeframe]) throw new Error(`udf_unsupported_resolution:${timeframe}`);
    const ticker = await this.resolveTicker(meta);
    const payload = await this.requestJson("/history", {
      symbol: ticker,
      resolution: UDF_RESOLUTION[timeframe],
      from: Math.floor(this.now() / 1000) - Math.max(count * interval * 3, 45 * 86400),
      to: Math.floor(this.now() / 1000),
      countback: count,
    });
    return filterClosedSsiRows(normalizeUdfOhlcv(payload), timeframe, Math.floor(this.now() / 1000));
  }

  async initialize(symbols, timeframes = this.timeframes) {
    this.symbols = symbols.filter((meta) => meta.market !== "CRYPTO");
    this.timeframes = [...timeframes];
    if (!this.configured()) return super.initialize(symbols, timeframes);
    try {
      await this.loadConfig();
    } catch (error) {
      this.configError = sanitizeProviderError(error);
      for (const meta of this.symbols) for (const timeframe of timeframes) this.recordFailure(meta, timeframe, error);
      this.initializedAt = new Date(this.now()).toISOString();
      const total = this.symbols.length * timeframes.length;
      return { total, fulfilled: 0, rejected: total, liveSeries: 0, fallbackSeries: 0, configured: true, configError: this.configError };
    }
    return super.initialize(symbols, timeframes);
  }

  async warmSymbol(meta, timeframes = this.timeframes, countOverrides = {}) {
    for (const timeframe of timeframes) {
      if (this.circuitOpen(meta, timeframe)) continue;
      const count = countOverrides[timeframe] ?? analysisRowCount(meta, timeframe);
      try { this.cacheSeries(meta, timeframe, await this.fetchRows(meta, timeframe, count), count); }
      catch (error) { this.recordFailure(meta, timeframe, error); }
    }
  }

  status() {
    return {
      ...super.status(),
      configLoaded: Boolean(this.config),
      configError: this.configError,
      supportsSearch: Boolean(this.config?.supports_search),
      supportsGroupRequest: Boolean(this.config?.supports_group_request),
      supportedResolutions: this.config?.supported_resolutions ?? null,
    };
  }
}

export class EquityFailoverMarketDataProvider {
  constructor({ providers, now = () => Date.now() }) {
    this.id = "vn-equity-failover-v1";
    this.providers = providers;
    this.now = now;
    this.symbols = [];
    this.timeframes = ["D1", "H4"];
  }

  selectedProvider(meta, timeframe) { return this.providers.find((provider) => provider.isExecutable(meta, timeframe)); }

  async initialize(symbols, timeframes = this.timeframes) {
    this.symbols = symbols.filter((meta) => meta.market !== "CRYPTO");
    this.timeframes = [...timeframes];
    const results = await Promise.all(this.providers.map((provider) => provider.initialize(symbols, timeframes)));
    const liveSeries = this.symbols.reduce((sum, meta) => sum + timeframes.filter((timeframe) => this.isExecutable(meta, timeframe)).length, 0);
    return { total: this.symbols.length * timeframes.length, fulfilled: liveSeries, rejected: this.symbols.length * timeframes.length - liveSeries, liveSeries, fallbackSeries: 0, providers: Object.fromEntries(this.providers.map((provider, index) => [provider.id, results[index]])) };
  }

  async ensureRows(meta, timeframe, count) {
    const failures = [];
    for (const provider of this.providers) {
      if (!provider.configured?.()) continue;
      try {
        await provider.ensureRows(meta, timeframe, count);
        if (provider.isExecutable(meta, timeframe)) return true;
      } catch (error) { failures.push(`${provider.id}:${sanitizeProviderError(error)}`); }
    }
    throw new Error(`equity_failover_exhausted:${meta.symbol}:${timeframe}:${failures.join("|") || "no_provider_configured"}`);
  }

  getRows(meta, timeframe, count) {
    const provider = this.selectedProvider(meta, timeframe);
    if (!provider) throw new Error(`equity_market_data_unavailable:${meta.symbol}:${timeframe}`);
    return provider.getRows(meta, timeframe, count);
  }

  isExecutable(meta, timeframe) { return Boolean(this.selectedProvider(meta, timeframe)); }
  sourceFor(meta, timeframe) { return this.selectedProvider(meta, timeframe)?.id ?? null; }
  getRevision() { return this.providers.map((provider) => provider.getRevision()).join("."); }

  seriesStatus(meta, timeframe) {
    const selected = this.selectedProvider(meta, timeframe);
    const attempts = this.providers.map((provider) => provider.seriesStatus(meta, timeframe));
    return {
      ...(selected?.seriesStatus(meta, timeframe) ?? attempts[0]),
      provider: this.id,
      source: selected?.id ?? null,
      live: Boolean(selected),
      executable: Boolean(selected),
      state: selected ? "live" : "unavailable",
      failoverLayer: selected ? this.providers.indexOf(selected) + 1 : null,
      attempts,
    };
  }

  async getQuotes(symbols = this.symbols) {
    const settled = await Promise.allSettled(this.providers.map((provider) => provider.getQuotes(symbols)));
    const results = settled.map((result) => result.status === "fulfilled" ? result.value : null);
    const itemMap = new Map();
    const indexMap = new Map();
    for (const result of results.filter(Boolean)) {
      for (const item of result.items ?? []) if (!itemMap.has(item.symbol)) itemMap.set(item.symbol, item);
      for (const item of result.indices ?? []) if (!indexMap.has(item.symbol)) indexMap.set(item.symbol, item);
    }
    return {
      items: [...itemMap.values()],
      indices: [...indexMap.values()],
      source: this.id,
      providers: Object.fromEntries(this.providers.map((provider, index) => [provider.id, results[index]?.status ?? "unavailable"])),
      status: itemMap.size || indexMap.size ? "delayed" : "unavailable",
      observedAt: new Date(this.now()).toISOString(),
    };
  }

  async refreshDue() {
    const before = this.getRevision();
    const results = await Promise.all(this.providers.map((provider) => provider.refreshDue()));
    return { status: this.symbols.every((meta) => this.timeframes.every((timeframe) => this.isExecutable(meta, timeframe))) ? "ok" : "degraded", changed: before !== this.getRevision(), providers: Object.fromEntries(this.providers.map((provider, index) => [provider.id, results[index]])) };
  }

  status() {
    const total = this.symbols.length * this.timeframes.length;
    const executableSeries = this.symbols.reduce((sum, meta) => sum + this.timeframes.filter((timeframe) => this.isExecutable(meta, timeframe)).length, 0);
    const statuses = this.providers.map((provider) => provider.status());
    const providerStatuses = Object.fromEntries(statuses.map((status) => [status.id, status]));
    const coverage = total ? Math.round(executableSeries / total * 100) : 0;
    return {
      id: this.id,
      mode: "quote-plus-ohlcv-failover",
      priority: this.providers.map((provider) => provider.id),
      connected: executableSeries > 0,
      cachedSeries: statuses.reduce((sum, status) => sum + (status.cachedSeries ?? 0), 0),
      executableSeries,
      errors: statuses.reduce((sum, status) => sum + (status.errors ?? 0), 0),
      openCircuits: statuses.reduce((sum, status) => sum + (status.openCircuits ?? 0), 0),
      revision: this.getRevision(),
      providers: providerStatuses,
      quality: { status: coverage === 100 ? "healthy" : coverage > 0 ? "degraded" : "blocked", score: coverage, checkedFeeds: total, blocked: total - executableSeries, degraded: 0, totalFaults: total - executableSeries, issues: [], lastObservedAt: new Date(this.now()).toISOString() },
      checkedAt: new Date(this.now()).toISOString(),
    };
  }
}

export class CompositeMarketDataProvider {
  constructor({ crypto, equities, now = () => Date.now() }) {
    this.id = "binance-vn-failover-composite-v2";
    this.crypto = crypto;
    this.equities = equities;
    this.now = now;
    this.refreshTimer = null;
  }

  providerFor(meta) {
    return meta.market === "CRYPTO" ? this.crypto : this.equities;
  }

  async initialize(symbols, timeframes) {
    const [crypto, equities] = await Promise.all([
      this.crypto.initialize(symbols, timeframes),
      this.equities.initialize(symbols, timeframes),
    ]);
    return {
      total: crypto.total + equities.total,
      fulfilled: crypto.fulfilled + equities.fulfilled,
      rejected: crypto.rejected + equities.rejected,
      liveSeries: crypto.liveSeries + equities.liveSeries,
      fallbackSeries: crypto.fallbackSeries + equities.fallbackSeries,
      providers: { crypto, equities },
    };
  }

  getRows(meta, timeframe, count, asOfSeconds) {
    return this.providerFor(meta).getRows(meta, timeframe, count, asOfSeconds);
  }

  ensureRows(meta, timeframe, count) {
    return this.providerFor(meta).ensureRows?.(meta, timeframe, count) ?? false;
  }

  async getQuotes(symbols) {
    const [crypto, equities] = await Promise.allSettled([
      this.crypto.getQuotes(symbols),
      this.equities.getQuotes(symbols),
    ]);
    const cryptoResult = crypto.status === "fulfilled" ? crypto.value : { items: [], indices: [], status: "unavailable" };
    const equityResult = equities.status === "fulfilled" ? equities.value : { items: [], indices: [], status: "unavailable" };
    return {
      items: [...cryptoResult.items, ...equityResult.items],
      indices: [...cryptoResult.indices, ...equityResult.indices],
      providers: { crypto: cryptoResult.status, equities: equityResult.status },
      status: cryptoResult.status === "live" && equityResult.status !== "unavailable" ? "live" : cryptoResult.items.length || equityResult.items.length ? "degraded" : "unavailable",
      observedAt: new Date(this.now()).toISOString(),
    };
  }

  sourceFor(meta, timeframe) {
    return this.providerFor(meta).sourceFor(meta, timeframe);
  }

  isExecutable(meta, timeframe) {
    const provider = this.providerFor(meta);
    const required = new Set(["D1", "H4", timeframe]);
    return [...required].every((requiredTimeframe) => provider.isExecutable(meta, requiredTimeframe));
  }

  seriesStatus(meta, timeframe) {
    const provider = this.providerFor(meta);
    const base = provider.seriesStatus?.(meta, timeframe) ?? {
      symbol: meta.symbol,
      market: meta.market,
      timeframe,
      provider: provider.id,
      source: provider.sourceFor?.(meta, timeframe) ?? provider.id,
      live: provider.isExecutable?.(meta, timeframe) ?? false,
    };
    const requiredTimeframes = [...new Set(["D1", "H4", timeframe])];
    const required = requiredTimeframes.map((requiredTimeframe) => {
      const status = provider.seriesStatus?.(meta, requiredTimeframe);
      return {
        timeframe: requiredTimeframe,
        source: status?.source ?? provider.sourceFor?.(meta, requiredTimeframe) ?? provider.id,
        live: status?.live ?? provider.isExecutable?.(meta, requiredTimeframe) ?? false,
        state: status?.state ?? "unknown",
        lastBarTime: status?.lastBarTime ?? null,
      };
    });
    return {
      ...base,
      seriesExecutable: Boolean(base.live),
      executable: required.every((item) => item.live),
      required,
    };
  }

  seriesStatuses(symbols, timeframes = ["D1", "H4"]) {
    return symbols.flatMap((meta) => timeframes.map((timeframe) => this.seriesStatus(meta, timeframe)));
  }

  getRevision() {
    return `${this.crypto.getRevision()}.${this.equities.getRevision()}`;
  }

  async refreshDue() {
    const beforeRevision = this.getRevision();
    const [crypto, equities] = await Promise.all([this.crypto.refreshDue(), this.equities.refreshDue()]);
    return { status: crypto.status === "ok" && ["ok", "disabled"].includes(equities.status) ? "ok" : "degraded", changed: this.getRevision() !== beforeRevision, providers: { crypto, equities } };
  }

  startAutoRefresh({ intervalMs = 60_000, onUpdate } = {}) {
    if (this.refreshTimer) return this.refreshTimer;
    this.refreshTimer = setInterval(async () => {
      const result = await this.refreshDue();
      if (result.changed) onUpdate?.(result);
    }, intervalMs);
    this.refreshTimer.unref?.();
    return this.refreshTimer;
  }

  stopAutoRefresh() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  status() {
    const crypto = this.crypto.status();
    const equities = this.equities.status();
    const providerStatuses = [crypto, equities];
    const checkedFeeds = providerStatuses.reduce((sum, provider) => sum + (provider.quality.checkedFeeds ?? 0), 0);
    const weightedScore = checkedFeeds
      ? Math.round(providerStatuses.reduce((sum, provider) => sum + provider.quality.score * (provider.quality.checkedFeeds || 0), 0) / checkedFeeds)
      : Math.round((crypto.quality.score + equities.quality.score) / 2);
    const qualityStatus = providerStatuses.some((provider) => provider.quality.status === "blocked")
      ? "blocked"
      : providerStatuses.some((provider) => provider.quality.status !== "healthy") ? "degraded" : "healthy";
    return {
      id: this.id,
      mode: "hybrid",
      connected: crypto.connected || equities.connected,
      cachedSeries: crypto.cachedSeries + equities.cachedSeries,
      executableSeries: crypto.executableSeries + equities.executableSeries,
      errors: crypto.errors + equities.errors,
      openCircuits: crypto.openCircuits + equities.openCircuits,
      revision: this.getRevision(),
      providers: { crypto, equities },
      quality: {
        status: qualityStatus,
        score: weightedScore,
        checkedFeeds,
        blocked: (crypto.quality.blocked ?? 0) + (equities.quality.blocked ?? 0),
        degraded: (crypto.quality.degraded ?? 0) + (equities.quality.degraded ?? 0),
        totalFaults: (crypto.quality.totalFaults ?? 0) + (equities.quality.totalFaults ?? 0),
        issues: [...(crypto.quality.issues ?? []).map((issue) => ({ provider: crypto.id, ...issue })), ...(equities.quality.issues ?? []).map((issue) => ({ provider: equities.id, ...issue }))].slice(0, 40),
        lastObservedAt: [crypto.quality.lastObservedAt, equities.quality.lastObservedAt].filter(Boolean).sort().at(-1) ?? "",
      },
      checkedAt: new Date(this.now()).toISOString(),
    };
  }
}

export async function createMarketDataProvider({ mode = process.env.DATA_PROVIDER ?? "hybrid", now = () => Date.now(), symbols = [], providerOptions = {} } = {}) {
  const fixture = new FixtureMarketDataProvider({ now });
  if (mode === "fixture") {
    if (process.env.NODE_ENV !== "test" && process.env.ALLOW_FIXTURE_DATA !== "true") throw new Error("fixture_data_forbidden:set_ALLOW_FIXTURE_DATA=true_only_for_local_research");
    return {
      provider: fixture,
      bootstrap: { mode, status: "ready", total: 0, fulfilled: 0, rejected: 0 },
      ready: Promise.resolve({ mode, status: "ready", total: 0, fulfilled: 0, rejected: 0 }),
    };
  }
  if (mode !== "hybrid") throw new Error(`unsupported_data_provider:${mode}`);
  const binanceOptions = providerOptions.binance ?? providerOptions;
  const ssiOptions = providerOptions.ssi ?? {};
  const twentyFourHMoneyOptions = providerOptions.twentyFourHMoney ?? {};
  const kbsOptions = providerOptions.kbs ?? {};
  const udfOptions = providerOptions.udf ?? {};
  const equities = new EquityFailoverMarketDataProvider({
    now,
    providers: [
      new TwentyFourHMoneyScreenerProvider({ now, ...twentyFourHMoneyOptions }),
      new SsiFastConnectMarketDataProvider({ now, fallback: null, ...ssiOptions }),
      new KbsMarketDataProvider({ now, ...kbsOptions }),
      new TradingViewUdfMarketDataProvider({ now, ...udfOptions }),
    ],
  });
  const provider = new CompositeMarketDataProvider({
    now,
    crypto: new BinanceRestMarketDataProvider({ now, fallback: null, ...binanceOptions }),
    equities,
  });
  const bootstrap = {
    mode,
    status: "warming",
    total: symbols.length * 2,
    fulfilled: 0,
    rejected: 0,
    liveSeries: 0,
    fallbackSeries: 0,
    startedAt: new Date(now()).toISOString(),
  };
  const ready = provider.initialize(symbols).then((result) => {
    Object.assign(bootstrap, result, { status: result.rejected || result.fallbackSeries ? "degraded" : "ready", completedAt: new Date(now()).toISOString() });
    return bootstrap;
  }).catch((error) => {
    Object.assign(bootstrap, { status: "degraded", error: error.message, completedAt: new Date(now()).toISOString() });
    return bootstrap;
  });
  return { provider, bootstrap, ready };
}
