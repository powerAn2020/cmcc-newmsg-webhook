import fs, { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import path from 'node:path';

export interface AccessLogEntry {
  timestamp?: Date;
  ip: string;
  method: string;
  url: string;
  statusCode: number;
  durationMs: number;
  authType?: string;
  credentialName?: string;
  maskedSecret?: string;
  upstreams?: string[];
  error?: string;
}

export function maskSecretKey(secret: string): string {
  if (!secret) return '';
  const trimmed = secret.trim();
  if (trimmed.length <= 6) return '***';
  if (trimmed.length <= 10) return `${trimmed.slice(0, 2)}***${trimmed.slice(-2)}`;
  return `${trimmed.slice(0, 4)}***${trimmed.slice(-4)}`;
}

export function isStaticAsset(urlPath: string): boolean {
  try {
    const pathname = urlPath.split('?')[0].toLowerCase();
    return /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|map)$/.test(pathname);
  } catch {
    return false;
  }
}

export function getLocalDateString(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatAccessLog(entry: AccessLogEntry): string {
  const time = entry.timestamp ?? new Date();
  const pad = (n: number, z = 2) => String(n).padStart(z, '0');
  const formattedTime = `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}.${pad(time.getMilliseconds(), 3)}`;

  // 构建 AUTH 描述
  let authDesc = 'none';
  if (entry.authType === 'admin_session') {
    authDesc = `admin_session(user="${entry.credentialName || 'admin'}")`;
  } else if (entry.authType === 'gotify' || entry.authType === 'webhook') {
    const parts = [
      entry.credentialName ? `name="${entry.credentialName}"` : '',
      entry.maskedSecret ? `key=${entry.maskedSecret}` : ''
    ].filter(Boolean);
    authDesc = `${entry.authType}(${parts.join(', ')})`;
  } else if (entry.authType?.startsWith('invalid_')) {
    authDesc = `${entry.authType}${entry.maskedSecret ? `(key=${entry.maskedSecret})` : ''}`;
  } else if (entry.authType) {
    authDesc = entry.authType;
  }

  // 构建 UPSTREAMS 描述
  const upstreamDesc = entry.upstreams && entry.upstreams.length > 0
    ? ` -> UPSTREAMS: [${entry.upstreams.join(', ')}]`
    : '';

  // 构建错误信息
  const errDesc = entry.error ? ` | ERROR: ${entry.error}` : '';

  return `[${formattedTime}] IP: ${entry.ip} | ${entry.method} ${entry.url} | ${entry.statusCode} (${entry.durationMs.toFixed(1)}ms) | AUTH: ${authDesc}${upstreamDesc}${errDesc}`;
}

export function formatAccessLogJson(entry: AccessLogEntry): string {
  const time = entry.timestamp ?? new Date();
  return JSON.stringify({
    timestamp: time.toISOString(),
    ip: entry.ip,
    method: entry.method,
    url: entry.url,
    statusCode: entry.statusCode,
    durationMs: Number(entry.durationMs.toFixed(1)),
    authType: entry.authType ?? 'none',
    credentialName: entry.credentialName,
    maskedSecret: entry.maskedSecret,
    upstreams: entry.upstreams,
    error: entry.error
  });
}

/**
 * 智能双模解析器：无论行是 JSON 还是旧纯文本格式，均解析为统一结构化对象
 */
export function parseLogLine(line: string): any {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // ignore
    }
  }

  // 正则解析标准文本格式
  // 格式 1: [time] IP: ip | METHOD URL | code (ms) | AUTH: authDesc -> UPSTREAMS: [...] | ERROR: ...
  let match = trimmed.match(/^\[(.*?)\]\s+IP:\s*(\S+)\s+\|\s*(\S+)\s+(\S+)\s+\|\s*(\d+)\s*\(([\d.]+)ms\)\s+\|\s*AUTH:\s*([^|]+?)(?:\s*->\s*UPSTREAMS:\s*\[(.*?)\])?(?:\s*\|\s*ERROR:\s*(.*?))?$/);

  // 格式 2: [time] [IP: ip] METHOD URL [code (ms)] [AUTH: authDesc] [UPSTREAMS: [...]] [ERROR: ...]
  if (!match) {
    match = trimmed.match(/^\[(.*?)\]\s+\[IP:\s*(\S+)\]\s+(\S+)\s+(\S+)\s+\[(\d+)\s*\(([\d.]+)ms\)\](?:\s+\[AUTH:\s*([^\]]+)\])?(?:\s+\[UPSTREAMS:\s*\[(.*?)\]\])?(?:\s+\[ERROR:\s*([^\]]+)\])?$/);
  }

  if (match) {
    let rawAuth = match[7].trim();
    let authType = rawAuth;
    let credentialName: string | undefined;
    let maskedSecret: string | undefined;

    const sessionMatch = rawAuth.match(/^admin_session\(user="([^"]+)"\)$/);
    if (sessionMatch) {
      authType = 'admin_session';
      credentialName = sessionMatch[1];
    } else {
      const credMatch = rawAuth.match(/^(gotify|webhook)\((?:name="([^"]+)",?\s*)?(?:key=([^\)]+))?\)$/);
      if (credMatch) {
        authType = credMatch[1];
        credentialName = credMatch[2];
        maskedSecret = credMatch[3];
      } else {
        const invalidMatch = rawAuth.match(/^(invalid_[a-z0-9_]+)(?:\(key=([^\)]+)\))?$/);
        if (invalidMatch) {
          authType = invalidMatch[1];
          maskedSecret = invalidMatch[2];
        }
      }
    }

    return {
      timestamp: match[1],
      ip: match[2],
      method: match[3],
      url: match[4],
      statusCode: Number(match[5]),
      durationMs: Number(match[6]),
      authType,
      credentialName,
      maskedSecret,
      upstreams: match[8] ? match[8].split(',').map(s => s.trim()).filter(Boolean) : undefined,
      error: match[9] ? match[9].trim() : undefined
    };
  }

  return { raw: trimmed };
}

export class AccessLogger {
  private stream?: WriteStream;
  private baseFilePath: string;
  private logDir: string;
  private fileBaseName: string;
  private fileExt: string;
  private format: 'text' | 'json';
  private retentionDays: number;
  private currentDate: string = '';
  private cleanupTimer?: NodeJS.Timeout;

  constructor(filePath: string, format: 'text' | 'json' = 'text', retentionDays = 7) {
    this.baseFilePath = filePath;
    this.logDir = path.dirname(filePath);
    this.fileExt = path.extname(filePath) || '.log';
    this.fileBaseName = path.basename(filePath, this.fileExt);
    this.format = format;
    this.retentionDays = Math.max(1, retentionDays);
  }

  public getDailyFilePath(dateStr: string): string {
    return path.join(this.logDir, `${this.fileBaseName}-${dateStr}${this.fileExt}`);
  }

  public getCurrentDateStr(): string {
    return getLocalDateString();
  }

  public getFilePath(): string {
    const today = this.getCurrentDateStr();
    return this.getDailyFilePath(today);
  }

  private rotateStream(dateStr: string) {
    if (this.stream) {
      try {
        this.stream.end();
      } catch {
        // ignore
      }
    }
    this.currentDate = dateStr;
    const dailyPath = this.getDailyFilePath(dateStr);
    try {
      mkdirSync(this.logDir, { recursive: true });
      this.stream = createWriteStream(dailyPath, { flags: 'a', encoding: 'utf8' });
      this.stream.on('error', (err) => {
        console.error('AccessLogger write stream error:', err.message);
      });
    } catch (err) {
      console.error('AccessLogger stream creation failed:', err);
    }
  }

  public setFormat(format: 'text' | 'json') {
    this.format = format;
  }

  public getFormat(): 'text' | 'json' {
    return this.format;
  }

  public setRetentionDays(days: number) {
    this.retentionDays = Math.max(1, days);
    this.cleanupOldLogs(this.retentionDays);
  }

  public getRetentionDays(): number {
    return this.retentionDays;
  }

  public log(entry: AccessLogEntry) {
    if (isStaticAsset(entry.url)) return;
    try {
      const now = entry.timestamp ?? new Date();
      const dateStr = getLocalDateString(now);
      if (dateStr !== this.currentDate || !this.stream || !this.stream.writable) {
        this.rotateStream(dateStr);
      }
      const line = this.format === 'json' ? formatAccessLogJson(entry) : formatAccessLog(entry);
      if (this.stream && this.stream.writable) {
        this.stream.write(line + '\n');
      }
    } catch (err) {
      console.error('AccessLogger failed to write log:', err);
    }
  }

  public listLogDates(): string[] {
    const dates = new Set<string>();
    const today = this.getCurrentDateStr();
    dates.add(today);

    try {
      if (fs.existsSync(this.logDir)) {
        const files = fs.readdirSync(this.logDir);
        const prefix = `${this.fileBaseName}-`;
        const ext = this.fileExt;
        for (const file of files) {
          if (file.startsWith(prefix) && file.endsWith(ext)) {
            const datePart = file.slice(prefix.length, file.length - ext.length);
            if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
              dates.add(datePart);
            }
          }
        }
      }
    } catch (err) {
      console.error('Failed to list log dates:', err);
    }

    return Array.from(dates).sort().reverse();
  }

  public getTodayDate(): string {
    return this.getCurrentDateStr();
  }

  public async readLogsByDate(
    dateStr: string,
    page = 1,
    pageSize = 50
  ): Promise<{
    date: string;
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
    items: any[];
    format: 'text' | 'json';
  }> {
    const safePage = Math.max(1, Number(page) || 1);
    const safePageSize = Math.max(1, Math.min(Number(pageSize) || 50, 500));

    let filePath = this.getDailyFilePath(dateStr);
    if (!fs.existsSync(filePath)) {
      if (dateStr === this.getCurrentDateStr() && fs.existsSync(this.baseFilePath)) {
        filePath = this.baseFilePath;
      } else {
        return {
          date: dateStr,
          page: 1,
          pageSize: safePageSize,
          total: 0,
          totalPages: 1,
          items: [],
          format: this.format
        };
      }
    }

    try {
      const content = await fs.promises.readFile(filePath, 'utf8');
      const lines = content.trim().split('\n').filter(Boolean);
      lines.reverse(); // 最新日志排在前面

      const total = lines.length;
      const totalPages = Math.max(1, Math.ceil(total / safePageSize));
      const validPage = Math.min(safePage, totalPages);
      const start = (validPage - 1) * safePageSize;
      const pageLines = lines.slice(start, start + safePageSize);

      const items = pageLines.map((line, idx) => {
        const parsed = parseLogLine(line);
        if (parsed) return parsed;
        return { raw: line, index: idx };
      });

      return {
        date: dateStr,
        page: validPage,
        pageSize: safePageSize,
        total,
        totalPages,
        items,
        format: this.format
      };
    } catch (err) {
      console.error(`Failed to read log file for date ${dateStr}:`, err);
      return {
        date: dateStr,
        page: 1,
        pageSize: safePageSize,
        total: 0,
        totalPages: 1,
        items: [],
        format: this.format
      };
    }
  }

  public async readRecentLogs(limit = 100): Promise<{ raw: string; items: any[]; format: 'text' | 'json'; total: number }> {
    const today = this.getCurrentDateStr();
    const result = await this.readLogsByDate(today, 1, limit);
    return {
      raw: '',
      items: result.items,
      format: this.format,
      total: result.total
    };
  }

  public async readDangerousLogs(
    dateStr?: string,
    page = 1,
    pageSize = 50
  ): Promise<{
    date: string;
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
    items: any[];
    format: 'text' | 'json';
  }> {
    const targetDate = dateStr?.trim() || this.getCurrentDateStr();
    const safePage = Math.max(1, Number(page) || 1);
    const safePageSize = Math.max(1, Math.min(Number(pageSize) || 50, 500));

    let filePath = this.getDailyFilePath(targetDate);
    if (!fs.existsSync(filePath)) {
      if (targetDate === this.getCurrentDateStr() && fs.existsSync(this.baseFilePath)) {
        filePath = this.baseFilePath;
      } else {
        return {
          date: targetDate,
          page: 1,
          pageSize: safePageSize,
          total: 0,
          totalPages: 1,
          items: [],
          format: this.format
        };
      }
    }

    try {
      const content = await fs.promises.readFile(filePath, 'utf8');
      const lines = content.trim().split('\n').filter(Boolean);
      lines.reverse();

      const dangerousItems: any[] = [];
      for (let i = 0; i < lines.length; i++) {
        const parsed = parseLogLine(lines[i]);
        if (!parsed) continue;
        const statusCode = Number(parsed.statusCode);
        const isDangerous = (statusCode >= 400) ||
          (parsed.authType && String(parsed.authType).startsWith('invalid_')) ||
          (parsed.authType === 'login_failed') ||
          (Boolean(parsed.error));
        if (isDangerous) {
          dangerousItems.push(parsed);
        }
      }

      const total = dangerousItems.length;
      const totalPages = Math.max(1, Math.ceil(total / safePageSize));
      const validPage = Math.min(safePage, totalPages);
      const start = (validPage - 1) * safePageSize;
      const items = dangerousItems.slice(start, start + safePageSize);

      return {
        date: targetDate,
        page: validPage,
        pageSize: safePageSize,
        total,
        totalPages,
        items,
        format: this.format
      };
    } catch (err) {
      console.error(`Failed to read dangerous logs for date ${targetDate}:`, err);
      return {
        date: targetDate,
        page: 1,
        pageSize: safePageSize,
        total: 0,
        totalPages: 1,
        items: [],
        format: this.format
      };
    }
  }

  public cleanupOldLogs(retentionDays = this.retentionDays): number {
    let deletedCount = 0;
    if (retentionDays < 1) return 0;
    try {
      if (!fs.existsSync(this.logDir)) return 0;
      const files = fs.readdirSync(this.logDir);
      const prefix = `${this.fileBaseName}-`;
      const ext = this.fileExt;
      const todayDate = new Date(`${this.getCurrentDateStr()}T00:00:00`);

      for (const file of files) {
        if (file.startsWith(prefix) && file.endsWith(ext)) {
          const datePart = file.slice(prefix.length, file.length - ext.length);
          if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
            const fileDate = new Date(`${datePart}T00:00:00`);
            const diffDays = Math.floor((todayDate.getTime() - fileDate.getTime()) / (24 * 3600 * 1000));
            if (diffDays > retentionDays) {
              const fullPath = path.join(this.logDir, file);
              fs.unlinkSync(fullPath);
              deletedCount++;
            }
          }
        }
      }
    } catch (err) {
      console.error('cleanupOldLogs error:', err);
    }
    return deletedCount;
  }

  public startCleanupTimer(retentionDays = this.retentionDays) {
    this.stopCleanupTimer();
    this.retentionDays = retentionDays;
    this.cleanupOldLogs(retentionDays);
    this.cleanupTimer = setInterval(() => {
      this.cleanupOldLogs(this.retentionDays);
    }, 24 * 3600 * 1000);
    this.cleanupTimer.unref();
  }

  public stopCleanupTimer() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  public async close(): Promise<void> {
    this.stopCleanupTimer();
    if (!this.stream) return;
    return new Promise((resolve) => {
      this.stream!.end(() => resolve());
    });
  }
}
