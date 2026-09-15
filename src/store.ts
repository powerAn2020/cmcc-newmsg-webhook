import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CredentialKind, CredentialSummary, HistoryEntry, UpstreamSummary } from './types.js';

type UpstreamRow = { id: number; name: string; api_key: string; created_at: string; updated_at: string };
type CredentialRow = { id: number; name: string; kind: CredentialKind; secret: string; created_at: string; updated_at: string };

function now(): string { return new Date().toISOString(); }

export class Store {
  private readonly db: DatabaseSync;
  private readonly key: Buffer;

  constructor(databasePath: string, encryptionKey: string) {
    fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.key = crypto.createHash('sha256').update(encryptionKey).digest();
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
        title TEXT, content TEXT, media_type TEXT, message_id TEXT, error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_history_created_at ON notification_history(created_at DESC);
    `);
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
  recordLoginFailure(ip: string) {
    const row = this.db.prepare('SELECT * FROM login_attempts WHERE ip = ?').get(ip) as { failed_count: number; first_failed_at: string } | undefined;
    const first = row && Date.now() - Date.parse(row.first_failed_at) < 15 * 60_000 ? row.first_failed_at : now();
    const count = first === row?.first_failed_at ? row.failed_count + 1 : 1;
    const lock = count >= 5 ? new Date(Date.now() + 30 * 60_000).toISOString() : null;
    this.db.prepare(`INSERT INTO login_attempts (ip, failed_count, first_failed_at, locked_until) VALUES (?, ?, ?, ?)
      ON CONFLICT(ip) DO UPDATE SET failed_count = excluded.failed_count, first_failed_at = excluded.first_failed_at, locked_until = excluded.locked_until`).run(ip, count, first, lock);
  }
  clearLoginFailures(ip: string) { this.db.prepare('DELETE FROM login_attempts WHERE ip = ?').run(ip); }
  close() { this.db.close(); }
}
