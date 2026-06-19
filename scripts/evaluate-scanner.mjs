import { performance } from "node:perf_hooks";
import { analyzeSymbol } from "../server/engine.js";
import { defaultScannerConfig, scannerConfigPresets } from "../server/scanner-config.js";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function numberArg(name, fallback) {
  const value = Number(arg(name, fallback));
  return Number.isFinite(value) ? value : fallback;
}

function pct(value) {
  return Number.isFinite(value) ? Number((value * 100).toFixed(2)) : 0;
}

function round(value, digits = 4) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function signedJson(url, { retries = 4, retryDelayMs = 1200 } = {}) {
  let response;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    response = await fetch(url);
    if (response.ok) {
      const payload = await response.json();
      return payload.data ?? payload;
    }
    if (response.status !== 429 || attempt === retries) break;
    await wait(retryDelayMs * (attempt + 1));
  }
  if (!response.ok) throw new Error(`${response.status}:${await response.text()}`);
}

function normalizeRows(rows = []) {
  return rows
    .map((row) => ({
      time: Number(row.time),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume ?? 0),
    }))
    .filter((row) => [row.time, row.open, row.high, row.low, row.close, row.volume].every(Number.isFinite))
    .sort((a, b) => a.time - b.time);
}

function sourceFor(rowsByTf) {
  return (_meta, timeframe, count, asOfSeconds) => {
    const rows = rowsByTf[timeframe] ?? [];
    const available = rows.filter((row) => row.time <= asOfSeconds);
    if (available.length < Math.min(count, 80)) throw new Error(`insufficient_${timeframe}_rows:${available.length}`);
    return available.slice(-count);
  };
}

function outcomeFor({ direction, entry, stopDistance, tpDistance, futureRows }) {
  if (!futureRows.length || !Number.isFinite(entry) || stopDistance <= 0 || tpDistance <= 0) return { result: "invalid", r: 0 };
  const tp = direction === "bull" ? entry + tpDistance : entry - tpDistance;
  const sl = direction === "bull" ? entry - stopDistance : entry + stopDistance;
  for (const row of futureRows) {
    const hitTp = direction === "bull" ? row.high >= tp : row.low <= tp;
    const hitSl = direction === "bull" ? row.low <= sl : row.high >= sl;
    if (hitTp && hitSl) return { result: "sl", r: -1 };
    if (hitTp) return { result: "tp1", r: tpDistance / stopDistance };
    if (hitSl) return { result: "sl", r: -1 };
  }
  const close = futureRows.at(-1).close;
  const signedMove = direction === "bull" ? close - entry : entry - close;
  return { result: "timeout", r: signedMove / stopDistance };
}

function emptyBucket() {
  return { signals: 0, tp1: 0, sl: 0, timeout: 0, invalid: 0, rSum: 0, scoreSum: 0 };
}

function addSignal(bucket, analysis, outcome) {
  bucket.signals += 1;
  bucket[outcome.result] = (bucket[outcome.result] ?? 0) + 1;
  bucket.rSum += outcome.r;
  bucket.scoreSum += analysis.score.total;
}

function finalize(bucket) {
  return {
    signals: bucket.signals,
    tp1: bucket.tp1,
    sl: bucket.sl,
    timeout: bucket.timeout,
    invalid: bucket.invalid,
    winRateTp1: pct(bucket.signals ? bucket.tp1 / bucket.signals : 0),
    stopRate: pct(bucket.signals ? bucket.sl / bucket.signals : 0),
    timeoutRate: pct(bucket.signals ? bucket.timeout / bucket.signals : 0),
    avgScore: round(bucket.signals ? bucket.scoreSum / bucket.signals : 0, 2),
    expectancyR: round(bucket.signals ? bucket.rSum / bucket.signals : 0, 3),
  };
}

function marketGroup(market) {
  if (market === "CRYPTO") return "crypto";
  if (market === "VN_INDEX") return "vn_index";
  return "vn_stock";
}

async function mapLimit(items, limit, worker, delayMs = 0) {
  const results = [];
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      if (delayMs) await wait(delayMs);
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

async function evaluateSymbol({ baseUrl, symbol, meta, stride, horizon, preset }) {
  const [h4Workspace, d1Workspace] = await Promise.all([
    signedJson(`${baseUrl}/api/workspace/${symbol}?timeframe=H4&confirmationBars=3`),
    signedJson(`${baseUrl}/api/workspace/${symbol}?timeframe=D1&confirmationBars=3`),
  ]);
  const chartH4 = h4Workspace.chart;
  const chartD1 = d1Workspace.chart;
  if (chartH4?.sync?.executionBlocked || chartD1?.sync?.executionBlocked) throw new Error("execution_blocked");
  if (String(chartH4?.sync?.source ?? "").includes("fixture") || String(chartD1?.sync?.source ?? "").includes("fixture")) throw new Error("fixture_source_blocked");
  const rowsByTf = { H4: normalizeRows(chartH4?.rows), D1: normalizeRows(chartD1?.rows) };
  const rows = rowsByTf.H4;
  if (rows.length < 120) throw new Error(`insufficient_history:${rows.length}`);

  const buckets = {
    aPlus: emptyBucket(),
    aWatch: emptyBucket(),
    arrow: emptyBucket(),
  };
  const rowSource = sourceFor(rowsByTf);
  const config = preset.values ?? defaultScannerConfig;
  const warmup = Math.min(rows.length - horizon - 1, Math.max(90, Math.floor(rows.length * 0.38)));
  for (let index = warmup; index < rows.length - horizon; index += stride) {
    const asOf = rows[index].time;
    let analysis;
    try {
      analysis = analyzeSymbol(meta, "H4", 3, asOf, rowSource, { config, allowPartialMtf: false });
    } catch {
      continue;
    }
    const last = analysis.rows.at(-1);
    const atrValue = analysis.atrValues.at(-1);
    const stopDistance = atrValue * config.riskAtrStopMultiplier;
    const tpDistance = atrValue * config.riskTp1AtrMultiplier;
    const futureRows = rows.filter((row) => row.time > asOf).slice(0, horizon);
    const outcome = outcomeFor({ direction: analysis.score.direction, entry: last.close, stopDistance, tpDistance, futureRows });
    if (analysis.score.classification === "A+" && analysis.score.executability?.executable) addSignal(buckets.aPlus, analysis, outcome);
    if (analysis.score.classification === "A") addSignal(buckets.aWatch, analysis, outcome);
    if (analysis.score.evidence.crystal === "confirmed") addSignal(buckets.arrow, analysis, outcome);
  }

  return {
    symbol,
    market: meta.market,
    source: chartH4?.sync?.source,
    rows: rows.length,
    buckets,
  };
}

function mergeBuckets(results, selector) {
  const bucket = emptyBucket();
  for (const result of results) {
    const source = selector(result);
    if (!source) continue;
    for (const key of Object.keys(bucket)) bucket[key] += source[key] ?? 0;
  }
  return finalize(bucket);
}

const baseUrl = String(arg("url", "http://127.0.0.1:8787")).replace(/\/$/, "");
const limit = numberArg("limit", 0);
const concurrency = Math.max(1, numberArg("concurrency", 8));
const requestDelayMs = Math.max(0, numberArg("requestDelayMs", 0));
const stride = Math.max(1, numberArg("stride", 8));
const horizon = Math.max(1, numberArg("horizon", 10));
const presetId = String(arg("preset", "production-conservative"));
const preset = scannerConfigPresets.find((item) => item.id === presetId) ?? scannerConfigPresets[0];

const startedAt = performance.now();
const scanner = await signedJson(`${baseUrl}/api/scanner?confirmationBars=3`);
const universe = scanner.items
  .map((item) => ({ symbol: item.symbol, meta: { symbol: item.symbol, venue: item.venue, market: item.market } }))
  .filter((item) => item.meta.market === "CRYPTO" || item.meta.market === "VN30" || item.meta.market === "MIDCAP" || item.meta.market === "VN_INDEX");
const sample = limit > 0 ? universe.slice(0, limit) : universe;
const evaluations = await mapLimit(sample, concurrency, async (item) => {
  try {
    return await evaluateSymbol({ baseUrl, symbol: item.symbol, meta: item.meta, stride, horizon, preset });
  } catch (error) {
    return { symbol: item.symbol, market: item.meta.market, error: String(error?.message ?? error) };
  }
}, requestDelayMs);
const ok = evaluations.filter((item) => !item.error);
const failed = evaluations.filter((item) => item.error);
const groups = Object.fromEntries(["vn_stock", "vn_index", "crypto"].map((group) => {
  const results = ok.filter((item) => marketGroup(item.market) === group);
  return [group, {
    symbols: results.length,
    aPlus: mergeBuckets(results, (item) => item.buckets.aPlus),
    aWatch: mergeBuckets(results, (item) => item.buckets.aWatch),
    arrow: mergeBuckets(results, (item) => item.buckets.arrow),
  }];
}));

console.log(JSON.stringify({
  preset: preset.id,
  baseUrl,
  evaluatedSymbols: ok.length,
  failedSymbols: failed.length,
  failed: failed.slice(0, 20).map((item) => ({ symbol: item.symbol, market: item.market, error: item.error })),
  settings: { stride, horizon, concurrency, requestDelayMs, limit: limit || "all" },
  groups,
  elapsedMs: round(performance.now() - startedAt, 2),
  caveats: [
    "Walk-forward evaluation uses historical OHLCV currently returned by the live local API.",
    "No fees, tax, slippage, liquidity constraint, or same-bar intrabar ordering beyond conservative SL-first handling.",
    "This is a scanner-quality evaluation harness, not a reintroduced product backtest module.",
  ],
}, null, 2));
