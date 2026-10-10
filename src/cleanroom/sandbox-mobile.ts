/**
 * The mobile sandbox: an Android app on a device or emulator, through adb.
 *
 * Everything is the stock Android debug bridge, so it works on a physical
 * phone, the Android Emulator or any emulator that exposes adb (Corellium's
 * Android devices do):
 *  - the **accessibility tree**: `uiautomator dump`, an XML of every view with
 *    its class, text, resource id, content description, bounds and whether it
 *    is clickable, enabled, scrollable, checkable;
 *  - a **frame**: `screencap -p`;
 *  - **touch and keys**: `input tap`, `input swipe`, `input text`,
 *    `input keyevent` (Back, Home, Enter ...);
 *  - **system events**: rotation (`settings put system user_rotation`),
 *    backgrounding (Home) and resuming (relaunch to the front), deep links
 *    (`am start -a VIEW -d`), runtime permissions (`pm grant`/`revoke`) and
 *    posted notifications (`cmd notification post`, Android 10+).
 *
 * The explorer treats a screen like a page. To make it exercise the system
 * events too, every observation carries a few pseudo-controls with `sys:`
 * selectors (Back, rotate, background and resume), clicked like any button.
 *
 * What adb cannot observe, and the spec says so: haptics, whether a push
 * notification was delivered to the app, multi-touch (a pinch needs a
 * different injection path), and anything drawn outside the app (system
 * sheets). `adb` may name a command with arguments, so a wrapper or a test
 * double can stand in for it.
 *
 * iOS is not built: a simulator needs macOS and Xcode (`simctl`, XCUITest) and a
 * real device or Corellium needs their tooling; the sandbox refuses it by name.
 * **Not run against a real device or emulator in this repository's tests**: it
 * is built on adb's documented behaviour and exercised against a simulated adb
 * that records every command (scripts/fixtures/fake-adb.mjs); the first live
 * run is the real check.
 *
 * @module cleanroom/sandbox-mobile
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dominantColors } from './sandbox-desktop.js';
import type { Control, LaunchSpec, Observation, Sandbox, StateFingerprint, Stimulus, StyleFacts } from './types.js';

type MobileSpec = Extract<LaunchSpec, { kind: 'mobile' }>;

export interface UiNode { depth: number; cls: string; text: string; id: string; desc: string; pkg: string; bounds: [number, number, number, number]; clickable: boolean; enabled: boolean; scrollable: boolean; checkable: boolean; checked: boolean; password: boolean; focused: boolean }

const attr = (tag: string, name: string): string => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? m[1]!.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#10;/g, '\n') : '';
};

/** The view hierarchy from a `uiautomator dump`: a flat list of nodes with their depth. */
export function parseUiXml(xml: string): UiNode[] {
  const out: UiNode[] = [];
  let depth = -1;
  for (const m of xml.matchAll(/<node\b[^>]*?(\/?)>|<\/node>/g)) {
    if (m[0] === '</node>') { depth--; continue; }
    depth++;
    const tag = m[0];
    const b = /bounds="\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]"/.exec(tag);
    out.push({
      depth, cls: attr(tag, 'class'), text: attr(tag, 'text'), id: attr(tag, 'resource-id'), desc: attr(tag, 'content-desc'), pkg: attr(tag, 'package'),
      bounds: b ? [Number(b[1]), Number(b[2]), Number(b[3]), Number(b[4])] : [0, 0, 0, 0],
      clickable: attr(tag, 'clickable') === 'true', enabled: attr(tag, 'enabled') !== 'false', scrollable: attr(tag, 'scrollable') === 'true',
      checkable: attr(tag, 'checkable') === 'true', checked: attr(tag, 'checked') === 'true', password: attr(tag, 'password') === 'true', focused: attr(tag, 'focused') === 'true',
    });
    if (m[1] === '/') depth--; // a self-closing node has no end tag
  }
  return out;
}

const KEYS: Record<string, number> = { Back: 4, Home: 3, Enter: 66, Return: 66, Tab: 61, Escape: 111, Esc: 111, Backspace: 67, Delete: 112, ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22, Menu: 82, Search: 84, VolumeUp: 24, VolumeDown: 25, Space: 62 };

/** Quote one argument for the device shell. */
const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

function splitCommand(cmd: string): string[] {
  return cmd.match(/"[^"]*"|\S+/g)?.map(p => p.replace(/^"|"$/g, '')) ?? [cmd];
}

const short = (cls: string): string => cls.split('.').pop() ?? cls;
const center = (b: UiNode['bounds']): [number, number] => [Math.round((b[0] + b[2]) / 2), Math.round((b[1] + b[3]) / 2)];

export class MobileSandbox implements Sandbox {
  readonly kind = 'mobile' as const;
  private spec!: MobileSpec;
  private adbCmd: string[] = ['adb'];
  private landscape = false;
  private error?: string;
  private lastTitle = '';

  private run(args: string[], binary = false, ms = 30_000): Promise<{ code: number | null; out: Buffer; err: string }> {
    return new Promise(resolve => {
      const base = [...this.adbCmd.slice(1), ...(this.spec.serial ? ['-s', this.spec.serial] : []), ...args];
      const child = spawn(this.adbCmd[0]!, base, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const chunks: Buffer[] = []; let err = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); err += '\n[adb timed out]'; }, ms);
      child.stdout.on('data', (d: Buffer) => chunks.push(d));
      child.stderr.on('data', d => { if (err.length < 2000) err += d; });
      child.on('error', e => { err += `\n[could not run adb: ${e.message}]`; });
      child.on('close', code => { clearTimeout(timer); resolve({ code, out: Buffer.concat(chunks), err }); });
      void binary;
    });
  }
  private async sh(cmd: string): Promise<string> { const r = await this.run(['shell', cmd]); return r.out.toString('utf8'); }

  async start(spec: LaunchSpec): Promise<void> {
    if (spec.kind !== 'mobile') throw new Error('MobileSandbox starts a mobile target');
    if ((spec.platform ?? 'android') === 'ios') throw new Error('iOS is not built: a simulator needs macOS with Xcode (simctl, XCUITest), and a real device or Corellium needs their own tooling. Android is supported through adb.');
    this.spec = spec;
    this.adbCmd = splitCommand(spec.adb ?? process.env.ADB ?? 'adb');
    const st = await this.run(['get-state'], false, 15_000);
    if (!/device/.test(st.out.toString('utf8'))) throw new Error(`no Android device or emulator is connected (adb get-state said: ${(st.out.toString('utf8') + st.err).trim().slice(0, 160) || 'nothing'}). Start an emulator or plug in a device with USB debugging, then retry (--serial picks one).`);
    await this.launch(true);
    const end = Date.now() + (spec.timeoutMs ?? 20_000);
    while (Date.now() < end) {
      const xml = await this.dump();
      if (xml.includes(`package="${spec.appId}"`)) return;
      await new Promise(r => setTimeout(r, 400));
    }
    throw new Error(`the app ${spec.appId} did not come to the front (is it installed?)`);
  }

  private async launch(fresh: boolean): Promise<void> {
    const id = this.spec.appId;
    if (fresh) await this.sh(`am force-stop ${id}`);
    if (this.spec.activity) await this.sh(`am start -n ${id}/${this.spec.activity}`);
    else await this.sh(`monkey -p ${id} -c android.intent.category.LAUNCHER 1`);
  }

  private async dump(): Promise<string> {
    await this.sh('uiautomator dump /data/local/tmp/cleanroom-ui.xml');
    const r = await this.run(['exec-out', 'cat', '/data/local/tmp/cleanroom-ui.xml']);
    return r.out.toString('utf8');
  }

  /** The element a selector means, in the screen as it is now. */
  private resolve(nodes: UiNode[], selector: string): UiNode | undefined {
    const m = /^(id|text|desc|bounds):(.*)$/s.exec(selector);
    if (!m) return undefined;
    const [, kind, value] = m;
    if (kind === 'id') return nodes.find(n => n.id === value);
    if (kind === 'text') return nodes.find(n => n.text === value && n.clickable) ?? nodes.find(n => n.text === value);
    if (kind === 'desc') return nodes.find(n => n.desc === value);
    return nodes.find(n => n.bounds.join(',') === value);
  }

  async inject(s: Stimulus): Promise<void> {
    this.error = undefined;
    const sh = (c: string): Promise<string> => this.sh(c);
    switch (s.type) {
      case 'wait': await new Promise(r => setTimeout(r, Math.min(s.ms, 30_000))); return;
      case 'click': {
        if (s.selector.startsWith('sys:')) { await this.system(s.selector.slice(4)); break; }
        const n = this.resolve(parseUiXml(await this.dump()), s.selector);
        if (!n) { this.error = `no element matches ${s.selector}`; return; }
        const [x, y] = center(n.bounds);
        await sh(`input tap ${x} ${y}`);
        break;
      }
      case 'fill': {
        const n = this.resolve(parseUiXml(await this.dump()), s.selector);
        if (!n) { this.error = `no element matches ${s.selector}`; return; }
        if (/[^\x20-\x7e]/.test(s.value)) { this.error = 'adb cannot type non-ASCII text into a field'; return; }
        const [x, y] = center(n.bounds);
        await sh(`input tap ${x} ${y}`);
        await sh(`input keyevent 123${' 67'.repeat(Math.max(n.text.length, 1))}`); // end of text, then delete it all
        if (s.value) await sh(`input text ${q(s.value.replace(/ /g, '%s'))}`);
        break;
      }
      case 'press': { const code = KEYS[s.key] ?? (/^\d+$/.test(s.key) ? Number(s.key) : undefined); if (code === undefined) { this.error = `unknown key ${s.key}`; return; } await sh(`input keyevent ${code}`); break; }
      case 'scroll': { const root = parseUiXml(await this.dump())[0]; const [cx, cy] = root ? center(root.bounds) : [540, 960]; await sh(`input swipe ${cx} ${cy} ${cx} ${cy - s.dy} 300`); break; }
      case 'swipe': await sh(`input swipe ${s.x1} ${s.y1} ${s.x2} ${s.y2} ${s.ms ?? 300}`); break;
      case 'rotate': await this.rotate(s.orientation === 'landscape'); break;
      case 'background': await sh('input keyevent 3'); break;
      case 'resume': await this.launch(false); break;
      case 'deeplink': await sh(`am start -a android.intent.action.VIEW -d ${q(s.url)} ${this.spec.appId}`); break;
      case 'permission': await sh(`pm ${s.action} ${this.spec.appId} ${s.permission}`); break;
      case 'notify': await sh(`cmd notification post -S bigtext -t ${q(s.title)} cleanroom ${q(s.text)}`); break;
      default: throw new Error(`a mobile target cannot take a "${s.type}" stimulus`);
    }
    await new Promise(r => setTimeout(r, 400)); // time for the screen to settle
  }

  private async rotate(landscape: boolean): Promise<void> {
    this.landscape = landscape;
    await this.sh('settings put system accelerometer_rotation 0');
    await this.sh(`settings put system user_rotation ${landscape ? 1 : 0}`);
  }

  private async system(what: string): Promise<void> {
    if (what === 'back') await this.sh('input keyevent 4');
    else if (what === 'rotate') await this.rotate(!this.landscape);
    else if (what === 'bgresume') { await this.sh('input keyevent 3'); await new Promise(r => setTimeout(r, 400)); await this.launch(false); }
  }

  async observe(): Promise<Observation> {
    const xml = await this.dump();
    const nodes = parseUiXml(xml);
    if (!nodes.length) return { at: new Date().toISOString(), kind: 'mobile', error: 'the screen could not be read (uiautomator returned no hierarchy)', ...(this.error ? {} : {}) };
    const focus = (await this.sh("dumpsys window | grep mCurrentFocus")).match(/\s([\w.]+)\/(\S+?)\}?\s*$/m);
    const activity = focus ? (focus[2]!.startsWith('.') ? focus[2]!.slice(1) : focus[2]!.split('.').pop()!) : '';
    const title = activity || nodes.find(n => n.text)?.text || '';
    this.lastTitle = title;
    const ids = new Map<string, number>();
    for (const n of nodes) if (n.id) ids.set(n.id, (ids.get(n.id) ?? 0) + 1);
    const controls: Control[] = [];
    for (const n of nodes) {
      const edit = /EditText|AutoCompleteTextView/.test(n.cls);
      if (!(n.clickable || edit || n.checkable) || !n.enabled) continue;
      const selector = n.id && ids.get(n.id) === 1 ? `id:${n.id}` : n.text ? `text:${n.text}` : n.desc ? `desc:${n.desc}` : `bounds:${n.bounds.join(',')}`;
      controls.push({ role: edit ? 'textbox' : n.checkable ? 'checkbox' : 'button', name: n.text || n.desc || n.id.split('/').pop() || short(n.cls), selector, ...(edit ? { inputType: n.password ? 'password' : 'text' } : {}), formAction: '' });
    }
    controls.push({ role: 'button', name: 'system: Back', selector: 'sys:back' }, { role: 'button', name: 'system: rotate', selector: 'sys:rotate' }, { role: 'button', name: 'system: background and resume', selector: 'sys:bgresume' });
    const tree = nodes.map(n => `${'  '.repeat(n.depth)}${short(n.cls)}${n.text ? ` "${n.text}"` : ''}${n.desc ? ` [${n.desc}]` : ''}${n.id ? ` #${n.id.split('/').pop()}` : ''}${n.clickable ? ' (clickable)' : ''}${n.enabled ? '' : ' (disabled)'}`).join('\n');
    const root = nodes[0]!;
    const shot = await this.run(['exec-out', 'screencap', '-p']);
    const frame = shot.out.length > 8 ? new Uint8Array(shot.out) : undefined;
    const style: StyleFacts = {
      colors: { background: frame ? dominantColors(frame, 4) : [], text: [], accent: [] }, fonts: [], fontSizes: [], radii: [], spacing: [],
      layout: nodes.filter(n => n.depth <= 3 && n.bounds[2] - n.bounds[0] > 40 && n.bounds[3] - n.bounds[1] > 12).slice(0, 40).map(n => ({ role: short(n.cls).toLowerCase(), x: n.bounds[0], y: n.bounds[1], w: n.bounds[2] - n.bounds[0], h: n.bounds[3] - n.bounds[1] })),
      viewport: { width: root.bounds[2] - root.bounds[0], height: root.bounds[3] - root.bounds[1] },
    };
    return {
      at: new Date().toISOString(), kind: 'mobile', title, tree, text: nodes.filter(n => n.text).map(n => n.text).join(' '), controls, style,
      ...(frame ? { frame } : {}), ...(this.error ? { error: this.error } : {}),
    };
  }

  async snapshot(): Promise<StateFingerprint> {
    const nodes = parseUiXml(await this.dump());
    return createHash('sha256').update(`${this.lastTitle}\n${nodes.map(n => `${n.cls}|${n.text}|${n.id}`).join('\n')}`).digest('hex').slice(0, 16);
  }

  async stop(): Promise<void> {
    if (!this.spec) return;
    try { await this.sh(`am force-stop ${this.spec.appId}`); if (this.landscape) await this.rotate(false); } catch { /* the device may be gone */ }
  }
}
