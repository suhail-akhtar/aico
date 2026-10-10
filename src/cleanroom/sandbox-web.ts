/**
 * The web sandbox: a headless browser pointed at a page, driven by stimuli.
 *
 * It reuses what AICO already ships to find a browser (`findBrowser`, the same
 * Chrome/Edge lookup VerifyApp uses) and `playwright-core`, so there is no new
 * dependency and no browser download. Nothing is injected into the page: the
 * target is observed from outside, through its accessibility tree, its text,
 * its controls and its network traffic, which is also what a person could see
 * with the developer tools open.
 *
 * What is recorded per observation: URL and title, the role/name tree
 * (Playwright's aria snapshot), the visible text, the interactive controls with
 * a selector that finds each again (the explorer's menu of things to try), the
 * requests the last stimulus caused with their bodies (capped), and a PNG of the
 * viewport. The PNG stays in the corpus: it is evidence for the twin-test, and
 * it never crosses the spec firewall.
 *
 * The state fingerprint is the path plus a hash of the normalised tree, so the
 * same screen reached twice is one node of the graph while a changed list or a
 * new dialog is another.
 *
 * Deliberately not here: stealth, request throttling, or any gate on what may
 * be opened (ADR 0041). A target that shows a human check or needs a login is
 * handed back to the operator through `error`, the same as any automation.
 *
 * @module cleanroom/sandbox-web
 */

import { createHash } from 'node:crypto';
import type { Control, LaunchSpec, NetworkEvent, Observation, Sandbox, StateFingerprint, StyleFacts, Stimulus } from './types.js';

const BODY_CAP = 100_000;
const TEXT_CAP = 20_000;

type Page = import('playwright-core').Page;
type Browser = import('playwright-core').Browser;

export class WebSandbox implements Sandbox {
  readonly kind = 'web' as const;
  private browser?: Browser;
  private page?: Page;
  private events: NetworkEvent[] = [];
  private error?: string;
  private timeoutMs = 15_000;

  async start(spec: LaunchSpec, signal?: AbortSignal): Promise<void> {
    if (spec.kind !== 'web') throw new Error('WebSandbox starts a web target');
    const { findBrowser } = await import('../tools/verify-app.js');
    const executablePath = findBrowser();
    if (!executablePath) throw new Error('no Chrome or Edge is installed, so there is no browser to drive');
    const { chromium } = await import('playwright-core');
    this.timeoutMs = spec.timeoutMs ?? 15_000;
    this.browser = await chromium.launch({ executablePath, headless: true, timeout: this.timeoutMs });
    const ctx = await this.browser.newContext({ viewport: spec.viewport ?? { width: 1280, height: 800 }, locale: spec.locale ?? 'en-US', serviceWorkers: 'block' });
    this.page = await ctx.newPage();
    this.page.setDefaultTimeout(this.timeoutMs);
    this.page.on('response', res => { void this.capture(res); });
    signal?.addEventListener('abort', () => { void this.stop(); }, { once: true });
    await this.go(spec.url);
  }

  async inject(s: Stimulus): Promise<void> {
    const page = this.page;
    if (!page) throw new Error('the web sandbox is not started');
    this.events = [];
    this.error = undefined;
    try {
      switch (s.type) {
        case 'navigate': await this.go(s.url); break;
        case 'click': await page.locator(s.selector).first().click(); break;
        case 'fill': await page.locator(s.selector).first().fill(s.value); break;
        case 'press': await page.keyboard.press(s.key); break;
        case 'scroll': await page.mouse.wheel(0, s.dy); break;
        case 'wait': await page.waitForTimeout(Math.min(s.ms, 30_000)); break;
        default: throw new Error(`a web target cannot take a "${s.type}" stimulus`);
      }
      await this.quiet();
    } catch (e) {
      // A selector that no longer matches is information about the target, not a crash of the run.
      this.error = e instanceof Error ? e.message.split('\n')[0] : String(e);
    }
  }

  async observe(): Promise<Observation> {
    const page = this.page;
    if (!page) throw new Error('the web sandbox is not started');
    const [title, tree, text, controls, style, frame] = await Promise.all([
      page.title().catch(() => ''),
      page.locator('body').ariaSnapshot().catch(() => ''),
      page.evaluate(`document.body ? document.body.innerText.replace(/\\s+/g, ' ').trim().slice(0, ${TEXT_CAP}) : ''`).catch(() => '') as Promise<string>,
      this.controls(page),
      this.styleFacts(page),
      page.screenshot({ type: 'png' }).catch(() => undefined),
    ]);
    return {
      at: new Date().toISOString(), kind: 'web', url: page.url(), title, tree, text, controls, ...(style ? { style } : {}),
      network: [...this.events], ...(frame ? { frame: new Uint8Array(frame) } : {}), ...(this.error ? { error: this.error } : {}),
    };
  }

  async snapshot(): Promise<StateFingerprint> {
    const page = this.page;
    if (!page) return 'stopped';
    const tree = await page.locator('body').ariaSnapshot().catch(() => '');
    let p = '';
    try { p = new URL(page.url()).pathname; } catch { p = page.url(); }
    return createHash('sha256').update(p + '\n' + normaliseTree(tree)).digest('hex').slice(0, 16);
  }

  async stop(): Promise<void> {
    const b = this.browser;
    this.browser = undefined; this.page = undefined;
    if (b) await b.close().catch(() => { /* already gone */ });
  }

  private async go(url: string): Promise<void> {
    await this.page!.goto(url, { waitUntil: 'load', timeout: this.timeoutMs });
    await this.quiet();
  }

  /** Let the page's own follow-up requests finish; a page that never goes quiet is observed as it is. */
  private async quiet(): Promise<void> {
    await this.page!.waitForLoadState('networkidle', { timeout: 2_000 }).catch(() => { /* chatty page: observe anyway */ });
    await this.page!.waitForTimeout(80);
  }

  private async capture(res: import('playwright-core').Response): Promise<void> {
    try {
      const req = res.request();
      const type = req.resourceType();
      if (!['xhr', 'fetch', 'document'].includes(type)) return;
      const ct = res.headers()['content-type'] ?? '';
      let body: string | undefined;
      if (/json|text|xml|javascript/.test(ct)) body = (await res.text().catch(() => '')).slice(0, BODY_CAP);
      this.events.push({
        method: req.method(), url: req.url(), status: res.status(), contentType: ct.split(';')[0],
        ...(req.postData() ? { requestBody: req.postData()!.slice(0, BODY_CAP) } : {}), ...(body !== undefined ? { responseBody: body } : {}),
      });
    } catch { /* a response that was torn down mid-read: nothing to record */ }
  }

  /** Read the look of the page as numbers: the colours, fonts, sizes, radii and gaps in use, and where the big blocks sit. */
  private async styleFacts(page: Page): Promise<StyleFacts | undefined> {
    const raw = await page.evaluate(`(() => {
      const count = (m, k) => m.set(k, (m.get(k) || 0) + 1);
      const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(e => e[0]);
      const bg = new Map(), tx = new Map(), ac = new Map(), fonts = new Map(), sizes = new Map(), radii = new Map(), gaps = new Map();
      const clear = (c) => !c || c === 'rgba(0, 0, 0, 0)' || c === 'transparent';
      let n = 0;
      for (const el of document.querySelectorAll('body *')) {
        if (++n > 1500) break;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') continue;
        if (!clear(s.backgroundColor)) count(bg, s.backgroundColor);
        if (el.childNodes.length && [...el.childNodes].some(c => c.nodeType === 3 && c.textContent.trim())) { count(tx, s.color); count(fonts, s.fontFamily.split(',')[0].trim().replace(/["']/g, '')); count(sizes, parseFloat(s.fontSize)); }
        if (el.matches('a, button, [role=button]') && !clear(s.backgroundColor)) count(ac, s.backgroundColor);
        const rad = parseFloat(s.borderTopLeftRadius); if (rad > 0) count(radii, rad);
        for (const g of [s.paddingTop, s.paddingLeft, s.marginTop, s.rowGap, s.columnGap]) { const v = parseFloat(g); if (v > 0 && v < 200) count(gaps, v); }
      }
      const layout = [];
      for (const el of document.querySelectorAll('header, nav, main, aside, footer, section, form, [role=banner], [role=navigation], [role=main], [role=dialog]')) {
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 12) continue;
        layout.push({ role: el.getAttribute('role') || el.tagName.toLowerCase(), x: Math.round(r.x), y: Math.round(r.y + scrollY), w: Math.round(r.width), h: Math.round(r.height) });
        if (layout.length >= 40) break;
      }
      return { colors: { background: top(bg, 6), text: top(tx, 4), accent: top(ac, 3) }, fonts: top(fonts, 3), fontSizes: top(sizes, 8).sort((a, b) => a - b), radii: top(radii, 4).sort((a, b) => a - b), spacing: top(gaps, 8).sort((a, b) => a - b), layout, viewport: { width: innerWidth, height: innerHeight } };
    })()`).catch(() => undefined) as StyleFacts | undefined;
    return raw;
  }

  private async controls(page: Page): Promise<Control[]> {
    const raw = await page.evaluate(`(() => {
      const out = [];
      const esc = (s) => String(s).replace(/"/g, '\\\\"');
      const label = (el) => (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.getAttribute('title') || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
      const sel = (el, role, name) => {
        if (el.id) return '#' + CSS.escape(el.id);
        if (el.getAttribute('name')) return el.tagName.toLowerCase() + '[name="' + esc(el.getAttribute('name')) + '"]';
        if (el.tagName === 'A' && el.getAttribute('href')) return 'a[href="' + esc(el.getAttribute('href')) + '"]';
        if (name) return role === 'link' ? 'a:has-text("' + esc(name) + '")' : el.tagName.toLowerCase() + ':has-text("' + esc(name) + '")';
        return el.tagName.toLowerCase();
      };
      const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
      for (const el of document.querySelectorAll('a[href], button, input, select, textarea, [role=button], [role=link], [role=tab], [role=menuitem], summary')) {
        if (!visible(el)) continue;
        const tag = el.tagName;
        const role = el.getAttribute('role') || (tag === 'A' ? 'link' : tag === 'BUTTON' ? 'button' : tag === 'SELECT' ? 'combobox' : tag === 'TEXTAREA' || tag === 'INPUT' ? 'textbox' : 'button');
        const name = label(el);
        const c = { role, name, selector: sel(el, role, name) };
        if (tag === 'A') c.href = el.getAttribute('href');
        if (tag === 'INPUT') c.inputType = el.getAttribute('type') || 'text';
        const form = el.closest('form'); if (form) c.formAction = form.getAttribute('action') || '';
        out.push(c);
        if (out.length >= 200) break;
      }
      return out;
    })()`).catch(() => []) as Control[];
    return raw;
  }
}

/** The tree without the parts that change run to run (counts, times) so equal screens fingerprint equal. */
export function normaliseTree(tree: string): string {
  return tree.replace(/\d{1,2}:\d{2}(:\d{2})?/g, '<time>').replace(/\b\d{4}-\d{2}-\d{2}(T[\d:.Z+-]+)?\b/g, '<date>').replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>');
}
