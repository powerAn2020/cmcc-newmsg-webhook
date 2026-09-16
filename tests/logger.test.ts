import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AccessLogger,
  formatAccessLog,
  isStaticAsset,
  maskSecretKey,
  parseLogLine
} from '../src/logger.js';

describe('logger unit tests', () => {
  const testLogPath = path.resolve('./logs/test-logger-unit.log');
  const logDir = path.dirname(testLogPath);

  function cleanTestLogs() {
    if (fs.existsSync(logDir)) {
      const files = fs.readdirSync(logDir);
      for (const file of files) {
        if (file.startsWith('test-logger-unit')) {
          try {
            fs.unlinkSync(path.join(logDir, file));
          } catch {
            // ignore
          }
        }
      }
    }
  }

  afterEach(() => {
    cleanTestLogs();
  });

  it('masks secret key safely', () => {
    expect(maskSecretKey('')).toBe('');
    expect(maskSecretKey('12345')).toBe('***');
    expect(maskSecretKey('abcdefghij')).toBe('ab***ij');
    expect(maskSecretKey('tok_1234567890abcdef')).toBe('tok_***cdef');
  });

  it('detects static assets correctly', () => {
    expect(isStaticAsset('/app.js')).toBe(true);
    expect(isStaticAsset('/app.css?v=123')).toBe(true);
    expect(isStaticAsset('/favicon.ico')).toBe(true);
    expect(isStaticAsset('/logo.png')).toBe(true);

    expect(isStaticAsset('/message?token=abc')).toBe(false);
    expect(isStaticAsset('/webhook')).toBe(false);
    expect(isStaticAsset('/healthz')).toBe(false);
    expect(isStaticAsset('/admin/api/push')).toBe(false);
  });

  it('formats access log line properly', () => {
    const line = formatAccessLog({
      timestamp: new Date('2026-09-16T12:00:00.123Z'),
      ip: '127.0.0.1',
      method: 'POST',
      url: '/message?token=secret123',
      statusCode: 200,
      durationMs: 14.5,
      authType: 'gotify',
      credentialName: '监控告警',
      maskedSecret: 'sec_***1234',
      upstreams: ['primary', 'backup']
    });

    expect(line).toContain('IP: 127.0.0.1');
    expect(line).toContain('POST /message?token=secret123');
    expect(line).toContain('200 (14.5ms)');
    expect(line).toContain('AUTH: gotify(name="监控告警", key=sec_***1234)');
    expect(line).toContain('UPSTREAMS: [primary, backup]');
  });

  it('parses both JSON and standard text log lines into structured data', () => {
    // 1. JSON 格式解析
    const jsonLine = JSON.stringify({
      timestamp: '2026-09-16T10:00:00.000Z',
      ip: '10.0.0.1',
      method: 'POST',
      url: '/message',
      statusCode: 200,
      durationMs: 12,
      authType: 'gotify',
      credentialName: 'Token1',
      maskedSecret: 'tok_***',
      upstreams: ['up1'],
      error: undefined
    });
    const parsedJson = parseLogLine(jsonLine);
    expect(parsedJson).toMatchObject({
      ip: '10.0.0.1',
      method: 'POST',
      url: '/message',
      statusCode: 200,
      authType: 'gotify'
    });

    // 2. 文本格式解析
    const textLine = '[2026-09-16 10:00:00.123] [IP: 192.168.1.100] POST /webhook [200 (15.2ms)] [AUTH: webhook(name="Bot", key=sec_***)] [UPSTREAMS: [up1, up2]]';
    const parsedText = parseLogLine(textLine);
    expect(parsedText).toMatchObject({
      ip: '192.168.1.100',
      method: 'POST',
      url: '/webhook',
      statusCode: 200,
      durationMs: 15.2,
      authType: 'webhook',
      credentialName: 'Bot',
      maskedSecret: 'sec_***',
      upstreams: ['up1', 'up2']
    });
  });

  it('writes daily log file, lists dates, supports pagination and cleanup', async () => {
    cleanTestLogs();
    const logger = new AccessLogger(testLogPath, 'text', 7);
    const today = logger.getCurrentDateStr();
    const dailyPath = logger.getDailyFilePath(today);

    // 写两条日志
    logger.log({
      ip: '192.168.1.10',
      method: 'POST',
      url: '/webhook',
      statusCode: 200,
      durationMs: 10,
      authType: 'webhook',
      credentialName: '测试通道',
      maskedSecret: 'web_***7890'
    });

    logger.log({
      ip: '192.168.1.11',
      method: 'POST',
      url: '/message',
      statusCode: 201,
      durationMs: 25,
      authType: 'gotify',
      credentialName: '测试Gotify',
      maskedSecret: 'got_***1111'
    });

    // 静态资源应该被忽略
    logger.log({
      ip: '192.168.1.10',
      method: 'GET',
      url: '/app.js',
      statusCode: 200,
      durationMs: 2
    });

    await logger.close();

    expect(fs.existsSync(dailyPath)).toBe(true);
    const content = fs.readFileSync(dailyPath, 'utf8');
    expect(content).toContain('POST /webhook');
    expect(content).toContain('POST /message');
    expect(content).not.toContain('/app.js');

    // 测试日期列表
    const dates = logger.listLogDates();
    expect(dates).toContain(today);

    // 测试分页读取
    const paged = await logger.readLogsByDate(today, 1, 1);
    expect(paged.total).toBe(2);
    expect(paged.totalPages).toBe(2);
    expect(paged.page).toBe(1);
    expect(paged.items.length).toBe(1);
    // 最新写入的排前面
    expect(paged.items[0].url).toBe('/message');

    // 模拟一个 10 天前的旧日志文件并测试 cleanup
    const oldDate = '2020-01-01';
    const oldFilePath = logger.getDailyFilePath(oldDate);
    fs.writeFileSync(oldFilePath, 'old log content\n');
    expect(fs.existsSync(oldFilePath)).toBe(true);

    const deleted = logger.cleanupOldLogs(7);
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(oldFilePath)).toBe(false);
    expect(fs.existsSync(dailyPath)).toBe(true);
  });
});
