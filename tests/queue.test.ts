import { describe, expect, it } from 'vitest';
import { DispatchQueue } from '../src/queue.js';

describe('DispatchQueue unit tests', () => {
  it('dispatches messages immediately when under the limit', async () => {
    const executed: string[] = [];
    const queue = new DispatchQueue(() => 10, 60_000);

    queue.enqueue({
      id: 'msg_1',
      execute: async () => { executed.push('msg_1'); }
    });
    queue.enqueue({
      id: 'msg_2',
      execute: async () => { executed.push('msg_2'); }
    });

    await queue.waitForIdle();
    expect(executed).toEqual(['msg_1', 'msg_2']);
    queue.close();
  });

  it('queues messages when exceeding the limit and releases them as window slides', async () => {
    const executed: { id: string; time: number }[] = [];
    // Limit to 2 per 100ms window
    const windowMs = 100;
    const queue = new DispatchQueue(() => 2, windowMs);
    const start = Date.now();

    for (let i = 1; i <= 4; i++) {
      queue.enqueue({
        id: `msg_${i}`,
        execute: async () => {
          executed.push({ id: `msg_${i}`, time: Date.now() });
        }
      });
    }

    // Immediately after enqueueing, 2 should have been picked up/processed, 2 should be in queue
    await queue.waitForIdle();

    expect(executed).toHaveLength(4);
    expect(executed.map(e => e.id)).toEqual(['msg_1', 'msg_2', 'msg_3', 'msg_4']);
    // msg_3 must have been delayed by at least ~windowMs
    expect(executed[2].time - start).toBeGreaterThanOrEqual(windowMs - 20);
    queue.close();
  });

  it('handles execution errors gracefully and continues processing', async () => {
    const executed: string[] = [];
    const queue = new DispatchQueue(() => 10, 1000);

    queue.enqueue({
      id: 'msg_fail',
      execute: async () => { throw new Error('simulated failure'); }
    });
    queue.enqueue({
      id: 'msg_ok',
      execute: async () => { executed.push('msg_ok'); }
    });

    await queue.waitForIdle();
    expect(executed).toEqual(['msg_ok']);
    queue.close();
  });
});
