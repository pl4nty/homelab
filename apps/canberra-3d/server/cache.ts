import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Files on disk keyed by a relative path, with in-flight loads shared between callers. */
export class DiskCache {
  private pending = new Map<string, Promise<Buffer>>();
  private writable = true;

  constructor(private dir: string) {}

  private file(key: string): string {
    return path.join(this.dir, key);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.file(key));
    } catch {
      return null;
    }
  }

  async set(key: string, value: Buffer): Promise<void> {
    if (!this.writable) return;
    const file = this.file(key);
    try {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile(tmp, value);
      await rename(tmp, file);
    } catch (e) {
      // A read-only or full volume costs the cache, not the request.
      this.writable = false;
      console.warn(`cache disabled: ${(e as Error).message}`);
      setTimeout(() => {
        this.writable = true;
      }, 60000).unref();
    }
  }

  /** Returns the cached bytes, or builds, stores and returns them. Concurrent callers share one build. */
  getOrBuild(key: string, build: () => Promise<Buffer>): Promise<Buffer> {
    let p = this.pending.get(key);
    if (!p) {
      p = (async () => {
        const hit = await this.get(key);
        if (hit) return hit;
        const made = await build();
        await this.set(key, made);
        return made;
      })().finally(() => this.pending.delete(key));
      this.pending.set(key, p);
    }
    return p;
  }
}

/** A small least-recently-used map for decoded source blocks. */
export class Lru<V> {
  private map = new Map<string, V>();
  constructor(private max: number) {}

  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }

  delete(key: string): void {
    this.map.delete(key);
  }
}
