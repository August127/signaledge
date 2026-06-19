import "./env.js";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { getSymbolMeta, listSymbolMeta } from "./engine.js";
import { CALCULATION_VERSION, SnapshotStore } from "./snapshot-store.js";
import { createMarketDataProvider } from "./market-data.js";
import { createEvidenceSigner, evidenceEtag } from "./evidence-signer.js";
import { operationalStatus, requireConfiguredSecret, RuntimeMetrics, validBearerToken } from "./runtime-metrics.js";
import { logger } from "./logger.js";
import { dataPolicy, scaleReadiness } from "./scale-readiness.js";
import { buildAPlusTelegramPayload, createTelegramNotifier, evaluateSignalOutcome, formatSignalResultTelegramMessage } from "./telegram.js";
import { activateSubscription, authenticateAdmin, createSubscriptionProfile, getSubscriptionTier, publicSubscriptionPlans } from "./subscription.js";
import { defaultScannerConfig, normalizeScannerConfig, scannerConfigPresets, scannerConfigSchema } from "./scanner-config.js";
import { closePostgresPool, createJsonStateStore, createOperationsStateStore, createPostgresPool } from "./postgres-store.js";
import { createRedisCache } from "./redis-cache.js";

const app = express();
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const evidenceSigner = createEvidenceSigner();
const apiToken = requireConfiguredSecret("SCANNER_API_TOKEN", process.env.SCANNER_API_TOKEN ?? "");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const postgresPool = createPostgresPool();
const runtimeCache = createRedisCache();
const providerBootstrap = await createMarketDataProvider({ symbols: listSymbolMeta() });
const scannerConfigStore = await createJsonStateStore({
  pool: postgresPool,
  key: "scanner-config",
  filePath: path.resolve(__dirname, "../.data/scanner-config.json"),
  fallback: { config: defaultScannerConfig, updatedAt: new Date().toISOString(), updatedBy: "system" },
});
const adminUserStore = await createJsonStateStore({
  pool: postgresPool,
  key: "admin-users",
  filePath: path.resolve(__dirname, "../.data/admin-users.json"),
  fallback: { users: [], audit: [] },
});
const telegramSignalStore = await createJsonStateStore({
  pool: postgresPool,
  key: "telegram-signals",
  filePath: path.resolve(__dirname, "../.data/telegram-signals.json"),
  fallback: { signals: [] },
});
await migrateIssuedUserTiers();
const loadedScannerConfig = normalizeScannerConfig(scannerConfigStore.current().config);
const snapshots = new SnapshotStore({ provider: providerBootstrap.provider, scannerConfig: loadedScannerConfig });
const operations = await createOperationsStateStore({ pool: postgresPool, filePath: path.resolve(__dirname, "../.data/operations.json") });
const runtimeMetrics = new RuntimeMetrics();
const metricsToken = process.env.METRICS_TOKEN;
const telegram = createTelegramNotifier();
let telegramOutcomeCheckRunning = false;
let prewarmTimer = null;

function scheduleSnapshotPrewarm(reason = "scheduled") {
  if (prewarmTimer) clearTimeout(prewarmTimer);
  prewarmTimer = setTimeout(() => {
    prewarmTimer = null;
    const startedAt = performance.now();
    try {
      const scanner = snapshots.getScanner(3);
      logger.info({
        event: "snapshot_prewarmed",
        reason,
        items: scanner.items.length,
        durationMs: Number((performance.now() - startedAt).toFixed(1)),
        snapshotId: scanner.sync.snapshotId,
      });
    } catch (error) {
      logger.warn({ event: "snapshot_prewarm_failed", reason, message: error.message });
    }
  }, Number(process.env.SNAPSHOT_PREWARM_DELAY_MS ?? 250));
  prewarmTimer.unref?.();
}

async function trackTelegramSignal(plan, key) {
  if (!plan?.symbol || !Number.isFinite(plan.entry)) return;
  const state = telegramSignalStore.current();
  const signals = (state.signals ?? []).filter((item) => item.key !== key);
  signals.unshift({
    key,
    ...plan,
    status: "active",
    checkpoints: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await telegramSignalStore.save({ signals: signals.slice(0, 500) });
}

async function checkTelegramSignalOutcomes() {
  if (telegramOutcomeCheckRunning) return;
  telegramOutcomeCheckRunning = true;
  try {
    const state = telegramSignalStore.current();
    const activeSignals = (state.signals ?? []).filter((signal) => signal.status === "active");
    if (!activeSignals.length) return;
    const metas = activeSignals.map((signal) => getSymbolMeta(signal.symbol)).filter((meta) => meta?.symbol);
    const quotePayload = await providerBootstrap.provider.getQuotes(metas).catch(() => ({ items: [] }));
    const quoteBySymbol = new Map((quotePayload.items ?? []).map((quote) => [quote.symbol, quote]));
    let changed = false;
    const nowIso = new Date().toISOString();
    const signals = await Promise.all((state.signals ?? []).map(async (signal) => {
      if (signal.status !== "active") return signal;
      const quote = quoteBySymbol.get(signal.symbol);
      const price = Number(quote?.price);
      const outcome = evaluateSignalOutcome(signal, price);
      if (!outcome) return signal;
      const message = formatSignalResultTelegramMessage({ signal, price, outcome, observedAt: quote?.quotedAt ?? nowIso });
      const result = await telegram.sendResult({ key: `${signal.key}:result:${outcome.type}`, message });
      logger.info({ event: "telegram_signal_result", symbol: signal.symbol, outcome: outcome.type, sent: result.sent, reason: result.reason });
      changed = true;
      return {
        ...signal,
        checkpoints: { ...(signal.checkpoints ?? {}), [outcome.type]: { price, at: quote?.quotedAt ?? nowIso, sent: result.sent, skipped: result.skipped ?? false } },
        status: outcome.final ? "closed" : "active",
        lastPrice: price,
        updatedAt: nowIso,
      };
    }));
    if (changed) await telegramSignalStore.save({ signals: signals.slice(0, 500) });
  } catch (error) {
    logger.warn({ event: "telegram_signal_result_check_failed", message: error.message });
  } finally {
    telegramOutcomeCheckRunning = false;
  }
}

providerBootstrap.ready.then(() => {
  snapshots.invalidate();
  scheduleSnapshotPrewarm("provider_ready");
  providerBootstrap.provider.startAutoRefresh?.({
    intervalMs: Number(process.env.MARKET_DATA_REFRESH_MS ?? 60_000),
    onUpdate: () => {
      snapshots.invalidate();
      scheduleSnapshotPrewarm("provider_update");
      checkTelegramSignalOutcomes();
    },
  });
});

setInterval(checkTelegramSignalOutcomes, Number(process.env.TELEGRAM_SIGNAL_CHECK_MS ?? 30_000)).unref();

app.disable("x-powered-by");
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(express.json({ limit: "64kb" }));
app.use(runtimeMetrics.middleware());
app.use(rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: "draft-8", legacyHeaders: false }));
const mutationRateLimit = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false });
app.use((request, response, next) => {
  const startedAt = performance.now();
  response.setHeader("Cache-Control", "private, max-age=2, stale-while-revalidate=5");
  response.setHeader("X-Request-Id", crypto.randomUUID());
  response.once("finish", () => logger.info({
    event: "http_request",
    requestId: response.getHeader("X-Request-Id"),
    method: request.method,
    route: request.route?.path ?? request.path,
    statusCode: response.statusCode,
    durationMs: Number((performance.now() - startedAt).toFixed(1)),
  }));
  next();
});

const querySchema = z.object({
  confirmationBars: z.coerce.number().int().min(1).max(10).default(3),
  timeframe: z.enum(["D1", "H4"]).default("H4"),
});

const seriesQuerySchema = z.object({
  symbol: z.string().min(2).max(20).transform((value) => value.toUpperCase()).optional(),
  timeframe: z.enum(["D1", "H4"]).optional(),
});

const quoteQuerySchema = z.object({
  symbols: z.string().max(500).optional(),
});

function signed(payload) {
  return {
    data: payload,
    signature: evidenceSigner.sign(payload),
    algorithm: evidenceSigner.algorithm,
    keyId: evidenceSigner.keyId,
    issuedAt: new Date().toISOString(),
  };
}

function sendSigned(request, response, payload) {
  const etag = evidenceEtag(payload, evidenceSigner.keyId);
  response.setHeader("ETag", etag);
  response.setHeader("X-Calculation-Version", CALCULATION_VERSION);
  response.setHeader("X-Evidence-Key-Id", evidenceSigner.keyId);
  if (request.headers["if-none-match"] === etag) return response.status(304).end();
  return response.json(signed(payload));
}

function requireApiAccess(request, response, next) {
  if (validBearerToken(request.headers.authorization, apiToken)) return next();
  response.setHeader("WWW-Authenticate", "Bearer");
  return response.status(401).json({ error: "api_unauthorized" });
}

function currentOperationalStatus() {
  const providerStatus = snapshots.provider.status();
  return { providerStatus, ...operationalStatus(providerBootstrap.bootstrap.status, providerStatus) };
}

function isMarketDataUnavailable(error) {
  return /market_data_unavailable|equity_market_data_unavailable|crypto_market_data_unavailable/i.test(error?.message ?? "");
}

function marketDataUnavailable(response, symbol, timeframe, error) {
  return response.status(503).json({
    error: "market_data_unavailable",
    symbol,
    timeframe,
    reason: error?.message ?? "market_data_unavailable",
  });
}

function udfTimeframe(resolution) {
  const normalized = String(resolution ?? "").toUpperCase();
  if (["D", "1D"].includes(normalized)) return "D1";
  if (["240", "4H", "H4"].includes(normalized)) return "H4";
  return null;
}

function normalizeUdfSymbol(value) {
  const raw = String(value ?? "").trim().toUpperCase();
  const withoutExchange = raw.includes(":") ? raw.split(":").at(-1) : raw;
  return withoutExchange.split("~")[0];
}

function findUdfMeta(value) {
  const symbol = normalizeUdfSymbol(value);
  return listSymbolMeta().find((meta) => meta.symbol === symbol) ?? null;
}

function udfTicker(meta) {
  return `${meta.venue}:${meta.symbol}`;
}

function udfSymbolInfo(meta) {
  const cryptoMarket = meta.market === "CRYPTO";
  return {
    name: meta.symbol,
    ticker: udfTicker(meta),
    full_name: udfTicker(meta),
    description: meta.symbol,
    type: cryptoMarket ? "crypto" : "stock",
    exchange: meta.venue,
    listed_exchange: meta.venue,
    session: cryptoMarket ? "24x7" : "0900-1500",
    timezone: cryptoMarket ? "Etc/UTC" : "Asia/Ho_Chi_Minh",
    minmov: 1,
    pricescale: cryptoMarket ? 100000 : 100,
    has_intraday: true,
    has_daily: true,
    has_weekly_and_monthly: false,
    supported_resolutions: ["240", "1D"],
    intraday_multipliers: ["240"],
    volume_precision: 0,
    data_status: cryptoMarket ? "streaming" : "delayed_streaming",
  };
}

function udfHistoryPayload(rows) {
  if (!rows.length) return { s: "no_data" };
  return {
    s: "ok",
    t: rows.map((row) => row.time),
    o: rows.map((row) => row.open),
    h: rows.map((row) => row.high),
    l: rows.map((row) => row.low),
    c: rows.map((row) => row.close),
    v: rows.map((row) => row.volume),
  };
}

const subscriptionActivationSchema = z.object({
  accessCode: z.string().max(120).optional(),
  requestedTier: z.enum(["free", "pro", "admin"]).default("free"),
});

const adminLoginSchema = z.object({
  username: z.string().min(1).max(80),
  password: z.string().min(1).max(160),
});

const adminUserSchema = z.object({
  displayName: z.string().min(2).max(120),
  email: z.string().email().max(180).optional().or(z.literal("")),
  tier: z.enum(["free", "pro", "admin"]),
  brokerCode: z.string().max(80).optional().default(""),
  note: z.string().max(300).optional().default(""),
});

function publicAdminUser(user) {
  const { accessCode, ...safe } = user;
  return { ...safe, accessCodePreview: accessCode ? `${accessCode.slice(0, 4)}…${accessCode.slice(-3)}` : null };
}

function adminSessionSecret() {
  return process.env.SIGNALEDGE_ADMIN_SESSION_SECRET
    || process.env.JWT_COOKIE_SECRET
    || process.env.SIGNALEDGE_ADMIN_PASSWORD
    || process.env.SIGNALEDGE_ADMIN_PASS
    || "signaledge-local-admin-session";
}

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signAdminSession(profile) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload = { sub: profile.username ?? "admin", tier: "admin", iat: nowSeconds, exp: nowSeconds + 8 * 3600 };
  const body = base64urlJson(payload);
  const signature = crypto.createHmac("sha256", adminSessionSecret()).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function verifyAdminSession(token = "") {
  const [body, signature] = String(token).split(".");
  if (!body || !signature) return null;
  const expected = crypto.createHmac("sha256", adminSessionSecret()).update(body).digest("base64url");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (payload.tier !== "admin" || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function requireAdminSession(request, response, next) {
  const header = request.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const payload = verifyAdminSession(token);
  if (!payload) return response.status(401).json({ error: "admin_session_required" });
  request.adminSession = payload;
  return next();
}

function activateIssuedUser({ accessCode = "", requestedTier = "free" } = {}) {
  const supplied = String(accessCode || "").trim();
  if (!supplied) return null;
  const state = adminUserStore.current();
  const user = state.users.find((item) => item.status === "active" && item.tier === requestedTier && item.accessCode === supplied);
  if (!user) return null;
  return createSubscriptionProfile(user.tier, {
    userId: user.id,
    displayName: user.displayName,
    email: user.email || null,
    brokerCodeStatus: user.brokerCode ? "verified" : ["free", "admin"].includes(user.tier) ? "not_required" : "pending_verification",
    issuedByAdmin: true,
    issuedAt: user.createdAt,
  });
}

async function migrateIssuedUserTiers() {
  const state = adminUserStore.current();
  const users = state.users ?? [];
  let changed = false;
  const migrated = users.map((user) => {
    if (!["signal", "desk"].includes(user.tier)) return user;
    changed = true;
    return {
      ...user,
      tier: "pro",
      tierName: getSubscriptionTier("pro")?.name ?? "SignalEdge Pro",
      note: [user.note, `Migrated from ${user.tier} to pro`].filter(Boolean).join(" | "),
      updatedAt: new Date().toISOString(),
    };
  });
  if (!changed) return;
  await adminUserStore.save({
    users: migrated,
    audit: [{ id: crypto.randomUUID(), action: "migrate_tier_model", targetId: "all", tier: "pro", actor: "system", at: new Date().toISOString() }, ...(state.audit ?? [])].slice(0, 1000),
  });
}

async function createIssuedUser(input, actor = "admin") {
  const tier = getSubscriptionTier(input.tier);
  if (!tier) throw new Error("unknown_subscription_tier");
  const state = adminUserStore.current();
  const now = new Date().toISOString();
  const accessCode = `SE-${input.tier.toUpperCase()}-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
  const user = {
    id: crypto.randomUUID(),
    displayName: input.displayName,
    email: input.email || "",
    tier: tier.id,
    tierName: tier.name,
    brokerCode: input.brokerCode || "",
    note: input.note || "",
    status: "active",
    accessCode,
    createdAt: now,
    createdBy: actor,
    updatedAt: now,
  };
  const nextState = {
    users: [user, ...(state.users ?? [])].slice(0, 5000),
    audit: [{ id: crypto.randomUUID(), action: "create_user", targetId: user.id, tier: user.tier, actor, at: now }, ...(state.audit ?? [])].slice(0, 1000),
  };
  await adminUserStore.save(nextState);
  return user;
}

app.get("/api/health/live", (_request, response) => response.json({
  status: "alive",
  service: "scanner-core",
  calculationVersion: CALCULATION_VERSION,
  serverTime: new Date().toISOString(),
  uptimeSeconds: runtimeMetrics.snapshot().uptimeSeconds,
}));

app.get("/api/evidence/public-key", (_request, response) => {
  response.setHeader("Cache-Control", "public, max-age=300, must-revalidate");
  return response.json({ algorithm: evidenceSigner.algorithm, keyId: evidenceSigner.keyId, publicKey: evidenceSigner.publicJwk });
});

app.get("/api/health/ready", (_request, response) => {
  const operational = currentOperationalStatus();
  return response.status(operational.ready ? 200 : 503).json({
    status: operational.state,
    ready: operational.ready,
    service: "scanner-core",
    calculationVersion: CALCULATION_VERSION,
    bootstrap: providerBootstrap.bootstrap,
    dataQuality: operational.providerStatus.quality,
    serverTime: new Date().toISOString(),
  });
});

app.get("/api/health", (_request, response) => {
  const operational = currentOperationalStatus();
  return response.json({
    status: operational.state,
    ready: operational.ready,
    service: "scanner-core",
    mode: "closed-candle",
    calculationVersion: CALCULATION_VERSION,
    serverTime: new Date().toISOString(),
    cache: snapshots.stats(operational.providerStatus),
    runtimeCache: runtimeCache.status(),
    persistence: {
      mode: postgresPool ? "postgresql" : "file",
      sharedPersistence: Boolean(postgresPool),
      stateStore: postgresPool ? "signaledge_state" : ".data/*.json",
    },
    operations: operations.stats(),
    bootstrap: providerBootstrap.bootstrap,
  });
});

app.get("/api/metrics", (request, response) => {
  if (!validBearerToken(request.headers.authorization, metricsToken)) {
    response.setHeader("WWW-Authenticate", "Bearer");
    return response.status(401).json({ error: "metrics_unauthorized" });
  }
  return response.json({
  service: "scanner-core",
  calculationVersion: CALCULATION_VERSION,
  runtime: runtimeMetrics.snapshot(),
  cache: snapshots.stats(),
  runtimeCache: runtimeCache.status(),
  persistence: {
    mode: postgresPool ? "postgresql" : "file",
    sharedPersistence: Boolean(postgresPool),
  },
  operations: operations.stats(),
  observedAt: new Date().toISOString(),
  });
});

app.get("/udf/config", (_request, response) => response.json({
  supports_search: true,
  supports_group_request: false,
  supports_marks: false,
  supports_timescale_marks: false,
  supports_time: true,
  supported_resolutions: ["240", "1D"],
  exchanges: [
    { value: "", name: "All", desc: "All exchanges" },
    { value: "HOSE", name: "HOSE", desc: "Ho Chi Minh Stock Exchange" },
    { value: "HNX", name: "HNX", desc: "Hanoi Stock Exchange" },
    { value: "NASDAQ", name: "NASDAQ", desc: "Nasdaq Stock Market" },
    { value: "NYSE", name: "NYSE", desc: "New York Stock Exchange" },
    { value: "BINANCE", name: "BINANCE", desc: "Binance Spot" },
  ],
  symbols_types: [
    { name: "All", value: "" },
    { name: "Stock", value: "stock" },
    { name: "Crypto", value: "crypto" },
  ],
}));

app.get("/udf/search", (request, response) => {
  const query = String(request.query.query ?? "").trim().toUpperCase();
  const exchange = String(request.query.exchange ?? "").trim().toUpperCase();
  const type = String(request.query.type ?? "").trim().toLowerCase();
  const limit = Math.min(50, Math.max(1, Number(request.query.limit ?? 30)));
  const rows = listSymbolMeta()
    .filter((meta) => !query || meta.symbol.includes(query) || udfTicker(meta).includes(query))
    .filter((meta) => !exchange || meta.venue === exchange)
    .filter((meta) => !type || (type === "crypto" ? meta.market === "CRYPTO" : meta.market !== "CRYPTO"))
    .slice(0, limit)
    .map((meta) => ({
      symbol: meta.symbol,
      full_name: udfTicker(meta),
      description: meta.symbol,
      exchange: meta.venue,
      ticker: udfTicker(meta),
      type: meta.market === "CRYPTO" ? "crypto" : "stock",
    }));
  return response.json(rows);
});

app.get("/udf/symbols", (request, response) => {
  const meta = findUdfMeta(request.query.symbol);
  if (!meta) return response.status(404).json({ s: "error", errmsg: "symbol_not_found" });
  return response.json(udfSymbolInfo(meta));
});

app.get("/udf/history", async (request, response) => {
  const meta = findUdfMeta(request.query.symbol);
  const timeframe = udfTimeframe(request.query.resolution);
  if (!meta) return response.json({ s: "error", errmsg: "symbol_not_found" });
  if (!timeframe) return response.json({ s: "error", errmsg: "unsupported_resolution" });
  const to = Number(request.query.to ?? Math.floor(Date.now() / 1000));
  const from = Number(request.query.from ?? 0);
  const countback = Number(request.query.countback ?? 0);
  const count = Math.min(1000, Math.max(1, Number.isFinite(countback) && countback > 0 ? countback : snapshots.requiredRows(meta.symbol, timeframe)));
  const requiredCount = Math.max(count, snapshots.requiredRows(meta.symbol, timeframe));
  try {
    await providerBootstrap.provider.ensureRows?.(meta, timeframe, requiredCount);
    const sourceRows = providerBootstrap.provider.getRows(meta, timeframe, requiredCount);
    const rows = (countback > 0 ? sourceRows.filter((row) => row.time < to).slice(-count) : sourceRows.filter((row) => row.time >= from && row.time < to));
    return response.json(udfHistoryPayload(rows));
  } catch (error) {
    logger.warn({ event: "udf_history_unavailable", symbol: meta.symbol, timeframe, message: error.message });
    return response.json({ s: "no_data" });
  }
});

app.get("/udf/time", (_request, response) => response.type("text/plain").send(String(Math.floor(Date.now() / 1000))));

app.get("/udf/quotes", async (request, response) => {
  const requested = String(request.query.symbols ?? "").split(",").map((symbol) => symbol.trim()).filter(Boolean);
  const metas = requested.map(findUdfMeta).filter(Boolean);
  const quotePayload = await providerBootstrap.provider.getQuotes(metas);
  const quotes = new Map((quotePayload.items ?? []).map((item) => [item.symbol, item]));
  return response.json({
    s: "ok",
    d: requested.map((symbol) => {
      const meta = findUdfMeta(symbol);
      const quote = meta ? quotes.get(meta.symbol) : null;
      if (!meta || !quote) return { s: "error", n: symbol, errmsg: "quote_not_found" };
      return {
        s: "ok",
        n: udfTicker(meta),
        v: {
          ch: quote.absoluteChange ?? null,
          chp: quote.change ?? null,
          short_name: meta.symbol,
          exchange: meta.venue,
          description: quote.companyName ?? meta.symbol,
          lp: quote.price,
          volume: quote.volume ?? null,
        },
      };
    }),
  });
});

app.get("/api/subscription/plans", (_request, response) => response.json(publicSubscriptionPlans()));

app.post("/api/subscription/activate", mutationRateLimit, (request, response) => {
  const parsed = subscriptionActivationSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: "invalid_subscription_activation", issues: parsed.error.issues });
  const result = activateSubscription(parsed.data);
  if (!result.ok) {
    const issuedProfile = activateIssuedUser(parsed.data);
    if (!issuedProfile) return response.status(result.status).json({ error: result.error, tier: result.tier });
    return response.status(200).json(issuedProfile);
  }
  return response.status(200).json(result.profile);
});

app.post("/api/admin/login", mutationRateLimit, (request, response) => {
  const parsed = adminLoginSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: "invalid_admin_login", issues: parsed.error.issues });
  const result = authenticateAdmin(parsed.data);
  if (!result.ok) return response.status(result.status).json({ error: result.error });
  return response.status(200).json({ ...result.profile, adminSessionToken: signAdminSession(result.profile) });
});

app.get("/api/admin/users", requireAdminSession, (_request, response) => {
  const state = adminUserStore.current();
  return response.json({
    users: (state.users ?? []).map(publicAdminUser),
    total: state.users?.length ?? 0,
    audit: (state.audit ?? []).slice(0, 20),
    checkedAt: new Date().toISOString(),
  });
});

app.post("/api/admin/users", requireAdminSession, mutationRateLimit, async (request, response) => {
  const parsed = adminUserSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: "invalid_admin_user", issues: parsed.error.issues });
  const user = await createIssuedUser(parsed.data, request.adminSession?.sub || request.headers["x-admin-user"] || "admin");
  return response.status(201).json({ user: publicAdminUser(user), accessCode: user.accessCode });
});

app.get("/api/admin/scanner-config", requireAdminSession, (_request, response) => {
  const state = scannerConfigStore.current();
  return response.json({
    config: normalizeScannerConfig(state.config),
    presets: scannerConfigPresets,
    updatedAt: state.updatedAt,
    updatedBy: state.updatedBy,
  });
});

app.put("/api/admin/scanner-config", requireAdminSession, mutationRateLimit, async (request, response) => {
  const parsed = scannerConfigSchema.partial().safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: "invalid_scanner_config", issues: parsed.error.issues });
  const config = normalizeScannerConfig({ ...scannerConfigStore.current().config, ...parsed.data });
  const state = { config, updatedAt: new Date().toISOString(), updatedBy: request.adminSession?.sub || request.headers["x-admin-user"] || "admin" };
  await scannerConfigStore.save(state);
  snapshots.setScannerConfig(config);
  await runtimeCache.deletePattern("scanner:*").catch(() => 0);
  return response.json({ ...state, cacheInvalidated: true });
});

app.use("/api", requireApiAccess);

app.get("/api/system/status", (_request, response) => {
  const providerStatus = snapshots.provider.status();
  const status = operationalStatus(providerBootstrap.bootstrap.status, providerStatus).state;
  return response.json({
    status,
    calculationVersion: CALCULATION_VERSION,
    provider: providerStatus,
    cache: snapshots.stats(providerStatus),
    runtimeCache: runtimeCache.status(),
    persistence: {
      mode: postgresPool ? "postgresql" : "file",
      sharedPersistence: Boolean(postgresPool),
    },
    operations: operations.stats(),
    scale: scaleReadiness(),
    dataPolicy: dataPolicy(),
    bootstrap: providerBootstrap.bootstrap,
    serverTime: new Date().toISOString(),
  });
});

app.get("/api/data/series", (request, response) => {
  const parsed = seriesQuerySchema.safeParse(request.query);
  if (!parsed.success) return response.status(400).json({ error: "invalid_query", issues: parsed.error.issues });
  const symbols = parsed.data.symbol
    ? listSymbolMeta().filter((meta) => meta.symbol === parsed.data.symbol)
    : listSymbolMeta();
  if (parsed.data.symbol && !symbols.length) return response.status(404).json({ error: "symbol_not_found" });
  const timeframes = parsed.data.timeframe ? [parsed.data.timeframe] : ["D1", "H4"];
  const provider = providerBootstrap.provider;
  const items = provider.seriesStatuses?.(symbols, timeframes)
    ?? symbols.flatMap((meta) => timeframes.map((timeframe) => ({
      symbol: meta.symbol,
      market: meta.market,
      timeframe,
      provider: provider.id,
      source: provider.sourceFor?.(meta, timeframe) ?? provider.id,
      executable: provider.isExecutable?.(meta, timeframe) ?? false,
    })));
  return response.json({ items, total: items.length, bootstrap: providerBootstrap.bootstrap.status, checkedAt: new Date().toISOString() });
});

app.get("/api/data/diagnostics", async (request, response) => {
  const parsed = quoteQuerySchema.safeParse(request.query);
  if (!parsed.success) return response.status(400).json({ error: "invalid_query", issues: parsed.error.issues });
  const requested = parsed.data.symbols
    ? new Set(parsed.data.symbols.split(",").map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))
    : null;
  const symbols = requested ? listSymbolMeta().filter((meta) => requested.has(meta.symbol)) : listSymbolMeta();
  if (requested && symbols.length !== requested.size) return response.status(404).json({ error: "symbol_not_found" });
  const timeframes = ["D1", "H4"];
  const provider = providerBootstrap.provider;
  const series = provider.seriesStatuses?.(symbols, timeframes) ?? [];
  const seriesSummary = timeframes.map((timeframe) => {
    const rows = series.filter((item) => item.timeframe === timeframe);
    return {
      timeframe,
      total: rows.length,
      live: rows.filter((item) => item.live).length,
      executable: rows.filter((item) => item.executable).length,
      unavailable: rows.filter((item) => !item.live).length,
    };
  });
  const quotes = await provider.getQuotes(symbols);
  return response.json({
    status: operationalStatus(providerBootstrap.bootstrap.status, provider.status()).state,
    provider: provider.status(),
    seriesSummary,
    quoteSummary: {
      requested: symbols.length,
      returned: quotes.items?.length ?? 0,
      indices: quotes.indices?.length ?? 0,
      providers: quotes.providers ?? {},
      sources: [...new Set((quotes.items ?? []).map((item) => item.source).filter(Boolean))],
    },
    dataPolicy: dataPolicy(),
    bootstrap: providerBootstrap.bootstrap.status,
    checkedAt: new Date().toISOString(),
  });
});

app.get("/api/quotes", async (request, response) => {
  const parsed = quoteQuerySchema.safeParse(request.query);
  if (!parsed.success) return response.status(400).json({ error: "invalid_query", issues: parsed.error.issues });
  const requested = parsed.data.symbols
    ? new Set(parsed.data.symbols.split(",").map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))
    : null;
  const symbols = requested ? listSymbolMeta().filter((meta) => requested.has(meta.symbol)) : listSymbolMeta();
  if (requested && symbols.length !== requested.size) return response.status(404).json({ error: "symbol_not_found" });
  response.setHeader("Cache-Control", "private, no-cache");
  const cacheKey = `quotes:${symbols.map((meta) => meta.symbol).sort().join(",") || "all"}`;
  const cached = await runtimeCache.getJson(cacheKey);
  if (cached) {
    response.setHeader("X-Redis-Cache", "HIT");
    return sendSigned(request, response, cached);
  }
  const quotePayload = await providerBootstrap.provider.getQuotes(symbols);
  const metaBySymbol = new Map(symbols.map((meta) => [meta.symbol, meta]));
  quotePayload.items = (quotePayload.items ?? []).map((item) => {
    const meta = metaBySymbol.get(item.symbol);
    return meta ? { ...item, venue: meta.venue, market: meta.market } : item;
  });
  await runtimeCache.setJson(cacheKey, quotePayload, 2);
  response.setHeader("X-Redis-Cache", runtimeCache.enabled ? "MISS" : "DISABLED");
  return sendSigned(request, response, quotePayload);
});

app.get("/api/scanner", async (request, response) => {
  const parsed = querySchema.safeParse(request.query);
  if (!parsed.success) return response.status(400).json({ error: "invalid_query", issues: parsed.error.issues });
  const cacheKey = `scanner:${parsed.data.confirmationBars}`;
  const cached = await runtimeCache.getJson(cacheKey);
  if (cached) {
    response.setHeader("X-Redis-Cache", "HIT");
    return sendSigned(request, response, cached);
  }
  const payload = snapshots.getScanner(parsed.data.confirmationBars);
  await runtimeCache.setJson(cacheKey, payload, 2);
  response.setHeader("X-Redis-Cache", runtimeCache.enabled ? "MISS" : "DISABLED");
  return sendSigned(request, response, payload);
});

async function ensureChartRows(meta, timeframe) {
  await providerBootstrap.provider.ensureRows?.(meta, timeframe, snapshots.requiredRows(meta.symbol, timeframe));
}

app.get("/api/chart/:symbol", async (request, response) => {
  const parsed = querySchema.safeParse(request.query);
  if (!parsed.success) return response.status(400).json({ error: "invalid_query", issues: parsed.error.issues });
  const meta = getSymbolMeta(request.params.symbol.toUpperCase());
  if (meta.symbol !== request.params.symbol.toUpperCase()) return response.status(404).json({ error: "symbol_not_found" });
  try {
    await ensureChartRows(meta, parsed.data.timeframe);
    return sendSigned(request, response, snapshots.getAnalysis(meta.symbol, parsed.data.timeframe, parsed.data.confirmationBars));
  } catch (error) {
    if (isMarketDataUnavailable(error)) return marketDataUnavailable(response, meta.symbol, parsed.data.timeframe, error);
    throw error;
  }
});

app.get("/api/workspace/:symbol", async (request, response) => {
  const parsed = querySchema.safeParse(request.query);
  if (!parsed.success) return response.status(400).json({ error: "invalid_query", issues: parsed.error.issues });
  const requestedSymbol = request.params.symbol.toUpperCase();
  const meta = getSymbolMeta(requestedSymbol);
  if (meta.symbol !== requestedSymbol) return response.status(404).json({ error: "symbol_not_found" });
  try {
    await ensureChartRows(meta, parsed.data.timeframe);
    const workspace = snapshots.getWorkspace(meta.symbol, parsed.data.timeframe, parsed.data.confirmationBars);
    return sendSigned(request, response, workspace);
  } catch (error) {
    if (isMarketDataUnavailable(error)) return marketDataUnavailable(response, meta.symbol, parsed.data.timeframe, error);
    throw error;
  }
});

app.post("/api/alerts", mutationRateLimit, async (request, response) => {
  const schema = z.object({ symbol: z.string().min(2).max(20), mode: z.enum(["confirmed", "watch"]), channels: z.array(z.enum(["app", "email", "telegram"])).min(1) });
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: "invalid_alert", issues: parsed.error.issues });
  const policy = parsed.data.mode === "confirmed" ? "ARROW+BOS+ATR+MTF" : "CIRCLE_ONLY_WATCH";
  const result = await operations.createAlert({ policy, ...parsed.data }, request.headers["idempotency-key"]);
  response.setHeader("Idempotency-Replayed", String(result.replayed));
  return response.status(result.replayed ? 200 : 201).json(result.item);
});

app.get("/api/alerts", (_request, response) => response.json({ items: operations.listAlerts(), total: operations.listAlerts().length }));

app.delete("/api/alerts/:id", mutationRateLimit, async (request, response) => {
  const alert = await operations.disableAlert(request.params.id);
  return alert ? response.json(alert) : response.status(404).json({ error: "alert_not_found" });
});

const aPlusTelegramSchema = z.object({
  symbol: z.string().min(2).max(20).transform((value) => value.toUpperCase()),
  timeframe: z.enum(["D1", "H4"]).default("H4"),
  confirmationBars: z.number().int().min(1).max(10).default(3),
  detectedAt: z.number().int().positive().optional(),
});

app.post("/api/notifications/a-plus-telegram", mutationRateLimit, async (request, response) => {
  const parsed = aPlusTelegramSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: "invalid_a_plus_notification", issues: parsed.error.issues });
  const meta = getSymbolMeta(parsed.data.symbol);
  if (meta.symbol !== parsed.data.symbol) return response.status(404).json({ error: "symbol_not_found" });
  try {
    await ensureChartRows(meta, parsed.data.timeframe);
    const workspace = snapshots.getWorkspace(meta.symbol, parsed.data.timeframe, parsed.data.confirmationBars);
    const row = workspace.selectedScanner;
    if (!row || row.classification !== "A+") {
      return response.status(409).json({ error: "symbol_not_a_plus", symbol: meta.symbol, classification: row?.classification ?? "NONE" });
    }
    const quotePayload = await providerBootstrap.provider.getQuotes([meta]).catch(() => ({ items: [] }));
    const quote = quotePayload.items?.find((item) => item.symbol === meta.symbol) ?? null;
    const key = `${workspace.scanner.sync.snapshotId}:${meta.symbol}:A+`;
    const payload = buildAPlusTelegramPayload({ row, analysis: workspace.chart, quote, snapshotId: workspace.scanner.sync.snapshotId });
    const telegramResult = await telegram.sendAPlus({ key, message: payload.message });
    if (telegramResult.sent) await trackTelegramSignal(payload.plan, key);
    logger.info({ event: "a_plus_telegram_notification", symbol: meta.symbol, sent: telegramResult.sent, reason: telegramResult.reason });
    return response.status(telegramResult.sent ? 201 : 200).json({
      symbol: meta.symbol,
      notification: "telegram",
      ...telegramResult,
      configured: telegram.configured,
      snapshotId: workspace.scanner.sync.snapshotId,
      tracked: telegramResult.sent,
    });
  } catch (error) {
    if (isMarketDataUnavailable(error)) return marketDataUnavailable(response, meta.symbol, parsed.data.timeframe, error);
    logger.error({ event: "a_plus_telegram_failed", symbol: meta.symbol, message: error.message });
    return response.status(502).json({ error: "telegram_notification_failed", message: error.message });
  }
});

const journalSchema = z.object({
  symbol: z.string().min(2).max(20),
  timeframe: z.enum(["D1", "H4"]),
  score: z.number().int().min(0).max(100),
  classification: z.enum(["A+", "A", "B", "C"]),
  signal: z.string().min(2).max(40),
  snapshotId: z.string().min(6).max(80).nullable().optional(),
  notes: z.string().max(2000).optional(),
});

app.get("/api/journal", (_request, response) => response.json({ items: operations.listJournal(), total: operations.listJournal().length }));

app.post("/api/journal", mutationRateLimit, async (request, response) => {
  const parsed = journalSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: "invalid_journal_entry", issues: parsed.error.issues });
  const result = await operations.createJournalEntry(parsed.data, request.headers["idempotency-key"]);
  response.setHeader("Idempotency-Replayed", String(result.replayed));
  return response.status(result.replayed ? 200 : 201).json(result.item);
});

app.delete("/api/journal", mutationRateLimit, async (_request, response) => response.json({ removed: await operations.clearJournal() }));

const dist = path.resolve(__dirname, "../dist");
app.use(express.static(dist, { immutable: true, maxAge: "1y", index: false }));
app.get("/{*path}", (_request, response) => response.sendFile(path.join(dist, "index.html")));
app.use((error, _request, response, next) => {
  if (response.headersSent) return next(error);
  logger.error({ event: "request_failed", requestId: response.getHeader("X-Request-Id"), message: error.message });
  return response.status(500).json({ error: "internal_error", requestId: response.getHeader("X-Request-Id") });
});

const server = app.listen(port, host, () => {
  logger.info({ event: "server_started", host, port, provider: process.env.DATA_PROVIDER ?? "hybrid" });
});

async function shutdown() {
  const forceExit = setTimeout(() => process.exit(1), 5_000);
  forceExit.unref();
  providerBootstrap.provider.stopAutoRefresh?.();
  await operations.flush().catch(() => {});
  await runtimeCache.close().catch(() => {});
  await closePostgresPool(postgresPool);
  server.close(() => {
    clearTimeout(forceExit);
    process.exit(0);
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
