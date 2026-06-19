const responseCache = new Map();
let evidenceKey = null;

function decodeBase64Url(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function loadEvidenceKey(expectedKeyId, force = false) {
  if (!force && evidenceKey?.keyId === expectedKeyId) return evidenceKey.key;
  const response = await fetch("/api/evidence/public-key", { cache: "no-store" });
  if (!response.ok) throw new Error("Evidence public key unavailable");
  const payload = await response.json();
  if (payload.algorithm !== "Ed25519" || payload.keyId !== expectedKeyId) throw new Error("Evidence key mismatch");
  const key = await crypto.subtle.importKey("jwk", payload.publicKey, { name: "Ed25519" }, false, ["verify"]);
  evidenceKey = { keyId: payload.keyId, key };
  return key;
}

async function verifyEnvelope(envelope) {
  if (!envelope?.signature) return;
  if (envelope.algorithm !== "Ed25519" || !envelope.keyId) throw new Error("Unsupported evidence signature");
  const message = new TextEncoder().encode(JSON.stringify(envelope.data));
  const signature = decodeBase64Url(envelope.signature);
  let key = await loadEvidenceKey(envelope.keyId);
  let valid = await crypto.subtle.verify({ name: "Ed25519" }, key, signature, message);
  if (!valid) {
    key = await loadEvidenceKey(envelope.keyId, true);
    valid = await crypto.subtle.verify({ name: "Ed25519" }, key, signature, message);
  }
  if (!valid) throw new Error("Evidence signature verification failed");
}

function abortableSignal(externalSignal, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException("Request timeout", "TimeoutError")), timeoutMs);
  const abort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abort();
  else externalSignal?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abort);
    },
  };
}

async function request(path, options = {}, attempt = 0) {
  const method = options.method ?? "GET";
  const cached = method === "GET" ? responseCache.get(path) : null;
  const headers = new Headers(options.headers);
  if (cached?.etag) headers.set("If-None-Match", cached.etag);
  const startedAt = performance.now();
  const abortable = abortableSignal(options.signal, options.timeoutMs ?? 7000);

  try {
    const response = await fetch(path, { ...options, method, headers, signal: abortable.signal });
    const latencyMs = Math.round(performance.now() - startedAt);
    if (response.status === 304 && cached) {
      return { ...cached.payload, transport: { latencyMs, cache: "VALIDATED", receivedAt: new Date().toISOString() } };
    }
    if (!response.ok) {
      const error = new Error(`Request failed: ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const payload = await response.json();
    await verifyEnvelope(payload);
    const enriched = { ...payload, transport: { latencyMs, cache: "NETWORK", receivedAt: new Date().toISOString() } };
    if (method === "GET") responseCache.set(path, { etag: response.headers.get("etag"), payload });
    return enriched;
  } catch (error) {
    if (!options.signal?.aborted && attempt < 1 && (error.name === "TypeError" || error.name === "TimeoutError" || error.status >= 500)) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return request(path, options, attempt + 1);
    }
    throw error;
  } finally {
    abortable.cleanup();
  }
}

export const api = {
  health: (options) => request("/api/health", options),
  subscriptionPlans: (options) => request("/api/subscription/plans", options),
  activateSubscription: (payload, options) => request("/api/subscription/activate", {
    ...options,
    method: "POST",
    headers: { "Content-Type": "application/json", ...options?.headers },
    body: JSON.stringify(payload),
  }),
  adminLogin: (payload, options) => request("/api/admin/login", {
    ...options,
    method: "POST",
    headers: { "Content-Type": "application/json", ...options?.headers },
    body: JSON.stringify(payload),
  }),
  adminUsers: (options) => request("/api/admin/users", options),
  adminCreateUser: (payload, options) => request("/api/admin/users", {
    ...options,
    method: "POST",
    headers: { "Content-Type": "application/json", ...options?.headers },
    body: JSON.stringify(payload),
  }),
  adminScannerConfig: (options) => request("/api/admin/scanner-config", options),
  adminUpdateScannerConfig: (payload, options) => request("/api/admin/scanner-config", {
    ...options,
    method: "PUT",
    headers: { "Content-Type": "application/json", ...options?.headers },
    body: JSON.stringify(payload),
  }),
  systemStatus: (options) => request("/api/system/status", options),
  dataDiagnostics: (symbols, options) => request(`/api/data/diagnostics${symbols?.length ? `?symbols=${encodeURIComponent(symbols.join(","))}` : ""}`, options),
  quotes: (symbols, options) => request(`/api/quotes${symbols?.length ? `?symbols=${encodeURIComponent(symbols.join(","))}` : ""}`, options),
  scanner: (confirmationBars, options) => request(`/api/scanner?confirmationBars=${confirmationBars}`, options),
  chart: (symbol, timeframe, confirmationBars, options) => request(`/api/chart/${symbol}?timeframe=${timeframe}&confirmationBars=${confirmationBars}`, options),
  workspace: (symbol, timeframe, confirmationBars, options) => request(`/api/workspace/${symbol}?timeframe=${timeframe}&confirmationBars=${confirmationBars}`, options),
  createAlert: (payload, options) => request("/api/alerts", {
    ...options,
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": options?.idempotencyKey ?? crypto.randomUUID(), ...options?.headers },
    body: JSON.stringify(payload),
  }),
  notifyAPlusTelegram: (payload, options) => request("/api/notifications/a-plus-telegram", {
    ...options,
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": options?.idempotencyKey ?? crypto.randomUUID(), ...options?.headers },
    body: JSON.stringify(payload),
  }),
  alerts: (options) => request("/api/alerts", options),
  disableAlert: (id, options) => request(`/api/alerts/${id}`, { ...options, method: "DELETE" }),
  journal: (options) => request("/api/journal", options),
  createJournalEntry: (payload, options) => request("/api/journal", {
    ...options,
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": options?.idempotencyKey ?? crypto.randomUUID(), ...options?.headers },
    body: JSON.stringify(payload),
  }),
  clearJournal: (options) => request("/api/journal", { ...options, method: "DELETE" }),
};
