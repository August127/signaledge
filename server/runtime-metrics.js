const percentile = (sorted, value) => {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1);
  return Number(sorted[index].toFixed(2));
};

function routeKey(request) {
  const route = request.route?.path;
  if (route) return `${request.method} ${request.baseUrl ?? ""}${route}`;
  return `${request.method} ${request.path ?? "unknown"}`;
}

export function validBearerToken(authorization, expectedToken) {
  if (!expectedToken) return true;
  if (!authorization?.startsWith("Bearer ")) return false;
  const supplied = authorization.slice(7);
  const expected = Buffer.from(expectedToken);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && expected.length > 0 && crypto.timingSafeEqual(expected, actual);
}

export function requireConfiguredSecret(name, value, production = process.env.NODE_ENV === "production") {
  if (production && !value) throw new Error(`${name}_required_in_production`);
  return value;
}

export function operationalStatus(bootstrapStatus, providerStatus) {
  const quality = providerStatus?.quality?.status ?? "blocked";
  if (bootstrapStatus === "warming") return { state: "warming", ready: false };
  if (quality === "blocked") return { state: "blocked", ready: false };
  if (quality === "degraded" || bootstrapStatus === "degraded") return { state: "degraded", ready: true };
  return { state: "operational", ready: true };
}

export class RuntimeMetrics {
  constructor({ now = () => Date.now(), maxSamplesPerRoute = 512 } = {}) {
    this.now = now;
    this.maxSamplesPerRoute = maxSamplesPerRoute;
    this.startedAt = now();
    this.inFlight = 0;
    this.total = 0;
    this.statusCounts = new Map();
    this.routes = new Map();
  }

  middleware() {
    return (request, response, next) => {
      const startedAt = this.now();
      this.inFlight += 1;
      let recorded = false;
      const record = () => {
        if (recorded) return;
        recorded = true;
        this.inFlight = Math.max(0, this.inFlight - 1);
        this.record(routeKey(request), response.statusCode, Math.max(0, this.now() - startedAt));
      };
      response.once("finish", record);
      response.once("close", record);
      next();
    };
  }

  record(route, statusCode, durationMs) {
    this.total += 1;
    const statusClass = `${Math.floor(statusCode / 100)}xx`;
    this.statusCounts.set(statusClass, (this.statusCounts.get(statusClass) ?? 0) + 1);
    const current = this.routes.get(route) ?? { count: 0, errors: 0, samples: [] };
    current.count += 1;
    if (statusCode >= 500) current.errors += 1;
    current.samples.push(durationMs);
    if (current.samples.length > this.maxSamplesPerRoute) current.samples.shift();
    this.routes.set(route, current);
  }

  snapshot() {
    const routes = [...this.routes.entries()].map(([route, value]) => {
      const samples = [...value.samples].sort((left, right) => left - right);
      return {
        route,
        requests: value.count,
        errors: value.errors,
        errorRate: value.count ? Number((value.errors / value.count).toFixed(4)) : 0,
        latencyMs: {
          min: samples.length ? Number(samples[0].toFixed(2)) : 0,
          p50: percentile(samples, 0.5),
          p95: percentile(samples, 0.95),
          p99: percentile(samples, 0.99),
          max: samples.length ? Number(samples.at(-1).toFixed(2)) : 0,
          samples: samples.length,
        },
      };
    }).sort((left, right) => right.requests - left.requests || left.route.localeCompare(right.route));
    return {
      uptimeSeconds: Math.floor((this.now() - this.startedAt) / 1000),
      inFlight: this.inFlight,
      requests: this.total,
      statusCodes: Object.fromEntries([...this.statusCounts.entries()].sort()),
      routes,
    };
  }
}
import crypto from "node:crypto";
