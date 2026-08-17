import fetch from 'node-fetch';
import { McpBaseClient, type McpServerConfigV2, type McpHealthStatus } from './base.js';

/**
 * MCP SSE transport — uses Server-Sent Events for server→client streaming
 * and POST for client→server requests. Auto-reconnects on disconnect.
 */
export class McpSseClient extends McpBaseClient {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private msgId = 1;
  private _healthy = false;
  private _stopped = false;
  private _pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
  }>();
  private _sseBuffer = '';
  private _reconnectTimer?: ReturnType<typeof setTimeout>;
  private _reconnectAttempts = 0;

  constructor(config: McpServerConfigV2) {
    super();
    if (!config.url) throw new Error('McpSseClient requires config.url');
    this.url = config.url;
    this.headers = {
      'Content-Type': 'application/json',
      ...(config.headers ?? {}),
    };
    void this._connect();
  }

  private async _connect(): Promise<void> {
    if (this._stopped) return;

    try {
      const resp = await fetch(this.url, {
        method: 'GET',
        headers: { ...this.headers, Accept: 'text/event-stream' },
      });

      if (!resp.ok || !resp.body) {
        throw new Error(`SSE connect failed: ${resp.status}`);
      }

      this._healthy = true;
      this._reconnectAttempts = 0;
      this._sseBuffer = '';

      resp.body.on('data', (chunk: Buffer) => this._handleSseChunk(chunk.toString()));
      resp.body.on('end', () => {
        this._healthy = false;
        if (!this._stopped) this._scheduleReconnect();
      });
      resp.body.on('error', () => {
        this._healthy = false;
        if (!this._stopped) this._scheduleReconnect();
      });
    } catch {
      this._healthy = false;
      if (!this._stopped) this._scheduleReconnect();
    }
  }

  private _scheduleReconnect(): void {
    if (this._stopped) return;
    const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts), 30_000);
    this._reconnectAttempts++;
    this._reconnectTimer = setTimeout(() => { void this._connect(); }, delay);
  }

  private _handleSseChunk(chunk: string): void {
    this._sseBuffer += chunk;
    const events = this._sseBuffer.split('\n\n');
    this._sseBuffer = events.pop() ?? '';

    for (const event of events) {
      const lines = event.split('\n');
      let data = '';
      for (const line of lines) {
        if (line.startsWith('data: ')) data += line.slice(6);
      }
      if (!data) continue;
      try {
        const msg = JSON.parse(data) as {
          id?: number;
          result?: unknown;
          error?: { message: string };
        };
        if (msg.id === undefined) continue;
        const pending = this._pendingRequests.get(msg.id);
        if (pending) {
          this._pendingRequests.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(msg.error.message));
          } else {
            pending.resolve(msg.result);
          }
        }
      } catch {
        // Ignore malformed SSE data
      }
    }
  }

  isAlive(): boolean {
    return this._healthy && !this._stopped;
  }

  getHealth(): McpHealthStatus {
    if (this._stopped) return 'disconnected';
    return this._healthy ? 'healthy' : 'degraded';
  }

  async send(method: string, params?: unknown): Promise<unknown> {
    const id = this.msgId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);

    return new Promise((resolve, reject) => {
      this._pendingRequests.set(id, { resolve, reject });

      fetch(this.url, {
        method: 'POST',
        headers: this.headers,
        body,
        signal: controller.signal as unknown as globalThis.AbortSignal,
      })
        .then((resp) => {
          if (!resp.ok) {
            this._pendingRequests.delete(id);
            reject(new Error(`SSE POST ${resp.status}: ${resp.statusText}`));
          }
          // Response comes via SSE stream — no body needed here
        })
        .catch((err) => {
          this._pendingRequests.delete(id);
          reject(err instanceof Error ? err : new Error(String(err)));
        })
        .finally(() => clearTimeout(timer));

      // Safety timeout for the pending request
      setTimeout(() => {
        if (this._pendingRequests.has(id)) {
          this._pendingRequests.delete(id);
          reject(new Error(`SSE response timeout: ${method}`));
        }
      }, 30_000);
    });
  }

  stop(): void {
    this._stopped = true;
    this._healthy = false;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    for (const { reject } of this._pendingRequests.values()) {
      reject(new Error('McpSseClient stopped'));
    }
    this._pendingRequests.clear();
  }
}
