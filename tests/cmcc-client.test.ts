import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { describe, expect, it } from 'vitest';
import { CmccClientPool } from '../src/cmcc-client.js';

describe('CMCC WebSocket protocol', () => {
  it('sends the API key header, OpenClaw-compatible version, and media payload', async () => {
    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>(resolve => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    const received = new Promise<{ header: string | undefined; auth: any; message: any }>(resolve => {
      server.once('connection', (socket, request) => {
        const header = request.headers['x-api-key'];
        socket.once('message', authData => {
          const auth = JSON.parse(authData.toString());
          socket.send(JSON.stringify({ type: 'auth_ok' }));
          socket.once('message', messageData => resolve({ header, auth, message: JSON.parse(messageData.toString()) }));
        });
      });
    });
    const pool = new CmccClientPool(`ws://127.0.0.1:${port}`, '2.0', 2000);

    try {
      await pool.send(
        { apiKey: 'ak_protocol_test' },
        { type: 'send', mediaType: 'IMAGE', mediaUrl: 'https://cdn.example/image.png', content: 'caption' }
      );
      await expect(received).resolves.toMatchObject({
        header: 'ak_protocol_test',
        auth: { type: 'auth', apiKey: 'ak_protocol_test', version: '2.0' },
        message: {
          type: 'send',
          apiKey: 'ak_protocol_test',
          mediaType: 'IMAGE',
          mediaUrl: 'https://cdn.example/image.png',
          content: 'caption'
        }
      });
    } finally {
      pool.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
