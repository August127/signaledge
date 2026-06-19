import { performance } from "node:perf_hooks";
import { analyzeSymbol, ema } from "../server/engine.js";
import { defaultScannerConfig } from "../server/scanner-config.js";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function numberArg(name, fallback) {
  const value = Number(arg(name, fallback));
  return Number.isFinite(value) ? value : fallback;
}

function round(value, digits = 4) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function pct(value) {
  return Number.isFinite(value) ? Number((value * 100).toFixed(2)) : 0;
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function signedJson(url, { retries = 5, retryDelayMs = 1400 } = {}) {
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
  throw new Error(`${response.status}:${await response.text()}`);
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

function mergeBuckets(results, variant, group) {
  const bucket = emptyBucket();
  for (const result of results) {
    if (groupOf(result.market) !== group) continue;
    const source = result.variants?.[variant];
    if (!source) continue;
    for (const key of Object.keys(bucket)) bucket[key] += source[key] ?? 0;
  }
  return finalize(bucket);
}

function groupOf(market) {
  if (market === "CRYPTO") return "crypto";
  if (market === "VN_INDEX") return "vn_index";
  return "vn_stock";
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

function dmiAdx(rows, period = 14) {
  if (rows.length < period + 2) return { adx: 0, plusDi: 0, minusDi: 0 };
  let trSmoothed = 0;
  let plusSmoothed = 0;
  let minusSmoothed = 0;
  const dxValues = [];
  for (let index = 1; index < rows.length; index += 1) {
    const current = rows[index];
    const previous = rows[index - 1];
    const upMove = current.high - previous.high;
    const downMove = previous.low - current.low;
    const plusDm = upMove > downMove && upMove > 0 ? upMove : 0;
    const minusDm = downMove > upMove && downMove > 0 ? downMove : 0;
    const tr = Math.max(current.high - current.low, Math.abs(current.high - previous.close), Math.abs(current.low - previous.close));
    if (index <= period) {
      trSmoothed += tr;
      plusSmoothed += plusDm;
      minusSmoothed += minusDm;
      if (index < period) continue;
    } else {
      trSmoothed = trSmoothed - trSmoothed / period + tr;
      plusSmoothed = plusSmoothed - plusSmoothed / period + plusDm;
      minusSmoothed = minusSmoothed - minusSmoothed / period + minusDm;
    }
    const plusDi = trSmoothed ? (100 * plusSmoothed) / trSmoothed : 0;
    const minusDi = trSmoothed ? (100 * minusSmoothed) / trSmoothed : 0;
    const dx = plusDi + minusDi ? (100 * Math.abs(plusDi - minusDi)) / (plusDi + minusDi) : 0;
    dxValues.push({ dx, plusDi, minusDi });
  }
  const tail = dxValues.slice(-period);
  const latest = dxValues.at(-1) ?? { plusDi: 0, minusDi: 0 };
  return {
    adx: tail.length ? tail.reduce((sum, item) => sum + item.dx, 0) / tail.length : 0,
    plusDi: latest.plusDi,
    minusDi: latest.minusDi,
  };
}

function rowsAt(rows, asOfSeconds, count) {
  return rows.filter((row) => row.time <= asOfSeconds).slice(-count);
}

function trendDirection(rows, asOfSeconds) {
  const history = rowsAt(rows, asOfSeconds, 80);
  if (history.length < 50) return "unavailable";
  const fast = ema(history, 20).at(-1);
  const slow = ema(history, 50).at(-1);
  return fast >= slow ? "bull" : "bear";
}

function returnN(rows, asOfSeconds, lookback = 20) {
  const history = rowsAt(rows, asOfSeconds, lookback + 1);
  if (history.length < lookback + 1) return null;
  return history.at(-1).close / history[0].close - 1;
}

function regimePass({ analysis, meta, rowsByTf, asOf, benchmarks }) {
  if (meta.market === "VN_INDEX") return true;
  const direction = analysis.score.direction;
  if (meta.market === "CRYPTO") {
    if (meta.symbol === "BTCUSDT") return true;
    const btcTrend = trendDirection(benchmarks.btc.H4, asOf);
    return btcTrend === direction;
  }
  const vnTrend = trendDirection(benchmarks.vnindex.H4, asOf);
  if (vnTrend !== direction) return false;
  const symbolReturn = returnN(rowsByTf.H4, asOf, 20);
  const indexReturn = returnN(benchmarks.vnindex.H4, asOf, 20);
  if (symbolReturn == null || indexReturn == null) return true;
  return direction === "bull" ? symbolReturn >= indexReturn : symbolReturn <= indexReturn;
}

function variantPass(variant, { analysis, meta, rowsByTf, asOf, benchmarks }) {
  const isVn = meta.market !== "CRYPTO";
  const latestRows = rowsAt(rowsByTf.H4, asOf, 80);
  const dmi = dmiAdx(latestRows);
  const direction = analysis.score.direction;
  const dmiAligned = direction === "bull" ? dmi.plusDi > dmi.minusDi : dmi.minusDi > dmi.plusDi;
  const trendStrength = dmi.adx >= (isVn ? 18 : 20) && dmiAligned;
  const qualityGate =
    analysis.score.evidence.volumePercentile >= (isVn ? 0.45 : 0.38) &&
    analysis.score.evidence.bodyAtr >= (isVn ? 0.22 : 0.18) &&
    analysis.score.evidence.retestQuality >= 7;
  const regime = regimePass({ analysis, meta, rowsByTf, asOf, benchmarks });

  if (variant === "baseline") return true;
  if (variant === "trendStrength") return trendStrength;
  if (variant === "qualityGate") return qualityGate;
  if (variant === "regimeAlign") return regime;
  if (variant === "combined") return trendStrength && qualityGate && regime;
  return false;
}

async function fetchRowsByTf(baseUrl, symbol) {
  const [h4Workspace, d1Workspace] = await Promise.all([
    signedJson(`${baseUrl}/api/workspace/${symbol}?timeframe=H4&confirmationBars=3`),
    signedJson(`${baseUrl}/api/workspace/${symbol}?timeframe=D1&confirmationBars=3`),
  ]);
  const chartH4 = h4Workspace.chart;
  const chartD1 = d1Workspace.chart;
  if (chartH4?.sync?.executionBlocked || chartD1?.sync?.executionBlocked) throw new Error("execution_blocked");
  if (String(chartH4?.sync?.source ?? "").includes("fixture") || String(chartD1?.sync?.source ?? "").includes("fixture")) throw new Error("fixture_source_blocked");
  return { H4: normalizeRows(chartH4?.rows), D1: normalizeRows(chartD1?.rows) };
}

async function mapLimit(items, limit, delayMs, worker) {
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

async function evaluateSymbol({ baseUrl, meta, stride, horizon, benchmarks }) {
  const rowsByTf = await fetchRowsByTf(baseUrl, meta.symbol);
  const rows = rowsByTf.H4;
  if (rows.length < 120) throw new Error(`insufficient_history:${rows.length}`);
  const rowSource = sourceFor(rowsByTf);
  const variants = Object.fromEntries(["baseline", "trendStrength", "qualityGate", "regimeAlign", "combined"].map((name) => [name, emptyBucket()]));
  const warmup = Math.min(rows.length - horizon - 1, Math.max(90, Math.floor(rows.length * 0.38)));
  for (let index = warmup; index < rows.length - horizon; index += stride) {
    const asOf = rows[index].time;
    let analysis;
    try {
      analysis = analyzeSymbol(meta, "H4", 3, asOf, rowSource, { config: defaultScannerConfig, allowPartialMtf: false });
    } catch {
      continue;
    }
    if (analysis.score.classification !== "A+" || !analysis.score.executability?.executable) continue;
    const last = analysis.rows.at(-1);
    const atrValue = analysis.atrValues.at(-1);
    const futureRows = rows.filter((row) => row.time > asOf).slice(0, horizon);
    const outcome = outcomeFor({
      direction: analysis.score.direction,
      entry: last.close,
      stopDistance: atrValue * defaultScannerConfig.riskAtrStopMultiplier,
      tpDistance: atrValue * defaultScannerConfig.riskTp1AtrMultiplier,
      futureRows,
    });
    for (const variant of Object.keys(variants)) {
      if (variantPass(variant, { analysis, meta, rowsByTf, asOf, benchmarks })) addSignal(variants[variant], analysis, outcome);
    }
  }
  return { symbol: meta.symbol, market: meta.market, variants };
}

const baseUrl = String(arg("url", "http://127.0.0.1:8787")).replace(/\/$/, "");
const limit = numberArg("limit", 0);
const stride = Math.max(1, numberArg("stride", 10));
const horizon = Math.max(1, numberArg("horizon", 10));
const concurrency = Math.max(1, numberArg("concurrency", 2));
const requestDelayMs = Math.max(0, numberArg("requestDelayMs", 450));
const startedAt = performance.now();

const scanner = await signedJson(`${baseUrl}/api/scanner?confirmationBars=3`);
const universe = scanner.items
  .map((item) => ({ symbol: item.symbol, venue: item.venue, market: item.market }))
  .filter((item) => ["CRYPTO", "VN30", "MIDCAP", "VN_INDEX"].includes(item.market));
const sample = limit > 0 ? universe.slice(0, limit) : universe;

const [vnindexRows, btcRows] = await Promise.all([
  fetchRowsByTf(baseUrl, "VNINDEX"),
  fetchRowsByTf(baseUrl, "BTCUSDT"),
]);
const benchmarks = { vnindex: vnindexRows, btc: btcRows };

const evaluations = await mapLimit(sample, concurrency, requestDelayMs, async (meta) => {
  try {
    return await evaluateSymbol({ baseUrl, meta, stride, horizon, benchmarks });
  } catch (error) {
    return { symbol: meta.symbol, market: meta.market, error: String(error?.message ?? error) };
  }
});
const ok = evaluations.filter((item) => !item.error);
const failed = evaluations.filter((item) => item.error);
const variantNames = ["baseline", "trendStrength", "qualityGate", "regimeAlign", "combined"];
const groups = Object.fromEntries(["vn_stock", "vn_index", "crypto"].map((group) => [
  group,
  Object.fromEntries(variantNames.map((variant) => [variant, mergeBuckets(ok, variant, group)])),
]));

console.log(JSON.stringify({
  evaluatedSymbols: ok.length,
  failedSymbols: failed.length,
  failed: failed.slice(0, 20).map(({ symbol, market, error }) => ({ symbol, market, error })),
  settings: { stride, horizon, concurrency, requestDelayMs, limit: limit || "all" },
  variants: {
    baseline: "Production conservative A+ as currently configured.",
    trendStrength: "Adds ADX/DMI trend-strength gate: ADX >= 18 VN / 20 crypto and DI aligned with signal direction.",
    qualityGate: "Adds volume/body/retest gate: volume percentile, candle body ATR and retest quality must be sufficient.",
    regimeAlign: "VN aligns with VNINDEX trend and relative strength; crypto aligns with BTC H4 trend.",
    combined: "Requires trendStrength + qualityGate + regimeAlign.",
  },
  groups,
  elapsedMs: round(performance.now() - startedAt, 2),
  caveats: [
    "Research-only experiment; production scanner was not changed.",
    "Uses current real OHLCV returned by local API, conservative SL-first same-bar handling, no fee/slippage/tax.",
    "Evaluate with a longer out-of-sample window before promoting any filter into production.",
  ],
}, null, 2));
