export interface QueueItem {
  id: string;
  execute: () => Promise<void>;
}

export class DispatchQueue {
  private queue: QueueItem[] = [];
  private sentTimestamps: number[] = [];
  private timer?: NodeJS.Timeout;
  private processing = false;
  private closed = false;
  private idleResolvers: (() => void)[] = [];

  constructor(
    private readonly getLimit: () => number,
    private readonly windowMs: number = 60_000
  ) {}

  get length(): number {
    return this.queue.length;
  }

  get isProcessing(): boolean {
    return this.processing;
  }

  recordSent(timestamp: number = Date.now()): void {
    this.sentTimestamps.push(timestamp);
  }

  canSendNow(): boolean {
    if (this.closed) return false;
    if (this.queue.length > 0) return false; // maintain strict FIFO
    const limit = this.getLimit();
    if (limit <= 0) return true;
    this.pruneTimestamps(Date.now());
    return this.sentTimestamps.length < limit;
  }

  enqueue(item: QueueItem): void {
    if (this.closed) throw new Error('Queue is closed');
    this.queue.push(item);
    this.scheduleNext();
  }

  private pruneTimestamps(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.sentTimestamps.length > 0 && this.sentTimestamps[0] <= cutoff) {
      this.sentTimestamps.shift();
    }
  }

  private scheduleNext(): void {
    if (this.closed || this.processing || this.queue.length === 0) {
      this.checkIdle();
      return;
    }

    const now = Date.now();
    this.pruneTimestamps(now);
    const limit = this.getLimit();

    // If limit <= 0, no limit enforced
    if (limit > 0 && this.sentTimestamps.length >= limit) {
      const earliest = this.sentTimestamps[0];
      const waitMs = Math.max(10, (earliest + this.windowMs) - now);
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          void this.processNext();
        }, waitMs);
      }
      return;
    }

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    void this.processNext();
  }

  private async processNext(): Promise<void> {
    if (this.closed || this.processing || this.queue.length === 0) {
      this.checkIdle();
      return;
    }

    const now = Date.now();
    this.pruneTimestamps(now);
    const limit = this.getLimit();

    if (limit > 0 && this.sentTimestamps.length >= limit) {
      this.scheduleNext();
      return;
    }

    const item = this.queue.shift();
    if (!item) {
      this.checkIdle();
      return;
    }

    this.processing = true;
    this.sentTimestamps.push(Date.now());

    try {
      await item.execute();
    } catch (err) {
      console.error(`Error executing queued message ${item.id}:`, err);
    } finally {
      this.processing = false;
      this.scheduleNext();
    }
  }

  private checkIdle(): void {
    if (this.queue.length === 0 && !this.processing) {
      while (this.idleResolvers.length > 0) {
        const resolve = this.idleResolvers.shift();
        resolve?.();
      }
    }
  }

  async waitForIdle(): Promise<void> {
    if (this.queue.length === 0 && !this.processing) return;
    return new Promise(resolve => this.idleResolvers.push(resolve));
  }

  close(): void {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.queue = [];
    this.checkIdle();
  }
}
