/**
 * The desktop sandbox: start an application and read and drive its window
 * through the operating system's accessibility tree.
 *
 * Windows only (UI Automation, desktop-worker.ts). Starting it on another
 * platform fails with a message saying so, rather than returning an observation
 * it could not have made; macOS (AXUIElement) and Linux (AT-SPI) are separate
 * workers that are not built (ADR 0041).
 *
 * An observation is what a person perceives: the window title, the outline of
 * the accessibility tree (roles, names, values, disabled state), the visible
 * text, the interactive controls with selectors that find them again, the
 * layout boxes of the main regions, the dominant colours measured from a
 * screenshot, and the screenshot itself (corpus only, never in the spec). The
 * stimuli are the same ones a page takes (`click`, `fill`, `press`, `wait`), so
 * the explorer and the twin-test treat a window like a page.
 *
 * Custom-drawn surfaces (a game, a canvas, many Electron regions) expose little
 * or nothing in the tree; for those the screenshot and the layout boxes are all
 * there is, and the spec says the tree was empty.
 *
 * @module cleanroom/sandbox-desktop
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DESKTOP_WORKER } from './desktop-worker.js';
import { decodePng } from './pixel.js';
import type { Control, LaunchSpec, Observation, Sandbox, StateFingerprint, Stimulus, StyleFacts } from './types.js';

type DesktopSpec = Extract<LaunchSpec, { kind: 'desktop' }>;
interface Reply { id?: number; event?: string; ok?: boolean; error?: string; [k: string]: unknown }

export class DesktopSandbox implements Sandbox {
  readonly kind = 'desktop' as const;
  private spec!: DesktopSpec;
  private app?: ChildProcess;
  private worker?: ChildProcess;
  private scratch = '';
  private nextId = 1;
  private waiting = new Map<number, (r: Reply) => void>();
  private events: Reply[] = [];
  private buf = '';
  private error?: string;

  async start(spec: LaunchSpec): Promise<void> {
    if (spec.kind !== 'desktop') throw new Error('DesktopSandbox starts a desktop target');
    if (process.platform !== 'win32') throw new Error('desktop automation is built for Windows (UI Automation). macOS (AXUIElement) and Linux (AT-SPI) adapters are not built.');
    this.spec = spec;
    const app = spawn(spec.command, spec.args ?? [], { cwd: spec.cwd, env: { ...process.env, ...spec.env }, stdio: 'ignore', windowsHide: false });
    this.app = app;
    app.on('error', e => { this.error = e.message; });
    if (!app.pid) throw new Error(`could not start ${spec.command}`);
    this.scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanroom-desktop-'));
    const script = path.join(this.scratch, 'worker.ps1');
    fs.writeFileSync(script, '﻿' + DESKTOP_WORKER); // a BOM so Windows PowerShell reads it as UTF-8
    const worker = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script, String(app.pid), spec.windowTitle ?? ''], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.worker = worker;
    let stderr = '';
    worker.stderr.on('data', d => { if (stderr.length < 4000) stderr += d; });
    worker.stdout.on('data', d => this.onData(String(d)));
    worker.on('close', () => { for (const [id, f] of this.waiting) f({ id, ok: false, error: 'the automation worker exited' }); this.waiting.clear(); });
    const ready = await this.waitEvent(['ready', 'load-failed'], (spec.timeoutMs ?? 25_000) + 5000);
    if (!ready) throw new Error(`the application's window was not found in time${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}`);
    if (ready.event === 'load-failed') throw new Error(String(ready.error));
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let m: Reply;
      try { m = JSON.parse(line) as Reply; } catch { continue; }
      if (m.id !== undefined && this.waiting.has(m.id)) { const f = this.waiting.get(m.id)!; this.waiting.delete(m.id); f(m); }
      else if (m.event) this.events.push(m);
    }
  }

  private async waitEvent(names: string[], ms: number): Promise<Reply | undefined> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const e = this.events.find(x => names.includes(x.event ?? ''));
      if (e) return e;
      if (this.worker && this.worker.exitCode !== null) return this.events.find(x => names.includes(x.event ?? ''));
      await new Promise(r => setTimeout(r, 50));
    }
    return undefined;
  }

  private rpc(msg: Record<string, unknown>, ms = 20_000): Promise<Reply> {
    return new Promise(resolve => {
      const id = this.nextId++;
      const timer = setTimeout(() => { this.waiting.delete(id); resolve({ id, ok: false, error: `the automation worker did not answer within ${ms / 1000}s` }); }, ms);
      this.waiting.set(id, r => { clearTimeout(timer); resolve(r); });
      this.worker!.stdin!.write(JSON.stringify({ id, ...msg }) + '\n');
    });
  }

  async inject(s: Stimulus): Promise<void> {
    this.error = undefined;
    let r: Reply | undefined;
    if (s.type === 'click') r = await this.rpc({ op: 'click', selector: s.selector });
    else if (s.type === 'fill') r = await this.rpc({ op: 'fill', selector: s.selector, value: s.value });
    else if (s.type === 'press') r = await this.rpc({ op: 'press', key: s.key });
    else if (s.type === 'wait') { await new Promise(res => setTimeout(res, Math.min(s.ms, 30_000))); }
    else throw new Error(`a desktop target cannot take a "${s.type}" stimulus`);
    if (r && !r.ok) this.error = String(r.error ?? 'the action failed'); // a selector that no longer matches is information about the app
    await new Promise(res => setTimeout(res, 350)); // time for the window to react
  }

  async observe(): Promise<Observation> {
    const tree = await this.rpc({ op: 'tree' });
    const shot = await this.rpc({ op: 'shot' });
    if (!tree.ok) return { at: new Date().toISOString(), kind: 'desktop', error: String(tree.error ?? 'the window could not be read') };
    const asArray = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : v ? [v as T] : []);
    const controls = asArray<Control>(tree.controls).map(c => ({ ...c, ...(c.inputType === null ? { inputType: undefined } : {}) }));
    const frame = shot.ok && typeof shot.png === 'string' ? new Uint8Array(Buffer.from(shot.png, 'base64')) : undefined;
    const layout = asArray<StyleFacts['layout'][number]>(tree.layout);
    const style: StyleFacts = {
      colors: { background: frame ? dominantColors(frame, 4) : [], text: [], accent: [] },
      fonts: [], fontSizes: [], radii: [], spacing: [], layout, viewport: { width: Number(tree.width) || 0, height: Number(tree.height) || 0 },
    };
    return {
      at: new Date().toISOString(), kind: 'desktop', title: String(tree.title ?? ''), tree: String(tree.tree ?? ''), text: String(tree.text ?? ''),
      controls, style, ...(frame ? { frame } : {}), ...(this.error ? { error: this.error } : {}),
    };
  }

  async snapshot(): Promise<StateFingerprint> {
    const t = await this.rpc({ op: 'tree' });
    return createHash('sha256').update(`${t.title ?? ''}\n${String(t.tree ?? '').replace(/\d{1,2}:\d{2}(:\d{2})?/g, '<time>')}`).digest('hex').slice(0, 16);
  }

  async stop(): Promise<void> {
    const kill = (c?: ChildProcess): void => { if (c?.pid && c.exitCode === null) spawnSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { windowsHide: true }); };
    kill(this.worker); kill(this.app);
    this.worker = this.app = undefined;
    await new Promise(r => setTimeout(r, 100));
    if (this.scratch) { try { fs.rmSync(this.scratch, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp */ } this.scratch = ''; }
  }
}

/** The most common colours in a screenshot, quantised so anti-aliasing does not split one colour into hundreds. */
export function dominantColors(png: Uint8Array, n: number): string[] {
  const r = decodePng(png);
  if ('error' in r) return [];
  const counts = new Map<string, number>();
  for (let i = 0; i < r.width * r.height; i += 3) {
    const q = (v: number): number => Math.round(v / 17) * 17;
    const k = `${q(r.rgb[i * 3]!)},${q(r.rgb[i * 3 + 1]!)},${q(r.rgb[i * 3 + 2]!)}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => `rgb(${k.split(',').join(', ')})`);
}
