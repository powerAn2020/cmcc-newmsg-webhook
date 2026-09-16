import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CredentialKind, CredentialSummary, HistoryEntry, UpstreamSummary } from './types.js';

type UpstreamRow = { id: number; name: string; api_key: string; created_at: string; updated_at: string };
type CredentialRow = { id: number; name: string; kind: CredentialKind; secret: string; created_at: string; updated_at: string };

function now(): string { return new Date().toISOString(); }

export interface IStore {
  listUpstreams(): UpstreamSummary[];
  addUpstream(name: string, apiKey: string): UpstreamSummary;
  deleteUpstream(id: number): boolean;
  getUpstream(id: number): { id: number; name: string; apiKey: string } | undefined;
  createCredential(name: string, kind: CredentialKind, secret: string, upstreamIds: number[]): CredentialSummary;
  listCredentials(): CredentialSummary[];
  deleteCredential(id: number): boolean;
  findCredential(kind: CredentialKind, secret: string): { id: number; name: string; upstreams: { id: number; name: string; apiKey: string }[] } | undefined;
  addHistory(input: Omit<HistoryEntry, 'id' | 'createdAt' | 'credentialName' | 'upstreamName'> & { credentialId?: number; upstreamId?: number }): void;
  listHistory(limit?: number): HistoryEntry[];
  listHistoryPaged(page?: number, pageSize?: number): { items: HistoryEntry[]; total: number; page: number; pageSize: number; totalPages: number };
  createSession(sessionId: string, expiresAt: Date): void;
  hasSession(sessionId: string): boolean;
  deleteSession(sessionId: string): void;
  loginAllowed(ip: string): { allowed: boolean; retryAfter?: number };
  updateBruteForceOptions(options: { loginFailLimit?: number; loginFailWindowMs?: number; loginBanDurationMs?: number }): void;
  recordLoginFailure(ip: string): { count: number; locked: boolean; lockDurationMs: number };
  clearLoginFailures(ip: string): void;
  getSetting(key: string, defaultValue?: string): string;
  setSetting(key: string, value: string): void;
  getSecuritySettings(): SecurityAlertSettings;
  updateSecuritySettings(settings: Partial<SecurityAlertSettings>): void;
  listLockedIps(): { ip: string; failedCount: number; firstFailedAt: string; lockedUntil: string }[];
  unbanIp(ip: string): boolean;
  listSecurityAlerts(page?: number, pageSize?: number): { items: HistoryEntry[]; total: number; page: number; pageSize: number; totalPages: number };
  resolveSecurityAlert(id: number): boolean;
  resolveAllSecurityAlerts(): number;
  getSecurityRiskSummary(): {
    lockedCount: number;
    todayAlertsCount: number;
    totalAlertsCount: number;
    recentAlerts: HistoryEntry[];
  };
  close(): void;
}

export class Store implements IStore {
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
    fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.key = crypto.createHash('sha256').update(encryptionKey).digest();
    this.loginFailLimit = options?.loginFailLimit ?? 5;
    this.loginFailWindowMs = options?.loginFailWindowMs ?? 15 * 60_000;
    this.loginBanDurationMs = options?.loginBanDurationMs ?? 30 * 60_000;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS upstreams (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, api_key TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS credentials (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL CHECK(kind IN ('gotify','webhook')),
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
        id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, source TEXT NOT NULL,
        credential_id INTEGER, upstream_id INTEGER, status TEXT NOT NULL,
        title TEXT, content TEXT, media_type TEXT, message_id TEXT, error TEXT,
        handled_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_history_created_at ON notification_history(created_at DESC);
      CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    try {
      this.db.exec('ALTER TABLE notification_history ADD COLUMN handled_at TEXT');
    } catch {}
  }

  private encrypt(value: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }

  private decrypt(value: string): string {
    const raw = Buffer.from(value, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }

  private preview(value: string): string { return value.length <= 8 ? '********' : `${value.slice(0, 4)}...${value.slice(-4)}`; }

  listUpstreams(): UpstreamSummary[] {
    return (this.db.prepare('SELECT * FROM upstreams ORDER BY name').all() as UpstreamRow[]).map(row => ({
      id: row.id, name: row.name, apiKeyPreview: this.preview(this.decrypt(row.api_key)), createdAt: row.created_at, updatedAt: row.updated_at
    }));
  }

  addUpstream(name: string, apiKey: string): UpstreamSummary {
    const time = now();
    const result = this.db.prepare('INSERT INTO upstreams (name, api_key, created_at, updated_at) VALUES (?, ?, ?, ?)').run(name, this.encrypt(apiKey), time, time);
    return { id: Number(result.lastInsertRowid), name, apiKeyPreview: this.preview(apiKey), createdAt: time, updatedAt: time };
  }

  deleteUpstream(id: number): boolean { return Number(this.db.prepare('DELETE FROM upstreams WHERE id = ?').run(id).changes) > 0; }

  getUpstream(id: number): { id: number; name: string; apiKey: string } | undefined {
    const row = this.db.prepare('SELECT * FROM upstreams WHERE id = ?').get(id) as UpstreamRow | undefined;
    return row ? { id: row.id, name: row.name, apiKey: this.decrypt(row.api_key) } : undefined;
  }

  createCredential(name: string, kind: CredentialKind, secret: string, upstreamIds: number[]): CredentialSummary {
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
    return { id, name, kind, secretPreview: this.preview(secret), upstreamIds, createdAt: time, updatedAt: time };
  }

  listCredentials(): CredentialSummary[] {
    const rows = this.db.prepare('SELECT * FROM credentials ORDER BY kind, name').all() as CredentialRow[];
    const bindings = this.db.prepare('SELECT upstream_id FROM credential_bindings WHERE credential_id = ?');
    return rows.map(row => ({
      id: row.id, name: row.name, kind: row.kind, secretPreview: this.preview(this.decrypt(row.secret)),
      upstreamIds: (bindings.all(row.id) as { upstream_id: number }[]).map(item => item.upstream_id),
      createdAt: row.created_at, updatedAt: row.updated_at
    }));
  }

  deleteCredential(id: number): boolean { return Number(this.db.prepare('DELETE FROM credentials WHERE id = ?').run(id).changes) > 0; }

  findCredential(kind: CredentialKind, secret: string): { id: number; name: string; upstreams: { id: number; name: string; apiKey: string }[] } | undefined {
    const rows = this.db.prepare('SELECT * FROM credentials WHERE kind = ?').all(kind) as CredentialRow[];
    const candidate = Buffer.from(secret);
    const credential = rows.find(row => {
      const stored = Buffer.from(this.decrypt(row.secret));
      return stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate);
    });
    if (!credential) return undefined;
    const upstreams = this.db.prepare(`SELECT u.* FROM upstreams u JOIN credential_bindings b ON b.upstream_id = u.id WHERE b.credential_id = ?`).all(credential.id) as UpstreamRow[];
    return { id: credential.id, name: credential.name, upstreams: upstreams.map(row => ({ id: row.id, name: row.name, apiKey: this.decrypt(row.api_key) })) };
  }

  addHistory(input: Omit<HistoryEntry, 'id' | 'createdAt' | 'credentialName' | 'upstreamName'> & { credentialId?: number; upstreamId?: number }) {
    this.db.prepare(`INSERT INTO notification_history (created_at, source, credential_id, upstream_id, status, title, content, media_type, message_id, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(now(), input.source, input.credentialId ?? null, input.upstreamId ?? null, input.status, input.title, input.content, input.mediaType, input.messageId, input.error);
  }

  listHistory(limit = 100): HistoryEntry[] {
    return this.db.prepare(`SELECT h.id, h.created_at, h.source, c.name credential_name, u.name upstream_name, h.status, h.title, h.content, h.media_type, h.message_id, h.error
      FROM notification_history h LEFT JOIN credentials c ON c.id = h.credential_id LEFT JOIN upstreams u ON u.id = h.upstream_id
      ORDER BY h.id DESC LIMIT ?`).all(limit).map((row: any) => ({
        id: row.id, createdAt: row.created_at, source: row.source, credentialName: row.credential_name, upstreamName: row.upstream_name,
        status: row.status, title: row.title, content: row.content, mediaType: row.media_type, messageId: row.message_id, error: row.error
      }));
  }

  listHistoryPaged(page = 1, pageSize = 20): { items: HistoryEntry[]; total: number; page: number; pageSize: number; totalPages: number } {
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

  createSession(sessionId: string, expiresAt: Date) {
    this.db.prepare('INSERT INTO sessions (id_hash, expires_at, created_at) VALUES (?, ?, ?)').run(this.hash(sessionId), expiresAt.toISOString(), now());
  }
  hasSession(sessionId: string): boolean {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
    return !!this.db.prepare('SELECT 1 FROM sessions WHERE id_hash = ?').get(this.hash(sessionId));
  }
  deleteSession(sessionId: string) { this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(this.hash(sessionId)); }
  private hash(value: string) { return crypto.createHash('sha256').update(value).digest('hex'); }

  loginAllowed(ip: string): { allowed: boolean; retryAfter?: number } {
    const row = this.db.prepare('SELECT * FROM login_attempts WHERE ip = ?').get(ip) as { locked_until: string | null } | undefined;
    if (!row?.locked_until || Date.parse(row.locked_until) <= Date.now()) return { allowed: true };
    return { allowed: false, retryAfter: Math.ceil((Date.parse(row.locked_until) - Date.now()) / 1000) };
  }
  updateBruteForceOptions(options: { loginFailLimit?: number; loginFailWindowMs?: number; loginBanDurationMs?: number }) {
    if (options.loginFailLimit !== undefined) this.loginFailLimit = options.loginFailLimit;
    if (options.loginFailWindowMs !== undefined) this.loginFailWindowMs = options.loginFailWindowMs;
    if (options.loginBanDurationMs !== undefined) this.loginBanDurationMs = options.loginBanDurationMs;
  }
  recordLoginFailure(ip: string): { count: number; locked: boolean; lockDurationMs: number } {
    const row = this.db.prepare('SELECT * FROM login_attempts WHERE ip = ?').get(ip) as { failed_count: number; first_failed_at: string } | undefined;
    const first = row && Date.now() - Date.parse(row.first_failed_at) < this.loginFailWindowMs ? row.first_failed_at : now();
    const count = first === row?.first_failed_at ? row.failed_count + 1 : 1;
    const locked = count >= this.loginFailLimit;
    const lock = locked ? new Date(Date.now() + this.loginBanDurationMs).toISOString() : null;
    this.db.prepare(`INSERT INTO login_attempts (ip, failed_count, first_failed_at, locked_until) VALUES (?, ?, ?, ?)
      ON CONFLICT(ip) DO UPDATE SET failed_count = excluded.failed_count, first_failed_at = excluded.first_failed_at, locked_until = excluded.locked_until`).run(ip, count, first, lock);
    return { count, locked, lockDurationMs: this.loginBanDurationMs };
  }
  clearLoginFailures(ip: string) { this.db.prepare('DELETE FROM login_attempts WHERE ip = ?').run(ip); }
  unbanIp(ip: string): boolean {
    const result = this.db.prepare('DELETE FROM login_attempts WHERE ip = ?').run(ip);
    return result.changes > 0;
  }
  listLockedIps(): { ip: string; failedCount: number; firstFailedAt: string; lockedUntil: string }[] {
    const rows = this.db.prepare(`
      SELECT ip, failed_count, first_failed_at, locked_until
      FROM login_attempts
      WHERE locked_until IS NOT NULL AND locked_until > ?
      ORDER BY locked_until DESC
    `).all(now()) as any[];
    return rows.map(r => ({
      ip: r.ip,
      failedCount: r.failed_count,
      firstFailedAt: r.first_failed_at,
      lockedUntil: r.locked_until
    }));
  }
  listSecurityAlerts(page = 1, pageSize = 50): { items: HistoryEntry[]; total: number; page: number; pageSize: number; totalPages: number } {
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
  resolveSecurityAlert(id: number): boolean {
    const result = this.db.prepare("UPDATE notification_history SET handled_at = ? WHERE id = ? AND source = 'system'").run(now(), id);
    return result.changes > 0;
  }
  resolveAllSecurityAlerts(): number {
    const result = this.db.prepare("UPDATE notification_history SET handled_at = ? WHERE source = 'system' AND handled_at IS NULL").run(now());
    return Number(result.changes);
  }
  getSecurityRiskSummary(): {
    lockedCount: number;
    todayAlertsCount: number;
    totalAlertsCount: number;
    recentAlerts: HistoryEntry[];
  } {
    const currentTime = now();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayIso = todayStart.toISOString();

    const lockedRow = this.db.prepare('SELECT COUNT(1) as count FROM login_attempts WHERE locked_until IS NOT NULL AND locked_until > ?').get(currentTime) as { count: number };
    const todayRow = this.db.prepare("SELECT COUNT(1) as count FROM notification_history WHERE source = 'system' AND handled_at IS NULL AND created_at >= ?").get(todayIso) as { count: number };
    const totalRow = this.db.prepare("SELECT COUNT(1) as count FROM notification_history WHERE source = 'system'").get() as { count: number };

    const recent = this.listSecurityAlerts(1, 5).items;

    return {
      lockedCount: lockedRow?.count ?? 0,
      todayAlertsCount: todayRow?.count ?? 0,
      totalAlertsCount: totalRow?.count ?? 0,
      recentAlerts: recent
    };
  }

  getSetting(key: string, defaultValue = ''): string {
    const row = this.db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : defaultValue;
  }

  setSetting(key: string, value: string): void {
    const time = now();
    this.db.prepare(`
      INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, time);
  }

  getSecuritySettings(): SecurityAlertSettings {
    const parseNum = (key: string, def: number) => {
      const v = this.getSetting(key);
      if (!v && v !== '0') return def;
      const n = Number(v);
      return Number.isFinite(n) ? n : def;
    };
    return {
      accessLogFormat: this.getSetting('accessLogFormat', 'text') === 'json' ? 'json' : 'text',
      accessLogRetentionDays: Math.max(1, parseNum('accessLogRetentionDays', 30)),
      notifyOnLogin: this.getSetting('notifyOnLogin', 'false') === 'true',
      notifyOnLoginFailed: this.getSetting('notifyOnLoginFailed', 'false') === 'true',
      notifyOnAuthFailed: this.getSetting('notifyOnAuthFailed', 'false') === 'true',
      notifyUpstreamId: parseNum('notifyUpstreamId', 0),
      notifyLoginFailThreshold: Math.max(1, parseNum('notifyLoginFailThreshold', 3)),
      notifyAuthFailThreshold: Math.max(1, parseNum('notifyAuthFailThreshold', 3)),
      notifyAuthFailWindowMin: Math.max(1, parseNum('notifyAuthFailWindowMin', 1)),
      rateLimitPhoneMinIntervalSec: Math.max(0, parseNum('rateLimitPhoneMinIntervalSec', 60)),
      rateLimitPhoneHourMax: Math.max(0, parseNum('rateLimitPhoneHourMax', 10)),
      rateLimitPhoneDayMax: Math.max(0, parseNum('rateLimitPhoneDayMax', 20)),
      rateLimitIpMinMax: Math.max(0, parseNum('rateLimitIpMinMax', 30)),
      rateLimitDuplicateWindowSec: Math.max(0, parseNum('rateLimitDuplicateWindowSec', 300)),
      notifyOnRateLimit: this.getSetting('notifyOnRateLimit', 'true') === 'true'
    };
  }

  updateSecuritySettings(settings: Partial<SecurityAlertSettings>): void {
    if (settings.accessLogFormat !== undefined) this.setSetting('accessLogFormat', settings.accessLogFormat);
    if (settings.accessLogRetentionDays !== undefined) this.setSetting('accessLogRetentionDays', String(settings.accessLogRetentionDays));
    if (settings.notifyOnLogin !== undefined) this.setSetting('notifyOnLogin', String(settings.notifyOnLogin));
    if (settings.notifyOnLoginFailed !== undefined) this.setSetting('notifyOnLoginFailed', String(settings.notifyOnLoginFailed));
    if (settings.notifyOnAuthFailed !== undefined) this.setSetting('notifyOnAuthFailed', String(settings.notifyOnAuthFailed));
    if (settings.notifyUpstreamId !== undefined) this.setSetting('notifyUpstreamId', String(settings.notifyUpstreamId));
    if (settings.notifyLoginFailThreshold !== undefined) this.setSetting('notifyLoginFailThreshold', String(settings.notifyLoginFailThreshold));
    if (settings.notifyAuthFailThreshold !== undefined) this.setSetting('notifyAuthFailThreshold', String(settings.notifyAuthFailThreshold));
    if (settings.notifyAuthFailWindowMin !== undefined) this.setSetting('notifyAuthFailWindowMin', String(settings.notifyAuthFailWindowMin));
    if (settings.rateLimitPhoneMinIntervalSec !== undefined) this.setSetting('rateLimitPhoneMinIntervalSec', String(settings.rateLimitPhoneMinIntervalSec));
    if (settings.rateLimitPhoneHourMax !== undefined) this.setSetting('rateLimitPhoneHourMax', String(settings.rateLimitPhoneHourMax));
    if (settings.rateLimitPhoneDayMax !== undefined) this.setSetting('rateLimitPhoneDayMax', String(settings.rateLimitPhoneDayMax));
    if (settings.rateLimitIpMinMax !== undefined) this.setSetting('rateLimitIpMinMax', String(settings.rateLimitIpMinMax));
    if (settings.rateLimitDuplicateWindowSec !== undefined) this.setSetting('rateLimitDuplicateWindowSec', String(settings.rateLimitDuplicateWindowSec));
    if (settings.notifyOnRateLimit !== undefined) this.setSetting('notifyOnRateLimit', String(settings.notifyOnRateLimit));
  }

  close() { this.db.close(); }
}

export { Store as SqliteStore };

export function createStore(
  databasePath: string,
  encryptionKey: string,
  options?: {
    loginFailLimit?: number;
    loginFailWindowMs?: number;
    loginBanDurationMs?: number;
  }
): IStore {
  return new Store(databasePath, encryptionKey, options);
}

export interface SecurityAlertSettings {
  accessLogFormat: 'text' | 'json';
  accessLogRetentionDays: number;
  notifyOnLogin: boolean;
  notifyOnLoginFailed: boolean;
  notifyOnAuthFailed: boolean;
  notifyUpstreamId: number;
  notifyLoginFailThreshold: number;
  notifyAuthFailThreshold: number;
  notifyAuthFailWindowMin: number;
  rateLimitPhoneMinIntervalSec: number;
  rateLimitPhoneHourMax: number;
  rateLimitPhoneDayMax: number;
  rateLimitIpMinMax: number;
  rateLimitDuplicateWindowSec: number;
  notifyOnRateLimit: boolean;
}

