import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Pool as PgPool, type PoolConfig as PgPoolConfig } from 'pg';
import mysql, { type Pool as MysqlPool, type PoolOptions as MysqlPoolConfig } from 'mysql2/promise';
import type { CredentialKind, CredentialSummary, HistoryEntry, UpstreamSummary } from './types.js';

export interface SecurityAlertSettings {
  accessLogFormat: 'json';
  accessLogRetentionDays: number;
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

type UpstreamRow = { id: number; name: string; api_key: string; created_at: string; updated_at: string };
type CredentialRow = { id: number; name: string; kind: CredentialKind; secret: string; created_at: string; updated_at: string };

function now(): string { return new Date().toISOString(); }

function preview(value: string): string {
  return value.length <= 8 ? '********' : `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function encryptSecret(value: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

function decryptSecret(value: string, key: Buffer): string {
  const raw = Buffer.from(value, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

function hashSessionId(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function loadSqlFile(filename: string, fallback: string): string {
  try {
    const candidatePaths = [
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'sql', filename),
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/sql', filename),
      path.resolve(process.cwd(), 'src/sql', filename)
    ];
    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        return fs.readFileSync(p, 'utf8');
      }
    }
  } catch {}
  return fallback;
}

export interface IStore {
  listUpstreams(): Promise<UpstreamSummary[]>;
  addUpstream(name: string, apiKey: string): Promise<UpstreamSummary>;
  deleteUpstream(id: number): Promise<boolean>;
  getUpstream(id: number): Promise<{ id: number; name: string; apiKey: string } | undefined>;
  createCredential(name: string, kind: CredentialKind, secret: string, upstreamIds: number[]): Promise<CredentialSummary>;
  listCredentials(): Promise<CredentialSummary[]>;
  deleteCredential(id: number): Promise<boolean>;
  findCredential(kind: CredentialKind, secret: string): Promise<{ id: number; name: string; upstreams: { id: number; name: string; apiKey: string }[] } | undefined>;
  addHistory(input: Omit<HistoryEntry, 'id' | 'createdAt' | 'credentialName' | 'upstreamName'> & { credentialId?: number; upstreamId?: number }): Promise<void>;
  listHistory(limit?: number): Promise<HistoryEntry[]>;
  listHistoryPaged(page?: number, pageSize?: number): Promise<{ items: HistoryEntry[]; total: number; page: number; pageSize: number; totalPages: number }>;
  createSession(sessionId: string, expiresAt: Date): Promise<void>;
  hasSession(sessionId: string): Promise<boolean>;
  deleteSession(sessionId: string): Promise<void>;
  loginAllowed(ip: string): Promise<{ allowed: boolean; retryAfter?: number }>;
  updateBruteForceOptions(options: { loginFailLimit?: number; loginFailWindowMs?: number; loginBanDurationMs?: number }): void;
  recordLoginFailure(ip: string): Promise<{ count: number; locked: boolean; lockDurationMs: number }>;
  clearLoginFailures(ip: string): Promise<void>;
  getSetting(key: string, defaultValue?: string): Promise<string>;
  setSetting(key: string, value: string): Promise<void>;
  getLastLoginIp(): Promise<string | null>;
  setLastLoginIp(ip: string): Promise<void>;
  getSecuritySettings(): Promise<SecurityAlertSettings>;
  updateSecuritySettings(settings: Partial<SecurityAlertSettings>): Promise<void>;
  listLockedIps(): Promise<{ ip: string; failedCount: number; firstFailedAt: string; lockedUntil: string | null; reason?: string }[]>;
  banIp(ip: string, durationMs?: number): Promise<{ ip: string; lockedUntil: string | null }>;
  unbanIp(ip: string): Promise<boolean>;
  listSecurityAlerts(page?: number, pageSize?: number): Promise<{ items: HistoryEntry[]; total: number; page: number; pageSize: number; totalPages: number }>;
  resolveSecurityAlert(id: number): Promise<boolean>;
  resolveAllSecurityAlerts(): Promise<number>;
  resolveSecurityAlertsByIp(ip: string): Promise<number>;
  getSecurityRiskSummary(): Promise<{
    lockedCount: number;
    autoLockedCount: number;
    manualLockedCount: number;
    todayAlertsCount: number;
    totalAlertsCount: number;
    recentAlerts: HistoryEntry[];
  }>;
  close(): Promise<void> | void;
}

const DEFAULT_SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS upstreams (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, api_key TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL CHECK(kind IN ('gotify','webhook')),
  secret TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS credential_bindings (
  credential_id INTEGER NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
  upstream_id INTEGER NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
  PRIMARY KEY (credential_id, upstream_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT PRIMARY KEY, failed_count INTEGER NOT NULL, first_failed_at TEXT NOT NULL, locked_until TEXT
);
CREATE TABLE IF NOT EXISTS notification_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, source TEXT NOT NULL,
  credential_id INTEGER, upstream_id INTEGER, status TEXT NOT NULL,
  title TEXT, content TEXT, media_type TEXT, message_id TEXT, error TEXT,
  handled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_history_created_at ON notification_history(created_at DESC);
CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
);
`;

export class SqliteStore implements IStore {
  private readonly db: DatabaseSync;
  private readonly key: Buffer;
  private loginFailLimit: number;
  private loginFailWindowMs: number;
  private loginBanDurationMs: number;

  constructor(
    databasePath: string,
    encryptionKey: string,
    options?: {
      loginFailLimit?: number;
      loginFailWindowMs?: number;
      loginBanDurationMs?: number;
    }
  ) {
    let finalPath = databasePath;
    if (finalPath !== ':memory:') {
      const resolved = path.resolve(finalPath);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        finalPath = path.join(resolved, 'cmcc-webhook.sqlite');
      }
      const dir = path.dirname(path.resolve(finalPath));
      fs.mkdirSync(dir, { recursive: true });
    }
    try {
      this.db = new DatabaseSync(finalPath);
    } catch (err: any) {
      if (err?.code === 'ERR_SQLITE_ERROR' && err?.errcode === 14) {
        throw new Error(`Unable to open SQLite database at "${finalPath}". Please check folder write permissions: ${err.message}`);
      }
      throw err;
    }
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.key = crypto.createHash('sha256').update(encryptionKey).digest();
    this.loginFailLimit = options?.loginFailLimit ?? 5;
    this.loginFailWindowMs = options?.loginFailWindowMs ?? 15 * 60_000;
    this.loginBanDurationMs = options?.loginBanDurationMs ?? 30 * 60_000;

    const ddl = loadSqlFile('sqlite.sql', DEFAULT_SQLITE_DDL);
    this.db.exec(ddl);
    try {
      this.db.exec('ALTER TABLE notification_history ADD COLUMN handled_at TEXT');
    } catch {}
  }

  private encrypt(value: string): string { return encryptSecret(value, this.key); }
  private decrypt(value: string): string { return decryptSecret(value, this.key); }

  async listUpstreams(): Promise<UpstreamSummary[]> {
    return (this.db.prepare('SELECT * FROM upstreams ORDER BY name').all() as UpstreamRow[]).map(row => ({
      id: row.id, name: row.name, apiKeyPreview: preview(this.decrypt(row.api_key)), createdAt: row.created_at, updatedAt: row.updated_at
    }));
  }

  async addUpstream(name: string, apiKey: string): Promise<UpstreamSummary> {
    const time = now();
    const result = this.db.prepare('INSERT INTO upstreams (name, api_key, created_at, updated_at) VALUES (?, ?, ?, ?)').run(name, this.encrypt(apiKey), time, time);
    return { id: Number(result.lastInsertRowid), name, apiKeyPreview: preview(apiKey), createdAt: time, updatedAt: time };
  }

  async deleteUpstream(id: number): Promise<boolean> {
    return Number(this.db.prepare('DELETE FROM upstreams WHERE id = ?').run(id).changes) > 0;
  }

  async getUpstream(id: number): Promise<{ id: number; name: string; apiKey: string } | undefined> {
    const row = this.db.prepare('SELECT * FROM upstreams WHERE id = ?').get(id) as UpstreamRow | undefined;
    return row ? { id: row.id, name: row.name, apiKey: this.decrypt(row.api_key) } : undefined;
  }

  async createCredential(name: string, kind: CredentialKind, secret: string, upstreamIds: number[]): Promise<CredentialSummary> {
    const time = now();
    let id = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare('INSERT INTO credentials (name, kind, secret, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(name, kind, this.encrypt(secret), time, time);
      id = Number(result.lastInsertRowid);
      const bind = this.db.prepare('INSERT INTO credential_bindings (credential_id, upstream_id) VALUES (?, ?)');
      for (const upstreamId of upstreamIds) bind.run(id, upstreamId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { id, name, kind, secretPreview: preview(secret), upstreamIds, createdAt: time, updatedAt: time };
  }

  async listCredentials(): Promise<CredentialSummary[]> {
    const rows = this.db.prepare('SELECT * FROM credentials ORDER BY kind, name').all() as CredentialRow[];
    const bindings = this.db.prepare('SELECT upstream_id FROM credential_bindings WHERE credential_id = ?');
    return rows.map(row => ({
      id: row.id, name: row.name, kind: row.kind, secretPreview: preview(this.decrypt(row.secret)),
      upstreamIds: (bindings.all(row.id) as { upstream_id: number }[]).map(item => item.upstream_id),
      createdAt: row.created_at, updatedAt: row.updated_at
    }));
  }

  async deleteCredential(id: number): Promise<boolean> {
    return Number(this.db.prepare('DELETE FROM credentials WHERE id = ?').run(id).changes) > 0;
  }

  async findCredential(kind: CredentialKind, secret: string): Promise<{ id: number; name: string; upstreams: { id: number; name: string; apiKey: string }[] } | undefined> {
    const rows = this.db.prepare('SELECT * FROM credentials WHERE kind = ?').all(kind) as CredentialRow[];
    const candidate = Buffer.from(secret);
    const credential = rows.find(row => {
      const stored = Buffer.from(this.decrypt(row.secret));
      return stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate);
    });
    if (!credential) return undefined;
    const upstreams = this.db.prepare('SELECT u.* FROM upstreams u JOIN credential_bindings b ON b.upstream_id = u.id WHERE b.credential_id = ?').all(credential.id) as UpstreamRow[];
    return { id: credential.id, name: credential.name, upstreams: upstreams.map(row => ({ id: row.id, name: row.name, apiKey: this.decrypt(row.api_key) })) };
  }

  async addHistory(input: Omit<HistoryEntry, 'id' | 'createdAt' | 'credentialName' | 'upstreamName'> & { credentialId?: number; upstreamId?: number }): Promise<void> {
    this.db.prepare(`INSERT INTO notification_history (created_at, source, credential_id, upstream_id, status, title, content, media_type, message_id, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(now(), input.source, input.credentialId ?? null, input.upstreamId ?? null, input.status, input.title, input.content, input.mediaType, input.messageId, input.error);
  }

  async listHistory(limit = 100): Promise<HistoryEntry[]> {
    return this.db.prepare(`SELECT h.id, h.created_at, h.source, c.name credential_name, u.name upstream_name, h.status, h.title, h.content, h.media_type, h.message_id, h.error
      FROM notification_history h LEFT JOIN credentials c ON c.id = h.credential_id LEFT JOIN upstreams u ON u.id = h.upstream_id
      ORDER BY h.id DESC LIMIT ?`).all(limit).map((row: any) => ({
        id: row.id, createdAt: row.created_at, source: row.source, credentialName: row.credential_name, upstreamName: row.upstream_name,
        status: row.status, title: row.title, content: row.content, mediaType: row.media_type, messageId: row.message_id, error: row.error
      }));
  }

  async listHistoryPaged(page = 1, pageSize = 20): Promise<{ items: HistoryEntry[]; total: number; page: number; pageSize: number; totalPages: number }> {
    const totalRow = this.db.prepare('SELECT COUNT(*) as count FROM notification_history').get() as { count: number };
    const total = totalRow.count;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const offset = (safePage - 1) * pageSize;
    const items = this.db.prepare(`SELECT h.id, h.created_at, h.source, c.name credential_name, u.name upstream_name, h.status, h.title, h.content, h.media_type, h.message_id, h.error
      FROM notification_history h LEFT JOIN credentials c ON c.id = h.credential_id LEFT JOIN upstreams u ON u.id = h.upstream_id
      ORDER BY h.id DESC LIMIT ? OFFSET ?`).all(pageSize, offset).map((row: any) => ({
        id: row.id, createdAt: row.created_at, source: row.source, credentialName: row.credential_name, upstreamName: row.upstream_name,
        status: row.status, title: row.title, content: row.content, mediaType: row.media_type, messageId: row.message_id, error: row.error
      }));
    return { items, total, page: safePage, pageSize, totalPages };
  }

  async createSession(sessionId: string, expiresAt: Date): Promise<void> {
    this.db.prepare('INSERT INTO sessions (id_hash, expires_at, created_at) VALUES (?, ?, ?)').run(hashSessionId(sessionId), expiresAt.toISOString(), now());
  }

  async hasSession(sessionId: string): Promise<boolean> {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
    return !!this.db.prepare('SELECT 1 FROM sessions WHERE id_hash = ?').get(hashSessionId(sessionId));
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(hashSessionId(sessionId));
  }

  async loginAllowed(ip: string): Promise<{ allowed: boolean; retryAfter?: number }> {
    const row = this.db.prepare('SELECT failed_count, locked_until FROM login_attempts WHERE ip = ?').get(ip) as { failed_count: number; locked_until: string | null } | undefined;
    if (!row) return { allowed: true };
    if (row.failed_count === 0) return { allowed: false };
    if (!row.locked_until || Date.parse(row.locked_until) <= Date.now()) return { allowed: true };
    return { allowed: false, retryAfter: Math.ceil((Date.parse(row.locked_until) - Date.now()) / 1000) };
  }

  updateBruteForceOptions(options: { loginFailLimit?: number; loginFailWindowMs?: number; loginBanDurationMs?: number }): void {
    if (options.loginFailLimit !== undefined) this.loginFailLimit = options.loginFailLimit;
    if (options.loginFailWindowMs !== undefined) this.loginFailWindowMs = options.loginFailWindowMs;
    if (options.loginBanDurationMs !== undefined) this.loginBanDurationMs = options.loginBanDurationMs;
  }

  async recordLoginFailure(ip: string): Promise<{ count: number; locked: boolean; lockDurationMs: number }> {
    const row = this.db.prepare('SELECT * FROM login_attempts WHERE ip = ?').get(ip) as { failed_count: number; first_failed_at: string } | undefined;
    const first = row && Date.now() - Date.parse(row.first_failed_at) < this.loginFailWindowMs ? row.first_failed_at : now();
    const count = first === row?.first_failed_at ? row.failed_count + 1 : 1;
    const locked = count >= this.loginFailLimit;
    const lock = locked ? new Date(Date.now() + this.loginBanDurationMs).toISOString() : null;
    this.db.prepare(`INSERT INTO login_attempts (ip, failed_count, first_failed_at, locked_until) VALUES (?, ?, ?, ?)
      ON CONFLICT(ip) DO UPDATE SET failed_count = excluded.failed_count, first_failed_at = excluded.first_failed_at, locked_until = excluded.locked_until`).run(ip, count, first, lock);
    return { count, locked, lockDurationMs: this.loginBanDurationMs };
  }

  async clearLoginFailures(ip: string): Promise<void> {
    this.db.prepare('DELETE FROM login_attempts WHERE ip = ?').run(ip);
  }

  async banIp(ip: string, _durationMs?: number): Promise<{ ip: string; lockedUntil: string | null }> {
    const firstFailedAt = now();
    this.db.prepare(`
      INSERT INTO login_attempts (ip, failed_count, first_failed_at, locked_until)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(ip) DO UPDATE SET
        failed_count = excluded.failed_count,
        first_failed_at = excluded.first_failed_at,
        locked_until = excluded.locked_until
    `).run(ip, 0, firstFailedAt, null);
    return { ip, lockedUntil: null };
  }

  async unbanIp(ip: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM login_attempts WHERE ip = ?').run(ip);
    return result.changes > 0;
  }

  async listLockedIps(): Promise<{ ip: string; failedCount: number; firstFailedAt: string; lockedUntil: string | null; reason?: string }[]> {
    const rows = this.db.prepare(`
      SELECT ip, failed_count, first_failed_at, locked_until
      FROM login_attempts
      WHERE failed_count = 0 OR (locked_until IS NOT NULL AND locked_until > ?)
      ORDER BY (CASE WHEN failed_count = 0 THEN 1 ELSE 0 END) DESC, locked_until DESC, first_failed_at DESC
    `).all(now()) as any[];
    return rows.map(r => ({
      ip: r.ip,
      failedCount: r.failed_count,
      firstFailedAt: r.first_failed_at,
      lockedUntil: r.locked_until,
      reason: r.failed_count === 0 ? '手动封禁' : `连续失败 ${r.failed_count} 次`
    }));
  }

  async listSecurityAlerts(page = 1, pageSize = 50): Promise<{ items: HistoryEntry[]; total: number; page: number; pageSize: number; totalPages: number }> {
    const safePage = Math.max(1, Number(page) || 1);
    const safePageSize = Math.max(1, Math.min(Number(pageSize) || 50, 500));
    const countRow = this.db.prepare("SELECT COUNT(1) as total FROM notification_history WHERE source = 'system'").get() as { total: number };
    const total = countRow?.total ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / safePageSize));
    const offset = (safePage - 1) * safePageSize;
    const items = this.db.prepare(`SELECT h.id, h.created_at, h.source, c.name credential_name, u.name upstream_name, h.status, h.title, h.content, h.media_type, h.message_id, h.error, h.handled_at
      FROM notification_history h LEFT JOIN credentials c ON c.id = h.credential_id LEFT JOIN upstreams u ON u.id = h.upstream_id
      WHERE h.source = 'system'
      ORDER BY h.id DESC LIMIT ? OFFSET ?`).all(safePageSize, offset).map((row: any) => ({
        id: row.id, createdAt: row.created_at, source: row.source, credentialName: row.credential_name, upstreamName: row.upstream_name,
        status: row.status, title: row.title, content: row.content, mediaType: row.media_type, messageId: row.message_id, error: row.error,
        handledAt: row.handled_at
      }));
    return { items, total, page: safePage, pageSize: safePageSize, totalPages };
  }

  async resolveSecurityAlert(id: number): Promise<boolean> {
    const result = this.db.prepare("UPDATE notification_history SET handled_at = ? WHERE id = ? AND source = 'system'").run(now(), id);
    return result.changes > 0;
  }

  async resolveAllSecurityAlerts(): Promise<number> {
    const result = this.db.prepare("UPDATE notification_history SET handled_at = ? WHERE source = 'system' AND handled_at IS NULL").run(now());
    return Number(result.changes);
  }

  async resolveSecurityAlertsByIp(ip: string): Promise<number> {
    const result = this.db.prepare(
      "UPDATE notification_history SET handled_at = ? WHERE source = 'system' AND handled_at IS NULL AND (content LIKE ? OR title LIKE ?)"
    ).run(now(), `%${ip}%`, `%${ip}%`);
    return Number(result.changes);
  }

  async getSecurityRiskSummary(): Promise<{
    lockedCount: number;
    autoLockedCount: number;
    manualLockedCount: number;
    todayAlertsCount: number;
    totalAlertsCount: number;
    recentAlerts: HistoryEntry[];
  }> {
    const currentTime = now();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayIso = todayStart.toISOString();

    const autoRow = this.db.prepare('SELECT COUNT(1) as count FROM login_attempts WHERE failed_count > 0 AND locked_until IS NOT NULL AND locked_until > ?').get(currentTime) as { count: number };
    const manualRow = this.db.prepare('SELECT COUNT(1) as count FROM login_attempts WHERE failed_count = 0').get() as { count: number };
    const todayRow = this.db.prepare("SELECT COUNT(1) as count FROM notification_history WHERE source = 'system' AND handled_at IS NULL AND created_at >= ?").get(todayIso) as { count: number };
    const totalRow = this.db.prepare("SELECT COUNT(1) as count FROM notification_history WHERE source = 'system'").get() as { count: number };

    const recent = (await this.listSecurityAlerts(1, 5)).items;
    const autoLockedCount = autoRow?.count ?? 0;
    const manualLockedCount = manualRow?.count ?? 0;

    return {
      lockedCount: autoLockedCount + manualLockedCount,
      autoLockedCount,
      manualLockedCount,
      todayAlertsCount: todayRow?.count ?? 0,
      totalAlertsCount: totalRow?.count ?? 0,
      recentAlerts: recent
    };
  }

  async getSetting(key: string, defaultValue = ''): Promise<string> {
    const row = this.db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : defaultValue;
  }

  async setSetting(key: string, value: string): Promise<void> {
    const time = now();
    this.db.prepare(`
      INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, time);
  }

  async getLastLoginIp(): Promise<string | null> {
    const ip = await this.getSetting('last_login_ip');
    return ip && ip.trim() ? ip.trim() : null;
  }

  async setLastLoginIp(ip: string): Promise<void> {
    await this.setSetting('last_login_ip', ip.trim());
  }

  async getSecuritySettings(): Promise<SecurityAlertSettings> {
    return buildSecuritySettings(k => this.getSetting(k));
  }

  async updateSecuritySettings(settings: Partial<SecurityAlertSettings>): Promise<void> {
    await applySecuritySettingsUpdate(settings, (k, v) => this.setSetting(k, v));
  }

  close(): void { this.db.close(); }
}

const DEFAULT_PG_DDL = `
CREATE TABLE IF NOT EXISTS upstreams (
  id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL UNIQUE, api_key TEXT NOT NULL,
  created_at VARCHAR(64) NOT NULL, updated_at VARCHAR(64) NOT NULL
);
CREATE TABLE IF NOT EXISTS credentials (
  id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL UNIQUE, kind VARCHAR(32) NOT NULL CHECK(kind IN ('gotify','webhook')),
  secret TEXT NOT NULL UNIQUE, created_at VARCHAR(64) NOT NULL, updated_at VARCHAR(64) NOT NULL
);
CREATE TABLE IF NOT EXISTS credential_bindings (
  credential_id INT NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
  upstream_id INT NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
  PRIMARY KEY (credential_id, upstream_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash VARCHAR(128) PRIMARY KEY, expires_at VARCHAR(64) NOT NULL, created_at VARCHAR(64) NOT NULL
);
CREATE TABLE IF NOT EXISTS login_attempts (
  ip VARCHAR(64) PRIMARY KEY, failed_count INT NOT NULL, first_failed_at VARCHAR(64) NOT NULL, locked_until VARCHAR(64)
);
CREATE TABLE IF NOT EXISTS notification_history (
  id SERIAL PRIMARY KEY, created_at VARCHAR(64) NOT NULL, source VARCHAR(64) NOT NULL,
  credential_id INT, upstream_id INT, status VARCHAR(64) NOT NULL,
  title TEXT, content TEXT, media_type VARCHAR(64), message_id VARCHAR(255), error TEXT,
  handled_at VARCHAR(64)
);
CREATE INDEX IF NOT EXISTS idx_history_created_at ON notification_history(created_at DESC);
CREATE TABLE IF NOT EXISTS system_settings (
  key VARCHAR(128) PRIMARY KEY, value TEXT NOT NULL, updated_at VARCHAR(64) NOT NULL
);
`;

export class PgStore implements IStore {
  private readonly pool: PgPool;
  private readonly key: Buffer;
  private loginFailLimit: number;
  private loginFailWindowMs: number;
  private loginBanDurationMs: number;

  constructor(
    poolConfig: PgPoolConfig,
    encryptionKey: string,
    options?: {
      loginFailLimit?: number;
      loginFailWindowMs?: number;
      loginBanDurationMs?: number;
    }
  ) {
    this.pool = new PgPool(poolConfig);
    this.key = crypto.createHash('sha256').update(encryptionKey).digest();
    this.loginFailLimit = options?.loginFailLimit ?? 5;
    this.loginFailWindowMs = options?.loginFailWindowMs ?? 15 * 60_000;
    this.loginBanDurationMs = options?.loginBanDurationMs ?? 30 * 60_000;
  }

  async init(): Promise<void> {
    const ddl = loadSqlFile('pg.sql', DEFAULT_PG_DDL);
    await this.pool.query(ddl);
  }

  private encrypt(value: string): string { return encryptSecret(value, this.key); }
  private decrypt(value: string): string { return decryptSecret(value, this.key); }

  async listUpstreams(): Promise<UpstreamSummary[]> {
    const res = await this.pool.query('SELECT * FROM upstreams ORDER BY name');
    return res.rows.map((row: any) => ({
      id: row.id, name: row.name, apiKeyPreview: preview(this.decrypt(row.api_key)), createdAt: row.created_at, updatedAt: row.updated_at
    }));
  }

  async addUpstream(name: string, apiKey: string): Promise<UpstreamSummary> {
    const time = now();
    const res = await this.pool.query(
      'INSERT INTO upstreams (name, api_key, created_at, updated_at) VALUES ($1, $2, $3, $4) RETURNING id',
      [name, this.encrypt(apiKey), time, time]
    );
    const id = Number(res.rows[0].id);
    return { id, name, apiKeyPreview: preview(apiKey), createdAt: time, updatedAt: time };
  }

  async deleteUpstream(id: number): Promise<boolean> {
    const res = await this.pool.query('DELETE FROM upstreams WHERE id = $1', [id]);
    return (res.rowCount ?? 0) > 0;
  }

  async getUpstream(id: number): Promise<{ id: number; name: string; apiKey: string } | undefined> {
    const res = await this.pool.query('SELECT * FROM upstreams WHERE id = $1', [id]);
    const row = res.rows[0];
    return row ? { id: row.id, name: row.name, apiKey: this.decrypt(row.api_key) } : undefined;
  }

  async createCredential(name: string, kind: CredentialKind, secret: string, upstreamIds: number[]): Promise<CredentialSummary> {
    const time = now();
    const client = await this.pool.connect();
    let id = 0;
    try {
      await client.query('BEGIN');
      const res = await client.query(
        'INSERT INTO credentials (name, kind, secret, created_at, updated_at) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [name, kind, this.encrypt(secret), time, time]
      );
      id = Number(res.rows[0].id);
      for (const upstreamId of upstreamIds) {
        await client.query('INSERT INTO credential_bindings (credential_id, upstream_id) VALUES ($1, $2)', [id, upstreamId]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return { id, name, kind, secretPreview: preview(secret), upstreamIds, createdAt: time, updatedAt: time };
  }

  async listCredentials(): Promise<CredentialSummary[]> {
    const rowsRes = await this.pool.query('SELECT * FROM credentials ORDER BY kind, name');
    const credentials = rowsRes.rows;
    const summaries: CredentialSummary[] = [];
    for (const row of credentials) {
      const bindRes = await this.pool.query('SELECT upstream_id FROM credential_bindings WHERE credential_id = $1', [row.id]);
      summaries.push({
        id: row.id,
        name: row.name,
        kind: row.kind,
        secretPreview: preview(this.decrypt(row.secret)),
        upstreamIds: bindRes.rows.map((r: any) => r.upstream_id),
        createdAt: row.created_at,
        updatedAt: row.updated_at
      });
    }
    return summaries;
  }

  async deleteCredential(id: number): Promise<boolean> {
    const res = await this.pool.query('DELETE FROM credentials WHERE id = $1', [id]);
    return (res.rowCount ?? 0) > 0;
  }

  async findCredential(kind: CredentialKind, secret: string): Promise<{ id: number; name: string; upstreams: { id: number; name: string; apiKey: string }[] } | undefined> {
    const rowsRes = await this.pool.query('SELECT * FROM credentials WHERE kind = $1', [kind]);
    const candidate = Buffer.from(secret);
    const credential = rowsRes.rows.find((row: any) => {
      const stored = Buffer.from(this.decrypt(row.secret));
      return stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate);
    });
    if (!credential) return undefined;
    const upRes = await this.pool.query(
      'SELECT u.* FROM upstreams u JOIN credential_bindings b ON b.upstream_id = u.id WHERE b.credential_id = $1',
      [credential.id]
    );
    return {
      id: credential.id,
      name: credential.name,
      upstreams: upRes.rows.map((row: any) => ({ id: row.id, name: row.name, apiKey: this.decrypt(row.api_key) }))
    };
  }

  async addHistory(input: Omit<HistoryEntry, 'id' | 'createdAt' | 'credentialName' | 'upstreamName'> & { credentialId?: number; upstreamId?: number }): Promise<void> {
    await this.pool.query(
      `INSERT INTO notification_history (created_at, source, credential_id, upstream_id, status, title, content, media_type, message_id, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [now(), input.source, input.credentialId ?? null, input.upstreamId ?? null, input.status, input.title, input.content, input.mediaType, input.messageId, input.error]
    );
  }

  async listHistory(limit = 100): Promise<HistoryEntry[]> {
    const res = await this.pool.query(
      `SELECT h.id, h.created_at, h.source, c.name credential_name, u.name upstream_name, h.status, h.title, h.content, h.media_type, h.message_id, h.error
       FROM notification_history h LEFT JOIN credentials c ON c.id = h.credential_id LEFT JOIN upstreams u ON u.id = h.upstream_id
       ORDER BY h.id DESC LIMIT $1`,
      [limit]
    );
    return res.rows.map((row: any) => ({
      id: row.id, createdAt: row.created_at, source: row.source, credentialName: row.credential_name, upstreamName: row.upstream_name,
      status: row.status, title: row.title, content: row.content, mediaType: row.media_type, messageId: row.message_id, error: row.error
    }));
  }

  async listHistoryPaged(page = 1, pageSize = 20): Promise<{ items: HistoryEntry[]; total: number; page: number; pageSize: number; totalPages: number }> {
    const totalRes = await this.pool.query('SELECT COUNT(*) as count FROM notification_history');
    const total = Number(totalRes.rows[0]?.count ?? 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const offset = (safePage - 1) * pageSize;
    const res = await this.pool.query(
      `SELECT h.id, h.created_at, h.source, c.name credential_name, u.name upstream_name, h.status, h.title, h.content, h.media_type, h.message_id, h.error
       FROM notification_history h LEFT JOIN credentials c ON c.id = h.credential_id LEFT JOIN upstreams u ON u.id = h.upstream_id
       ORDER BY h.id DESC LIMIT $1 OFFSET $2`,
      [pageSize, offset]
    );
    const items = res.rows.map((row: any) => ({
      id: row.id, createdAt: row.created_at, source: row.source, credentialName: row.credential_name, upstreamName: row.upstream_name,
      status: row.status, title: row.title, content: row.content, mediaType: row.media_type, messageId: row.message_id, error: row.error
    }));
    return { items, total, page: safePage, pageSize, totalPages };
  }

  async createSession(sessionId: string, expiresAt: Date): Promise<void> {
    await this.pool.query(
      'INSERT INTO sessions (id_hash, expires_at, created_at) VALUES ($1, $2, $3)',
      [hashSessionId(sessionId), expiresAt.toISOString(), now()]
    );
  }

  async hasSession(sessionId: string): Promise<boolean> {
    await this.pool.query('DELETE FROM sessions WHERE expires_at <= $1', [now()]);
    const res = await this.pool.query('SELECT 1 FROM sessions WHERE id_hash = $1', [hashSessionId(sessionId)]);
    return res.rows.length > 0;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE id_hash = $1', [hashSessionId(sessionId)]);
  }

  async loginAllowed(ip: string): Promise<{ allowed: boolean; retryAfter?: number }> {
    const res = await this.pool.query('SELECT failed_count, locked_until FROM login_attempts WHERE ip = $1', [ip]);
    const row = res.rows[0];
    if (!row) return { allowed: true };
    if (row.failed_count === 0) return { allowed: false };
    if (!row.locked_until || Date.parse(row.locked_until) <= Date.now()) return { allowed: true };
    return { allowed: false, retryAfter: Math.ceil((Date.parse(row.locked_until) - Date.now()) / 1000) };
  }

  updateBruteForceOptions(options: { loginFailLimit?: number; loginFailWindowMs?: number; loginBanDurationMs?: number }): void {
    if (options.loginFailLimit !== undefined) this.loginFailLimit = options.loginFailLimit;
    if (options.loginFailWindowMs !== undefined) this.loginFailWindowMs = options.loginFailWindowMs;
    if (options.loginBanDurationMs !== undefined) this.loginBanDurationMs = options.loginBanDurationMs;
  }

  async recordLoginFailure(ip: string): Promise<{ count: number; locked: boolean; lockDurationMs: number }> {
    const res = await this.pool.query('SELECT * FROM login_attempts WHERE ip = $1', [ip]);
    const row = res.rows[0];
    const first = row && Date.now() - Date.parse(row.first_failed_at) < this.loginFailWindowMs ? row.first_failed_at : now();
    const count = first === row?.first_failed_at ? row.failed_count + 1 : 1;
    const locked = count >= this.loginFailLimit;
    const lock = locked ? new Date(Date.now() + this.loginBanDurationMs).toISOString() : null;
    await this.pool.query(
      `INSERT INTO login_attempts (ip, failed_count, first_failed_at, locked_until) VALUES ($1, $2, $3, $4)
       ON CONFLICT (ip) DO UPDATE SET failed_count = EXCLUDED.failed_count, first_failed_at = EXCLUDED.first_failed_at, locked_until = EXCLUDED.locked_until`,
      [ip, count, first, lock]
    );
    return { count, locked, lockDurationMs: this.loginBanDurationMs };
  }

  async clearLoginFailures(ip: string): Promise<void> {
    await this.pool.query('DELETE FROM login_attempts WHERE ip = $1', [ip]);
  }

  async banIp(ip: string, _durationMs?: number): Promise<{ ip: string; lockedUntil: string | null }> {
    const firstFailedAt = now();
    await this.pool.query(
      `INSERT INTO login_attempts (ip, failed_count, first_failed_at, locked_until)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (ip) DO UPDATE SET
         failed_count = EXCLUDED.failed_count,
         first_failed_at = EXCLUDED.first_failed_at,
         locked_until = EXCLUDED.locked_until`,
      [ip, 0, firstFailedAt, null]
    );
    return { ip, lockedUntil: null };
  }

  async unbanIp(ip: string): Promise<boolean> {
    const res = await this.pool.query('DELETE FROM login_attempts WHERE ip = $1', [ip]);
    return (res.rowCount ?? 0) > 0;
  }

  async listLockedIps(): Promise<{ ip: string; failedCount: number; firstFailedAt: string; lockedUntil: string | null; reason?: string }[]> {
    const res = await this.pool.query(
      `SELECT ip, failed_count, first_failed_at, locked_until
       FROM login_attempts
       WHERE failed_count = 0 OR (locked_until IS NOT NULL AND locked_until > $1)
       ORDER BY (CASE WHEN failed_count = 0 THEN 1 ELSE 0 END) DESC, locked_until DESC, first_failed_at DESC`,
      [now()]
    );
    return res.rows.map((r: any) => ({
      ip: r.ip,
      failedCount: r.failed_count,
      firstFailedAt: r.first_failed_at,
      lockedUntil: r.locked_until,
      reason: r.failed_count === 0 ? '手动封禁' : `连续失败 ${r.failed_count} 次`
    }));
  }

  async listSecurityAlerts(page = 1, pageSize = 50): Promise<{ items: HistoryEntry[]; total: number; page: number; pageSize: number; totalPages: number }> {
    const safePage = Math.max(1, Number(page) || 1);
    const safePageSize = Math.max(1, Math.min(Number(pageSize) || 50, 500));
    const countRes = await this.pool.query("SELECT COUNT(1) as total FROM notification_history WHERE source = 'system'");
    const total = Number(countRes.rows[0]?.total ?? 0);
    const totalPages = Math.max(1, Math.ceil(total / safePageSize));
    const offset = (safePage - 1) * safePageSize;
    const res = await this.pool.query(
      `SELECT h.id, h.created_at, h.source, c.name credential_name, u.name upstream_name, h.status, h.title, h.content, h.media_type, h.message_id, h.error, h.handled_at
       FROM notification_history h LEFT JOIN credentials c ON c.id = h.credential_id LEFT JOIN upstreams u ON u.id = h.upstream_id
       WHERE h.source = 'system'
       ORDER BY h.id DESC LIMIT $1 OFFSET $2`,
      [safePageSize, offset]
    );
    const items = res.rows.map((row: any) => ({
      id: row.id, createdAt: row.created_at, source: row.source, credentialName: row.credential_name, upstreamName: row.upstream_name,
      status: row.status, title: row.title, content: row.content, mediaType: row.media_type, messageId: row.message_id, error: row.error,
      handledAt: row.handled_at
    }));
    return { items, total, page: safePage, pageSize: safePageSize, totalPages };
  }

  async resolveSecurityAlert(id: number): Promise<boolean> {
    const res = await this.pool.query("UPDATE notification_history SET handled_at = $1 WHERE id = $2 AND source = 'system'", [now(), id]);
    return (res.rowCount ?? 0) > 0;
  }

  async resolveAllSecurityAlerts(): Promise<number> {
    const res = await this.pool.query("UPDATE notification_history SET handled_at = $1 WHERE source = 'system' AND handled_at IS NULL", [now()]);
    return Number(res.rowCount ?? 0);
  }

  async resolveSecurityAlertsByIp(ip: string): Promise<number> {
    const res = await this.pool.query(
      "UPDATE notification_history SET handled_at = $1 WHERE source = 'system' AND handled_at IS NULL AND (content LIKE $2 OR title LIKE $2)",
      [now(), `%${ip}%`]
    );
    return Number(res.rowCount ?? 0);
  }

  async getSecurityRiskSummary(): Promise<{
    lockedCount: number;
    autoLockedCount: number;
    manualLockedCount: number;
    todayAlertsCount: number;
    totalAlertsCount: number;
    recentAlerts: HistoryEntry[];
  }> {
    const currentTime = now();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayIso = todayStart.toISOString();

    const autoRes = await this.pool.query('SELECT COUNT(1) as count FROM login_attempts WHERE failed_count > 0 AND locked_until IS NOT NULL AND locked_until > $1', [currentTime]);
    const manualRes = await this.pool.query('SELECT COUNT(1) as count FROM login_attempts WHERE failed_count = 0');
    const todayRes = await this.pool.query("SELECT COUNT(1) as count FROM notification_history WHERE source = 'system' AND handled_at IS NULL AND created_at >= $1", [todayIso]);
    const totalRes = await this.pool.query("SELECT COUNT(1) as count FROM notification_history WHERE source = 'system'");

    const recent = (await this.listSecurityAlerts(1, 5)).items;
    const autoLockedCount = Number(autoRes.rows[0]?.count ?? 0);
    const manualLockedCount = Number(manualRes.rows[0]?.count ?? 0);

    return {
      lockedCount: autoLockedCount + manualLockedCount,
      autoLockedCount,
      manualLockedCount,
      todayAlertsCount: Number(todayRes.rows[0]?.count ?? 0),
      totalAlertsCount: Number(totalRes.rows[0]?.count ?? 0),
      recentAlerts: recent
    };
  }

  async getSetting(key: string, defaultValue = ''): Promise<string> {
    const res = await this.pool.query('SELECT value FROM system_settings WHERE key = $1', [key]);
    return res.rows[0] ? res.rows[0].value : defaultValue;
  }

  async setSetting(key: string, value: string): Promise<void> {
    const time = now();
    await this.pool.query(
      `INSERT INTO system_settings (key, value, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [key, value, time]
    );
  }

  async getLastLoginIp(): Promise<string | null> {
    const ip = await this.getSetting('last_login_ip');
    return ip && ip.trim() ? ip.trim() : null;
  }

  async setLastLoginIp(ip: string): Promise<void> {
    await this.setSetting('last_login_ip', ip.trim());
  }

  async getSecuritySettings(): Promise<SecurityAlertSettings> {
    return buildSecuritySettings(k => this.getSetting(k));
  }

  async updateSecuritySettings(settings: Partial<SecurityAlertSettings>): Promise<void> {
    await applySecuritySettingsUpdate(settings, (k, v) => this.setSetting(k, v));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

const DEFAULT_MYSQL_DDL = `
CREATE TABLE IF NOT EXISTS upstreams (
  id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255) NOT NULL UNIQUE, api_key TEXT NOT NULL,
  created_at VARCHAR(64) NOT NULL, updated_at VARCHAR(64) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS credentials (
  id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255) NOT NULL UNIQUE, kind VARCHAR(32) NOT NULL CHECK(kind IN ('gotify','webhook')),
  secret VARCHAR(512) NOT NULL UNIQUE, created_at VARCHAR(64) NOT NULL, updated_at VARCHAR(64) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS credential_bindings (
  credential_id INT NOT NULL, upstream_id INT NOT NULL,
  PRIMARY KEY (credential_id, upstream_id),
  CONSTRAINT fk_cb_credential FOREIGN KEY (credential_id) REFERENCES credentials(id) ON DELETE CASCADE,
  CONSTRAINT fk_cb_upstream FOREIGN KEY (upstream_id) REFERENCES upstreams(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS sessions (
  id_hash VARCHAR(128) PRIMARY KEY, expires_at VARCHAR(64) NOT NULL, created_at VARCHAR(64) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS login_attempts (
  ip VARCHAR(64) PRIMARY KEY, failed_count INT NOT NULL, first_failed_at VARCHAR(64) NOT NULL, locked_until VARCHAR(64)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS notification_history (
  id INT AUTO_INCREMENT PRIMARY KEY, created_at VARCHAR(64) NOT NULL, source VARCHAR(64) NOT NULL,
  credential_id INT, upstream_id INT, status VARCHAR(64) NOT NULL,
  title TEXT, content TEXT, media_type VARCHAR(64), message_id VARCHAR(255), error TEXT,
  handled_at VARCHAR(64),
  INDEX idx_history_created_at (created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS system_settings (
  \`key\` VARCHAR(128) PRIMARY KEY, value TEXT NOT NULL, updated_at VARCHAR(64) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

export class MysqlStore implements IStore {
  private readonly pool: MysqlPool;
  private readonly key: Buffer;
  private loginFailLimit: number;
  private loginFailWindowMs: number;
  private loginBanDurationMs: number;

  constructor(
    poolConfig: MysqlPoolConfig,
    encryptionKey: string,
    options?: {
      loginFailLimit?: number;
      loginFailWindowMs?: number;
      loginBanDurationMs?: number;
    }
  ) {
    this.pool = mysql.createPool({ ...poolConfig, multipleStatements: true });
    this.key = crypto.createHash('sha256').update(encryptionKey).digest();
    this.loginFailLimit = options?.loginFailLimit ?? 5;
    this.loginFailWindowMs = options?.loginFailWindowMs ?? 15 * 60_000;
    this.loginBanDurationMs = options?.loginBanDurationMs ?? 30 * 60_000;
  }

  async init(): Promise<void> {
    const ddl = loadSqlFile('mysql.sql', DEFAULT_MYSQL_DDL);
    await this.pool.query(ddl);
  }

  private encrypt(value: string): string { return encryptSecret(value, this.key); }
  private decrypt(value: string): string { return decryptSecret(value, this.key); }

  async listUpstreams(): Promise<UpstreamSummary[]> {
    const [rows]: any = await this.pool.query('SELECT * FROM upstreams ORDER BY name');
    return (rows as any[]).map(row => ({
      id: row.id, name: row.name, apiKeyPreview: preview(this.decrypt(row.api_key)), createdAt: row.created_at, updatedAt: row.updated_at
    }));
  }

  async addUpstream(name: string, apiKey: string): Promise<UpstreamSummary> {
    const time = now();
    const [res]: any = await this.pool.query(
      'INSERT INTO upstreams (name, api_key, created_at, updated_at) VALUES (?, ?, ?, ?)',
      [name, this.encrypt(apiKey), time, time]
    );
    const id = Number(res.insertId);
    return { id, name, apiKeyPreview: preview(apiKey), createdAt: time, updatedAt: time };
  }

  async deleteUpstream(id: number): Promise<boolean> {
    const [res]: any = await this.pool.query('DELETE FROM upstreams WHERE id = ?', [id]);
    return Number(res.affectedRows ?? 0) > 0;
  }

  async getUpstream(id: number): Promise<{ id: number; name: string; apiKey: string } | undefined> {
    const [rows]: any = await this.pool.query('SELECT * FROM upstreams WHERE id = ?', [id]);
    const row = rows[0];
    return row ? { id: row.id, name: row.name, apiKey: this.decrypt(row.api_key) } : undefined;
  }

  async createCredential(name: string, kind: CredentialKind, secret: string, upstreamIds: number[]): Promise<CredentialSummary> {
    const time = now();
    const conn = await this.pool.getConnection();
    let id = 0;
    try {
      await conn.beginTransaction();
      const [res]: any = await conn.query(
        'INSERT INTO credentials (name, kind, secret, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        [name, kind, this.encrypt(secret), time, time]
      );
      id = Number(res.insertId);
      for (const upstreamId of upstreamIds) {
        await conn.query('INSERT INTO credential_bindings (credential_id, upstream_id) VALUES (?, ?)', [id, upstreamId]);
      }
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
    return { id, name, kind, secretPreview: preview(secret), upstreamIds, createdAt: time, updatedAt: time };
  }

  async listCredentials(): Promise<CredentialSummary[]> {
    const [rows]: any = await this.pool.query('SELECT * FROM credentials ORDER BY kind, name');
    const summaries: CredentialSummary[] = [];
    for (const row of rows) {
      const [bindRows]: any = await this.pool.query('SELECT upstream_id FROM credential_bindings WHERE credential_id = ?', [row.id]);
      summaries.push({
        id: row.id,
        name: row.name,
        kind: row.kind,
        secretPreview: preview(this.decrypt(row.secret)),
        upstreamIds: (bindRows as any[]).map(r => r.upstream_id),
        createdAt: row.created_at,
        updatedAt: row.updated_at
      });
    }
    return summaries;
  }

  async deleteCredential(id: number): Promise<boolean> {
    const [res]: any = await this.pool.query('DELETE FROM credentials WHERE id = ?', [id]);
    return Number(res.affectedRows ?? 0) > 0;
  }

  async findCredential(kind: CredentialKind, secret: string): Promise<{ id: number; name: string; upstreams: { id: number; name: string; apiKey: string }[] } | undefined> {
    const [rows]: any = await this.pool.query('SELECT * FROM credentials WHERE kind = ?', [kind]);
    const candidate = Buffer.from(secret);
    const credential = (rows as any[]).find(row => {
      const stored = Buffer.from(this.decrypt(row.secret));
      return stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate);
    });
    if (!credential) return undefined;
    const [upRows]: any = await this.pool.query(
      'SELECT u.* FROM upstreams u JOIN credential_bindings b ON b.upstream_id = u.id WHERE b.credential_id = ?',
      [credential.id]
    );
    return {
      id: credential.id,
      name: credential.name,
      upstreams: (upRows as any[]).map(row => ({ id: row.id, name: row.name, apiKey: this.decrypt(row.api_key) }))
    };
  }

  async addHistory(input: Omit<HistoryEntry, 'id' | 'createdAt' | 'credentialName' | 'upstreamName'> & { credentialId?: number; upstreamId?: number }): Promise<void> {
    await this.pool.query(
      `INSERT INTO notification_history (created_at, source, credential_id, upstream_id, status, title, content, media_type, message_id, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [now(), input.source, input.credentialId ?? null, input.upstreamId ?? null, input.status, input.title, input.content, input.mediaType, input.messageId, input.error]
    );
  }

  async listHistory(limit = 100): Promise<HistoryEntry[]> {
    const [rows]: any = await this.pool.query(
      `SELECT h.id, h.created_at, h.source, c.name credential_name, u.name upstream_name, h.status, h.title, h.content, h.media_type, h.message_id, h.error
       FROM notification_history h LEFT JOIN credentials c ON c.id = h.credential_id LEFT JOIN upstreams u ON u.id = h.upstream_id
       ORDER BY h.id DESC LIMIT ?`,
      [Number(limit)]
    );
    return (rows as any[]).map(row => ({
      id: row.id, createdAt: row.created_at, source: row.source, credentialName: row.credential_name, upstreamName: row.upstream_name,
      status: row.status, title: row.title, content: row.content, mediaType: row.media_type, messageId: row.message_id, error: row.error
    }));
  }

  async listHistoryPaged(page = 1, pageSize = 20): Promise<{ items: HistoryEntry[]; total: number; page: number; pageSize: number; totalPages: number }> {
    const [totalRows]: any = await this.pool.query('SELECT COUNT(*) as count FROM notification_history');
    const total = Number(totalRows[0]?.count ?? 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const offset = (safePage - 1) * pageSize;
    const [rows]: any = await this.pool.query(
      `SELECT h.id, h.created_at, h.source, c.name credential_name, u.name upstream_name, h.status, h.title, h.content, h.media_type, h.message_id, h.error
       FROM notification_history h LEFT JOIN credentials c ON c.id = h.credential_id LEFT JOIN upstreams u ON u.id = h.upstream_id
       ORDER BY h.id DESC LIMIT ? OFFSET ?`,
      [Number(pageSize), Number(offset)]
    );
    const items = (rows as any[]).map(row => ({
      id: row.id, createdAt: row.created_at, source: row.source, credentialName: row.credential_name, upstreamName: row.upstream_name,
      status: row.status, title: row.title, content: row.content, mediaType: row.media_type, messageId: row.message_id, error: row.error
    }));
    return { items, total, page: safePage, pageSize, totalPages };
  }

  async createSession(sessionId: string, expiresAt: Date): Promise<void> {
    await this.pool.query(
      'INSERT INTO sessions (id_hash, expires_at, created_at) VALUES (?, ?, ?)',
      [hashSessionId(sessionId), expiresAt.toISOString(), now()]
    );
  }

  async hasSession(sessionId: string): Promise<boolean> {
    await this.pool.query('DELETE FROM sessions WHERE expires_at <= ?', [now()]);
    const [rows]: any = await this.pool.query('SELECT 1 FROM sessions WHERE id_hash = ?', [hashSessionId(sessionId)]);
    return rows.length > 0;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE id_hash = ?', [hashSessionId(sessionId)]);
  }

  async loginAllowed(ip: string): Promise<{ allowed: boolean; retryAfter?: number }> {
    const [rows]: any = await this.pool.query('SELECT failed_count, locked_until FROM login_attempts WHERE ip = ?', [ip]);
    const row = rows[0];
    if (!row) return { allowed: true };
    if (Number(row.failed_count) === 0) return { allowed: false };
    if (!row.locked_until || Date.parse(row.locked_until) <= Date.now()) return { allowed: true };
    return { allowed: false, retryAfter: Math.ceil((Date.parse(row.locked_until) - Date.now()) / 1000) };
  }

  updateBruteForceOptions(options: { loginFailLimit?: number; loginFailWindowMs?: number; loginBanDurationMs?: number }): void {
    if (options.loginFailLimit !== undefined) this.loginFailLimit = options.loginFailLimit;
    if (options.loginFailWindowMs !== undefined) this.loginFailWindowMs = options.loginFailWindowMs;
    if (options.loginBanDurationMs !== undefined) this.loginBanDurationMs = options.loginBanDurationMs;
  }

  async recordLoginFailure(ip: string): Promise<{ count: number; locked: boolean; lockDurationMs: number }> {
    const [rows]: any = await this.pool.query('SELECT * FROM login_attempts WHERE ip = ?', [ip]);
    const row = rows[0];
    const first = row && Date.now() - Date.parse(row.first_failed_at) < this.loginFailWindowMs ? row.first_failed_at : now();
    const count = first === row?.first_failed_at ? row.failed_count + 1 : 1;
    const locked = count >= this.loginFailLimit;
    const lock = locked ? new Date(Date.now() + this.loginBanDurationMs).toISOString() : null;
    await this.pool.query(
      `INSERT INTO login_attempts (ip, failed_count, first_failed_at, locked_until) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE failed_count = VALUES(failed_count), first_failed_at = VALUES(first_failed_at), locked_until = VALUES(locked_until)`,
      [ip, count, first, lock]
    );
    return { count, locked, lockDurationMs: this.loginBanDurationMs };
  }

  async clearLoginFailures(ip: string): Promise<void> {
    await this.pool.query('DELETE FROM login_attempts WHERE ip = ?', [ip]);
  }

  async banIp(ip: string, _durationMs?: number): Promise<{ ip: string; lockedUntil: string | null }> {
    const firstFailedAt = now();
    await this.pool.query(
      `INSERT INTO login_attempts (ip, failed_count, first_failed_at, locked_until) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE failed_count = VALUES(failed_count), first_failed_at = VALUES(first_failed_at), locked_until = VALUES(locked_until)`,
      [ip, 0, firstFailedAt, null]
    );
    return { ip, lockedUntil: null };
  }

  async unbanIp(ip: string): Promise<boolean> {
    const [res]: any = await this.pool.query('DELETE FROM login_attempts WHERE ip = ?', [ip]);
    return Number(res.affectedRows ?? 0) > 0;
  }

  async listLockedIps(): Promise<{ ip: string; failedCount: number; firstFailedAt: string; lockedUntil: string | null; reason?: string }[]> {
    const [rows]: any = await this.pool.query(
      `SELECT ip, failed_count, first_failed_at, locked_until
       FROM login_attempts
       WHERE failed_count = 0 OR (locked_until IS NOT NULL AND locked_until > ?)
       ORDER BY (CASE WHEN failed_count = 0 THEN 1 ELSE 0 END) DESC, locked_until DESC, first_failed_at DESC`,
      [now()]
    );
    return (rows as any[]).map(r => ({
      ip: r.ip,
      failedCount: r.failed_count,
      firstFailedAt: r.first_failed_at,
      lockedUntil: r.locked_until,
      reason: r.failed_count === 0 ? '手动封禁' : `连续失败 ${r.failed_count} 次`
    }));
  }

  async listSecurityAlerts(page = 1, pageSize = 50): Promise<{ items: HistoryEntry[]; total: number; page: number; pageSize: number; totalPages: number }> {
    const safePage = Math.max(1, Number(page) || 1);
    const safePageSize = Math.max(1, Math.min(Number(pageSize) || 50, 500));
    const [countRows]: any = await this.pool.query("SELECT COUNT(1) as total FROM notification_history WHERE source = 'system'");
    const total = Number(countRows[0]?.total ?? 0);
    const totalPages = Math.max(1, Math.ceil(total / safePageSize));
    const offset = (safePage - 1) * safePageSize;
    const [rows]: any = await this.pool.query(
      `SELECT h.id, h.created_at, h.source, c.name credential_name, u.name upstream_name, h.status, h.title, h.content, h.media_type, h.message_id, h.error, h.handled_at
       FROM notification_history h LEFT JOIN credentials c ON c.id = h.credential_id LEFT JOIN upstreams u ON u.id = h.upstream_id
       WHERE h.source = 'system'
       ORDER BY h.id DESC LIMIT ? OFFSET ?`,
      [safePageSize, offset]
    );
    const items = (rows as any[]).map(row => ({
      id: row.id, createdAt: row.created_at, source: row.source, credentialName: row.credential_name, upstreamName: row.upstream_name,
      status: row.status, title: row.title, content: row.content, mediaType: row.media_type, messageId: row.message_id, error: row.error,
      handledAt: row.handled_at
    }));
    return { items, total, page: safePage, pageSize: safePageSize, totalPages };
  }

  async resolveSecurityAlert(id: number): Promise<boolean> {
    const [res]: any = await this.pool.query("UPDATE notification_history SET handled_at = ? WHERE id = ? AND source = 'system'", [now(), id]);
    return Number(res.affectedRows ?? 0) > 0;
  }

  async resolveAllSecurityAlerts(): Promise<number> {
    const [res]: any = await this.pool.query("UPDATE notification_history SET handled_at = ? WHERE source = 'system' AND handled_at IS NULL", [now()]);
    return Number(res.affectedRows ?? 0);
  }

  async resolveSecurityAlertsByIp(ip: string): Promise<number> {
    const [res]: any = await this.pool.query(
      "UPDATE notification_history SET handled_at = ? WHERE source = 'system' AND handled_at IS NULL AND (content LIKE ? OR title LIKE ?)",
      [now(), `%${ip}%`, `%${ip}%`]
    );
    return Number(res.affectedRows ?? 0);
  }

  async getSecurityRiskSummary(): Promise<{
    lockedCount: number;
    autoLockedCount: number;
    manualLockedCount: number;
    todayAlertsCount: number;
    totalAlertsCount: number;
    recentAlerts: HistoryEntry[];
  }> {
    const currentTime = now();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayIso = todayStart.toISOString();

    const [autoRows]: any = await this.pool.query('SELECT COUNT(1) as count FROM login_attempts WHERE failed_count > 0 AND locked_until IS NOT NULL AND locked_until > ?', [currentTime]);
    const [manualRows]: any = await this.pool.query('SELECT COUNT(1) as count FROM login_attempts WHERE failed_count = 0');
    const [todayRows]: any = await this.pool.query("SELECT COUNT(1) as count FROM notification_history WHERE source = 'system' AND handled_at IS NULL AND created_at >= ?", [todayIso]);
    const [totalRows]: any = await this.pool.query("SELECT COUNT(1) as count FROM notification_history WHERE source = 'system'");

    const recent = (await this.listSecurityAlerts(1, 5)).items;
    const autoLockedCount = Number(autoRows[0]?.count ?? 0);
    const manualLockedCount = Number(manualRows[0]?.count ?? 0);

    return {
      lockedCount: autoLockedCount + manualLockedCount,
      autoLockedCount,
      manualLockedCount,
      todayAlertsCount: Number(todayRows[0]?.count ?? 0),
      totalAlertsCount: Number(totalRows[0]?.count ?? 0),
      recentAlerts: recent
    };
  }

  async getSetting(key: string, defaultValue = ''): Promise<string> {
    const [rows]: any = await this.pool.query('SELECT value FROM system_settings WHERE `key` = ?', [key]);
    return rows[0] ? rows[0].value : defaultValue;
  }

  async setSetting(key: string, value: string): Promise<void> {
    const time = now();
    await this.pool.query(
      `INSERT INTO system_settings (\`key\`, value, updated_at) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)`,
      [key, value, time]
    );
  }

  async getLastLoginIp(): Promise<string | null> {
    const ip = await this.getSetting('last_login_ip');
    return ip && ip.trim() ? ip.trim() : null;
  }

  async setLastLoginIp(ip: string): Promise<void> {
    await this.setSetting('last_login_ip', ip.trim());
  }

  async getSecuritySettings(): Promise<SecurityAlertSettings> {
    return buildSecuritySettings(k => this.getSetting(k));
  }

  async updateSecuritySettings(settings: Partial<SecurityAlertSettings>): Promise<void> {
    await applySecuritySettingsUpdate(settings, (k, v) => this.setSetting(k, v));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

async function buildSecuritySettings(getter: (key: string) => Promise<string>): Promise<SecurityAlertSettings> {
  const parseNum = async (key: string, def: number) => {
    const v = await getter(key);
    if (!v && v !== '0') return def;
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  };
  return {
    accessLogFormat: 'json',
    accessLogRetentionDays: Math.max(1, await parseNum('accessLogRetentionDays', 30)),
    notifyOnLogin: (await getter('notifyOnLogin')) === 'true',
    notifyOnLoginFailed: (await getter('notifyOnLoginFailed')) === 'true',
    notifyOnAuthFailed: (await getter('notifyOnAuthFailed')) === 'true',
    notifyUpstreamId: await parseNum('notifyUpstreamId', 0),
    notifyLoginFailThreshold: Math.max(1, await parseNum('notifyLoginFailThreshold', 3)),
    notifyAuthFailThreshold: Math.max(1, await parseNum('notifyAuthFailThreshold', 3)),
    notifyAuthFailWindowMin: Math.max(1, await parseNum('notifyAuthFailWindowMin', 1)),
    rateLimitMsgMinMax: Math.max(1, await parseNum('rateLimitMsgMinMax', 10)),
    rateLimitMsgMinIntervalSec: Math.max(0, await parseNum('rateLimitMsgMinIntervalSec', await parseNum('rateLimitPhoneMinIntervalSec', 0))),
    rateLimitMsgHourMax: Math.max(0, await parseNum('rateLimitMsgHourMax', await parseNum('rateLimitPhoneHourMax', 0))),
    rateLimitMsgDayMax: Math.max(0, await parseNum('rateLimitMsgDayMax', await parseNum('rateLimitPhoneDayMax', 0))),
    rateLimitIpMinMax: Math.max(0, await parseNum('rateLimitIpMinMax', 30)),
    rateLimitDuplicateWindowSec: Math.max(0, await parseNum('rateLimitDuplicateWindowSec', 300)),
    notifyOnRateLimit: (await getter('notifyOnRateLimit')) !== 'false'
  };
}

async function applySecuritySettingsUpdate(
  settings: Partial<SecurityAlertSettings>,
  setter: (key: string, value: string) => Promise<void>
): Promise<void> {
  if (settings.accessLogFormat !== undefined) await setter('accessLogFormat', 'json');
  if (settings.accessLogRetentionDays !== undefined) await setter('accessLogRetentionDays', String(settings.accessLogRetentionDays));
  if (settings.notifyOnLogin !== undefined) await setter('notifyOnLogin', String(settings.notifyOnLogin));
  if (settings.notifyOnLoginFailed !== undefined) await setter('notifyOnLoginFailed', String(settings.notifyOnLoginFailed));
  if (settings.notifyOnAuthFailed !== undefined) await setter('notifyOnAuthFailed', String(settings.notifyOnAuthFailed));
  if (settings.notifyUpstreamId !== undefined) await setter('notifyUpstreamId', String(settings.notifyUpstreamId));
  if (settings.notifyLoginFailThreshold !== undefined) await setter('notifyLoginFailThreshold', String(settings.notifyLoginFailThreshold));
  if (settings.notifyAuthFailThreshold !== undefined) await setter('notifyAuthFailThreshold', String(settings.notifyAuthFailThreshold));
  if (settings.notifyAuthFailWindowMin !== undefined) await setter('notifyAuthFailWindowMin', String(settings.notifyAuthFailWindowMin));
  if (settings.rateLimitMsgMinMax !== undefined) await setter('rateLimitMsgMinMax', String(settings.rateLimitMsgMinMax));
  if (settings.rateLimitMsgMinIntervalSec !== undefined) await setter('rateLimitMsgMinIntervalSec', String(settings.rateLimitMsgMinIntervalSec));
  if (settings.rateLimitMsgHourMax !== undefined) await setter('rateLimitMsgHourMax', String(settings.rateLimitMsgHourMax));
  if (settings.rateLimitMsgDayMax !== undefined) await setter('rateLimitMsgDayMax', String(settings.rateLimitMsgDayMax));
  if (settings.rateLimitIpMinMax !== undefined) await setter('rateLimitIpMinMax', String(settings.rateLimitIpMinMax));
  if (settings.rateLimitDuplicateWindowSec !== undefined) await setter('rateLimitDuplicateWindowSec', String(settings.rateLimitDuplicateWindowSec));
  if (settings.notifyOnRateLimit !== undefined) await setter('notifyOnRateLimit', String(settings.notifyOnRateLimit));
}

export { SqliteStore as Store };

export interface StoreFactoryOptions {
  type?: 'sqlite' | 'postgres' | 'mysql';
  databasePath?: string;
  url?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  ssl?: boolean;
  encryptionKey: string;
  loginFailLimit?: number;
  loginFailWindowMs?: number;
  loginBanDurationMs?: number;
}

export function createStore(
  databasePath: string,
  encryptionKey: string,
  options?: {
    loginFailLimit?: number;
    loginFailWindowMs?: number;
    loginBanDurationMs?: number;
  }
): IStore;
export function createStore(options: StoreFactoryOptions): Promise<IStore>;
export function createStore(
  arg1: string | StoreFactoryOptions,
  arg2?: string,
  arg3?: {
    loginFailLimit?: number;
    loginFailWindowMs?: number;
    loginBanDurationMs?: number;
  }
): IStore | Promise<IStore> {
  if (typeof arg1 === 'string') {
    return new SqliteStore(arg1, arg2!, arg3);
  }

  const opts = arg1;
  const dbType = opts.type ?? 'sqlite';

  if (dbType === 'postgres') {
    const pgConfig: PgPoolConfig = opts.url
      ? { connectionString: opts.url, ssl: opts.ssl ? { rejectUnauthorized: false } : undefined }
      : {
          host: opts.host ?? 'localhost',
          port: opts.port ?? 5432,
          user: opts.user ?? 'postgres',
          password: opts.password,
          database: opts.database ?? 'cmcc_db',
          ssl: opts.ssl ? { rejectUnauthorized: false } : undefined
        };
    const store = new PgStore(pgConfig, opts.encryptionKey, {
      loginFailLimit: opts.loginFailLimit,
      loginFailWindowMs: opts.loginFailWindowMs,
      loginBanDurationMs: opts.loginBanDurationMs
    });
    return store.init().then(() => store);
  }

  if (dbType === 'mysql') {
    const mysqlConfig: MysqlPoolConfig = opts.url
      ? { uri: opts.url, ssl: opts.ssl ? { rejectUnauthorized: false } : undefined }
      : {
          host: opts.host ?? 'localhost',
          port: opts.port ?? 3306,
          user: opts.user ?? 'root',
          password: opts.password,
          database: opts.database ?? 'cmcc_db',
          ssl: opts.ssl ? { rejectUnauthorized: false } : undefined
        };
    const store = new MysqlStore(mysqlConfig, opts.encryptionKey, {
      loginFailLimit: opts.loginFailLimit,
      loginFailWindowMs: opts.loginFailWindowMs,
      loginBanDurationMs: opts.loginBanDurationMs
    });
    return store.init().then(() => store);
  }

  return Promise.resolve(
    new SqliteStore(opts.databasePath ?? './data/cmcc-webhook.sqlite', opts.encryptionKey, {
      loginFailLimit: opts.loginFailLimit,
      loginFailWindowMs: opts.loginFailWindowMs,
      loginBanDurationMs: opts.loginBanDurationMs
    })
  );
}
