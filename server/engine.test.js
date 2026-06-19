import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeSymbol,
  applyExecutabilityGates,
  atr,
  confirmedPivots,
  detectCrystal,
  ema,
  getSymbolMeta,
  heikinAshi,
  listSymbolMeta,
  scannerSnapshot,
} from "./engine.js";
import { FixtureMarketDataProvider } from "./market-data.js";
import { SnapshotStore } from "./snapshot-store.js";

test("Heikin Ashi preserves timestamps and uses synthetic OHLC without mutating source", () => {
  const rows = [
    { time: 1, open: 10, high: 12, low: 9, close: 11, volume: 1 },
    { time: 2, open: 11, high: 13, low: 10, close: 12, volume: 1 },
  ];
  const original = structuredClone(rows);
  const ha = heikinAshi(rows);
  assert.equal(ha.length, rows.length);
  assert.equal(ha[0].time, 1);
  assert.equal(ha[0].close, 10.5);
  assert.deepEqual(rows, original);
});

test("EMA and Wilder ATR match independently calculated reference values", () => {
  const rows = [
    { time: 1, open: 9, high: 11, low: 9, close: 10, volume: 100 },
    { time: 2, open: 10, high: 14, low: 11, close: 13, volume: 100 },
    { time: 3, open: 13, high: 15, low: 12, close: 14, volume: 100 },
  ];
  assert.deepEqual(ema(rows, 3), [10, 11.5, 12.75]);
  assert.deepEqual(atr(rows, 3), [2, 2.66667, 2.77778]);
});

test("flat volume uses a neutral percentile and neutral structure falls back to trend direction", () => {
  const rowSource = (_meta, timeframe, count) => Array.from({ length: count }, (_, index) => {
    const close = 100 + index * 0.2;
    return { time: index * ({ D1: 86400, H4: 14400 }[timeframe]), open: close - 0.1, high: close + 0.4, low: close - 0.4, close, volume: 1000 };
  });
  const analysis = analyzeSymbol(getSymbolMeta("BTCUSDT"), "H4", 3, 1_750_000_000, rowSource);
  assert.equal(analysis.score.evidence.volumePercentile, 0.5);
  assert.equal(analysis.structure.bias, "neutral");
  assert.equal(analysis.score.direction, "bull");
  assert.ok(analysis.score.evidence.emaSlopeAtr > 0);
});

test("Crystal Arrow is emitted only after a later closed candle breaks the reference", () => {
  const rows = [
    { time: 1, open: 10, high: 10.5, low: 9.5, close: 9.8 },
    { time: 2, open: 9.8, high: 11, low: 9.7, close: 10.6 },
    { time: 3, open: 10.6, high: 11.02, low: 10.4, close: 10.9 },
    { time: 4, open: 10.9, high: 11.4, low: 10.8, close: 11.2 },
  ];
  const ha = [
    { time: 1, direction: "bear" },
    { time: 2, direction: "bull" },
    { time: 3, direction: "bull" },
    { time: 4, direction: "bull" },
  ];
  const events = detectCrystal(rows, ha, [1, 1, 1, 1], 3);
  assert.equal(events[0].type, "circle");
  assert.equal(events[0].reference, 11);
  const arrow = events.find((event) => event.type === "arrow");
  assert.equal(arrow.index, 3);
  assert.equal(arrow.barsToConfirm, 2);
});

test("confirmed pivots expose the right-window confirmation timestamp", () => {
  const rows = [9, 10, 11, 15, 12, 10, 9].map((high, index) => ({ time: index + 1, high, low: high - 2, close: high - 1 }));
  const pivot = confirmedPivots(rows, 2, 2).find((item) => item.type === "high" && item.index === 3);
  assert.ok(pivot);
  assert.equal(pivot.confirmedAt, rows[5].time);
  assert.ok(pivot.confirmedAt > pivot.time);
});

test("A+ scanner rows always require fresh Arrow state and MTF alignment", () => {
  const snapshot = scannerSnapshot(3);
  assert.ok(snapshot.length > 0);
  for (const row of snapshot) {
    if (row.classification === "A+") {
      assert.equal(row.crystal, "arrow");
      assert.equal(row.aligned, true);
    }
    if (row.crystal !== "arrow" || !row.aligned) assert.notEqual(row.classification, "A+");
  }
});

test("scanner universe is limited to Vietnam instruments and crypto", () => {
  const symbols = listSymbolMeta();
  assert.ok(symbols.some((item) => item.symbol === "VNINDEX" && item.market === "VN_INDEX"));
  assert.ok(symbols.some((item) => item.symbol === "VN30" && item.market === "VN_INDEX"));
  assert.ok(symbols.some((item) => item.symbol === "NAB" && item.market === "MIDCAP"));
  assert.ok(symbols.some((item) => item.symbol === "SSB" && item.market === "VN30"));
  assert.ok(symbols.some((item) => item.symbol === "TPB" && item.market === "VN30"));
  assert.equal(symbols.some((item) => item.market === "US_STOCK"), false);
  assert.equal(getSymbolMeta("VNINDEX").market, "VN_INDEX");
  assert.equal(getSymbolMeta("VN30").market, "VN_INDEX");
  assert.equal(getSymbolMeta("NAB").market, "MIDCAP");
  assert.equal(getSymbolMeta("SSB").market, "VN30");
  assert.equal(getSymbolMeta("TPB").market, "VN30");
});

test("score remains bounded and component budgets do not exceed 40/30/30", () => {
  const analysis = analyzeSymbol(getSymbolMeta("BTCUSDT"), "H4", 3);
  assert.ok(analysis.score.total >= 0 && analysis.score.total <= 100);
  assert.ok(analysis.score.components.structure <= 40);
  assert.ok(analysis.score.components.momentum <= 30);
  assert.ok(analysis.score.components.entry <= 30);
  assert.equal(analysis.atrBands.upper.length, analysis.rows.length);
  assert.equal(analysis.atrBands.lower.length, analysis.rows.length);
});

test("all indicator arrays remain finite and aligned with source candles", () => {
  const analysis = analyzeSymbol(getSymbolMeta("ETHUSDT"), "H4", 3);
  for (const values of [analysis.ema20, analysis.ema50, analysis.ema200, analysis.atrValues, analysis.atrBands.upper, analysis.atrBands.lower]) {
    assert.equal(values.length, analysis.rows.length);
    assert.ok(values.every(Number.isFinite));
  }
  for (let index = 0; index < analysis.haRows.length; index += 1) {
    const candle = analysis.haRows[index];
    assert.ok(candle.high >= Math.max(candle.open, candle.close));
    assert.ok(candle.low <= Math.min(candle.open, candle.close));
    assert.equal(candle.time, analysis.rows[index].time);
  }
});

test("scanner output is deterministically sorted by gated score", () => {
  const snapshot = scannerSnapshot(3, 1_750_000_000);
  assert.ok(snapshot.every((row, index) => index === 0 || snapshot[index - 1].score >= row.score));
  assert.deepEqual(snapshot, scannerSnapshot(3, 1_750_000_000));
});

test("executability gates apply one auditable cap without changing the raw score", () => {
  const executable = applyExecutabilityGates(92, { trend: true, volatility: true, crystal: true, structure: true, mtf: true });
  assert.equal(executable.total, 92);
  assert.equal(executable.classification, "A+");
  assert.equal(executable.executable, true);

  const blocked = applyExecutabilityGates(92, { trend: true, volatility: true, crystal: false, structure: true, mtf: false });
  assert.equal(blocked.rawTotal, 92);
  assert.equal(blocked.total, 79);
  assert.equal(blocked.classification, "A");
  assert.deepEqual(blocked.failed, ["crystal", "mtf"]);
});

test("workspace keeps H4 scanner and selected chart on the same calculation snapshot", () => {
  const store = new SnapshotStore({ now: () => 1_750_000_000_000 });
  const workspace = store.getWorkspace("BTCUSDT", "H4", 3);
  assert.equal(workspace.synchronization.status, "consistent");
  assert.equal(workspace.selectedScanner.price, workspace.chart.rows.at(-1).close);
  assert.equal(workspace.selectedScanner.score, workspace.chart.score.total);
  assert.equal(workspace.scanner.sync.calculationVersion, workspace.chart.sync.calculationVersion);

  const cached = store.getWorkspace("BTCUSDT", "H4", 3);
  assert.equal(cached.chart.sync.snapshotId, workspace.chart.sync.snapshotId);
  assert.ok(store.stats().hits >= 2);
});

test("cold H4 workspace reuses the scanner analysis for the selected symbol", () => {
  const now = () => 1_750_000_000_000;
  const fixture = new FixtureMarketDataProvider({ now });
  let rowSourceCalls = 0;
  const provider = {
    id: fixture.id,
    getRows(...args) { rowSourceCalls += 1; return fixture.getRows(...args); },
    status: () => fixture.status(),
    sourceFor: () => fixture.id,
    getRevision: () => 0,
  };
  const store = new SnapshotStore({ now, provider });
  store.getWorkspace("BTCUSDT", "H4", 3);
  assert.equal(rowSourceCalls, listSymbolMeta().length * 2);
});

test("scanner snapshot reads provider telemetry once instead of once per asset", () => {
  const now = () => 1_750_000_000_000;
  const fixture = new FixtureMarketDataProvider({ now });
  let statusCalls = 0;
  const provider = {
    id: fixture.id,
    getRows: fixture.getRows.bind(fixture),
    status() { statusCalls += 1; return fixture.status(); },
    sourceFor: fixture.sourceFor.bind(fixture),
    isExecutable: fixture.isExecutable.bind(fixture),
    getRevision: fixture.getRevision.bind(fixture),
  };
  const store = new SnapshotStore({ now, provider });
  store.getScanner(3);
  store.getScanner(3);
  assert.equal(statusCalls, 1);
});
