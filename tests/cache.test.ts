import { describe, expect, it } from 'vitest';
import { MemoryCacheService } from '../src/cache.js';

describe('cache unit tests', () => {
  it('handles get, set and ttl expiration', async () => {
    const cache = new MemoryCacheService();
    await cache.set('k1', 'v1');
    expect(await cache.get('k1')).toBe('v1');

    await cache.set('k2', 'v2', 1); // 1s TTL
    expect(await cache.get('k2')).toBe('v2');
    await new Promise(r => setTimeout(r, 1100));
    expect(await cache.get('k2')).toBeNull();

    await cache.del('k1');
    expect(await cache.get('k1')).toBeNull();
    await cache.close();
  });

  it('handles atomic incrWithExpire', async () => {
    const cache = new MemoryCacheService();
    const c1 = await cache.incrWithExpire('counter', 10);
    expect(c1).toBe(1);
    const c2 = await cache.incrWithExpire('counter', 10);
    expect(c2).toBe(2);
    expect(await cache.get('counter')).toBe('2');
    await cache.close();
  });

  it('handles sliding rate limit correctly', async () => {
    const cache = new MemoryCacheService();
    const key = 'test_sliding_rl';
    // 允许 2 秒内最多 2 次
    const r1 = await cache.slidingRateLimit(key, 2, 2);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(1);

    const r2 = await cache.slidingRateLimit(key, 2, 2);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(0);

    const r3 = await cache.slidingRateLimit(key, 2, 2);
    expect(r3.allowed).toBe(false);
    expect(r3.retryAfterSeconds).toBeGreaterThanOrEqual(1);

    // 等待窗口滑动过去
    await new Promise(r => setTimeout(r, 2100));
    const r4 = await cache.slidingRateLimit(key, 2, 2);
    expect(r4.allowed).toBe(true);
    await cache.close();
  });
});
