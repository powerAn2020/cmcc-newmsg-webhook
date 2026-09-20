import fs from 'node:fs';
import { z } from 'zod';
import type { CmccAccount } from './types.js';

const accountSchema = z.object({
  apiKey: z.string().min(1)
}).transform((v): CmccAccount => ({ apiKey: v.apiKey }));

const mapSchema = z.record(accountSchema);

function parseMap(name: string, fallback = '{}'): Record<string, CmccAccount> {
  const raw = process.env[name] ?? fallback;
  try {
    return mapSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(`${name} must be a JSON object of {apiKey}`);
  }
}

export type DatabaseType = 'sqlite' | 'postgres' | 'mysql';

export interface AppConfig {
  host: string;
  port: number;
  wsUrl: string;
  wsVersion: string;
  sendTimeoutMs: number;
  uploadUrl: string;
  uploadTimeoutMs: number;
  gotifyTokens: Record<string, CmccAccount>;
  webhookSecrets: Record<string, CmccAccount>;
  databaseType: DatabaseType;
  databasePath: string;
  databaseUrl?: string;
  databaseHost?: string;
  databasePort?: number;
  databaseUser?: string;
  databasePassword?: string;
  databaseName?: string;
  databaseSsl?: boolean;
  adminUsername: string;
  adminPassword: string;
  encryptionKey: string;
  cookieSecure: boolean;
  adminLoginFailLimit: number;
  adminLoginFailWindowMin: number;
  adminLoginFailWindowMs: number;
  adminLoginBanDurationMin: number;
  adminLoginBanDurationMs: number;
  accessLogPath: string;
  accessLogFormat: 'json';
  accessLogRetentionDays: number;
  trustProxy: boolean | string;
  notifyOnLogin: boolean;
  notifyOnLoginFailed: boolean;
  notifyOnAuthFailed: boolean;
  notifyUpstreamId: number;
  notifyLoginFailThreshold: number;
  notifyAuthFailThreshold: number;
  notifyAuthFailWindowMin: number;
  rateLimitMsgMinMax: number;
  rateLimitMsgMinIntervalSec: number;
  rateLimitMsgHourMax: number;
  rateLimitMsgDayMax: number;
  rateLimitIpMinMax: number;
  rateLimitDuplicateWindowSec: number;
  notifyOnRateLimit: boolean;
}

export function loadConfig(): AppConfig {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1-65535');
  const wsUrl = process.env.CMCC_WS_URL ?? 'wss://5gvas01.cmicmaap.com/gtw-ai/openclaw/ws/msg';
  if (!z.string().url().safeParse(wsUrl).success || !/^wss?:\/\//.test(wsUrl)) throw new Error('CMCC_WS_URL must be a ws or wss URL');
  const sendTimeoutMs = Number(process.env.CMCC_SEND_TIMEOUT_MS ?? 10000);
  if (!Number.isInteger(sendTimeoutMs) || sendTimeoutMs < 1000 || sendTimeoutMs > 120000) throw new Error('CMCC_SEND_TIMEOUT_MS must be 1000-120000');
  const uploadUrl = process.env.CMCC_UPLOAD_URL ?? 'https://5gvas01.cmicmaap.com/gtw-ai/openclaw/api';
  if (!z.string().url().safeParse(uploadUrl).success || !/^https?:\/\//.test(uploadUrl)) throw new Error('CMCC_UPLOAD_URL must be an http or https URL');
  const uploadTimeoutMs = Number(process.env.CMCC_UPLOAD_TIMEOUT_MS ?? 120000);
  if (!Number.isInteger(uploadTimeoutMs) || uploadTimeoutMs < 1000 || uploadTimeoutMs > 600000) throw new Error('CMCC_UPLOAD_TIMEOUT_MS must be 1000-600000');
  const adminUsername = process.env.ADMIN_USERNAME;
  const adminPassword = process.env.ADMIN_PASSWORD;
  const encryptionKey = process.env.CONFIG_ENCRYPTION_KEY;
  if (!adminUsername || !adminPassword || !encryptionKey) {
    throw new Error('ADMIN_USERNAME, ADMIN_PASSWORD, and CONFIG_ENCRYPTION_KEY are required');
  }

  const adminLoginFailLimit = Number(process.env.ADMIN_LOGIN_FAIL_LIMIT ?? 5);
  if (!Number.isInteger(adminLoginFailLimit) || adminLoginFailLimit < 1) {
    throw new Error('ADMIN_LOGIN_FAIL_LIMIT must be a positive integer');
  }

  let adminLoginFailWindowMin = 15;
  if (process.env.ADMIN_LOGIN_FAIL_WINDOW_MIN !== undefined) {
    adminLoginFailWindowMin = Number(process.env.ADMIN_LOGIN_FAIL_WINDOW_MIN);
    if (!Number.isInteger(adminLoginFailWindowMin) || adminLoginFailWindowMin < 1) {
      throw new Error('ADMIN_LOGIN_FAIL_WINDOW_MIN must be a positive integer (minutes)');
    }
  } else if (process.env.ADMIN_LOGIN_FAIL_WINDOW_MS !== undefined) {
    const ms = Number(process.env.ADMIN_LOGIN_FAIL_WINDOW_MS);
    if (!Number.isInteger(ms) || ms < 1000) {
      throw new Error('ADMIN_LOGIN_FAIL_WINDOW_MS must be at least 1000');
    }
    adminLoginFailWindowMin = Math.max(1, Math.round(ms / 60000));
  }
  const adminLoginFailWindowMs = adminLoginFailWindowMin * 60_000;

  let adminLoginBanDurationMin = 30;
  if (process.env.ADMIN_LOGIN_BAN_DURATION_MIN !== undefined) {
    adminLoginBanDurationMin = Number(process.env.ADMIN_LOGIN_BAN_DURATION_MIN);
    if (!Number.isInteger(adminLoginBanDurationMin) || adminLoginBanDurationMin < 1) {
      throw new Error('ADMIN_LOGIN_BAN_DURATION_MIN must be a positive integer (minutes)');
    }
  } else if (process.env.ADMIN_LOGIN_BAN_DURATION_MS !== undefined) {
    const ms = Number(process.env.ADMIN_LOGIN_BAN_DURATION_MS);
    if (!Number.isInteger(ms) || ms < 1000) {
      throw new Error('ADMIN_LOGIN_BAN_DURATION_MS must be at least 1000');
    }
    adminLoginBanDurationMin = Math.max(1, Math.round(ms / 60000));
  }
  const adminLoginBanDurationMs = adminLoginBanDurationMin * 60_000;

  const trustProxyEnv = process.env.TRUST_PROXY?.trim();
  const trustProxy: boolean | string = trustProxyEnv === 'true' || trustProxyEnv === '1'
    ? true
    : trustProxyEnv === 'false' || trustProxyEnv === '0' || !trustProxyEnv
      ? false
      : trustProxyEnv;

  const accessLogFormat = 'json' as const;
  const accessLogRetentionDays = Math.max(1, Number(process.env.ACCESS_LOG_RETENTION_DAYS ?? 7) || 7);
  const notifyOnLogin = process.env.NOTIFY_ON_LOGIN === 'true';
  const notifyOnLoginFailed = process.env.NOTIFY_ON_LOGIN_FAILED === 'true';
  const notifyOnAuthFailed = process.env.NOTIFY_ON_AUTH_FAILED === 'true';
  const notifyUpstreamId = Number(process.env.NOTIFY_UPSTREAM_ID ?? 0) || 0;
  const notifyLoginFailThreshold = Math.max(1, Number(process.env.NOTIFY_LOGIN_FAIL_THRESHOLD ?? 3) || 3);
  const notifyAuthFailThreshold = Math.max(1, Number(process.env.NOTIFY_AUTH_FAIL_THRESHOLD ?? 3) || 3);
  const notifyAuthFailWindowMin = Math.max(1, Number(process.env.NOTIFY_AUTH_FAIL_WINDOW_MIN ?? 1) || 1);

  const parseEnvInt = (val: string | undefined, defaultVal: number): number => {
    if (val === undefined || val === '') return defaultVal;
    const n = Number(val);
    return Number.isInteger(n) && n >= 0 ? n : defaultVal;
  };

  const rateLimitMsgMinMax = parseEnvInt(process.env.RATE_LIMIT_MSG_MIN_MAX, 10);
  const rateLimitMsgMinIntervalSec = parseEnvInt(process.env.RATE_LIMIT_MSG_MIN_INTERVAL_SEC ?? process.env.RATE_LIMIT_PHONE_MIN_INTERVAL_SEC, 0);
  const rateLimitMsgHourMax = parseEnvInt(process.env.RATE_LIMIT_MSG_HOUR_MAX ?? process.env.RATE_LIMIT_PHONE_HOUR_MAX, 0);
  const rateLimitMsgDayMax = parseEnvInt(process.env.RATE_LIMIT_MSG_DAY_MAX ?? process.env.RATE_LIMIT_PHONE_DAY_MAX, 0);
  const rateLimitIpMinMax = parseEnvInt(process.env.RATE_LIMIT_IP_MIN_MAX, 30);
  const rateLimitDuplicateWindowSec = parseEnvInt(process.env.RATE_LIMIT_DUPLICATE_WINDOW_SEC, 300);
  const notifyOnRateLimit = process.env.NOTIFY_ON_RATE_LIMIT !== 'false';

  const rawDbType = (process.env.DB_TYPE || process.env.DATABASE_TYPE || 'sqlite').toLowerCase();
  const databaseType: DatabaseType = rawDbType === 'postgres' || rawDbType === 'postgresql' || rawDbType === 'pg'
    ? 'postgres'
    : rawDbType === 'mysql' || rawDbType === 'mariadb'
      ? 'mysql'
      : 'sqlite';

  const databaseUrl = process.env.DATABASE_URL || undefined;
  const databaseHost = process.env.DB_HOST || undefined;
  const databasePort = process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined;
  const databaseUser = process.env.DB_USER || undefined;
  const databasePassword = process.env.DB_PASSWORD || undefined;
  const databaseName = process.env.DB_NAME || undefined;
  const databaseSsl = process.env.DB_SSL === 'true';

  return {
    host: process.env.HOST ?? '0.0.0.0',
    port,
    wsUrl,
    wsVersion: process.env.CMCC_WS_VERSION ?? '2.0',
    sendTimeoutMs,
    uploadUrl,
    uploadTimeoutMs,
    gotifyTokens: parseMap('CMCC_TOKEN_MAP'),
    webhookSecrets: parseMap('CMCC_WEBHOOK_SECRETS'),
    databaseType,
    databasePath: process.env.CMCC_DATABASE_PATH ?? './data/cmcc-webhook.sqlite',
    databaseUrl,
    databaseHost,
    databasePort,
    databaseUser,
    databasePassword,
    databaseName,
    databaseSsl,
    adminUsername,
    adminPassword,
    encryptionKey,
    cookieSecure: process.env.ADMIN_COOKIE_SECURE === 'true',
    adminLoginFailLimit,
    adminLoginFailWindowMin,
    adminLoginFailWindowMs,
    adminLoginBanDurationMin,
    adminLoginBanDurationMs,
    accessLogPath: process.env.ACCESS_LOG_PATH ?? './logs/access.log',
    accessLogFormat,
    accessLogRetentionDays,
    trustProxy,
    notifyOnLogin,
    notifyOnLoginFailed,
    notifyOnAuthFailed,
    notifyUpstreamId,
    notifyLoginFailThreshold,
    notifyAuthFailThreshold,
    notifyAuthFailWindowMin,
    rateLimitMsgMinMax,
    rateLimitMsgMinIntervalSec,
    rateLimitMsgHourMax,
    rateLimitMsgDayMax,
    rateLimitIpMinMax,
    rateLimitDuplicateWindowSec,
    notifyOnRateLimit
  };
}

export function maskSecret(value: string): string {
  return value.length <= 6 ? '***' : `${value.slice(0, 3)}***${value.slice(-3)}`;
}

export function updateEnvFile(updates: Record<string, string | number | boolean>) {
  const envPath = '.env';
  if (!fs.existsSync(envPath)) {
    const content = Object.entries(updates).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
    fs.writeFileSync(envPath, content, 'utf8');
    return;
  }
  let content = fs.readFileSync(envPath, 'utf8');

  // Migrate legacy _MS keys to _MIN if present
  if ('ADMIN_LOGIN_FAIL_WINDOW_MIN' in updates) {
    content = content.replace(/^ADMIN_LOGIN_FAIL_WINDOW_MS=.*$\n?/m, '');
  }
  if ('ADMIN_LOGIN_BAN_DURATION_MIN' in updates) {
    content = content.replace(/^ADMIN_LOGIN_BAN_DURATION_MS=.*$\n?/m, '');
  }

  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      if (content && !content.endsWith('\n')) content += '\n';
      content += `${key}=${value}\n`;
    }
  }
  fs.writeFileSync(envPath, content, 'utf8');
}
