import Redis from "ioredis";
import { logger } from "./logger.js";

export function createRedisCache(env = process.env) {
  const url = env.REDIS_URL;
  if (!url) return new DisabledRedisCache();
  return new RedisRuntimeCache({
    url,
    keyPrefix: env.REDIS_KEY_PREFIX || "signaledge:",
    ttlSeconds: Math.max(1, Number(env.REDIS_CACHE_TTL_SECONDS ?? 3)),
  });
}

class DisabledRedisCache {
  constructor() {
    this.enabled = false;
  }

  async getJson() {
    return null;
  }

  async setJson() {
    return false;
  }

  async deletePattern() {
    return 0;
  }

  status() {
    return { enabled: false, connected: false };
  }

  async close() {}
}

class RedisRuntimeCache {
  constructor({ url, keyPrefix, ttlSeconds }) {
    this.enabled = true;
    this.keyPrefix = keyPrefix;
    this.ttlSeconds = ttlSeconds;
    this.connected = false;
    this.errors = 0;
    this.client = new Redis(url, {
      keyPrefix,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    this.client.on("connect", () => { this.connected = true; });
    this.client.on("close", () => { this.connected = false; });
    this.client.on("error", (error) => {
      this.errors += 1;
      logger.warn({ event: "redis_runtime_cache_error", message: error.message });
    });
  }

  async ensureConnected() {
    if (this.client.status === "ready" || this.client.status === "connect") return true;
    try {
      await this.client.connect();
      return true;
    } catch (error) {
      this.errors += 1;
      logger.warn({ event: "redis_runtime_cache_connect_failed", message: error.message });
      return false;
    }
  }

  async getJson(key) {
    if (!(await this.ensureConnected())) return null;
    try {
      const value = await this.client.get(key);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      this.errors += 1;
      logger.warn({ event: "redis_runtime_cache_get_failed", key, message: error.message });
      return null;
    }
  }

  async setJson(key, value, ttlSeconds = this.ttlSeconds) {
    if (!(await this.ensureConnected())) return false;
    try {
      await this.client.set(key, JSON.stringify(value), "EX", ttlSeconds);
      return true;
    } catch (error) {
      this.errors += 1;
      logger.warn({ event: "redis_runtime_cache_set_failed", key, message: error.message });
      return false;
    }
  }

  async deletePattern(pattern) {
    if (!(await this.ensureConnected())) return 0;
    let cursor = "0";
    let removed = 0;
    do {
      const [nextCursor, keys] = await this.client.scan(cursor, "MATCH", `${this.keyPrefix}${pattern}`, "COUNT", 100);
      cursor = nextCursor;
      const normalized = keys.map((key) => key.startsWith(this.keyPrefix) ? key.slice(this.keyPrefix.length) : key);
      if (normalized.length) removed += await this.client.del(...normalized);
    } while (cursor !== "0");
    return removed;
  }

  status() {
    return {
      enabled: true,
      connected: this.client.status === "ready",
      status: this.client.status,
      errors: this.errors,
      ttlSeconds: this.ttlSeconds,
    };
  }

  async close() {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}
