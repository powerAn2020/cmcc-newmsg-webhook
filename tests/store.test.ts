import { describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';

describe('SQLite store', () => {
  it('encrypts keys, binds multiple upstreams, and retains history', () => {
    const store = new Store(':memory:', 'test-encryption-key');
    const one = store.addUpstream('one', 'ak_one_123456');
    const two = store.addUpstream('two', 'ak_two_123456');
    const credential = store.createCredential('monitor', 'gotify', 'gotify-secret', [one.id, two.id]);
    expect(store.getUpstream(one.id)?.apiKey).toBe('ak_one_123456');
    expect(store.findCredential('gotify', 'wrong-secret')).toBeUndefined();
    expect(store.findCredential('gotify', 'gotify-secret')?.upstreams).toHaveLength(2);
    store.addHistory({ source: 'gotify', credentialId: credential.id, upstreamId: one.id, status: 'success', title: 'Alert', content: 'Delivered', mediaType: null, messageId: 'msg_1', error: null });
    expect(store.listHistory()).toMatchObject([{ status: 'success', credentialName: 'monitor', upstreamName: 'one', messageId: 'msg_1' }]);
    store.close();
  });

  it('locks an IP after five failed login attempts', () => {
    const store = new Store(':memory:', 'test-encryption-key');
    for (let index = 0; index < 5; index += 1) store.recordLoginFailure('127.0.0.1');
    expect(store.loginAllowed('127.0.0.1').allowed).toBe(false);
    store.close();
  });

  it('respects custom login failure limit and ban duration', () => {
    const store = new Store(':memory:', 'test-encryption-key', {
      loginFailLimit: 2,
      loginFailWindowMs: 5000,
      loginBanDurationMs: 10000
    });
    store.recordLoginFailure('127.0.0.1');
    expect(store.loginAllowed('127.0.0.1').allowed).toBe(true);
    store.recordLoginFailure('127.0.0.1');
    expect(store.loginAllowed('127.0.0.1').allowed).toBe(false);
    expect(store.loginAllowed('127.0.0.1').retryAfter).toBeGreaterThan(0);
    store.close();
  });

  it('deletes upstreams and cascades their credential bindings', () => {
    const store = new Store(':memory:', 'test-encryption-key');
    const upstream = store.addUpstream('delete-me', 'ak_delete');
    store.createCredential('bound', 'webhook', 'bound-secret', [upstream.id]);
    expect(store.deleteUpstream(upstream.id)).toBe(true);
    expect(store.listCredentials()[0].upstreamIds).toEqual([]);
    expect(store.deleteUpstream(upstream.id)).toBe(false);
    store.close();
  });
});
