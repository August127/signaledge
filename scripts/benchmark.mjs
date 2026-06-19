import { performance } from "node:perf_hooks";
import { scannerSnapshot } from "../server/engine.js";

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function listArgument(name, fallback) {
  return String(argument(name, fallback))
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
}

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

function summary(values) {
  return {
    samples: values.length,
    minMs: Number(Math.min(...values).toFixed(2)),
    p50Ms: Number(percentile(values, 0.5).toFixed(2)),
    p95Ms: Number(percentile(values, 0.95).toFixed(2)),
    maxMs: Number(Math.max(...values).toFixed(2)),
  };
}

const iterations = Number(argument("iterations", 30));
const asOfSeconds = 1_750_000_000;
for (let index = 0; index < 3; index += 1) scannerSnapshot(3, asOfSeconds + index * 14400);
const engineSamples = [];
for (let index = 0; index < iterations; index += 1) {
  const startedAt = performance.now();
  scannerSnapshot(3, asOfSeconds + index * 14400);
  engineSamples.push(performance.now() - startedAt);
}

const result = { engine: summary(engineSamples) };
const baseUrl = argument("url", "");
if (baseUrl) {
  const requests = Number(argument("requests", 60));
  const concurrency = Math.max(1, Number(argument("concurrency", 12)));
  const symbols = listArgument("symbols", "BTCUSDT,ETHUSDT,FPT,VCB");
  const timeframes = listArgument("timeframes", "H4,H1,M15");
  const urls = Array.from({ length: requests }, (_, index) => {
    const symbol = symbols[index % symbols.length];
    const timeframe = timeframes[index % timeframes.length];
    return `${baseUrl.replace(/\/$/, "")}/api/workspace/${symbol}?timeframe=${timeframe}&confirmationBars=3`;
  });
  const samples = [];
  let cursor = 0;
  let failures = 0;
  const statusCodes = {};
  const wallStartedAt = performance.now();
  async function worker() {
    while (cursor < urls.length) {
      const url = urls[cursor++];
      const startedAt = performance.now();
      const response = await fetch(url);
      await response.arrayBuffer();
      samples.push(performance.now() - startedAt);
      statusCodes[response.status] = (statusCodes[response.status] ?? 0) + 1;
      if (!response.ok) failures += 1;
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, requests) }, () => worker()));
  const wallMs = performance.now() - wallStartedAt;
  result.http = {
    ...summary(samples),
    requests,
    concurrency,
    failures,
    statusCodes,
    wallMs: Number(wallMs.toFixed(2)),
    requestsPerSecond: Number((requests / (wallMs / 1000)).toFixed(2)),
    symbols,
    timeframes,
  };
}

console.log(JSON.stringify(result, null, 2));
