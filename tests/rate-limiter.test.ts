import { describe, expect, it } from 'vitest';
import { MemoryCacheService } from '../src/cache.js';
import { MessageRateLimiter } from '../src/rate-limiter.js';
import type { SecurityAlertSettings } from '../src/store.js';

describe('MessageRateLimiter unit tests', () => {
  const baseSettings: SecurityAlertSettings = {
    accessLogFormat: 'json',
    accessLogRetentionDays: 30,
    notifyOnLogin: false,
    notifyOnLoginFailed: false,
    notifyOnAuthFailed: false,
    notifyUpstreamId: 0,
    notifyLoginFailThreshold: 3,
    notifyAuthFailThreshold: 3,
    notifyAuthFailWindowMin: 1,
    rateLimitMsgMinMax: 10,
    rateLimitMsgMinIntervalSec: 2, // 测试设为 2s 便于快速验证
    rateLimitMsgHourMax: 3,
    rateLimitMsgDayMax: 5,
    rateLimitIpMinMax: 5,
    rateLimitDuplicateWindowSec: 2, // 测试设为 2s
    notifyOnRateLimit: true
  };

  it('enforces minimum interval between messages', async () => {
    const cache = new MemoryCacheService();
    const limiter = new MessageRateLimiter(cache);

    // 第 1 次检查允许
    const check1 = await limiter.check({ credentialId: 1, ip: '127.0.0.1', content: 'msg 1' }, baseSettings);
    expect(check1.allowed).toBe(true);

    // 记录成功发送
    await limiter.recordSuccess('msg 1', 1, baseSettings);

    // 立即再次同一凭据发送，触发最小间隔拦截
    const check2 = await limiter.check({ credentialId: 1, ip: '127.0.0.1', content: 'msg 2' }, baseSettings);
    expect(check2.allowed).toBe(false);
    expect(check2.blockedType).toBe('msg_interval');
    expect(check2.reason).toContain('发送间隔不能少于');

    // 不同的凭据不受影响
    const checkOther = await limiter.check({ credentialId: 2, ip: '127.0.0.1', content: 'msg 2' }, baseSettings);
    expect(checkOther.allowed).toBe(true);

    // 等待 2s 间隔过后恢复允许
    await new Promise(r => setTimeout(r, 2100));
    const check3 = await limiter.check({ credentialId: 1, ip: '127.0.0.1', content: 'msg 3' }, baseSettings);
    expect(check3.allowed).toBe(true);

    await cache.close();
  });

  it('enforces duplicate content suppression', async () => {
    const cache = new MemoryCacheService();
    const limiter = new MessageRateLimiter(cache);
    const settings = { ...baseSettings, rateLimitMsgMinIntervalSec: 0 }; // 禁用间隔，专门测试内容去重

    const check1 = await limiter.check({ credentialId: 1, ip: '127.0.0.1', content: '验证码 1234' }, settings);
    expect(check1.allowed).toBe(true);
    await limiter.recordSuccess('验证码 1234', 1, settings);

    // 相同凭据 + 相同内容 -> 触发去重抑制
    const checkDup = await limiter.check({ credentialId: 1, ip: '127.0.0.1', content: '验证码 1234' }, settings);
    expect(checkDup.allowed).toBe(false);
    expect(checkDup.blockedType).toBe('duplicate');
    expect(checkDup.reason).toContain('相同消息内容在');

    // 相同凭据 + 不同内容 -> 允许
    const checkDiff = await limiter.check({ credentialId: 1, ip: '127.0.0.1', content: '新验证码 5678' }, settings);
    expect(checkDiff.allowed).toBe(true);

    // 不同凭据 + 相同内容 -> 允许
    const checkDiffCred = await limiter.check({ credentialId: 2, ip: '127.0.0.1', content: '验证码 1234' }, settings);
    expect(checkDiffCred.allowed).toBe(true);

    await cache.close();
  });

  it('enforces hourly limits on messages', async () => {
    const cache = new MemoryCacheService();
    const limiter = new MessageRateLimiter(cache);
    const settings = { ...baseSettings, rateLimitMsgMinIntervalSec: 0, rateLimitMsgHourMax: 2 };

    const c1 = await limiter.check({ credentialId: 1, ip: '127.0.0.1' }, settings);
    expect(c1.allowed).toBe(true);

    const c2 = await limiter.check({ credentialId: 1, ip: '127.0.0.1' }, settings);
    expect(c2.allowed).toBe(true);

    // 达到上限 2 次
    const c3 = await limiter.check({ credentialId: 1, ip: '127.0.0.1' }, settings);
    expect(c3.allowed).toBe(false);
    expect(c3.blockedType).toBe('msg_hour');
    expect(c3.reason).toContain('1 小时内消息发送量达到上限');

    await cache.close();
  });

  it('enforces client IP rate limit', async () => {
    const cache = new MemoryCacheService();
    const limiter = new MessageRateLimiter(cache);
    const settings = { ...baseSettings, rateLimitIpMinMax: 2 };

    const c1 = await limiter.check({ ip: '1.2.3.4' }, settings);
    expect(c1.allowed).toBe(true);
    const c2 = await limiter.check({ ip: '1.2.3.4' }, settings);
    expect(c2.allowed).toBe(true);

    // 超出 IP 限制
    const c3 = await limiter.check({ ip: '1.2.3.4' }, settings);
    expect(c3.allowed).toBe(false);
    expect(c3.blockedType).toBe('ip');
    expect(c3.reason).toContain('客户端 IP (1.2.3.4) 发送频率超限');

    await cache.close();
  });
});
