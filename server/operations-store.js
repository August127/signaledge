import crypto from "node:crypto";
import fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import path from "node:path";

const emptyState = () => ({ alerts: [], journal: [], idempotency: {} });

export class OperationsStore {
  constructor({ filePath, now = () => new Date(), id = () => crypto.randomUUID() } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.id = id;
    this.state = this.load();
    this.mutationQueue = Promise.resolve();
    this.writeSequence = 0;
  }

  load() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return emptyState();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return { ...emptyState(), ...parsed };
    } catch {
      return emptyState();
    }
  }

  async persist() {
    if (!this.filePath) return;
    await fsPromises.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${++this.writeSequence}.tmp`;
    try {
      await fsPromises.writeFile(temporary, JSON.stringify(this.state, null, 2), { encoding: "utf8", mode: 0o600 });
      await fsPromises.rename(temporary, this.filePath);
    } catch (error) {
      await fsPromises.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
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
    return { alerts: this.state.alerts.length, armedAlerts: this.state.alerts.filter((item) => item.enabled).length, journalEntries: this.state.journal.length };
  }
}
