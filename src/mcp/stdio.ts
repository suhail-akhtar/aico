import { spawn, ChildProcess } from 'child_process';
import { McpBaseClient, type McpServerConfigV2, type McpHealthStatus } from './base.js';

interface JsonRpcPendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

/**
 * MCP stdio transport — spawns a child process and communicates via JSON-RPC over
 * stdin/stdout. Lifted from the original McpClient in src/mcp.ts.
 */
export class McpStdioClient extends McpBaseClient {
  private proc: ChildProcess;
  private pendingRequests = new Map<number, JsonRpcPendingRequest>();
  private msgId = 1;
  private buffer = '';
  private _dead = false;

  constructor(config: McpServerConfigV2) {
    super();
    if (!config.command) throw new Error('McpStdioClient requires config.command');

    this.proc = spawn(config.command, config.args ?? [], {
      env: { ...process.env, ...(config.env ?? {}) } as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    this.proc.stdout!.on('data', (chunk: Buffer) => this.handleData(chunk.toString()));
    this.proc.stderr!.on('data', () => { /* silently consume */ });

    this.proc.on('error', (err) => {
      this._dead = true;
      for (const { reject } of this.pendingRequests.values()) {
        reject(new Error(`MCP process error: ${err.message}`));
      }
      this.pendingRequests.clear();
    });

    this.proc.on('exit', () => {
      this._dead = true;
      for (const { reject } of this.pendingRequests.values()) {
        reject(new Error('MCP process exited unexpectedly'));
      }
      this.pendingRequests.clear();
    });
  }

  private handleData(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as {
          id?: number;
          result?: unknown;
          error?: { message: string };
        };
        if (msg.id === undefined) continue;
        const resolver = this.pendingRequests.get(msg.id);
        if (resolver) {
          this.pendingRequests.delete(msg.id);
          if (msg.error) {
            resolver.reject(new Error(msg.error.message));
          } else {
            resolver.resolve(msg.result);
          }
        }
      } catch {
        // Ignore malformed JSON lines
      }
    }
  }

  isAlive(): boolean {
    return !this._dead && !this.proc.killed && this.proc.exitCode === null;
  }

  getHealth(): McpHealthStatus {
    return this.isAlive() ? 'healthy' : 'disconnected';
  }

  async send(method: string, params?: unknown): Promise<unknown> {
    if (!this.isAlive()) {
      throw new Error(`MCP server process is dead (exit code: ${this.proc.exitCode})`);
    }

    const id = this.msgId++;
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      const message = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }) + '\n';

      try {
        this.proc.stdin!.write(message);
      } catch (err) {
        this.pendingRequests.delete(id);
        reject(new Error(`MCP stdin write failed: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }

      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`MCP timeout: ${method}`));
        }
      }, 30_000);
    });
  }

  stop(): void {
    this._dead = true;
    try { this.proc.kill(); } catch { /* already dead */ }
  }
}
