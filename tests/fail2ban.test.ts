import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatAccessLogJson } from '../src/logger.js';

describe('fail2ban filter regex tests', () => {
  const confPath = path.resolve('deploy/fail2ban/cmcc-newmsg.conf');
  const confContent = fs.readFileSync(confPath, 'utf8');

  // 提取 failregex 行
  const regexLines = confContent
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#') && !l.startsWith('[') && !l.startsWith('ignoreregex'))
    .map(l => l.replace(/^failregex\s*=\s*/, ''))
    .map(l => {
      // 模拟 fail2ban 的 <HOST> 替换
      return new RegExp(l.replace('<HOST>', '(?<host>\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3})'));
    });

  function matchAnyFailregex(logLine: string): string | null {
    for (const re of regexLines) {
      const m = logLine.match(re);
      if (m?.groups?.host) return m.groups.host;
    }
    return null;
  }

  it('matches admin password brute-force 401 logs', () => {
    const line = formatAccessLogJson({
      ip: '198.51.100.23',
      method: 'POST',
      url: '/admin/api/login',
      statusCode: 401,
      durationMs: 5.2,
      authType: 'login_failed'
    });
    expect(matchAnyFailregex(line)).toBe('198.51.100.23');
  });

  it('matches admin lockout 429 logs', () => {
    const line = formatAccessLogJson({
      ip: '198.51.100.24',
      method: 'POST',
      url: '/admin/api/login',
      statusCode: 429,
      durationMs: 1.0,
      authType: 'none'
    });
    expect(matchAnyFailregex(line)).toBe('198.51.100.24');
  });

  it('matches invalid gotify token 401 logs', () => {
    const line = formatAccessLogJson({
      ip: '203.0.113.88',
      method: 'POST',
      url: '/message?token=invalid_tok',
      statusCode: 401,
      durationMs: 2.1,
      authType: 'invalid_gotify_token',
      maskedSecret: 'inv***tok'
    });
    expect(matchAnyFailregex(line)).toBe('203.0.113.88');
  });

  it('matches invalid webhook secret 401 logs', () => {
    const line = formatAccessLogJson({
      ip: '203.0.113.89',
      method: 'POST',
      url: '/webhook',
      statusCode: 401,
      durationMs: 2.1,
      authType: 'invalid_webhook_secret',
      maskedSecret: 'inv***sec'
    });
    expect(matchAnyFailregex(line)).toBe('203.0.113.89');
  });

  it('matches rate limit 429 logs', () => {
    const line = formatAccessLogJson({
      ip: '203.0.113.90',
      method: 'POST',
      url: '/webhook',
      statusCode: 429,
      durationMs: 1.2,
      authType: 'webhook',
      error: '客户端 IP 请求过于频繁'
    });
    expect(matchAnyFailregex(line)).toBe('203.0.113.90');
  });

  it('does NOT match normal successful 200/201 requests', () => {
    const line200 = formatAccessLogJson({
      ip: '10.0.0.1',
      method: 'POST',
      url: '/message',
      statusCode: 200,
      durationMs: 15.0,
      authType: 'gotify'
    });
    expect(matchAnyFailregex(line200)).toBeNull();

    const lineLoginOk = formatAccessLogJson({
      ip: '10.0.0.1',
      method: 'POST',
      url: '/admin/api/login',
      statusCode: 200,
      durationMs: 12.0,
      authType: 'login_success'
    });
    expect(matchAnyFailregex(lineLoginOk)).toBeNull();

    // 携带有效 token 访问健康检查正常放行
    const lineHealthOk = formatAccessLogJson({
      ip: '10.0.0.1',
      method: 'GET',
      url: '/healthz?token=valid_token',
      statusCode: 200,
      durationMs: 0.8,
      authType: 'gotify'
    });
    expect(matchAnyFailregex(lineHealthOk)).toBeNull();
  });

  it('matches healthz probe with invalid credential, but ignores unauthenticated probes (authType: none)', () => {
    // 提取 ignoreregex
    const ignoreLine = confContent
      .split('\n')
      .map(l => l.trim())
      .find(l => l.startsWith('ignoreregex'))
      ?.replace(/^ignoreregex\s*=\s*/, '');
    expect(ignoreLine).toBeDefined();
    const ignoreRe = new RegExp(ignoreLine!.replace('<HOST>', '(?<host>\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3})'));

    // 1. 携带无效凭据刺探健康检查（伪造 token，404 invalid_credential）-> 必须被 failregex 匹配到！
    const badHealthzLine = formatAccessLogJson({
      ip: '198.51.100.99',
      method: 'GET',
      url: '/healthz?token=fake_bad_token',
      statusCode: 404,
      durationMs: 0.5,
      authType: 'invalid_credential',
      maskedSecret: 'fak***ken'
    });
    expect(matchAnyFailregex(badHealthzLine)).toBe('198.51.100.99');
    expect(badHealthzLine.match(ignoreRe)).toBeNull(); // 绝不能被 ignoreregex 忽略！

    // 2. 普通无凭证健康探针（404 none）-> 不能被 failregex 匹配，且匹配 ignoreregex
    const probeHealthzLine = formatAccessLogJson({
      ip: '10.0.0.2',
      method: 'GET',
      url: '/healthz',
      statusCode: 404,
      durationMs: 0.3,
      authType: 'none'
    });
    expect(matchAnyFailregex(probeHealthzLine)).toBeNull();
    const ignoreMatch = probeHealthzLine.match(ignoreRe);
    expect(ignoreMatch?.groups?.host).toBe('10.0.0.2');
  });
});
