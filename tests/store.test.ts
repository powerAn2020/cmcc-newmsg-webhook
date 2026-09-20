import { describe, expect, it } from 'vitest';
import { Store, createStore, SqliteStore } from '../src/store.js';

describe('SQLite store', () => {
  it('encrypts keys, binds multiple upstreams, and retains history', async () => {
    const store = new Store(':memory:', 'test-encryption-key');
    const one = await store.addUpstream('one', 'ak_one_123456');
    const two = await store.addUpstream('two', 'ak_two_123456');
    const credential = await store.createCredential('monitor', 'gotify', 'gotify-secret', [one.id, two.id]);
    const up = await store.getUpstream(one.id);
    expect(up?.apiKey).toBe('ak_one_123456');
    expect(await store.findCredential('gotify', 'wrong-secret')).toBeUndefined();
    const found = await store.findCredential('gotify', 'gotify-secret');
    expect(found?.upstreams).toHaveLength(2);
    await store.addHistory({ source: 'gotify', credentialId: credential.id, upstreamId: one.id, status: 'success', title: 'Alert', content: 'Delivered', mediaType: null, messageId: 'msg_1', error: null });
    const history = await store.listHistory();
    expect(history).toMatchObject([{ status: 'success', credentialName: 'monitor', upstreamName: 'one', messageId: 'msg_1' }]);
    store.close();
  });

  it('locks an IP after five failed login attempts', async () => {
    const store = new Store(':memory:', 'test-encryption-key');
    for (let index = 0; index < 5; index += 1) await store.recordLoginFailure('127.0.0.1');
    const allowed = await store.loginAllowed('127.0.0.1');
    expect(allowed.allowed).toBe(false);
    store.close();
  });

  it('respects custom login failure limit and ban duration', async () => {
    const store = new Store(':memory:', 'test-encryption-key', {
      loginFailLimit: 2,
      loginFailWindowMs: 5000,
      loginBanDurationMs: 10000
    });
    await store.recordLoginFailure('127.0.0.1');
    expect((await store.loginAllowed('127.0.0.1')).allowed).toBe(true);
    await store.recordLoginFailure('127.0.0.1');
    expect((await store.loginAllowed('127.0.0.1')).allowed).toBe(false);
    expect((await store.loginAllowed('127.0.0.1')).retryAfter).toBeGreaterThan(0);
    store.close();
  });

  it('deletes upstreams and cascades their credential bindings', async () => {
    const store = new Store(':memory:', 'test-encryption-key');
    const upstream = await store.addUpstream('delete-me', 'ak_delete');
    await store.createCredential('bound', 'webhook', 'bound-secret', [upstream.id]);
    expect(await store.deleteUpstream(upstream.id)).toBe(true);
    const creds = await store.listCredentials();
    expect(creds[0].upstreamIds).toEqual([]);
    expect(await store.deleteUpstream(upstream.id)).toBe(false);
    store.close();
  });

  it('supports paginated history queries', async () => {
    const store = new Store(':memory:', 'test-encryption-key');
    for (let i = 1; i <= 25; i++) {
      await store.addHistory({ source: 'manual', status: 'success', title: `Msg ${i}`, content: `Content ${i}`, mediaType: null, messageId: `id_${i}`, error: null });
    }
    const page1 = await store.listHistoryPaged(1, 10);
    expect(page1.total).toBe(25);
    expect(page1.page).toBe(1);
    expect(page1.totalPages).toBe(3);
    expect(page1.items).toHaveLength(10);
    expect(page1.items[0].title).toBe('Msg 25');

    const page3 = await store.listHistoryPaged(3, 10);
    expect(page3.items).toHaveLength(5);
    expect(page3.items[4].title).toBe('Msg 1');
    store.close();
  });

  it('supports createStore factory for sqlite', async () => {
    const store = await createStore({
      type: 'sqlite',
      databasePath: ':memory:',
      encryptionKey: 'test-encryption-key'
    });
    expect(store).toBeInstanceOf(SqliteStore);
    await store.setSetting('test_key', 'test_val');
    expect(await store.getSetting('test_key')).toBe('test_val');
    store.close();
  });

  it('reads and updates rate limit msg settings', async () => {
    const store = new Store(':memory:', 'test-encryption-key');
    const settings = await store.getSecuritySettings();
    expect(settings.rateLimitMsgMinMax).toBe(10);
    expect(settings.rateLimitMsgHourMax).toBe(0);
    expect(settings.rateLimitMsgDayMax).toBe(0);
    expect(settings.rateLimitMsgMinIntervalSec).toBe(0);

    await store.updateSecuritySettings({
      rateLimitMsgMinMax: 20,
      rateLimitMsgHourMax: 50,
      rateLimitMsgDayMax: 100
    });
    const updated = await store.getSecuritySettings();
    expect(updated.rateLimitMsgMinMax).toBe(20);
    expect(updated.rateLimitMsgHourMax).toBe(50);
    expect(updated.rateLimitMsgDayMax).toBe(100);
    store.close();
  });
});
