import crypto from 'node:crypto';
import type { ICacheService } from './cache.js';
import type { SecurityAlertSettings } from './store.js';

export interface RateLimitCheckInput {
  ip: string;
  content?: string;
  credentialId?: number;
}

export interface RateLimitCheckResult {
  allowed: boolean;
  reason?: string;
  retryAfterSeconds?: number;
  blockedType?: 'msg_interval' | 'msg_hour' | 'msg_day' | 'duplicate' | 'ip';
}

export class MessageRateLimiter {
  constructor(private readonly cache: ICacheService) {}

  private hashContent(content: string, credentialId?: number): string {
    const scope = credentialId !== undefined ? `cred:${credentialId}` : 'global';
    return crypto.createHash('sha256').update(`${scope}:${content.trim()}`).digest('hex');
  }

  async check(input: RateLimitCheckInput, settings: SecurityAlertSettings): Promise<RateLimitCheckResult> {
    const { ip, content, credentialId } = input;

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

    const scopeKey = credentialId !== undefined ? `cred:${credentialId}` : 'global';

    // 2. 相同内容重复提交抑制 (去重窗口防重复刷屏)
    const dedupWindow = settings.rateLimitDuplicateWindowSec ?? 300;
    if (dedupWindow > 0 && content && content.trim().length > 0) {
      const contentHash = this.hashContent(content, credentialId);
      const dedupKey = `rl:dedup:${contentHash}`;
      const existing = await this.cache.get(dedupKey);
      if (existing) {
        return {
          allowed: false,
          reason: `相同消息内容在 ${dedupWindow} 秒内已被拦截抑制，防止重复刷屏。`,
          retryAfterSeconds: dedupWindow,
          blockedType: 'duplicate'
        };
      }
    }

    // 3. 消息最小发送间隔检查 (默认 0 关闭)
    const minInterval = settings.rateLimitMsgMinIntervalSec ?? 0;
    if (minInterval > 0) {
      const intervalKey = `rl:msg_int:${scopeKey}`;
      const lastSent = await this.cache.get(intervalKey);
      if (lastSent) {
        const elapsed = Math.floor((Date.now() - Number(lastSent)) / 1000);
        const remaining = Math.max(1, minInterval - elapsed);
        return {
          allowed: false,
          reason: `消息发送间隔不能少于 ${minInterval} 秒，请等待 ${remaining} 秒后重试。`,
          retryAfterSeconds: remaining,
          blockedType: 'msg_interval'
        };
      }
    }

    // 4. 1 小时频控 (默认 0 不限制)
    const hourMax = settings.rateLimitMsgHourMax ?? 0;
    if (hourMax > 0) {
      const hourRes = await this.cache.slidingRateLimit(`rl:msg_hr:${scopeKey}`, 3600, hourMax);
      if (!hourRes.allowed) {
        return {
          allowed: false,
          reason: `1 小时内消息发送量达到上限 (${hourMax} 条)，已触发防滥发拦截。`,
          retryAfterSeconds: hourRes.retryAfterSeconds,
          blockedType: 'msg_hour'
        };
      }
    }

    // 5. 24 小时自然日频控 (默认 0 不限制)
    const dayMax = settings.rateLimitMsgDayMax ?? 0;
    if (dayMax > 0) {
      const dayRes = await this.cache.slidingRateLimit(`rl:msg_day:${scopeKey}`, 86400, dayMax);
      if (!dayRes.allowed) {
        return {
          allowed: false,
          reason: `24 小时内累计消息发送量达到上限 (${dayMax} 条)，今日暂停下发。`,
          retryAfterSeconds: dayRes.retryAfterSeconds,
          blockedType: 'msg_day'
        };
      }
    }

    return { allowed: true };
  }

  /**
   * 当消息正式提交上游成功或入队后，记录最小间隔与去重锁
   */
  async recordSuccess(content?: string, credentialId?: number, settings?: SecurityAlertSettings): Promise<void> {
    if (!settings) return;
    const scopeKey = credentialId !== undefined ? `cred:${credentialId}` : 'global';

    const minInterval = settings.rateLimitMsgMinIntervalSec ?? 0;
    if (minInterval > 0) {
      await this.cache.set(`rl:msg_int:${scopeKey}`, String(Date.now()), minInterval);
    }

    const dedupWindow = settings.rateLimitDuplicateWindowSec ?? 300;
    if (dedupWindow > 0 && content && content.trim().length > 0) {
      const contentHash = this.hashContent(content, credentialId);
      await this.cache.set(`rl:dedup:${contentHash}`, '1', dedupWindow);
    }
  }
}
