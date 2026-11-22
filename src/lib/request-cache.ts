/** Bounded in-memory LRU + TTL cache and in-flight request deduplicator. */
interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const DEFAULT_MAX_ENTRIES = 80;

export class MemoryTtlCache {
  private readonly store = new Map<string, CacheEntry<unknown>>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly keyEpochs = new Map<string, number>();
  private clearGeneration = 0;
  private nextEpoch = 1;
  private readonly maxEntries: number;

  constructor(maxEntries: number = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  get<T>(key: string, now: number = Date.now()): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.store.delete(key);
      return undefined;
    }
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number, now: number = Date.now()): void {
    if (ttlMs <= 0) return;
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) this.store.delete(oldestKey);
    }
    this.store.set(key, { value, expiresAt: now + ttlMs });
  }

  async getOrLoad<T>(
    key: string,
    ttlMs: number,
    loader: () => Promise<T>,
    options?: { forceRefresh?: boolean; cacheNullish?: boolean }
  ): Promise<T> {
    if (!options?.forceRefresh) {
      const cached = this.get<T>(key);
      if (cached !== undefined) return cached;

      const pending = this.inFlight.get(key);
      if (pending) return pending as Promise<T>;
    }

    const capturedClearGen = this.clearGeneration;
    const epoch = this.nextEpoch++;
    this.keyEpochs.set(key, epoch);

    const promise = loader()
      .then((value) => {
        if (
          this.clearGeneration === capturedClearGen &&
          this.keyEpochs.get(key) === epoch &&
          (options?.cacheNullish !== false || (value !== null && value !== undefined))
        ) {
          this.set(key, value, ttlMs);
        }
        return value;
      })
      .finally(() => {
        if (this.inFlight.get(key) === promise) {
          this.inFlight.delete(key);
        }
        if (this.clearGeneration === capturedClearGen && this.keyEpochs.get(key) === epoch) {
          this.keyEpochs.delete(key);
        }
      });

    this.inFlight.set(key, promise);
    return promise;
  }

  invalidate(key: string): void {
    this.store.delete(key);
    this.inFlight.delete(key);
    this.keyEpochs.set(key, this.nextEpoch++);
  }

  invalidatePrefix(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        this.keyEpochs.set(key, this.nextEpoch++);
      }
    }
    for (const key of this.inFlight.keys()) {
      if (key.startsWith(prefix)) {
        this.inFlight.delete(key);
        this.keyEpochs.set(key, this.nextEpoch++);
      }
    }
  }

  clear(): void {
    this.clearGeneration += 1;
    this.store.clear();
    this.inFlight.clear();
    this.keyEpochs.clear();
  }
}

export const sharedRequestCache = new MemoryTtlCache(80);

export function clearRequestCache(): void {
  sharedRequestCache.clear();
}
