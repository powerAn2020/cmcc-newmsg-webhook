import { z } from 'zod';
import type { CmccAccount } from './types.js';

const accountSchema = z.object({
  apiKey: z.string().min(1),
  to: z.string().min(1).optional(),
  defaultTo: z.string().min(1).optional()
}).transform((v): CmccAccount => ({ apiKey: v.apiKey, defaultTo: v.defaultTo ?? v.to }));

const mapSchema = z.record(accountSchema);

function parseMap(name: string, fallback = '{}'): Record<string, CmccAccount> {
  const raw = process.env[name] ?? fallback;
  try {
    return mapSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(`${name} must be a JSON object of {apiKey, defaultTo}`);
  }
}

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
  databasePath: string;
  adminUsername: string;
  adminPassword: string;
  encryptionKey: string;
  cookieSecure: boolean;
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
    databasePath: process.env.CMCC_DATABASE_PATH ?? './data/cmcc-webhook.sqlite',
    adminUsername,
    adminPassword,
    encryptionKey,
    cookieSecure: process.env.ADMIN_COOKIE_SECURE === 'true'
  };
}

export function maskSecret(value: string): string {
  return value.length <= 6 ? '***' : `${value.slice(0, 3)}***${value.slice(-3)}`;
}
