import crypto from "node:crypto";
import { Pool } from "pg";
import { JsonFileStore } from "./json-file-store.js";
import { OperationsStore } from "./operations-store.js";
import { logger } from "./logger.js";

const clone = (value) => structuredClone(value);
const emptyOperationsState = () => ({ alerts: [], journal: [], idempotency: {} });

function pgSslConfig(env = process.env) {
  const mode = String(env.PGSSLMODE ?? env.DATABASE_SSL ?? "").toLowerCase();
  if (["require", "true", "1", "yes"].includes(mode)) return { rejectUnauthorized: false };
  return undefined;
}

export function createPostgresPool(env = process.env) {
  if (!env.DATABASE_URL) return null;
  return new Pool({
    connectionString: env.DATABASE_URL,
    ssl: pgSslConfig(env),
    max: Math.max(2, Number(env.POSTGRES_POOL_MAX ?? 10)),
    idleTimeoutMillis: Math.max(5_000, Number(env.POSTGRES_IDLE_TIMEOUT_MS ?? 30_000)),
    connectionTimeoutMillis: Math.max(1_000, Number(env.POSTGRES_CONNECT_TIMEOUT_MS ?? 10_000)),
  });
}

async function ensureStateTable(pool) {
  await pool.query(`
    create table if not exists signaledge_state (
      key text primary key,
      value jsonb not null,
      updated_at timestamptz not null default now()
    )
  `);
}

export class PostgresJsonStore {
  constructor({ pool, key, fallback }) {
    this.pool = pool;
    this.key = key;
    this.fallback = clone(fallback);
    this.value = clone(fallback);
    this.writeQueue = Promise.resolve();
  }

  async load() {
    await ensureStateTable(this.pool);
    const result = await this.pool.query("select value from signaledge_state where key = $1", [this.key]);
    if (result.rowCount) {
      this.value = clone(result.rows[0].value);
      return this.current();
    }
    await this.save(this.value);
    return this.current();
  }

  current() {
    return clone(this.value);
  }

  async save(value) {
    this.value = clone(value);
    this.writeQueue = this.writeQueue.then(async () => {
      await this.pool.query(
        `insert into signaledge_state (key, value, updated_at)
         values ($1, $2::jsonb, now())
         on conflict (key) do update set value = excluded.value, updated_at = now()`,
        [this.key, JSON.stringify(this.value)],
      );
    });
    await this.writeQueue;
    return this.current();
  }
}

export class PostgresOperationsStore {
  constructor({ pool, key = "operations", now = () => new Date(), id = () => crypto.randomUUID() }) {
    this.pool = pool;
    this.key = key;
    this.now = now;
    this.id = id;
    this.state = emptyOperationsState();
    this.mutationQueue = Promise.resolve();
  }

  async load() {
    await ensureStateTable(this.pool);
    const result = await this.pool.query("select value from signaledge_state where key = $1", [this.key]);
    if (result.rowCount) {
      this.state = { ...emptyOperationsState(), ...clone(result.rows[0].value) };
      return this.state;
    }
    await this.persist();
    return this.state;
  }

  async persist() {
    await this.pool.query(
      `insert into signaledge_state (key, value, updated_at)
       values ($1, $2::jsonb, now())
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [this.key, JSON.stringify(this.state)],
    );
  }

  enqueueMutation(factory) {
    const operation = this.mutationQueue.then(factory);
    this.mutationQueue = operation.catch(() => {});
    return operation;
  }

  idempotent(scope, key, factory) {
    return this.enqueueMutation(async () => {
      if (key) {
        const existingId = this.state.idempotency[`${scope}:${key}`];
        const collection = scope === "alert" ? this.state.alerts : this.state.journal;
        const existing = collection.find((item) => item.id === existingId);
        if (existing) return { item: existing, replayed: true };
      }
      const item = factory();
      if (key) this.state.idempotency[`${scope}:${key}`] = item.id;
      await this.persist();
      return { item, replayed: false };
    });
  }

  createAlert(payload, idempotencyKey) {
    return this.idempotent("alert", idempotencyKey, () => {
      const alert = { id: this.id(), status: "armed", enabled: true, createdAt: this.now().toISOString(), ...payload };
      this.state.alerts.unshift(alert);
      return alert;
    });
  }

  listAlerts() {
    return this.state.alerts;
  }

  disableAlert(id) {
    return this.enqueueMutation(async () => {
      const alert = this.state.alerts.find((item) => item.id === id);
      if (!alert) return null;
      alert.enabled = false;
      alert.status = "disabled";
      alert.updatedAt = this.now().toISOString();
      await this.persist();
      return alert;
    });
  }

  createJournalEntry(payload, idempotencyKey) {
    return this.idempotent("journal", idempotencyKey, () => {
      const entry = { id: this.id(), loggedAt: this.now().toISOString(), ...payload };
      this.state.journal.unshift(entry);
      this.state.journal = this.state.journal.slice(0, 500);
      return entry;
    });
  }

  listJournal() {
    return this.state.journal;
  }

  clearJournal() {
    return this.enqueueMutation(async () => {
      const removed = this.state.journal.length;
      this.state.journal = [];
      this.state.idempotency = Object.fromEntries(Object.entries(this.state.idempotency).filter(([key]) => !key.startsWith("journal:")));
      await this.persist();
      return removed;
    });
  }

  flush() {
    return this.mutationQueue;
  }

  stats() {
    return {
      alerts: this.state.alerts.length,
      armedAlerts: this.state.alerts.filter((item) => item.enabled).length,
      journalEntries: this.state.journal.length,
    };
  }
}

export async function createJsonStateStore({ pool, key, filePath, fallback }) {
  const store = pool
    ? new PostgresJsonStore({ pool, key, fallback })
    : new JsonFileStore({ filePath, fallback });
  await store.load();
  return store;
}

export async function createOperationsStateStore({ pool, filePath }) {
  const store = pool
    ? new PostgresOperationsStore({ pool })
    : new OperationsStore({ filePath });
  if (pool) await store.load();
  return store;
}

export async function closePostgresPool(pool) {
  if (!pool) return;
  try {
    await pool.end();
  } catch (error) {
    logger.warn({ event: "postgres_pool_close_failed", message: error.message });
  }
}
