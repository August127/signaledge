import crypto from "node:crypto";
import { analysisRowCount, analyzeSymbol, applyAnalysisExecutionGate, getSymbolMeta, listSymbolMeta, scannerSnapshot } from "./engine.js";
import { FixtureMarketDataProvider } from "./market-data.js";
import { defaultScannerConfig, normalizeScannerConfig } from "./scanner-config.js";

export const CALCULATION_VERSION = "scanner-core-2026.06.16.2";

const timeframeSeconds = { D1: 86400, H4: 14400 };

function candleClose(timeframe, nowSeconds) {
  const duration = timeframeSeconds[timeframe] ?? timeframeSeconds.H4;
  return Math.floor(nowSeconds / duration) * duration;
}

function revision(parts) {
  return crypto.createHash("sha256").update(parts.join(":"), "utf8").digest("base64url").slice(0, 18);
}

export class SnapshotStore {
  constructor({ now = () => Date.now(), maxEntries = Math.max(256, listSymbolMeta().length * 3), provider = new FixtureMarketDataProvider({ now }), scannerConfig = defaultScannerConfig } = {}) {
    this.now = now;
    this.maxEntries = maxEntries;
    this.provider = provider;
    this.scannerConfig = normalizeScannerConfig(scannerConfig);
    this.cache = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  prune() {
    while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value);
  }

  invalidate() {
    this.cache.clear();
  }

  setScannerConfig(scannerConfig) {
    this.scannerConfig = normalizeScannerConfig(scannerConfig);
    this.invalidate();
  }

  memo(key, factory) {
    if (this.cache.has(key)) {
      const value = this.cache.get(key);
      this.cache.delete(key);
      this.cache.set(key, value);
      this.hits += 1;
      return { value, cache: "HIT" };
    }
    const value = factory();
    this.cache.set(key, value);
    this.misses += 1;
    this.prune();
    return { value, cache: "MISS" };
  }

  analysisKey(symbol, timeframe, confirmationBars, asOf, providerRevision) {
    return `analysis:${symbol}:${timeframe}:${confirmationBars}:${asOf}:${providerRevision}:${revision([JSON.stringify(this.scannerConfig)])}:${CALCULATION_VERSION}`;
  }

  prepareAnalysis(analysis, timeframe, confirmationBars, providerRevision, providerStatus = this.provider.status(), applyMarketDataGate = true) {
    const marketDataExecutable = this.provider.isExecutable?.(analysis.meta, timeframe) ?? true;
    if (applyMarketDataGate) applyAnalysisExecutionGate(analysis, "marketData", marketDataExecutable);
    const lastBarTime = analysis.rows.at(-1).time;
    return {
      ...analysis,
      sync: {
        snapshotId: revision([analysis.meta.symbol, timeframe, confirmationBars, lastBarTime, JSON.stringify(this.scannerConfig), CALCULATION_VERSION]),
        scannerConfigRevision: revision([JSON.stringify(this.scannerConfig)]),
        calculationVersion: CALCULATION_VERSION,
        source: this.provider.sourceFor?.(analysis.meta, timeframe) ?? this.provider.id,
        providerRevision,
        dataQuality: providerStatus.quality,
        timeframe,
        lastBarTime,
        asOf: new Date(lastBarTime * 1000).toISOString(),
        generatedAt: new Date(this.now()).toISOString(),
        closedCandle: true,
        rowCount: analysis.rows.length,
        executionBlocked: !marketDataExecutable,
      },
    };
  }

  getAnalysis(symbol, timeframe = "H4", confirmationBars = 3) {
    const nowSeconds = Math.floor(this.now() / 1000);
    const asOf = candleClose(timeframe, nowSeconds);
    const normalizedSymbol = symbol.toUpperCase();
    const providerRevision = this.provider.getRevision?.() ?? 0;
    const key = this.analysisKey(normalizedSymbol, timeframe, confirmationBars, asOf, providerRevision);
    const result = this.memo(key, () => {
      const analysis = analyzeSymbol(getSymbolMeta(normalizedSymbol), timeframe, confirmationBars, nowSeconds, this.provider.getRows.bind(this.provider), { allowPartialMtf: true, config: this.scannerConfig });
      const providerStatus = this.provider.status();
      return this.prepareAnalysis(analysis, timeframe, confirmationBars, providerRevision, providerStatus);
    });
    return result.value;
  }

  getScanner(confirmationBars = 3) {
    const nowSeconds = Math.floor(this.now() / 1000);
    const asOf = candleClose("H4", nowSeconds);
    const providerRevision = this.provider.getRevision?.() ?? 0;
    const key = `scanner:${confirmationBars}:${asOf}:${providerRevision}:${revision([JSON.stringify(this.scannerConfig)])}:${CALCULATION_VERSION}`;
    const result = this.memo(key, () => {
      const analyses = [];
      const unavailable = [];
      const items = scannerSnapshot(confirmationBars, nowSeconds, this.provider.getRows.bind(this.provider), (_meta, analysis) => {
        const marketDataExecutable = this.provider.isExecutable?.(analysis.meta, "H4") ?? true;
        applyAnalysisExecutionGate(analysis, "marketData", marketDataExecutable);
        analyses.push(analysis);
      }, (meta, error) => unavailable.push({
        symbol: meta.symbol,
        venue: meta.venue,
        market: meta.market,
        reason: String(error?.message ?? "market_data_unavailable").slice(0, 120),
      }), { allowPartialMtf: true, config: this.scannerConfig });
      const providerStatus = this.provider.status();
      for (const analysis of analyses) {
        const prepared = this.prepareAnalysis(analysis, "H4", confirmationBars, providerRevision, providerStatus, false);
        const analysisKey = this.analysisKey(analysis.meta.symbol, "H4", confirmationBars, asOf, providerRevision);
        this.cache.set(analysisKey, prepared);
      }
      return {
        items,
        total: items.length,
        universeTotal: listSymbolMeta().length,
        unavailable,
        sync: {
          snapshotId: revision(["scanner", confirmationBars, asOf, JSON.stringify(this.scannerConfig), CALCULATION_VERSION]),
          scannerConfigRevision: revision([JSON.stringify(this.scannerConfig)]),
          calculationVersion: CALCULATION_VERSION,
          source: this.provider.id,
          providerRevision,
          dataQuality: providerStatus.quality,
          timeframe: "H4",
          lastBarTime: asOf,
          asOf: new Date(asOf * 1000).toISOString(),
          generatedAt: new Date(this.now()).toISOString(),
          closedCandle: true,
        },
      };
    });
    return result.value;
  }

  getWorkspace(symbol, timeframe = "H4", confirmationBars = 3) {
    const scanner = this.getScanner(confirmationBars);
    const chart = this.getAnalysis(symbol, timeframe, confirmationBars);
    const selectedScanner = scanner.items.find((item) => item.symbol === chart.meta.symbol) ?? null;
    const sameH4Result = timeframe !== "H4" || (
      selectedScanner?.price === chart.rows.at(-1).close &&
      selectedScanner?.score === chart.score.total &&
      selectedScanner?.classification === chart.score.classification
    );
    return {
      scanner,
      chart,
      selectedScanner,
      synchronization: {
        status: sameH4Result ? "consistent" : "mismatch",
        calculationVersion: CALCULATION_VERSION,
        scannerSnapshotId: scanner.sync.snapshotId,
        chartSnapshotId: chart.sync.snapshotId,
        checkedAt: chart.sync.generatedAt,
      },
    };
  }

  requiredRows(symbol, timeframe) {
    return analysisRowCount(getSymbolMeta(symbol.toUpperCase()), timeframe);
  }

  stats(providerStatus = this.provider.status()) {
    return { entries: this.cache.size, hits: this.hits, misses: this.misses, provider: providerStatus };
  }
}
