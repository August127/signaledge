import fs from "node:fs/promises";
import path from "node:path";

export class JsonFileStore {
  constructor({ filePath, fallback }) {
    this.filePath = filePath;
    this.fallback = fallback;
    this.value = structuredClone(fallback);
    this.writeQueue = Promise.resolve();
  }

  async load() {
    try {
      const content = await fs.readFile(this.filePath, "utf8");
      this.value = JSON.parse(content);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.save(this.value);
    }
    return this.value;
  }

  current() {
    return structuredClone(this.value);
  }

  async save(value) {
    this.value = structuredClone(value);
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const tmpPath = `${this.filePath}.${process.pid}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(this.value, null, 2), "utf8");
      await fs.rename(tmpPath, this.filePath);
    });
    await this.writeQueue;
    return this.current();
  }
}
