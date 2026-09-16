export interface SlidingRateLimitResult {
  allowed: boolean;
  count: number;
  remaining: number;
  retryAfterSeconds?: number;
}

export interface ICacheService {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  incrWithExpire(key: string, ttlSeconds: number): Promise<number>;
  slidingRateLimit(key: string, windowSeconds: number, maxHits: number): Promise<SlidingRateLimitResult>;
  close(): Promise<void>;
}

interface CacheItem {
  value: string;
  expiresAt: number | null;
}

interface SlidingEntry {
  timestamps: number[];
  expiresAt: number;
}

export class MemoryCacheService implements ICacheService {
  private cache = new Map<string, CacheItem>();
  private slidingMap = new Map<string, SlidingEntry>();
  private cleanupTimer?: NodeJS.Timeout;

  constructor(cleanupIntervalMs = 30_000) {
    this.cleanupTimer = setInterval(() => this.cleanup(), cleanupIntervalMs);
    this.cleanupTimer.unref?.();
  }

  async get(key: string): Promise<string | null> {
    const item = this.cache.get(key);
    if (!item) return null;
    if (item.expiresAt !== null && item.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return null;
    }
    return item.value;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const expiresAt = ttlSeconds && ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null;
    this.cache.set(key, { value, expiresAt });
  }

  async del(key: string): Promise<void> {
    this.cache.delete(key);
    this.slidingMap.delete(key);
  }

  async incrWithExpire(key: string, ttlSeconds: number): Promise<number> {
    const now = Date.now();
    const item = this.cache.get(key);
    let count = 1;
    let expiresAt = now + ttlSeconds * 1000;

    if (item && (item.expiresAt === null || item.expiresAt > now)) {
      const parsed = parseInt(item.value, 10);
      count = Number.isNaN(parsed) ? 1 : parsed + 1;
      expiresAt = item.expiresAt ?? expiresAt;
    }

    this.cache.set(key, { value: String(count), expiresAt });
    return count;
  }

  async slidingRateLimit(key: string, windowSeconds: number, maxHits: number): Promise<SlidingRateLimitResult> {
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const windowStart = now - windowMs;

    let entry = this.slidingMap.get(key);
    if (!entry) {
      entry = { timestamps: [], expiresAt: now + windowMs };
      this.slidingMap.set(key, entry);
    }

    // 剔除滑动窗口之前的旧记录
    entry.timestamps = entry.timestamps.filter(ts => ts > windowStart);
    entry.expiresAt = now + windowMs;

    const currentCount = entry.timestamps.length;
    if (currentCount >= maxHits) {
      const earliest = entry.timestamps[0] ?? now;
      const retryAfterMs = earliest + windowMs - now;
      const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
      return {
        allowed: false,
        count: currentCount,
        remaining: 0,
        retryAfterSeconds
      };
    }

    // 记录本次命中
    entry.timestamps.push(now);
    const newCount = entry.timestamps.length;
    return {
      allowed: true,
      count: newCount,
      remaining: Math.max(0, maxHits - newCount)
    };
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, item] of this.cache.entries()) {
      if (item.expiresAt !== null && item.expiresAt <= now) {
        this.cache.delete(key);
      }
    }
    for (const [key, entry] of this.slidingMap.entries()) {
      if (entry.expiresAt <= now) {
        this.slidingMap.delete(key);
      }
    }
  }

  async close(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.cache.clear();
    this.slidingMap.clear();
  }
}

export function createCacheService(): ICacheService {
  return new MemoryCacheService();
}
