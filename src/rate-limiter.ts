import crypto from 'node:crypto';
import type { ICacheService } from './cache.js';
import type { SecurityAlertSettings } from './store.js';

export interface RateLimitCheckInput {
  phone?: string;
  ip: string;
  content?: string;
  credentialId?: number;
}

export interface RateLimitCheckResult {
  allowed: boolean;
  reason?: string;
  retryAfterSeconds?: number;
  blockedType?: 'phone_interval' | 'phone_hour' | 'phone_day' | 'duplicate' | 'ip';
}

export class MessageRateLimiter {
  constructor(private readonly cache: ICacheService) {}

  private hashContent(phone: string, content: string): string {
    return crypto.createHash('sha256').update(`${phone}:${content.trim()}`).digest('hex');
  }

  async check(input: RateLimitCheckInput, settings: SecurityAlertSettings): Promise<RateLimitCheckResult> {
    const { phone, ip, content } = input;

    // 1. 客户端 IP 频率限制 (默认 30 次/分钟)
    const ipMax = settings.rateLimitIpMinMax || 30;
    const ipRes = await this.cache.slidingRateLimit(`rl:ip:${ip}`, 60, ipMax);
    if (!ipRes.allowed) {
      return {
        allowed: false,
        reason: `客户端 IP (${ip}) 发送频率超限 (上限 ${ipMax} 次/分钟)，请稍后再试。`,
        retryAfterSeconds: ipRes.retryAfterSeconds,
        blockedType: 'ip'
      };
    }

    if (phone) {
      const cleanPhone = phone.trim();

      // 2. 相同内容重复提交抑制 (去重窗口防重复轰炸)
      const dedupWindow = settings.rateLimitDuplicateWindowSec ?? 300;
      if (dedupWindow > 0 && content && content.trim().length > 0) {
        const contentHash = this.hashContent(cleanPhone, content);
        const dedupKey = `rl:dedup:${contentHash}`;
        const existing = await this.cache.get(dedupKey);
        if (existing) {
          return {
            allowed: false,
            reason: `向目标 (${cleanPhone}) 发送的相同消息在 ${dedupWindow} 秒内已被拦截抑制，防止重复刷屏。`,
            retryAfterSeconds: dedupWindow,
            blockedType: 'duplicate'
          };
        }
      }

      // 3. 手机号最小发送间隔检查 (默认 60 秒限制 1 条)
      const minInterval = settings.rateLimitPhoneMinIntervalSec ?? 60;
      if (minInterval > 0) {
        const intervalKey = `rl:phone_int:${cleanPhone}`;
        const lastSent = await this.cache.get(intervalKey);
        if (lastSent) {
          const elapsed = Math.floor((Date.now() - Number(lastSent)) / 1000);
          const remaining = Math.max(1, minInterval - elapsed);
          return {
            allowed: false,
            reason: `同一手机号 (${cleanPhone}) 发送间隔不能少于 ${minInterval} 秒，请等待 ${remaining} 秒后重试。`,
            retryAfterSeconds: remaining,
            blockedType: 'phone_interval'
          };
        }
      }

      // 4. 手机号 1 小时频控 (默认 10 条)
      const hourMax = settings.rateLimitPhoneHourMax ?? 10;
      if (hourMax > 0) {
        const hourRes = await this.cache.slidingRateLimit(`rl:phone_hr:${cleanPhone}`, 3600, hourMax);
        if (!hourRes.allowed) {
          return {
            allowed: false,
            reason: `目标手机号 (${cleanPhone}) 1 小时内发送量达到上限 (${hourMax} 条)，已触发防轰炸拦截。`,
            retryAfterSeconds: hourRes.retryAfterSeconds,
            blockedType: 'phone_hour'
          };
        }
      }

      // 5. 手机号 24 小时自然日频控 (默认 20 条)
      const dayMax = settings.rateLimitPhoneDayMax ?? 20;
      if (dayMax > 0) {
        const dayRes = await this.cache.slidingRateLimit(`rl:phone_day:${cleanPhone}`, 86400, dayMax);
        if (!dayRes.allowed) {
          return {
            allowed: false,
            reason: `目标手机号 (${cleanPhone}) 24 小时内累计发送量达到上限 (${dayMax} 条)，今日暂停下发。`,
            retryAfterSeconds: dayRes.retryAfterSeconds,
            blockedType: 'phone_day'
          };
        }
      }
    }

    return { allowed: true };
  }

  /**
   * 当消息正式提交上游成功后，记录最小间隔与去重锁
   */
  async recordSuccess(phone?: string, content?: string, settings?: SecurityAlertSettings): Promise<void> {
    if (!phone) return;
    const cleanPhone = phone.trim();

    if (settings) {
      const minInterval = settings.rateLimitPhoneMinIntervalSec ?? 60;
      if (minInterval > 0) {
        await this.cache.set(`rl:phone_int:${cleanPhone}`, String(Date.now()), minInterval);
      }

      const dedupWindow = settings.rateLimitDuplicateWindowSec ?? 300;
      if (dedupWindow > 0 && content && content.trim().length > 0) {
        const contentHash = this.hashContent(cleanPhone, content);
        await this.cache.set(`rl:dedup:${contentHash}`, '1', dedupWindow);
      }
    }
  }
}
