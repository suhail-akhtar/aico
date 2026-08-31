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
  /** The tail of what the server printed, so a failure can say why. */
  private stderrTail = '';

  constructor(config: McpServerConfigV2) {
    super();
    if (!config.command) throw new Error('McpStdioClient requires config.command');

    /*
      Windows needs a shell so `.cmd` shims work — `npx`, `pnpm dlx` and most
      globally installed servers are batch files, which `spawn` cannot execute
      directly. But `shell: true` hands the command and its arguments to
      `cmd.exe` as one joined string *without quoting them*, so anything
      containing a space is split at the space.

      That is not an edge case on Windows: the default Node installation lives
      in `C:\Program Files\nodejs`, so a server configured to run
      `"C:\Program Files\nodejs\node.exe" server.mjs` was executed as
      `C:\Program` with `Files\nodejs\node.exe` as an argument. It failed
      instantly, and the only symptom was "MCP process exited unexpectedly" —
      a message with nothing in it to act on.
    */
    const needsShell = process.platform === 'win32';
    const quote = (value: string): string =>
      needsShell && /\s/.test(value) && !value.startsWith('"') ? `"${value}"` : value;

    this.proc = spawn(quote(config.command), (config.args ?? []).map(quote), {
      env: { ...process.env, ...(config.env ?? {}) } as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: needsShell,
    });

    this.proc.stdout!.on('data', (chunk: Buffer) => this.handleData(chunk.toString()));
    // Kept rather than discarded. A server that will not start says why on
    // stderr — a missing module, a bad key, a port already taken — and that
    // message is the entire content of "it did not work". Throwing it away left
    // every startup failure looking identical.
    this.proc.stderr!.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-2000);
    });

    this.proc.on('error', (err) => {
      this._dead = true;
      for (const { reject } of this.pendingRequests.values()) {
        reject(new Error(`MCP process error: ${err.message}`));
      }
      this.pendingRequests.clear();
    });

    this.proc.on('exit', (code) => {
      this._dead = true;
      const why = this.stderrTail.trim().split('\n').slice(-4).join(' | ').slice(0, 400);
      const detail = `MCP server exited (code ${code ?? 'unknown'})`
        + (why ? `: ${why}` : ' with nothing on stderr — check the command and its arguments');
      for (const { reject } of this.pendingRequests.values()) {
        reject(new Error(detail));
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
