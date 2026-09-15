import WebSocket from 'ws';
import type { CmccAccount, NativeSendRequest } from './types.js';

class CmccConnection {
  private ws?: WebSocket;
  private connecting?: Promise<void>;
  private reconnectTimer?: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly apiKey: string, private readonly url: string, private readonly version: string) {}

  async ready(timeoutMs: number): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (!this.connecting) this.connecting = this.connect(timeoutMs).finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private connect(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, { rejectUnauthorized: true, headers: { 'X-API-Key': this.apiKey } });
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; ws.terminate(); reject(new Error('CMCC authentication timeout')); } }, timeoutMs);
      ws.once('open', () => ws.send(JSON.stringify({ type: 'auth', apiKey: this.apiKey, version: this.version })));
      ws.on('message', data => {
        let msg: any; try { msg = JSON.parse(data.toString()); } catch { return; }
        if (!settled && msg.type === 'auth_ok') { settled = true; clearTimeout(timer); this.ws = ws; resolve(); }
        else if (!settled && msg.type === 'auth_failed') { settled = true; clearTimeout(timer); ws.close(); reject(new Error(msg.message || 'CMCC authentication failed')); }
      });
      ws.on('close', () => { if (this.ws === ws) this.ws = undefined; if (!this.closed) this.scheduleReconnect(); });
      ws.on('error', () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error('CMCC WebSocket error')); } });
      const heartbeat = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' })); else clearInterval(heartbeat); }, 15000);
      ws.once('close', () => clearInterval(heartbeat));
    });
  }

  private scheduleReconnect() {
    if (!this.reconnectTimer) this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; void this.ready(10000).catch(() => undefined); }, 3000);
  }

  async send(payload: Omit<NativeSendRequest, 'apiKey'>, timeoutMs: number): Promise<string> {
    await this.ready(timeoutMs);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('CMCC WebSocket unavailable');
    const messageId = payload.messageId ?? `msg_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    const body = { ...payload, type: 'send', apiKey: this.apiKey, messageId };
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CMCC send timeout')), timeoutMs);
      this.ws!.send(JSON.stringify(body), error => { clearTimeout(timer); error ? reject(error) : resolve(); });
    });
    return messageId;
  }

  close() { this.closed = true; if (this.reconnectTimer) clearTimeout(this.reconnectTimer); this.ws?.close(); }
}

export class CmccClientPool {
  private readonly connections = new Map<string, CmccConnection>();
  constructor(private readonly url: string, private readonly version: string, private readonly timeoutMs: number) {}
  send(account: CmccAccount, payload: Omit<NativeSendRequest, 'apiKey'>) {
    let connection = this.connections.get(account.apiKey);
    if (!connection) { connection = new CmccConnection(account.apiKey, this.url, this.version); this.connections.set(account.apiKey, connection); }
    return connection.send(payload, this.timeoutMs);
  }
  async verify(apiKey: string): Promise<void> {
    let connection = this.connections.get(apiKey);
    if (!connection) {
      connection = new CmccConnection(apiKey, this.url, this.version);
      this.connections.set(apiKey, connection);
    }
    await connection.ready(this.timeoutMs);
  }
  close() { for (const c of this.connections.values()) c.close(); this.connections.clear(); }
}
