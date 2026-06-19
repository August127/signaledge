import { defaultScannerConfig, normalizeScannerConfig } from "./scanner-config.js";

const TIMEFRAME_MINUTES = { D1: 1440, H4: 240, H1: 60, M15: 15 };
export const SCANNER_TIMEFRAMES = ["D1", "H4"];

const CRYPTO_SYMBOLS = [
  "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT", "TRXUSDT", "TONUSDT", "AVAXUSDT",
  "SHIBUSDT", "LINKUSDT", "DOTUSDT", "BCHUSDT", "NEARUSDT", "LTCUSDT", "UNIUSDT", "APTUSDT", "ICPUSDT", "ETCUSDT",
  "XLMUSDT", "ATOMUSDT", "FILUSDT", "HBARUSDT", "ARBUSDT", "OPUSDT", "INJUSDT", "IMXUSDT", "RENDERUSDT", "STXUSDT",
  "SUIUSDT", "SEIUSDT", "AAVEUSDT", "GRTUSDT", "RUNEUSDT", "ALGOUSDT", "JUPUSDT", "PYTHUSDT", "FETUSDT", "WLDUSDT",
  "LDOUSDT", "ENSUSDT", "QNTUSDT", "FLOWUSDT", "SANDUSDT", "MANAUSDT", "AXSUSDT", "THETAUSDT", "GALAUSDT", "CHZUSDT",
  "EGLDUSDT", "KAVAUSDT", "KSMUSDT", "MINAUSDT", "ROSEUSDT", "ZILUSDT", "DYDXUSDT", "GMTUSDT", "GMXUSDT", "COMPUSDT",
  "ONDOUSDT", "CRVUSDT", "SNXUSDT", "1INCHUSDT", "CAKEUSDT", "RAYUSDT", "JTOUSDT", "TIAUSDT", "JASMYUSDT", "PEPEUSDT",
  "FLOKIUSDT", "BONKUSDT", "WIFUSDT", "PENDLEUSDT", "ENAUSDT", "STRKUSDT", "ZKUSDT", "ZROUSDT", "POLUSDT", "VETUSDT",
  "IOTAUSDT", "XTZUSDT", "NEOUSDT", "QTUMUSDT", "KAIAUSDT", "EIGENUSDT", "SUSHIUSDT", "ZRXUSDT", "ANKRUSDT", "CELOUSDT",
  "BLURUSDT", "APEUSDT", "MASKUSDT", "SSVUSDT", "API3USDT", "BANDUSDT", "SKLUSDT", "YFIUSDT", "UMAUSDT", "RSRUSDT",
];
const VN30_SYMBOLS = [
  "ACB", "BCM", "BID", "BVH", "CTG", "FPT", "GAS", "GVR", "HDB", "HPG",
  "LPB", "MBB", "MSN", "MWG", "PLX", "SAB", "SHB", "SSB", "SSI", "STB",
  "TCB", "TPB", "VCB", "VHM", "VIB", "VIC", "VJC", "VNM", "VPB", "VRE",
];
const MIDCAP_SYMBOLS = [
  "ANV", "BCG", "BMP", "BSR", "CII", "CSV", "CTD", "DBC", "DCM", "DGC",
  "DGW", "DIG", "DPM", "DXG", "EIB", "FRT", "GEX", "GMD", "HAH", "HCM",
  "HSG", "KBC", "KDH", "NAB", "NLG", "NKG", "OCB", "PC1", "PDR", "PNJ", "POW",
  "PVD", "PVT", "REE", "SBT", "SZC", "TCH", "VCG", "VCI", "VHC", "VND",
];
const VN_INDEX_SYMBOLS = ["VNINDEX", "VN30"];
const BASE_OVERRIDES = new Map(Object.entries({
  BTCUSDT: 67879, ETHUSDT: 3678, SOLUSDT: 158, BNBUSDT: 602, XRPUSDT: 0.52,
  ADAUSDT: 0.44, LINKUSDT: 14.8, NEARUSDT: 3.1, POLUSDT: 0.2, ICPUSDT: 5.6,
  FPT: 132.2, VCB: 61.4, HPG: 27.6, MSN: 78.4, VNM: 62.8, GAS: 67.2,
  DIG: 19.4, NAB: 15.2, PNJ: 91.5, VNINDEX: 1791, VN30: 1944,
}));

function symbolProfile(symbol, venue, market, index) {
  const crypto = market === "CRYPTO";
  const base = BASE_OVERRIDES.get(symbol) ?? (crypto ? 1 + index * 8 : 12 + (index % 30) * 3.2);
  const driftSeed = ((symbol.charCodeAt(0) + symbol.charCodeAt(symbol.length - 1)) % 9) - 4;
  return {
    symbol,
    venue,
    market,
    base,
    drift: crypto ? 0.0001 + driftSeed * 0.00004 : driftSeed * 0.000035,
    vol: crypto ? 0.021 + (index % 5) * 0.002 : 0.012 + (index % 6) * 0.002,
  };
}

const DEFAULT_SYMBOLS = [
  ...VN_INDEX_SYMBOLS.map((symbol, index) => symbolProfile(symbol, "HOSE", "VN_INDEX", index)),
  ...CRYPTO_SYMBOLS.map((symbol, index) => symbolProfile(symbol, "BINANCE", "CRYPTO", index)),
  ...VN30_SYMBOLS.map((symbol, index) => symbolProfile(symbol, "HOSE", "VN30", index)),
  ...MIDCAP_SYMBOLS.map((symbol, index) => symbolProfile(symbol, "HOSE", "MIDCAP", index)),
];

function parseConfiguredSymbols(value, market, venue) {
  if (!value) return [];
  return value.split(",").map((symbol) => symbol.trim().toUpperCase()).filter(Boolean).map((rawSymbol) => {
    const [venueHint, symbolHint] = rawSymbol.includes(":") ? rawSymbol.split(":", 2) : [venue, rawSymbol];
    const symbol = symbolHint || venueHint;
    const resolvedVenue = symbolHint ? venueHint : venue;
    return {
    symbol,
    venue: resolvedVenue,
    market,
    base: 1,
    drift: 0,
    vol: market === "CRYPTO" ? 0.025 : 0.015,
    };
  });
}

function configuredUniverse() {
  const configured = [
    ...parseConfiguredSymbols(process.env.CRYPTO_SYMBOLS, "CRYPTO", "BINANCE"),
    ...parseConfiguredSymbols(process.env.VN_INDEX_SYMBOLS, "VN_INDEX", "HOSE"),
    ...parseConfiguredSymbols(process.env.VN30_SYMBOLS, "VN30", "HOSE"),
    ...parseConfiguredSymbols(process.env.MIDCAP_SYMBOLS, "MIDCAP", "HOSE"),
  ];
  if (!configured.length) return DEFAULT_SYMBOLS;
  const defaults = new Map(DEFAULT_SYMBOLS.map((item) => [item.symbol, item]));
  return [...new Map(configured.map((item) => [item.symbol, { ...item, ...(defaults.get(item.symbol) ?? {}) }])).values()];
}

const SYMBOLS = configuredUniverse();

export function analysisRowCount(meta, timeframe) {
  if (timeframe === "H4") return 560;
  if (timeframe === "D1") return 260;
  return 260;
}

function hash(input) {
  let value = 2166136261;
  for (const char of input) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return value >>> 0;
}

function random(seed) {
  let state = seed || 1;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (value) => Number(value.toFixed(value >= 1000 ? 2 : value >= 10 ? 3 : 5));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function generateOhlcv(meta, timeframe = "H4", count = 220, asOfSeconds = Math.floor(Date.now() / 1000)) {
  const rng = random(hash(`${meta.symbol}:${timeframe}`));
  const minutes = TIMEFRAME_MINUTES[timeframe] ?? 240;
  const end = Math.floor(asOfSeconds / (minutes * 60)) * minutes * 60 - minutes * 60;
  let price = meta.base * 0.72;
  const rows = [];

  for (let index = 0; index < count; index += 1) {
    const cycle = Math.sin(index / 13) * meta.vol * 0.22 + Math.sin(index / 31) * meta.vol * 0.18;
    const regime = index > count * 0.58 ? meta.drift * 1.8 : meta.drift * 0.45;
    const shock = (rng() - 0.48) * meta.vol;
    const open = price;
    const close = Math.max(0.00001, open * (1 + regime + cycle * 0.12 + shock * 0.35));
    const spread = Math.max(meta.vol * 0.34, Math.abs(close / open - 1) * 0.7);
    const high = Math.max(open, close) * (1 + rng() * spread);
    const low = Math.min(open, close) * (1 - rng() * spread);
    const impulse = Math.abs(close - open) / Math.max(open, 0.00001);
    const volume = Math.round((800000 + rng() * 4200000) * (1 + impulse / meta.vol * 1.8));
    rows.push({
      time: end - (count - 1 - index) * minutes * 60,
      open: round(open), high: round(high), low: round(low), close: round(close), volume,
    });
    price = close;
  }

  const scale = meta.base / rows.at(-1).close;
  return rows.map((row) => ({
    ...row,
    open: round(row.open * scale), high: round(row.high * scale),
    low: round(row.low * scale), close: round(row.close * scale),
  }));
}

export function ema(rows, period, field = "close") {
  const multiplier = 2 / (period + 1);
  let current = rows[0][field];
  return rows.map((row) => {
    current = row[field] * multiplier + current * (1 - multiplier);
    return round(current);
  });
}

export function atr(rows, period = 14) {
  let previousClose = rows[0].close;
  let current = rows[0].high - rows[0].low;
  return rows.map((row, index) => {
    const tr = Math.max(row.high - row.low, Math.abs(row.high - previousClose), Math.abs(row.low - previousClose));
    current = index === 0 ? tr : (current * (period - 1) + tr) / period;
    previousClose = row.close;
    return round(current);
  });
}

export function heikinAshi(rows) {
  let previousOpen = (rows[0].open + rows[0].close) / 2;
  let previousClose = (rows[0].open + rows[0].high + rows[0].low + rows[0].close) / 4;
  return rows.map((row, index) => {
    const close = (row.open + row.high + row.low + row.close) / 4;
    const open = index === 0 ? previousOpen : (previousOpen + previousClose) / 2;
    const high = Math.max(row.high, open, close);
    const low = Math.min(row.low, open, close);
    previousOpen = open;
    previousClose = close;
    return { time: row.time, open: round(open), high: round(high), low: round(low), close: round(close), direction: close >= open ? "bull" : "bear" };
  });
}

function percentile(values, target) {
  if (!values.length) return 0;
  const lower = values.filter((value) => value < target).length;
  const equal = values.filter((value) => value === target).length;
  return (lower + equal * 0.5) / values.length;
}

export function confirmedPivots(rows, left = 3, right = 3) {
  const pivots = [];
  for (let index = left; index < rows.length - right; index += 1) {
    const window = rows.slice(index - left, index + right + 1);
    const high = Math.max(...window.map((row) => row.high));
    const low = Math.min(...window.map((row) => row.low));
    if (rows[index].high === high) pivots.push({ type: "high", price: rows[index].high, time: rows[index].time, confirmedAt: rows[index + right].time, index });
    if (rows[index].low === low) pivots.push({ type: "low", price: rows[index].low, time: rows[index].time, confirmedAt: rows[index + right].time, index });
  }
  return pivots;
}

export function detectStructure(rows, pivots, atrValues, config = defaultScannerConfig) {
  const events = [];
  let lastHigh = null;
  let lastLow = null;
  let bias = "neutral";
  let pivotCursor = 0;

  for (let index = 1; index < rows.length; index += 1) {
    while (pivotCursor < pivots.length && pivots[pivotCursor].confirmedAt <= rows[index].time) {
      const pivot = pivots[pivotCursor];
      if (pivot.type === "high") lastHigh = pivot;
      else lastLow = pivot;
      pivotCursor += 1;
    }
    const row = rows[index];
    const previous = rows[index - 1];
    const buffer = atrValues[index] * config.structureBosAtrBuffer;
    if (lastHigh && previous.close <= lastHigh.price + buffer && row.close > lastHigh.price + buffer) {
      const type = bias === "bear" ? "CHOCH" : "BOS";
      events.push({ type, direction: "bull", time: row.time, level: lastHigh.price, index, pivot: lastHigh });
      bias = "bull";
      lastHigh = null;
    }
    if (lastLow && previous.close >= lastLow.price - buffer && row.close < lastLow.price - buffer) {
      const type = bias === "bull" ? "CHOCH" : "BOS";
      events.push({ type, direction: "bear", time: row.time, level: lastLow.price, index, pivot: lastLow });
      bias = "bear";
      lastLow = null;
    }
  }
  return { events, bias };
}

export function detectSpartan123(rows, pivots, atrValues, config = defaultScannerConfig) {
  const alternating = [];
  for (const pivot of pivots) {
    const previous = alternating.at(-1);
    if (previous?.type === pivot.type) {
      const moreExtreme = pivot.type === "high" ? pivot.price > previous.price : pivot.price < previous.price;
      if (moreExtreme) alternating[alternating.length - 1] = pivot;
    } else {
      alternating.push(pivot);
    }
  }

  const events = [];
  for (let cursor = 2; cursor < alternating.length; cursor += 1) {
    const [p1, p2, p3] = alternating.slice(cursor - 2, cursor + 1);
    const bull = p1.type === "low" && p2.type === "high" && p3.type === "low" && p3.price > p1.price + atrValues[p3.index] * config.spartanP3AtrBuffer;
    const bear = p1.type === "high" && p2.type === "low" && p3.type === "high" && p3.price < p1.price - atrValues[p3.index] * config.spartanP3AtrBuffer;
    if (!bull && !bear) continue;
    const direction = bull ? "bull" : "bear";
    const startIndex = rows.findIndex((row) => row.time >= p3.confirmedAt);
    for (let index = Math.max(startIndex, p3.index + 1); index < Math.min(rows.length, p3.index + 16); index += 1) {
      const buffer = atrValues[index] * config.spartanBreakAtrBuffer;
      const confirmed = direction === "bull" ? rows[index].close > p2.price + buffer : rows[index].close < p2.price - buffer;
      if (confirmed) {
        events.push({ type: "123", direction, time: rows[index].time, index, p1, p2, p3, trigger: p2.price });
        break;
      }
    }
  }
  return events;
}

export function detectLiquiditySweeps(rows, pivots, atrValues, config = defaultScannerConfig) {
  const events = [];
  let lastHigh = null;
  let lastLow = null;
  let pivotCursor = 0;
  for (let index = 1; index < rows.length; index += 1) {
    while (pivotCursor < pivots.length && pivots[pivotCursor].confirmedAt <= rows[index].time) {
      const pivot = pivots[pivotCursor];
      if (pivot.type === "high") lastHigh = pivot;
      else lastLow = pivot;
      pivotCursor += 1;
    }
    const row = rows[index];
    const buffer = atrValues[index] * config.liquiditySweepAtrBuffer;
    if (lastHigh && row.high > lastHigh.price + buffer && row.close < lastHigh.price) {
      events.push({ type: "sweep", direction: "bear", time: row.time, index, level: lastHigh.price });
      lastHigh = null;
    }
    if (lastLow && row.low < lastLow.price - buffer && row.close > lastLow.price) {
      events.push({ type: "sweep", direction: "bull", time: row.time, index, level: lastLow.price });
      lastLow = null;
    }
  }
  return events;
}

export function detectCrystal(rows, haRows, atrValues, confirmationBars = 3, config = defaultScannerConfig) {
  const events = [];
  let pending = null;
  let cooldownUntil = -1;
  for (let index = 1; index < rows.length; index += 1) {
    const directionChanged = haRows[index].direction !== haRows[index - 1].direction;
    if (directionChanged && index > cooldownUntil) {
      pending = {
        direction: haRows[index].direction,
        index,
        time: rows[index].time,
        reference: haRows[index].direction === "bull" ? rows[index].high : rows[index].low,
        expiresAt: index + confirmationBars,
      };
      events.push({ type: "circle", ...pending });
    }
    if (!pending || index <= pending.index) continue;
    const buffer = atrValues[index] * config.crystalBreakAtrBuffer;
    const confirmed = pending.direction === "bull"
      ? rows[index].close > pending.reference + buffer
      : rows[index].close < pending.reference - buffer;
    if (confirmed) {
      events.push({ type: "arrow", direction: pending.direction, time: rows[index].time, index, reference: pending.reference, barsToConfirm: index - pending.index });
      cooldownUntil = index + 2;
      pending = null;
    } else if (index >= pending.expiresAt) {
      events.push({ type: "expired", direction: pending.direction, time: rows[index].time, index, reference: pending.reference });
      pending = null;
    }
  }
  return events;
}

function findOrderBlock(rows, structureEvents) {
  const event = [...structureEvents].reverse().find((item) => item.type === "BOS");
  if (!event) return null;
  const opposite = event.direction === "bull" ? "bear" : "bull";
  for (let index = event.index - 1; index >= Math.max(0, event.index - 8); index -= 1) {
    const direction = rows[index].close >= rows[index].open ? "bull" : "bear";
    if (direction === opposite) {
      return {
        direction: event.direction,
        low: Math.min(rows[index].open, rows[index].low),
        high: Math.max(rows[index].open, rows[index].high),
        originTime: rows[index].time,
        valid: event.direction === "bull" ? rows.at(-1).close > rows[index].low : rows.at(-1).close < rows[index].high,
      };
    }
  }
  return null;
}

function classificationFor(total) {
  return total >= 80 ? "A+" : total >= 60 ? "A" : total >= 45 ? "B" : "C";
}

export function applyExecutabilityGates(rawTotal, gates) {
  const normalizedRawTotal = clamp(Math.round(rawTotal), 0, 100);
  const failed = Object.entries(gates).filter(([, passed]) => !passed).map(([name]) => name);
  const total = failed.length ? Math.min(normalizedRawTotal, 79) : normalizedRawTotal;
  return {
    rawTotal: normalizedRawTotal,
    total,
    classification: classificationFor(total),
    executable: failed.length === 0,
    gates: { ...gates },
    failed,
  };
}

export function applyAnalysisExecutionGate(analysis, gate, passed) {
  const gates = { ...(analysis.score.executability?.gates ?? {}), [gate]: Boolean(passed) };
  const result = applyExecutabilityGates(analysis.score.rawTotal ?? analysis.score.total, gates);
  analysis.score.rawTotal = result.rawTotal;
  analysis.score.total = result.total;
  analysis.score.classification = result.classification;
  analysis.score.executability = result;
  return analysis;
}

function scoreAnalysis(rows, context) {
  const { atrValues, ema20, ema50, ema200, structure, crystal, pivots, orderBlock, spartan, liquiditySweeps } = context;
  const last = rows.at(-1);
  const index = rows.length - 1;
  const recentVolumes = rows.slice(-50, -1).map((row) => row.volume);
  const volumePercentile = percentile(recentVolumes, last.volume);
  const atrPercentile = percentile(atrValues.slice(-80, -1), atrValues.at(-1));
  const bodyAtr = Math.abs(last.close - last.open) / Math.max(atrValues.at(-1), 0.00001);
  const slopeLookback = Math.min(5, index);
  const emaSlopeAtr = (ema20[index] - ema20[index - slopeLookback]) / Math.max(atrValues.at(-1), 0.00001);
  const trendBull = last.close > ema20[index] && ema20[index] > ema50[index] && ema50[index] > ema200[index] && emaSlopeAtr > 0;
  const trendBear = last.close < ema20[index] && ema20[index] < ema50[index] && ema50[index] < ema200[index] && emaSlopeAtr < 0;
  const trendAligned = trendBull || trendBear;
  const latestStructure = structure.events.at(-1);
  const latestArrow = [...crystal].reverse().find((event) => event.type === "arrow");
  const latestCrystalDecision = [...crystal].reverse().find((event) => event.type === "arrow" || event.type === "circle");
  const crystalFresh = latestCrystalDecision?.type === "arrow" && index - latestCrystalDecision.index <= 18;
  const structuralDirection = structure.bias === "bull" || structure.bias === "bear" ? structure.bias : null;
  const trendDirection = trendBull ? "bull" : trendBear ? "bear" : last.close >= ema20[index] ? "bull" : "bear";
  const direction = crystalFresh ? latestCrystalDecision.direction : structuralDirection ?? trendDirection;
  const structureAligned = latestStructure?.direction === direction;
  const cleanPivotCount = pivots.filter((pivot) => pivot.index > index - 60).length;
  const rangeAtr = (Math.max(...rows.slice(-35).map((row) => row.high)) - Math.min(...rows.slice(-35).map((row) => row.low))) / Math.max(atrValues.at(-1), 0.00001);
  const latestSpartan = [...spartan].reverse().find((event) => index - event.index <= 45);
  const latestSweep = [...liquiditySweeps].reverse().find((event) => index - event.index <= 25 && event.direction === direction);
  const confluenceScore = (orderBlock?.valid ? 4 : orderBlock ? 2 : 0) + (latestSpartan ? 3 : 0) + (latestSweep ? 1 : 0);

  const structureScore = clamp(
    (trendAligned ? 8 : 3) +
    clamp(cleanPivotCount, 2, 8) +
    (latestStructure ? (latestStructure.type === "BOS" ? 10 : 7) : 2) +
    clamp(rangeAtr * 0.55, 2, 6) +
    confluenceScore, 0, 40,
  );
  const momentumScore = clamp(
    clamp(volumePercentile * 8, 1, 8) +
    clamp(bodyAtr * 7, 1, 7) +
    (trendAligned ? 6 : 2) +
    (crystalFresh ? 6 : latestCrystalDecision?.type === "circle" ? 2 : 0) +
    clamp(atrPercentile * 3, 0, 3), 0, 30,
  );
  const retestDistance = Math.abs(last.close - ema20[index]) / Math.max(atrValues.at(-1), 0.00001);
  const retestQuality = retestDistance < 0.75 ? 10 : retestDistance < 1.25 ? 7 : 3;
  const body = Math.max(Math.abs(last.close - last.open), atrValues.at(-1) * 0.05);
  const lowerWick = Math.min(last.close, last.open) - last.low;
  const upperWick = last.high - Math.max(last.close, last.open);
  const rejection = direction === "bull" ? lowerWick > body * 0.8 : upperWick > body * 0.8;
  const rr = clamp(1.5 + rangeAtr / 8, 1, 3.4);
  const entryScore = clamp(
    retestQuality + (rejection ? 6 : 2) + (crystalFresh ? 6 : latestCrystalDecision?.type === "circle" ? 2 : 0) +
    clamp(rr * 1.8, 2, 6) + (structureAligned ? 3 : 1), 0, 30,
  );
  const total = Math.round(structureScore + momentumScore + entryScore);
  const classification = classificationFor(total);
  return {
    total, rawTotal: total, classification, direction,
    components: {
      structure: Math.round(structureScore), momentum: Math.round(momentumScore), entry: Math.round(entryScore),
    },
    evidence: {
      trendAligned, structureAligned, volumePercentile: round(volumePercentile), atrPercentile: round(atrPercentile),
      bodyAtr: round(bodyAtr), emaSlopeAtr: round(emaSlopeAtr), rr: round(rr), retestQuality, rejection,
      crystal: crystalFresh ? "confirmed" : latestCrystalDecision?.type === "circle" ? "early" : "none",
      barsToConfirm: latestArrow?.barsToConfirm ?? null,
      spartan123: latestSpartan ? latestSpartan.direction : "none",
      liquiditySweep: latestSweep ? latestSweep.direction : "none",
    },
  };
}

export function analyzeSymbol(meta, timeframe = "H4", confirmationBars = 3, asOfSeconds = Math.floor(Date.now() / 1000), rowSource = generateOhlcv, options = {}) {
  const config = normalizeScannerConfig(options.config);
  const rows = rowSource(meta, timeframe, analysisRowCount(meta, timeframe), asOfSeconds);
  const atrValues = atr(rows);
  const ema20 = ema(rows, 20);
  const ema50 = ema(rows, 50);
  const ema200 = ema(rows, 200);
  const haRows = heikinAshi(rows);
  const pivots = confirmedPivots(rows);
  const structure = detectStructure(rows, pivots, atrValues, config);
  const spartan = detectSpartan123(rows, pivots, atrValues, config);
  const liquiditySweeps = detectLiquiditySweeps(rows, pivots, atrValues, config);
  const crystal = detectCrystal(rows, haRows, atrValues, confirmationBars, config);
  const orderBlock = findOrderBlock(rows, structure.events);
  const atrBands = {
    upper: ema20.map((value, index) => round(value + atrValues[index] * config.atrBandMultiplier)),
    lower: ema20.map((value, index) => round(value - atrValues[index] * config.atrBandMultiplier)),
  };
  const score = scoreAnalysis(rows, { atrValues, ema20, ema50, ema200, structure, crystal, pivots, orderBlock, spartan, liquiditySweeps });
  const mtf = SCANNER_TIMEFRAMES.map((tf) => {
    try {
      const mtfCount = analysisRowCount(meta, tf);
      const tfRows = tf === timeframe ? rows.slice(-mtfCount) : rowSource(meta, tf, mtfCount, asOfSeconds);
      const fast = ema(tfRows, 20).at(-1);
      const slow = ema(tfRows, 50).at(-1);
      return { timeframe: tf, direction: fast >= slow ? "bull" : "bear", available: true };
    } catch (error) {
      if (!options.allowPartialMtf) throw error;
      return { timeframe: tf, direction: "unavailable", available: false, reason: String(error?.message ?? "market_data_unavailable").slice(0, 120) };
    }
  });
  const mtfComplete = mtf.every((item) => item.available !== false);
  const aligned = mtfComplete && mtf.every((item) => item.direction === mtf[0].direction);
  const executability = applyExecutabilityGates(score.rawTotal, {
    trend: score.evidence.trendAligned,
    volatility: score.evidence.atrPercentile >= config.volatilityGateAtrPercentile,
    crystal: score.evidence.crystal === "confirmed",
    structure: score.evidence.structureAligned,
    mtf: aligned,
  });
  score.total = executability.total;
  score.classification = executability.classification;
  score.executability = executability;
  return { meta, timeframe, rows, haRows, atrValues, atrBands, ema20, ema50, ema200, pivots, structure, spartan, liquiditySweeps, crystal, orderBlock, score, mtf, aligned, mtfComplete, scannerConfig: config };
}

export function scannerSnapshot(confirmationBars = 3, asOfSeconds = Math.floor(Date.now() / 1000), rowSource = generateOhlcv, onAnalysis, onUnavailable, options = {}) {
  const items = [];
  for (const meta of SYMBOLS) {
    try {
      const analysis = analyzeSymbol(meta, "H4", confirmationBars, asOfSeconds, rowSource, options);
      onAnalysis?.(meta, analysis);
      const last = analysis.rows.at(-1);
      const previous = analysis.rows.at(-2);
      const latestCrystal = [...analysis.crystal].reverse().find((event) => event.type === "arrow" || event.type === "circle");
      const crystalFresh = latestCrystal && analysis.rows.length - 1 - latestCrystal.index <= 18;
      items.push({
        symbol: meta.symbol, venue: meta.venue, market: meta.market,
        price: last.close, change: round(((last.close / previous.close) - 1) * 100),
        score: analysis.score.total, classification: analysis.score.classification,
        direction: analysis.score.direction, crystal: crystalFresh ? latestCrystal.type : "none",
        barsToConfirm: analysis.score.evidence.barsToConfirm,
        mtf: analysis.mtf, aligned: analysis.aligned,
      });
    } catch (error) {
      onUnavailable?.(meta, error);
    }
  }
  return items.sort((a, b) => b.score - a.score);
}

export function getSymbolMeta(symbol) {
  return SYMBOLS.find((item) => item.symbol === symbol) ?? SYMBOLS[0];
}

export function listSymbolMeta() {
  return SYMBOLS.map((item) => ({ ...item }));
}
