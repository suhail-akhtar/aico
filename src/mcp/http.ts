import fetch from 'node-fetch';
import { McpBaseClient, type McpServerConfigV2, type McpHealthStatus } from './base.js';

/**
 * MCP HTTP transport — communicates via stateless POST requests.
 * Each JSON-RPC call is a single POST to the server URL.
 */
export class McpHttpClient extends McpBaseClient {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private msgId = 1;
  private _healthy = true;
  private _lastError?: string;

  constructor(config: McpServerConfigV2) {
    super();
    if (!config.url) throw new Error('McpHttpClient requires config.url');
    this.url = config.url;
    this.headers = {
      'Content-Type': 'application/json',
      ...(config.headers ?? {}),
    };
  }

  isAlive(): boolean {
    return this._healthy;
  }

  getHealth(): McpHealthStatus {
    return this._healthy ? 'healthy' : 'degraded';
  }

  async send(method: string, params?: unknown): Promise<unknown> {
    const id = this.msgId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);

    try {
      const resp = await fetch(this.url, {
        method: 'POST',
        headers: this.headers,
        body,
        signal: controller.signal as unknown as globalThis.AbortSignal,
      });

      if (!resp.ok) {
        throw new Error(`MCP HTTP ${resp.status}: ${resp.statusText}`);
      }

      const json = (await resp.json()) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
      };

      if (json.error) {
        throw new Error(json.error.message);
      }

      this._healthy = true;
      return json.result;
    } catch (err) {
      this._healthy = false;
      this._lastError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  stop(): void {
    this._healthy = false;
  }
}
