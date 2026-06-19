import test from "node:test";
import assert from "node:assert/strict";
import { operationalStatus, requireConfiguredSecret, RuntimeMetrics, validBearerToken } from "./runtime-metrics.js";

test("operational status separates liveness from readiness", () => {
  assert.deepEqual(operationalStatus("warming", { quality: { status: "healthy" } }), { state: "warming", ready: false });
  assert.deepEqual(operationalStatus("ready", { quality: { status: "blocked" } }), { state: "blocked", ready: false });
  assert.deepEqual(operationalStatus("degraded", { quality: { status: "healthy" } }), { state: "degraded", ready: true });
  assert.deepEqual(operationalStatus("ready", { quality: { status: "degraded" } }), { state: "degraded", ready: true });
  assert.deepEqual(operationalStatus("ready", { quality: { status: "healthy" } }), { state: "operational", ready: true });
});

test("runtime metrics retain bounded samples and calculate route percentiles", () => {
  let now = 1_000;
  const metrics = new RuntimeMetrics({ now: () => now, maxSamplesPerRoute: 3 });
  for (const duration of [10, 20, 30, 40]) metrics.record("GET /api/workspace/:symbol", 200, duration);
  metrics.record("GET /api/workspace/:symbol", 503, 50);
  now = 6_000;

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.uptimeSeconds, 5);
  assert.equal(snapshot.requests, 5);
  assert.deepEqual(snapshot.statusCodes, { "2xx": 4, "5xx": 1 });
  assert.equal(snapshot.routes[0].requests, 5);
  assert.equal(snapshot.routes[0].errors, 1);
  assert.equal(snapshot.routes[0].errorRate, 0.2);
  assert.deepEqual(snapshot.routes[0].latencyMs, { min: 30, p50: 40, p95: 50, p99: 50, max: 50, samples: 3 });
});

test("metrics bearer token is optional locally and exact when configured", () => {
  assert.equal(validBearerToken(undefined, undefined), true);
  assert.equal(validBearerToken(undefined, "monitor-secret"), false);
  assert.equal(validBearerToken("Basic monitor-secret", "monitor-secret"), false);
  assert.equal(validBearerToken("Bearer wrong-secret", "monitor-secret"), false);
  assert.equal(validBearerToken("Bearer monitor-secret", "monitor-secret"), true);
});

test("production secrets fail closed", () => {
  assert.throws(() => requireConfiguredSecret("SCANNER_API_TOKEN", "", true), /required_in_production/);
  assert.equal(requireConfiguredSecret("SCANNER_API_TOKEN", "secret", true), "secret");
  assert.equal(requireConfiguredSecret("SCANNER_API_TOKEN", "", false), "");
});
