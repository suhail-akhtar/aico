/**
 * The aico server, as a child of the extension host.
 *
 * The extension does not reimplement the agent — it starts `aico serve` in the
 * workspace folder and talks to its HTTP API. That server already owns runs,
 * survives a closed tab, and ships the whole web client, so the extension's job
 * is lifecycle and a few things a webview cannot do.
 *
 * ## The token is read from stdout, not stored
 *
 * `serve` mints a token at startup and prints it once, inside the URL. It is
 * deliberately never written to disk — the process it authorises can run shell
 * commands as you. So this captures it from the child's output and holds it in
 * memory for as long as the child lives, which is exactly as long as it is
 * valid: a restart mints a new one.
 *
 * @module server
 */

import { spawn, type ChildProcess } from 'child_process';
import * as vscode from 'vscode';
import { canonicalFolder } from './paths';

export interface RunningServer {
  url: string;
  port: number;
  token: string;
}

/** Where the URL line appears in `serve` output, and what it looks like. */
const URL_LINE = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+)/;

/** How long to wait for that line before giving up on the child. */
const READY_TIMEOUT_MS = 90_000;

/** How long a stopping server gets to flush its logs before it is forced. */
const STOP_GRACE_MS = 4_000;

export class ServerManager implements vscode.Disposable {
  private child: ChildProcess | undefined;
  private running: RunningServer | undefined;
  /** In flight, so two commands at once do not start two servers. */
  private starting: Promise<RunningServer> | undefined;

  constructor(private readonly output: vscode.OutputChannel) {}

  current(): RunningServer | undefined {
    return this.running;
  }

  /**
   * Start it, or hand back the one already running.
   *
   * The concurrency guard matters more than it looks: clicking the status bar
   * while the panel is opening would otherwise spawn a second server, and the
   * second one would take the port the first was about to bind.
   */
  async ensure(): Promise<RunningServer> {
    if (this.running) return this.running;
    if (this.starting) return this.starting;

    this.starting = this.start().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async start(): Promise<RunningServer> {
    const config = vscode.workspace.getConfiguration('aico');
    const command = config.get<string>('command', 'aico');
    const extraArgs = config.get<string[]>('args', []);
    const port = config.get<number>('port', 0);

    /*
      Run where the user is working.

      Without this the agent runs in whatever directory the extension host was
      launched from, which is rarely the project — the same class of bug that
      made every cron job write its files into the wrong folder.
    */
    /*
      Canonicalised, because `uri.fsPath` lowercases the Windows drive letter and
      aico's project registry compares paths as strings. Started as `e:\work` the
      server files its sessions under a project the terminal calls `E:\work`, and
      the same repository quietly becomes two. See `paths.ts`.
    */
    const raw = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!raw) {
      throw new Error('Open a folder first — aico runs against a project directory.');
    }
    const cwd = canonicalFolder(raw);

    /*
      `--project` is the important one.

      Without it a web session falls back to aico's scratch workspace rather
      than the folder you have open, and every `Read` of a project file is
      refused for being outside the run's roots — while `Bash`, which is not
      path-confined, keeps working. That combination is a confusing way to look
      broken, and it is exactly what happened the first time this ran.

      The fallback is right for a browser reaching a portal that has been up for
      days; it is wrong here, because this server was started for this folder
      moments ago.
    */
    const args = [...extraArgs, 'serve', '--no-open', '--project', cwd];
    /*
      Port 0 means "leave it alone", not "pass 0".

      Without `--port`, `serve` tries its default and falls back to a free one
      if that is taken — which is the behaviour wanted here, because an aico
      already running in a terminal is the common case for someone who also
      installs the extension. Passing an explicit port instead makes a clash
      fail loudly, which is right when a person chose the number and wrong when
      nobody did.
    */
    if (port > 0) args.push('--port', String(port));

    this.output.appendLine(`$ ${command} ${args.join(' ')}`);
    this.output.appendLine(`  in ${cwd}`);

    const child = spawn(command, args, {
      cwd,
      // A shell on Windows so a `.cmd` shim — which is what npm installs — can
      // be executed at all. The command is quoted below for the same reason
      // aico's own MCP client has to: `shell: true` joins without quoting, and
      // the default Node install path contains a space.
      shell: process.platform === 'win32',
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    this.child = child;

    return new Promise<RunningServer>((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error, server?: RunningServer): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err); else resolve(server!);
      };

      const timer = setTimeout(() => {
        finish(new Error(
          `aico did not report a URL within ${READY_TIMEOUT_MS / 1000}s. `
          + 'Check the server log (aico: Show Server Log).',
        ));
      }, READY_TIMEOUT_MS);

      const read = (chunk: Buffer): void => {
        const text = chunk.toString();
        // Everything the child says goes to the log. The token is in there, and
        // that is a deliberate trade: the log is local, and a server whose
        // startup failure is invisible is far worse to debug.
        this.output.append(text);
        const match = URL_LINE.exec(text);
        if (match && !settled) {
          const server = {
            url: match[0],
            port: Number(match[1]),
            token: match[2],
          };
          this.running = server;
          finish(undefined, server);
        }
      };

      child.stdout?.on('data', read);
      child.stderr?.on('data', read);

      child.on('error', (err) => {
        this.running = undefined;
        finish(new Error(
          `Could not run "${command}". Install aico, or set aico.command to its path. (${err.message})`,
        ));
      });

      child.on('exit', (code) => {
        this.output.appendLine(`\n[server exited with code ${code ?? 'unknown'}]`);
        this.running = undefined;
        this.child = undefined;
        finish(new Error(
          `aico exited before it was ready (code ${code ?? 'unknown'}). `
          + 'See the server log for why.',
        ));
      });
    });
  }

  /** A request to the running server, with the token attached. */
  async api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const server = await this.ensure();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-aico-token': server.token,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    if (!res.ok) {
      throw new Error(`aico API ${path} failed: HTTP ${res.status}`);
    }
    return res.json() as Promise<T>;
  }

  /**
   * Stop the server, and mean it.
   *
   * `child.kill()` is not enough on Windows, and the probe caught it: with
   * `shell: true` the pid held here belongs to `cmd.exe`, not to the node
   * process it launched. Killing the shell orphans the server, which then keeps
   * its port, keeps its session, and keeps running an agent with nothing
   * watching it. The port was still answering after `stop()` returned.
   *
   * `shell: true` cannot simply be dropped — a global npm install of aico on
   * Windows is `aico.cmd`, and Node has refused to execute `.cmd` without a
   * shell since the 2024 argument-injection fix. So the tree is killed instead,
   * which is what aico's own backgrounded-command handling already does.
   *
   * Graceful first, forced after a grace period: the server flushes session
   * logs on the way out, and losing a turn's transcript to an immediate hard
   * kill is a real cost.
   */
  stop(): void {
    const child = this.child;
    if (!child) return;
    const pid = child.pid;
    this.output.appendLine('\n[stopping server]');
    this.child = undefined;
    this.running = undefined;

    if (pid === undefined) return;

    if (process.platform === 'win32') {
      // No /F yet: this asks the tree to close.
      spawn('taskkill', ['/pid', String(pid), '/T'], { stdio: 'ignore' })
        .on('error', () => { /* taskkill missing is not worth surfacing */ });
    } else {
      // Negative pid signals the whole group, which is what a shell wrapper
      // makes necessary here too.
      try { process.kill(-pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
    }

    const force = setTimeout(() => {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
          .on('error', () => { /* already gone */ });
      } else {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }, STOP_GRACE_MS);
    // Never hold the extension host open waiting to kill something.
    force.unref?.();
    child.once('exit', () => clearTimeout(force));
  }

  dispose(): void {
    this.stop();
  }
}
