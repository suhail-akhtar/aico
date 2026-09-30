// @ts-nocheck — this function runs inside web pages (serialised with toString), not in main.
/**
 * The in-page half of the built-in browser's agent tools.
 *
 * `aicoPage(op, args)` is serialised with `Function.prototype.toString()` and
 * evaluated in the page through the DevTools protocol (`Runtime.evaluate`, which
 * page CSP does not apply to). It must therefore be SELF-CONTAINED: no imports,
 * no references to anything outside its own body. It only reads the page and
 * reports raw facts; the verdicts (is this a password field, is this a
 * CAPTCHA) are made in main by browser-safety.ts, where a page cannot tamper
 * with them.
 *
 * It walks the rendered tree the way a person sees it: open shadow roots (with
 * slotted content in place) and same-origin iframes are entered; cross-origin
 * frames are reported, not read.
 *
 * The third argument is for the unit tests, which run it against a small DOM
 * built from fixture HTML; in a page it is omitted and the real globals are used.
 *
 * Operations: snapshot, locate, highlight, read, forms, extract, insights,
 * humanCheck, probe, find, focused, setValue, fileTarget.
 *
 * @module desktop/electron/browser-page
 */

export function aicoPage(op, args, envIn) {
  const env = envIn || { document: document, window: window };
  const doc = env.document;
  const win = env.window || {};
  const A = args || {};
  const real = typeof win.getComputedStyle === 'function';
  const MAX_NODES = 60000;
  let visited = 0;

  // ── Basics ──
  const lower = (s) => String(s == null ? '' : s).toLowerCase();
  const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const clip = (s, n) => { const t = clean(s); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  const tag = (el) => (el && el.tagName ? String(el.tagName).toUpperCase() : '');
  const attr = (el, name) => (el && el.getAttribute ? el.getAttribute(name) : null);
  const isEl = (n) => n && n.nodeType === 1;
  const baseUrl = () => { try { return (doc.baseURI || (doc.location && doc.location.href) || doc.URL || ''); } catch (e) { return ''; } };
  const abs = (href, el) => {
    if (!href) return '';
    try { return new URL(href, (el && el.ownerDocument && el.ownerDocument.baseURI) || baseUrl()).href; } catch (e) { return href; }
  };
  const pageUrl = () => { try { return (doc.location && doc.location.href) || doc.URL || ''; } catch (e) { return ''; } };
  const textOf = (el) => {
    if (!el) return '';
    if (real && typeof el.innerText === 'string') return el.innerText;
    return el.textContent || '';
  };

  const styleOf = (el) => { try { return real ? (el.ownerDocument && el.ownerDocument.defaultView || win).getComputedStyle(el) : null; } catch (e) { return null; } };
  const hiddenAttr = (el) => {
    if (!isEl(el)) return false;
    if (el.hasAttribute && el.hasAttribute('hidden')) return true;
    if (attr(el, 'aria-hidden') === 'true' && !real) return true;
    const st = lower(attr(el, 'style'));
    return /display\s*:\s*none|visibility\s*:\s*hidden/.test(st);
  };
  /** Rendered at all (display/visibility) — cheap, used while walking. */
  const rendered = (el) => {
    if (!isEl(el)) return true;
    if (hiddenAttr(el) && !real) return false;
    if (!real) return true;
    const s = styleOf(el);
    if (!s) return true;
    return s.display !== 'none' && s.visibility !== 'hidden' && s.visibility !== 'collapse';
  };
  /** Visible on screen with a size — for interactive elements. */
  const visible = (el) => {
    if (!isEl(el)) return false;
    if (!real) return !hiddenAttr(el);
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = styleOf(el);
    return !s || (s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05);
  };
  const isOverlay = (el) => isEl(el) && el.hasAttribute && el.hasAttribute('data-aico-overlay');

  // ── Prompt-injection guard: text a person cannot see ──
  // A page can hide instructions for the agent in text no person sees (white on
  // white, opacity 0, a 1px font, off-screen, clipped to nothing). read and
  // snapshot drop it and count it; main decides what to tell the model
  // (shared/injection-guard.ts). A. guard === false (the setting is off) keeps
  // the old behaviour. Unit tests have no layout, so there the rules read the
  // inline style attribute (with inheritance done by hand).
  const guardOn = A.guard !== false;
  const concealed = { count: 0, tricks: 0, samples: [] };
  const noted = new Set();
  const SUSPECT = /ignore|instruction|assistant|\bai\b|prompt|system|exfil|http|you are|do not tell|llm|model|agent|\[inst|<\||summar|secret|password|token|cookie/i;
  const noteConcealed = (el, reason, text) => {
    if (!guardOn || noted.has(el)) return;
    noted.add(el);
    const t = clean(text);
    if (t.length < 3) return;
    concealed.count++;
    if (reason !== 'display') concealed.tricks++;
    const keep = SUSPECT.test(t) ? 60 : 20;
    if (concealed.samples.length < keep) concealed.samples.push({ reason, text: t.slice(0, 500) });
  };
  const inlineStyle = (el) => {
    const out = {};
    const s = attr(el, 'style') || '';
    for (const d of s.split(';')) { const i = d.indexOf(':'); if (i > 0) out[lower(d.slice(0, i).trim())] = lower(d.slice(i + 1).replace(/!important/i, '').trim()); }
    return out;
  };
  const toPx = (v) => {
    const m = /^\s*(-?[\d.]+)\s*(px|pt|em|rem|%)?/.exec(String(v == null ? '' : v));
    if (!m) return null;
    const n = Number(m[1]); const u = m[2] || 'px';
    return u === 'pt' ? n * 4 / 3 : (u === 'em' || u === 'rem') ? n * 16 : u === '%' ? n * 0.16 : n;
  };
  const NAMED = { white: [255, 255, 255, 1], black: [0, 0, 0, 1], transparent: [0, 0, 0, 0] };
  const colour = (c) => {
    const v = lower(c).replace(/\s+/g, '');
    if (!v) return null;
    if (NAMED[v]) return NAMED[v];
    let m = /^rgba?\((\d+(?:\.\d+)?),(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)(?:[,/]([\d.]+%?))?\)$/.exec(v);
    if (m) { let a = m[4] === undefined ? 1 : m[4].endsWith('%') ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]); return [Number(m[1]), Number(m[2]), Number(m[3]), a]; }
    m = /^#([0-9a-f]{3,8})$/.exec(v);
    if (m) {
      let h = m[1];
      if (h.length <= 4) h = h.split('').map(x => x + x).join('');
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
    }
    return null;
  };
  const parentOf = (n) => (n && (n.parentNode && n.parentNode.nodeType === 1 ? n.parentNode : (n.parentNode && n.parentNode.host) || null));
  /** An inherited property: computed in a page, looked up the inline-style chain in the tests. */
  const inherited = (el, css, prop) => {
    if (real) { const s = styleOf(el); return s ? s[prop] : ''; }
    for (let a = el, i = 0; a && isEl(a) && i < 40; a = parentOf(a), i++) { const v = inlineStyle(a)[css]; if (v) return v; }
    return '';
  };
  /** The solid colour behind an element, or null when it cannot be known (an image, a translucent layer). */
  const backdrop = (el) => {
    for (let a = el, i = 0; a && isEl(a) && i < 40; a = parentOf(a), i++) {
      let img = ''; let bg = '';
      if (real) { const s = styleOf(a); if (!s) return null; img = s.backgroundImage; bg = s.backgroundColor; }
      else { const s = inlineStyle(a); bg = s['background-color'] || (/^(#[0-9a-f]{3,8}|rgba?\([^)]*\)|[a-z]+)$/.test(s.background || '') ? s.background : ''); img = /url\(|gradient/.test(s['background-image'] || s.background || '') ? 'x' : ''; }
      if (img && img !== 'none') return null;
      const c = colour(bg);
      if (c && c[3] >= 0.9) return c;
      if (c && c[3] > 0.1) return null;
    }
    return [255, 255, 255, 1];
  };
  /** Why this element and everything in it cannot be seen ('' when it can). */
  const concealBox = (el) => {
    if (!guardOn || !isEl(el)) return '';
    if (real) {
      const s = styleOf(el);
      if (!s) return '';
      if (Number(s.opacity) <= 0.05) return 'transparent';
      if (/rect\(0px,?\s*0px,?\s*0px,?\s*0px\)/.test(s.clip || '') || /inset\((50|100)%\)|circle\(0/.test(s.clipPath || '')) return 'clipped';
      if (s.display === 'contents' || !el.getBoundingClientRect) return '';
      const r = el.getBoundingClientRect();
      const ov = (s.overflow || '') + ' ' + (s.overflowX || '') + ' ' + (s.overflowY || '');
      if ((r.width <= 1 || r.height <= 1) && /hidden|clip/.test(ov)) return 'clipped';
      const sx = win.scrollX || 0; const sy = win.scrollY || 0;
      const dw = Math.max((doc.documentElement && doc.documentElement.scrollWidth) || 0, win.innerWidth || 0);
      if ((s.position === 'absolute' || s.position === 'fixed') && (r.right + sx <= 0 || r.bottom + sy <= 0 || r.left + sx >= dw + 50)) return 'off-screen';
      if (attr(el, 'aria-hidden') === 'true' && (r.width < 2 || r.height < 2)) return 'aria-hidden';
      return '';
    }
    const s = inlineStyle(el);
    const op = toPx(s.opacity);
    if (op !== null && op <= 0.05) return 'transparent';
    if ((s.position === 'absolute' || s.position === 'fixed') && ['left', 'top', 'right', 'bottom'].some(k => { const n = toPx(s[k]); return n !== null && n <= -500; })) return 'off-screen';
    if (/rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)/.test(s.clip || '') || /inset\((50|100)%\)|circle\(0/.test(s['clip-path'] || '')) return 'clipped';
    const w = toPx(s.width); const h = toPx(s.height);
    if (((w !== null && w <= 1) || (h !== null && h <= 1)) && /hidden|clip/.test(s.overflow || '')) return 'clipped';
    return '';
  };
  /** Why this element's own text cannot be read (tiny, pushed away, or the colour of what is behind it). */
  const concealText = (el) => {
    if (!guardOn || !isEl(el)) return '';
    const fs = toPx(inherited(el, 'font-size', 'fontSize'));
    if (fs !== null && fs <= 1.5) return 'tiny-font';
    const ti = toPx(real ? (styleOf(el) || {}).textIndent : inlineStyle(el)['text-indent']);
    if (ti !== null && ti <= -500) return 'off-screen';
    const fg = colour(inherited(el, 'color', 'color'));
    if (!fg) return '';
    if (fg[3] <= 0.05) return 'same-colour';
    const bg = backdrop(el);
    if (bg && Math.abs(fg[0] - bg[0]) + Math.abs(fg[1] - bg[1]) + Math.abs(fg[2] - bg[2]) <= 24) return 'same-colour';
    return '';
  };
  const ownTextOf = (el) => Array.from(el.childNodes || []).filter(n => n.nodeType === 3).map(n => n.nodeValue).join(' ');
  /** Any reason text inside `el` would be invisible, looking up its ancestors (for find). */
  const hiddenDeep = (el) => {
    if (!guardOn) return false;
    if (concealText(el)) return true;
    for (let a = el, i = 0; a && isEl(a) && i < 40; a = parentOf(a), i++) if (!rendered(a) || concealBox(a)) return true;
    return false;
  };

  /** Children as rendered: a shadow root's tree (with slots filled) instead of the light DOM. */
  const kids = (n) => {
    if (isEl(n) && n.shadowRoot) return Array.from(n.shadowRoot.childNodes || []);
    if (isEl(n) && tag(n) === 'SLOT' && typeof n.assignedNodes === 'function') {
      const a = n.assignedNodes({ flatten: true });
      if (a && a.length) return Array.from(a);
    }
    if (isEl(n) && tag(n) === 'TEMPLATE') return [];
    return Array.from(n.childNodes || []);
  };
  const frameDoc = (el) => { try { return el.contentDocument || null; } catch (e) { return null; } };

  /** Every element in rendered order, through open shadow roots and same-origin frames. */
  const allElements = (root, opts) => {
    const out = [];
    const o = opts || {};
    const stack = [root];
    while (stack.length) {
      const n = stack.pop();
      if (++visited > MAX_NODES) break;
      if (isEl(n)) {
        if (isOverlay(n)) continue;
        out.push(n);
        const t = tag(n);
        if ((t === 'IFRAME' || t === 'FRAME') && o.frames !== false) {
          const d = frameDoc(n);
          if (d && d.documentElement) { stack.push(d.documentElement); }
          continue;
        }
        if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(t)) continue;
      }
      const ch = kids(n);
      for (let i = ch.length - 1; i >= 0; i--) stack.push(ch[i]);
    }
    return out;
  };
  const docRoot = () => doc.documentElement || doc;
  const matches = (el, sel) => { try { return el.matches ? el.matches(sel) : false; } catch (e) { return false; } };

  // ── Refs ──
  const topWin = win;
  const nextRef = () => { topWin.__aicoRefSeq = (topWin.__aicoRefSeq || 0) + 1; return 'e' + topWin.__aicoRefSeq; };
  const refOf = (el) => {
    let r = attr(el, 'data-aico-ref');
    if (!r) { r = nextRef(); try { el.setAttribute('data-aico-ref', r); } catch (e) { /* read-only node */ } }
    return r;
  };
  const byRef = (ref) => {
    try { const q = doc.querySelector && doc.querySelector('[data-aico-ref="' + ref + '"]'); if (q) return q; } catch (e) { /* fall through */ }
    return allElements(docRoot()).find(el => attr(el, 'data-aico-ref') === ref) || null;
  };

  // ── Labels and roles ──
  const idIndex = () => {
    const map = {};
    for (const el of allElements(docRoot())) {
      if (tag(el) === 'LABEL' && attr(el, 'for')) map['label:' + attr(el, 'for')] = el;
      const id = attr(el, 'id');
      if (id && !map['id:' + id]) map['id:' + id] = el;
    }
    return map;
  };
  let IDX = null;
  const index = () => (IDX || (IDX = idIndex()));
  const ownText = (el) => clean(textOf(el));
  const labelFor = (el) => {
    const lb = attr(el, 'aria-labelledby');
    if (lb) {
      const t = lb.split(/\s+/).map(id => index()['id:' + id]).filter(Boolean).map(ownText).join(' ');
      if (clean(t)) return clean(t);
    }
    const al = attr(el, 'aria-label');
    if (al && clean(al)) return clean(al);
    const id = attr(el, 'id');
    if (id) {
      const l = (el.labels && el.labels[0]) || index()['label:' + id];
      if (l) { const t = ownText(l); if (t) return t; }
    }
    let p = el.parentNode;
    for (let i = 0; p && i < 4; i++, p = p.parentNode) {
      if (tag(p) === 'LABEL') {
        // A label around a select or textarea also holds its text: take that out.
        const own = ownText(p);
        const t = (tag(el) === 'SELECT' || tag(el) === 'TEXTAREA') ? own.replace(clean(textOf(el)), '').trim() : own;
        if (t) return t;
        break;
      }
    }
    const ph = attr(el, 'placeholder') || attr(el, 'title') || attr(el, 'alt');
    if (ph && clean(ph)) return clean(ph);
    // Nearby text: a previous sibling, or the cell to the left.
    let prev = el.previousElementSibling || null;
    for (let i = 0; prev && i < 2; i++, prev = prev.previousElementSibling) {
      const t = ownText(prev);
      if (t && t.length < 80) return t;
    }
    const cell = el.closest ? el.closest('td') : null;
    if (cell && cell.previousElementSibling) { const t = ownText(cell.previousElementSibling); if (t && t.length < 80) return t; }
    const par = el.parentNode;
    if (par && isEl(par)) {
      const t = Array.from(par.childNodes || []).filter(n => n.nodeType === 3).map(n => n.nodeValue).join(' ');
      if (clean(t) && clean(t).length < 80) return clean(t);
    }
    const nm = attr(el, 'name') || attr(el, 'id') || '';
    return clean(nm.replace(/[_\-[\]]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2'));
  };
  const nameOf = (el) => {
    const a = attr(el, 'aria-label') || attr(el, 'title') || attr(el, 'alt') || attr(el, 'placeholder');
    if (a && clean(a)) return clean(a);
    const t = tag(el);
    if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') {
      const l = labelFor(el);
      if (l) return l;
    }
    const txt = clean(textOf(el));
    if (txt) return txt;
    if (t === 'INPUT') return clean(el.value || attr(el, 'value') || '');
    const img = el.querySelector ? el.querySelector('img[alt], svg[aria-label], [aria-label]') : null;
    return img ? clean(attr(img, 'alt') || attr(img, 'aria-label')) : '';
  };
  const inputType = (el) => lower(attr(el, 'type') || 'text');
  const roleOf = (el) => {
    const r = attr(el, 'role'); if (r) return r;
    const t = tag(el);
    if (t === 'A') return 'link';
    if (t === 'BUTTON' || t === 'SUMMARY') return 'button';
    if (t === 'SELECT') return 'combobox';
    if (t === 'TEXTAREA') return 'textbox';
    if (t === 'INPUT') {
      const ty = inputType(el);
      if (ty === 'checkbox' || ty === 'radio') return ty;
      if (['submit', 'button', 'reset', 'image'].includes(ty)) return 'button';
      if (ty === 'file') return 'file';
      return ty === 'password' ? 'password' : 'textbox';
    }
    if (el.isContentEditable || attr(el, 'contenteditable') === 'true') return 'textbox';
    return 'clickable';
  };
  const describeField = (el) => ({
    tag: lower(tag(el)), type: tag(el) === 'INPUT' ? inputType(el) : lower(tag(el)),
    autocomplete: attr(el, 'autocomplete') || '', name: attr(el, 'name') || '', id: attr(el, 'id') || '',
    label: clip(labelFor(el), 120), placeholder: attr(el, 'placeholder') || '', ariaLabel: attr(el, 'aria-label') || '',
    inputmode: attr(el, 'inputmode') || '', maxLength: Number(attr(el, 'maxlength')) || 0,
  });
  const isField = (el) => {
    const t = tag(el);
    if (t === 'TEXTAREA' || t === 'SELECT') return true;
    if (t === 'INPUT') return !['hidden', 'submit', 'button', 'reset', 'image'].includes(inputType(el));
    return attr(el, 'contenteditable') === 'true' || el.isContentEditable === true && !(el.parentNode && el.parentNode.isContentEditable);
  };
  const INTERACTIVE = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=checkbox], [role=radio], [role=switch], [role=option], [role=combobox], [role=textbox], [role=searchbox], [role=slider], [contenteditable=true], [onclick], [tabindex]:not([tabindex="-1"])';

  /** Offset of an element's frame chain, so rects are in the top viewport. */
  const frameOffset = (el) => {
    let x = 0; let y = 0;
    let d = el.ownerDocument;
    while (d && d !== doc) {
      const fe = d.defaultView && d.defaultView.frameElement;
      if (!fe) break;
      const r = fe.getBoundingClientRect();
      x += r.left + (fe.clientLeft || 0); y += r.top + (fe.clientTop || 0);
      d = fe.ownerDocument;
    }
    return { x, y };
  };
  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    const o = frameOffset(el);
    return { x: r.left + o.x, y: r.top + o.y, w: r.width, h: r.height };
  };

  // ── Human-check signals ──
  const humanSignals = () => {
    const frames = [];
    const widgets = [];
    const sels = A.humanSelectors || [];
    for (const el of allElements(docRoot())) {
      const t = tag(el);
      if (t === 'IFRAME' || t === 'FRAME') {
        let w = 0; let h = 0; let vis = true;
        if (real) { const r = el.getBoundingClientRect(); w = r.width; h = r.height; vis = visible(el); } else { w = Number(attr(el, 'width')) || 300; h = Number(attr(el, 'height')) || 150; vis = !hiddenAttr(el); }
        frames.push({ src: attr(el, 'src') || '', title: attr(el, 'title') || '', width: w, height: h, visible: vis });
      }
      for (const s of sels) if (matches(el, s) && visible(el) && !widgets.includes(s)) widgets.push(s);
    }
    const body = doc.body;
    return { url: pageUrl(), title: doc.title || '', frames: frames.slice(0, 60), widgets, text: body ? textOf(body).slice(0, 6000) : '' };
  };

  // ── Page probe (before / after an action) ──
  const probe = () => {
    const alerts = [];
    const invalid = [];
    const modals = [];
    for (const el of allElements(docRoot())) {
      if (alerts.length < 8 && (attr(el, 'role') === 'alert' || attr(el, 'aria-live') === 'assertive' || matches(el, '.error-message, .invalid-feedback, .form-error, .field-error, .alert-danger, .alert-error, .notification.is-danger, .toast-error'))) {
        if (visible(el)) { const t = clip(textOf(el), 200); if (t && !alerts.includes(t)) alerts.push(t); }
      }
      if (isField(el) && invalid.length < 12) {
        const inv = attr(el, 'aria-invalid') === 'true' || matches(el, ':user-invalid');
        if (inv && visible(el)) {
          let msg = el.validationMessage || '';
          const errId = attr(el, 'aria-errormessage') || attr(el, 'aria-describedby');
          if (!msg && errId) msg = errId.split(/\s+/).map(id => { const e = index()['id:' + id]; return e ? ownText(e) : ''; }).join(' ');
          invalid.push({ label: clip(labelFor(el), 60), message: clip(msg || 'invalid', 160) });
        }
      }
      if (modals.length < 3 && (matches(el, 'dialog[open]') || ['dialog', 'alertdialog'].includes(attr(el, 'role') || '') || attr(el, 'aria-modal') === 'true')) {
        if (visible(el)) { const t = clip(attr(el, 'aria-label') || textOf(el), 160); if (t && !modals.includes(t)) modals.push(t); }
      }
    }
    return { url: pageUrl(), title: doc.title || '', alerts, invalid, modals };
  };

  // ── Snapshot ──
  const snapshot = () => {
    const full = Boolean(A.full);
    const MAX = full ? 600 : 250;
    // Refs stay stable for the life of the document (browser_forms, browser_find and earlier snapshots
    // agree); an element a framework cloned together with its ref gets a fresh one.
    const seenRefs = {};
    visited = 0;
    const elements = [];
    const frames = [];
    const vh = real ? win.innerHeight : 800;
    let total = 0;
    for (const el of allElements(docRoot())) {
      const t = tag(el);
      if (t === 'IFRAME' || t === 'FRAME') {
        if (!frameDoc(el) && visible(el)) frames.push({ src: attr(el, 'src') || '', title: attr(el, 'title') || '' });
        continue;
      }
      if (!matches(el, INTERACTIVE) || !visible(el)) continue;
      total++;
      if (elements.length >= MAX) continue;
      let ref = refOf(el);
      if (seenRefs[ref]) { ref = nextRef(); el.setAttribute('data-aico-ref', ref); }
      seenRefs[ref] = 1;
      const role = roleOf(el);
      const item = { ref, role, name: clip(nameOf(el), 80) };
      if (role === 'textbox' || role === 'combobox' || role === 'searchbox' || role === 'password') {
        item.field = describeField(el);
        item.value = role === 'password' ? (el.value ? '(filled)' : '') : clip(el.value != null ? el.value : textOf(el), 60);
        if (t === 'SELECT' && el.options && el.selectedIndex >= 0 && el.options[el.selectedIndex]) item.value = clip(el.options[el.selectedIndex].text, 60);
      }
      if (role === 'checkbox' || role === 'radio' || role === 'switch') item.checked = Boolean(el.checked || attr(el, 'aria-checked') === 'true');
      if (el.disabled || attr(el, 'aria-disabled') === 'true') item.disabled = true;
      if (role === 'link') { const h = attr(el, 'href') || ''; if (h && !/^javascript:/i.test(h)) item.href = h.slice(0, 100); }
      if (role === 'file') item.field = describeField(el);
      if (real) { const r = rectOf(el); if (r.y + r.h < 0 || r.y > vh) item.offscreen = true; }
      if (el.ownerDocument !== doc) item.frame = true;
      elements.push(item);
    }
    const heads = allElements(docRoot()).filter(h => /^H[1-3]$/.test(tag(h)) && visible(h)).slice(0, 20).map(h => lower(tag(h)) + ': ' + clip(textOf(h), 100));
    const main = (doc.querySelector && (doc.querySelector('main') || doc.querySelector('[role=main]'))) || doc.body;
    const text = main ? (guardOn ? seenText(main) : textOf(main)).replace(/\n{3,}/g, '\n\n').trim() : '';
    const dialogs = allElements(docRoot()).filter(d => (matches(d, 'dialog[open]') || ['dialog', 'alertdialog'].includes(attr(d, 'role') || '')) && visible(d)).map(d => clip(attr(d, 'aria-label') || textOf(d), 160));
    const limit = full ? 12000 : 3500;
    return {
      title: doc.title || '', url: pageUrl(),
      scroll: real ? { y: Math.round(win.scrollY), height: doc.documentElement.scrollHeight, viewport: win.innerHeight } : { y: 0, height: 0, viewport: 0 },
      headings: heads, elements, total, crossOriginFrames: frames.slice(0, 10), dialogs,
      text: text.slice(0, limit), truncated: text.length > limit, concealed,
    };
  };

  /** innerText without what a person cannot see (the guard's version of the snapshot text). */
  const seenText = (root) => {
    const parts = [];
    visited = 0;
    const LINE =/^(P|DIV|SECTION|ARTICLE|MAIN|HEADER|FOOTER|ASIDE|NAV|FORM|FIELDSET|FIGURE|FIGCAPTION|ADDRESS|DETAILS|SUMMARY|LI|UL|OL|DL|DT|DD|TR|TABLE|PRE|BLOCKQUOTE|H[1-6]|HR|BR|DIALOG)$/;
    const walk = (n) => {
      if (++visited > MAX_NODES) return;
      if (n.nodeType === 3) {
        const p = n.parentNode;
        if (isEl(p) && clean(n.nodeValue)) { const why = concealText(p); if (why) { noteConcealed(p, why, ownTextOf(p)); return; } }
        parts.push(n.nodeValue || '');
        return;
      }
      if (n.nodeType === 11 || n.nodeType === 9) { kids(n).forEach(walk); return; }
      if (!isEl(n)) return;
      const t = tag(n);
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'IFRAME', 'FRAME', 'OBJECT', 'EMBED', 'SVG'].includes(t) || isOverlay(n)) return;
      if (!rendered(n)) { noteConcealed(n, 'display', n.textContent); return; }
      const why = concealBox(n);
      if (why) { noteConcealed(n, why, n.textContent); return; }
      const line = LINE.test(t);
      if (line) parts.push('\n');
      kids(n).forEach(walk);
      if (line) parts.push('\n'); else if (t === 'TD' || t === 'TH') parts.push('\t');
    };
    walk(root);
    return parts.join('').replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  };

  // ── Locate (and highlight) ──
  const findTarget = (t) => {
    let el = null;
    if (t.ref) el = byRef(t.ref);
    if (!el && t.selector) {
      try { el = doc.querySelector(t.selector); } catch (e) { return { error: 'Bad selector: ' + e.message }; }
      if (!el) el = allElements(docRoot()).find(x => matches(x, t.selector)) || null;
    }
    if (!el && t.text) {
      const want = lower(clean(t.text));
      const cands = allElements(docRoot()).filter(c => matches(c, 'a,button,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],label,summary,input[type=submit],input[type=button],li,span,div,td,p,h1,h2,h3,h4') && visible(c));
      const txt = (c) => lower(clean(textOf(c) || c.value || attr(c, 'aria-label') || ''));
      el = cands.find(c => txt(c) === want && matches(c, 'a,button,[role=button],[role=link],input,summary,label,[role=tab],[role=menuitem],[role=option]'))
        || cands.find(c => txt(c) === want)
        || cands.find(c => txt(c).includes(want) && (c.children ? c.children.length : 0) < 4);
    }
    if (!el) return { error: 'No element matches ' + JSON.stringify(t) + '. Take a new snapshot — refs change when the page changes.' };
    return { el };
  };
  const highlight = (r, label) => {
    if (!real || !r) return;
    try {
      const old = doc.querySelectorAll('[data-aico-overlay]');
      old.forEach(o => o.remove());
      const box = doc.createElement('div');
      box.setAttribute('data-aico-overlay', '1');
      const s = box.style;
      s.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #7c5cff;border-radius:6px;box-shadow:0 0 0 4px rgba(124,92,255,.25);transition:opacity .4s;';
      s.left = (r.x - 3) + 'px'; s.top = (r.y - 3) + 'px'; s.width = (r.w + 6) + 'px'; s.height = (r.h + 6) + 'px';
      if (label) {
        const tagEl = doc.createElement('div');
        tagEl.textContent = label.length > 60 ? label.slice(0, 59) + '…' : label;
        tagEl.style.cssText = 'position:absolute;left:-2px;top:-22px;white-space:nowrap;font:600 11px/18px system-ui,sans-serif;color:#fff;background:#7c5cff;padding:0 6px;border-radius:4px;';
        if (r.y < 24) tagEl.style.top = (r.h + 6) + 'px';
        box.appendChild(tagEl);
      }
      (doc.body || doc.documentElement).appendChild(box);
      setTimeout(() => { box.style.opacity = '0'; }, 1400);
      setTimeout(() => { box.remove(); }, 1900);
    } catch (e) { /* decoration only */ }
  };
  const locate = () => {
    const f = findTarget(A.target || {});
    if (f.error) return f;
    const el = f.el;
    if (A.scroll !== false && el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = real ? rectOf(el) : { x: 0, y: 0, w: 0, h: 0 };
    const out = {
      x: r.x + r.w / 2, y: r.y + r.h / 2, rect: r, tag: lower(tag(el)), role: roleOf(el),
      label: clip(nameOf(el) || el.value || '', 60), ref: refOf(el), field: describeField(el),
      isField: isField(el), isSelect: tag(el) === 'SELECT', isFile: tag(el) === 'INPUT' && inputType(el) === 'file',
      checked: typeof el.checked === 'boolean' ? el.checked : undefined, inFrame: el.ownerDocument !== doc,
      disabled: Boolean(el.disabled),
    };
    if (real && r.w > 0) {
      const hit = doc.elementFromPoint(out.x, out.y);
      const inside = (a, b) => { let n = b; while (n) { if (n === a) return true; n = n.parentNode || n.host; } return false; };
      if (hit && hit !== el && !inside(el, hit) && !inside(hit, el) && !(out.inFrame && tag(hit) === 'IFRAME')) {
        out.coveredBy = lower(tag(hit)) + (hit.id ? '#' + hit.id : '') + (typeof hit.className === 'string' && hit.className ? '.' + hit.className.trim().split(/\s+/).slice(0, 2).join('.') : '') + (clean(textOf(hit)) ? ' "' + clip(textOf(hit), 60) + '"' : '');
      }
    }
    if (A.highlight) highlight(r, A.highlight);
    return out;
  };

  // ── Reader / Markdown ──
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'OBJECT', 'EMBED', 'HEAD', 'META', 'LINK', 'INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'OPTION', 'DATALIST', 'MAP', 'AUDIO', 'VIDEO', 'SOURCE', 'TRACK', 'PARAM', 'DIALOG']);
  const BLOCKS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'ASIDE', 'NAV', 'FORM', 'FIELDSET', 'FIGURE', 'FIGCAPTION', 'ADDRESS', 'CENTER', 'DETAILS', 'SUMMARY', 'LEGEND', 'HGROUP', 'BODY', 'HTML']);
  const NEGATIVE = /(^|[\s_-])(comment|comments|disqus|footer|footnote|masthead|media|meta|outbrain|taboola|promo|related|recommend|scroll|share|sharing|social|shoutbox|sidebar|skyscraper|sponsor|shopping|tags|tool|widget|nav|navbar|menu|breadcrumb|banner|ad|ads|advert|advertisement|cookie|consent|popup|modal|newsletter|subscribe|signup|login|pagination|pager|byline-share|print)([\s_-]|$)/i;
  const POSITIVE = /(^|[\s_-])(article|body|content|entry|hentry|h-entry|main|page|post|text|blog|story|prose|markdown|rich-text)([\s_-]|$)/i;
  const classId = (el) => (typeof el.className === 'string' ? el.className : attr(el, 'class') || '') + ' ' + (attr(el, 'id') || '');

  const linkDensity = (el) => {
    const total = clean(el.textContent || '').length || 1;
    let linked = 0;
    for (const a of allElements(el, { frames: false })) if (tag(a) === 'A') linked += clean(a.textContent || '').length;
    return Math.min(1, linked / total);
  };

  const pickReaderRoot = () => {
    const body = doc.body || docRoot();
    const els = allElements(body, { frames: false });
    const len = (el) => clean(el.textContent || '').length;
    const explicit = els.filter(el => matches(el, 'article, [itemprop=articleBody], [role=article], main, [role=main], .post-content, .entry-content, .article-body, .article-content, .story-body, #article-body, .markdown-body, .prose') && rendered(el));
    if (explicit.length) {
      const best = explicit.map(el => ({ el, n: len(el) * (1 - linkDensity(el) * 0.8) })).sort((a, b) => b.n - a.n)[0];
      if (best && best.n > 400) return best.el;
    }
    const scores = new Map();
    const init = (el) => {
      if (scores.has(el)) return;
      let s = 0;
      const t = tag(el);
      if (t === 'DIV' || t === 'ARTICLE' || t === 'SECTION' || t === 'MAIN') s += 5;
      else if (t === 'PRE' || t === 'TD' || t === 'BLOCKQUOTE') s += 3;
      else if (['ADDRESS', 'OL', 'UL', 'DL', 'DD', 'DT', 'LI', 'FORM'].includes(t)) s -= 3;
      else if (/^H[1-6]$/.test(t) || t === 'TH') s -= 5;
      const ci = classId(el);
      if (NEGATIVE.test(ci)) s -= 25;
      if (POSITIVE.test(ci)) s += 25;
      scores.set(el, s);
    };
    for (const el of els) {
      const t = tag(el);
      if (t !== 'P' && t !== 'PRE' && t !== 'TD' && t !== 'BLOCKQUOTE' && !(t === 'DIV' && !(el.querySelector && el.querySelector('p,div,table,ul,ol,pre,blockquote')))) continue;
      const text = clean(el.textContent || '');
      if (text.length < 25) continue;
      const p = el.parentNode; const gp = p && p.parentNode;
      const add = 1 + (text.split(/[,，、]/).length - 1) + Math.min(3, Math.floor(text.length / 100));
      if (isEl(p)) { init(p); scores.set(p, scores.get(p) + add); }
      if (isEl(gp)) { init(gp); scores.set(gp, scores.get(gp) + add / 2); }
    }
    let best = null; let bestScore = -Infinity;
    for (const [el, s] of scores) {
      const f = s * (1 - linkDensity(el));
      if (f > bestScore) { best = el; bestScore = f; }
    }
    if (!best || len(best) < 250) return body;
    // A parent that holds most of the same text is the real container (split articles).
    let cur = best;
    for (let i = 0; i < 3; i++) {
      const p = cur.parentNode;
      if (!isEl(p) || p === body) break;
      if (len(cur) / Math.max(1, len(p)) > 0.66 && !NEGATIVE.test(classId(p))) cur = p; else break;
    }
    return cur;
  };

  const toMarkdown = (root, mode) => {
    const reader = mode === 'reader';
    const links = []; const seenLinks = {}; const images = []; const headings = [];
    let words = 0;
    const cell = (s) => clean(s).replace(/\|/g, '\\|');
    /** A node's children as one line of inline Markdown. */
    const inlineOf = (n, st) => { const s2 = Object.assign({}, st, { inline: true }); return clean(kids(n).map(c => conv(c, s2)).join('')); };
    const conv = (n, st) => {
      if (++visited > MAX_NODES) return '';
      if (n.nodeType === 3) {
        const v = n.nodeValue || '';
        const par = n.parentNode;
        if (guardOn && isEl(par) && clean(v)) { const why = concealText(par); if (why) { noteConcealed(par, why, ownTextOf(par)); return ''; } }
        if (st.pre) return v;
        const t = v.replace(/\s+/g, ' ');
        if (clean(t)) words += clean(t).split(' ').length;
        return t.replace(/([*_`])/g, '\\$1');
      }
      if (n.nodeType === 11 || n.nodeType === 9) return kids(n).map(c => conv(c, st)).join('');
      if (!isEl(n)) return '';
      const t = tag(n);
      if (SKIP.has(t) || isOverlay(n)) return '';
      if (!rendered(n)) { noteConcealed(n, 'display', n.textContent); return ''; }
      const why = concealBox(n);
      if (why) { noteConcealed(n, why, n.textContent); return ''; }
      if (reader && n !== root) {
        if (['NAV', 'ASIDE', 'FOOTER', 'FORM'].includes(t)) return '';
        const ci = classId(n);
        if (NEGATIVE.test(ci) && !POSITIVE.test(ci) && clean(n.textContent || '').length < 1500) return '';
        if (t === 'HEADER' && !(n.querySelector && n.querySelector('h1,h2'))) return '';
        if ((t === 'DIV' || t === 'SECTION' || t === 'UL') && clean(n.textContent || '').length < 600 && linkDensity(n) > 0.6) return '';
      }
      const inner = () => kids(n).map(c => conv(c, st)).join('');
      if (t === 'IFRAME' || t === 'FRAME') {
        if (reader) return '';
        const d = frameDoc(n);
        return d && d.body ? '\n\n' + conv(d.body, st) + '\n\n' : '';
      }
      if (/^H[1-6]$/.test(t)) {
        const level = Number(t[1]);
        const text = inlineOf(n, st);
        if (!text) return '';
        if (headings.length < 200) headings.push({ level, text: text.replace(/\\([*_`])/g, '$1').slice(0, 200) });
        return st.inline ? text : '\n\n' + '#'.repeat(level) + ' ' + text + '\n\n';
      }
      if (t === 'BR') return st.inline ? ' ' : '\n';
      if (t === 'HR') return '\n\n---\n\n';
      if (t === 'STRONG' || t === 'B') { const x = inner(); return clean(x) ? '**' + x.trim() + '**' + (/\s$/.test(x) ? ' ' : '') : x; }
      if (t === 'EM' || t === 'I' || t === 'CITE') { const x = inner(); return clean(x) ? '_' + x.trim() + '_' + (/\s$/.test(x) ? ' ' : '') : x; }
      if (t === 'DEL' || t === 'S' || t === 'STRIKE') { const x = inner(); return clean(x) ? '~~' + x.trim() + '~~' : x; }
      if (t === 'CODE' || t === 'KBD' || t === 'SAMP') {
        if (st.pre) return n.textContent || '';
        const x = (n.textContent || '').replace(/\s+/g, ' ');
        return x.trim() ? '`' + x.trim().replace(/`/g, 'ˋ') + '`' : '';
      }
      if (t === 'PRE') {
        const code = (n.textContent || '').replace(/\n+$/, '');
        const lang = (classId(n.querySelector ? (n.querySelector('code') || n) : n).match(/(?:language|lang)-([\w+#-]+)/) || [])[1] || '';
        words += clean(code).split(' ').length;
        return '\n\n```' + lang + '\n' + code + '\n```\n\n';
      }
      if (t === 'A') {
        const href = attr(n, 'href') || '';
        const text = inlineOf(n, st);
        if (!href || /^javascript:/i.test(href) || href === '#') return text ? text + ' ' : '';
        const url = abs(href, n);
        if (text && !seenLinks[url] && links.length < 500) { seenLinks[url] = 1; links.push({ text: text.replace(/\\([*_`])/g, '$1').slice(0, 150), href: url }); }
        if (!text) return '';
        // A linked image keeps its own Markdown: stripping brackets from the link
        // text turned "![alt](src)" into "!alt(src" inside the link.
        const label = text.indexOf('![') >= 0 ? text : text.replace(/[[\]]/g, '');
        return '[' + label + '](' + url.replace(/\)/g, '%29').replace(/ /g, '%20') + ')';
      }
      if (t === 'IMG' || t === 'PICTURE') {
        const img = t === 'PICTURE' ? (n.querySelector && n.querySelector('img')) : n;
        if (!img) return '';
        const src = attr(img, 'src') || attr(img, 'data-src') || '';
        const w = Number(attr(img, 'width')) || 99; const h = Number(attr(img, 'height')) || 99;
        if (!src || /^data:/i.test(src) || w <= 2 || h <= 2) return '';
        const alt = clean(attr(img, 'alt') || '');
        const url = abs(src, img);
        if (images.length < 200) images.push({ alt, src: url });
        return '![' + alt.replace(/[[\]]/g, '') + '](' + url.replace(/\)/g, '%29').replace(/ /g, '%20') + ')';
      }
      if (t === 'UL' || t === 'OL') {
        const depth = st.depth || 0;
        let i = Number(attr(n, 'start')) || 1;
        const items = kids(n).filter(c => isEl(c) && tag(c) === 'LI' && rendered(c)).map(li => {
          const marker = t === 'OL' ? (i++) + '. ' : '- ';
          const body = conv(li, Object.assign({}, st, { depth: depth + 1, inline: false, inList: true })).replace(/^\s+|\s+$/g, '').replace(/\n{2,}/g, '\n');
          if (!body) return '';
          const pad = '  '.repeat(depth);
          return pad + marker + body.split('\n').map((l, k) => (k === 0 ? l : pad + '  ' + l.replace(/^\s+/, ''))).join('\n');
        }).filter(Boolean);
        if (!items.length) return '';
        return (depth ? '\n' : '\n\n') + items.join('\n') + (depth ? '\n' : '\n\n');
      }
      if (t === 'LI') return inner();
      if (t === 'BLOCKQUOTE') {
        const x = inner().trim();
        return x ? '\n\n' + x.split('\n').map(l => '> ' + l).join('\n') + '\n\n' : '';
      }
      if (t === 'TABLE') {
        const rows = [];
        const walkRows = (node) => {
          for (const c of kids(node)) {
            if (!isEl(c)) continue;
            const ct = tag(c);
            if (ct === 'TR') rows.push(c);
            else if (ct === 'THEAD' || ct === 'TBODY' || ct === 'TFOOT') walkRows(c);
          }
        };
        walkRows(n);
        const nested = n.querySelector ? n.querySelector('table') : null;
        const cellsOf = (tr) => kids(tr).filter(c => isEl(c) && (tag(c) === 'TD' || tag(c) === 'TH'));
        const counts = rows.map(r => cellsOf(r).length);
        const width = Math.max(0, ...counts);
        const header = n.querySelector ? n.querySelector('th, thead, caption') : null;
        // A layout table (nested tables, ragged rows and no header, role=presentation) is not data:
        // its rows read as paragraphs, not as a Markdown table.
        const layout = nested || width < 2 || attr(n, 'role') === 'presentation' || attr(n, 'role') === 'none' || (!header && counts.some(c => c !== counts[0]));
        if (layout) {
          if (!rows.length) return '\n\n' + inner() + '\n\n';
          return '\n\n' + rows.map(r => cellsOf(r).map(c => conv(c, st)).join(' ').trim()).filter(Boolean).join('\n\n') + '\n\n';
        }
        const body = rows.slice(0, 300).map(r => {
          const cs = cellsOf(r).map(c => cell(inlineOf(c, st)));
          while (cs.length < width) cs.push('');
          return '| ' + cs.join(' | ') + ' |';
        });
        const cap = n.querySelector ? n.querySelector('caption') : null;
        const lines = [body[0], '|' + ' --- |'.repeat(width)].concat(body.slice(1));
        if (rows.length > 300) lines.push('| … ' + (rows.length - 300) + ' more rows |' + ' |'.repeat(width - 1));
        return '\n\n' + (cap ? '**' + clean(textOf(cap)) + '**\n\n' : '') + lines.join('\n') + '\n\n';
      }
      if (t === 'CAPTION') return '';
      if (t === 'TD' || t === 'TH') return inner() + ' ';
      if (t === 'DL') return '\n\n' + inner() + '\n\n';
      if (t === 'DT') return '\n**' + inlineOf(n, st) + '**\n';
      if (t === 'DD') return ': ' + inlineOf(n, st) + '\n';
      if (t === 'FIGCAPTION') { const x = inlineOf(n, st); return x ? '\n\n_' + x + '_\n\n' : ''; }
      if (t === 'SUP') return '^' + inner();
      if (BLOCKS.has(t) || t === 'TR' || t === 'THEAD' || t === 'TBODY') {
        const x = inner();
        return st.inline ? x + ' ' : '\n\n' + x + '\n\n';
      }
      return inner();
    };
    let md = conv(root, { inline: false, depth: 0 });
    // Tidy: keep code blocks as they are, collapse blank runs, trim line ends.
    const parts = md.split(/(\n```[\s\S]*?\n```\n)/);
    const tidy = (l) => {
      // List lines keep their indentation (nesting); everything else is trimmed.
      if (/^\s*([-*]|\d+\.)\s/.test(l)) { const ind = /^\s*/.exec(l)[0]; return ind + l.slice(ind.length).replace(/ {2,}/g, ' ').replace(/\s+$/, ''); }
      return l.trim().replace(/ {2,}/g, ' ');
    };
    md = parts.map((p, i) => (i % 2 ? p : p.split('\n').map(tidy).join('\n'))).join('');
    md = md.replace(/\n{3,}/g, '\n\n').trim();
    return { markdown: md, links, images, headings, words };
  };

  const bylineOf = () => {
    const meta = doc.querySelector && (doc.querySelector('meta[name="author"]') || doc.querySelector('meta[property="article:author"]'));
    if (meta && clean(attr(meta, 'content')) && !/^https?:/.test(attr(meta, 'content'))) return clean(attr(meta, 'content'));
    const el = doc.querySelector && doc.querySelector('[rel=author], [itemprop=author], .byline, .author, .post-author, [class*="byline"]');
    return el ? clip(textOf(el), 100) : '';
  };

  const read = () => {
    const ct = lower(doc.contentType || 'text/html');
    const url = pageUrl();
    const title = doc.title || '';
    if (ct === 'application/pdf' || (doc.querySelector && doc.querySelector('embed[type="application/pdf"]'))) {
      return { url, title, markdown: '', words: 0, headings: [], links: [], note: 'This is a PDF shown in the built-in viewer; its text cannot be read from the page. Ask the user, or download it (browser_open the URL) and read the file with your own tools.' };
    }
    if (/^image\//.test(ct)) return { url, title, markdown: '', words: 0, headings: [], links: [], note: 'This is an image (' + ct + '). Use browser_screenshot to look at it.' };
    if (ct !== 'text/html' && ct !== 'application/xhtml+xml' && doc.body) {
      const text = textOf(doc.body);
      const max = Math.max(500, Math.min(Number(A.maxChars) || 20000, 100000));
      return { url, title, markdown: '```' + (ct.includes('json') ? 'json' : '') + '\n' + text.slice(0, max) + '\n```', words: clean(text).split(' ').length, headings: [], links: [], truncated: text.length > max, note: 'Not an HTML page (' + ct + '); shown as text.' };
    }
    const mode = A.mode === 'full' ? 'full' : 'reader';
    const root = mode === 'reader' ? pickReaderRoot() : (doc.body || docRoot());
    visited = 0;
    const r = toMarkdown(root, mode);
    let md = r.markdown;
    const h1 = r.headings.find(h => h.level === 1);
    const ogTitle = doc.querySelector && doc.querySelector('meta[property="og:title"]');
    const pageTitle = (h1 && h1.text) || clean(ogTitle ? attr(ogTitle, 'content') : '') || title;
    if (!h1 && pageTitle) md = '# ' + pageTitle + '\n\n' + md;
    const max = Math.max(500, Math.min(Number(A.maxChars) || 20000, 200000));
    const truncated = md.length > max;
    if (truncated) md = md.slice(0, max).replace(/\n[^\n]*$/, '') + '\n\n…(truncated — call again with a larger maxChars, or use browser_extract / browser_find for the part you need)';
    return { url, title: pageTitle || title, byline: bylineOf() || undefined, markdown: md, words: r.words, headings: r.headings, links: r.links, images: r.images, truncated, concealed };
  };

  // ── Forms ──
  const forms = () => {
    const out = [];
    const groups = new Map();
    const formIndex = new Map();
    const loose = { index: -1, action: '', method: '', fields: [], submit: [] };
    const all = allElements(docRoot());
    const formOf = (el) => el.form || (el.closest ? el.closest('form') : null);
    for (const el of all) {
      if (tag(el) === 'FORM') {
        const f = { index: out.length, ref: refOf(el), name: attr(el, 'name') || attr(el, 'id') || attr(el, 'aria-label') || undefined, action: abs(attr(el, 'action') || '', el) || pageUrl(), method: lower(attr(el, 'method') || 'get'), fields: [], submit: [] };
        if (el.ownerDocument !== doc) f.frame = el.ownerDocument.URL;
        formIndex.set(el, f);
        out.push(f);
      }
    }
    for (const el of all) {
      const t = tag(el);
      const fEl = formOf(el);
      const target = (fEl && formIndex.get(fEl)) || loose;
      const isSubmit = (t === 'BUTTON' && ['submit', ''].includes(lower(attr(el, 'type') || ''))) || (t === 'INPUT' && ['submit', 'image'].includes(inputType(el)));
      if (isSubmit && (fEl || visible(el)) && target.submit.length < 6) {
        if (visible(el)) target.submit.push({ ref: refOf(el), label: clip(nameOf(el) || 'Submit', 60) });
        continue;
      }
      if (!isField(el)) continue;
      if (!visible(el) && !(t === 'INPUT' && ['checkbox', 'radio'].includes(inputType(el)) && el.parentNode && visible(el.parentNode))) continue;
      const d = describeField(el);
      const common = { ref: refOf(el), label: d.label, name: d.name, required: Boolean(el.required || attr(el, 'aria-required') === 'true'), placeholder: d.placeholder || undefined, disabled: Boolean(el.disabled) || undefined, raw: d };
      const inv = attr(el, 'aria-invalid') === 'true' || matches(el, ':user-invalid');
      if (inv) common.invalid = clip(el.validationMessage || 'invalid', 160);
      if (t === 'INPUT' && inputType(el) === 'radio') {
        const key = (fEl ? out.indexOf(target) : -1) + '|' + (d.name || d.id);
        let g = groups.get(key);
        if (!g) {
          const legend = el.closest && el.closest('fieldset') ? el.closest('fieldset').querySelector('legend') : null;
          g = Object.assign({}, common, { label: legend ? clip(textOf(legend), 120) : (d.name || d.label), type: 'radio-group', value: '', options: [] });
          groups.set(key, g);
          target.fields.push(g);
        }
        g.options.push({ value: el.value || attr(el, 'value') || '', label: clip(labelFor(el), 80), selected: Boolean(el.checked), ref: refOf(el) });
        if (el.checked) g.value = el.value || '';
        if (el.required) g.required = true;
        continue;
      }
      let value = '';
      let type = d.type;
      const f = Object.assign({}, common, { type });
      if (t === 'SELECT') {
        f.options = Array.from(el.options || []).slice(0, 200).map(o => ({ value: o.value, label: clip(o.text || o.label, 80), selected: Boolean(o.selected) }));
        value = el.value || '';
        f.type = el.multiple ? 'select-multiple' : 'select';
      } else if (t === 'INPUT' && inputType(el) === 'checkbox') {
        f.checked = Boolean(el.checked);
        value = el.value || 'on';
      } else if (t === 'INPUT' && inputType(el) === 'password') {
        value = el.value ? '(filled)' : '';
      } else if (t === 'INPUT' && inputType(el) === 'file') {
        value = el.files && el.files.length ? Array.from(el.files).map(x => x.name).join(', ') : '';
      } else if (t === 'INPUT' || t === 'TEXTAREA') {
        value = el.value != null ? String(el.value) : (attr(el, 'value') || '');
      } else {
        f.type = 'contenteditable';
        value = textOf(el);
      }
      f.value = clip(value, 300);
      target.fields.push(f);
    }
    if (loose.fields.length) { loose.index = out.length; out.push(loose); }
    return out.filter(f => f.fields.length || f.submit.length).slice(0, 30);
  };

  // ── Extraction ──
  const extract = () => {
    const kind = A.kind;
    const els = allElements(docRoot());
    if (kind === 'links') {
      const seen = {}; const out = [];
      for (const a of els) {
        if (tag(a) !== 'A' || !attr(a, 'href') || !visible(a)) continue;
        const href = abs(attr(a, 'href'), a);
        if (/^javascript:/i.test(href) || seen[href]) continue;
        seen[href] = 1;
        out.push({ text: clip(nameOf(a), 120), href, rel: attr(a, 'rel') || undefined, ref: refOf(a) });
        if (out.length >= 600) break;
      }
      return { links: out };
    }
    if (kind === 'tables') {
      const out = [];
      for (const tb of els) {
        if (tag(tb) !== 'TABLE' || !rendered(tb) || (tb.querySelector && tb.querySelector('table'))) continue;
        const rows = [];
        for (const tr of allElements(tb, { frames: false })) {
          if (tag(tr) !== 'TR') continue;
          const cells = kids(tr).filter(c => isEl(c) && (tag(c) === 'TD' || tag(c) === 'TH')).map(c => clip(textOf(c), 200));
          if (cells.length) rows.push(cells);
          if (rows.length >= 300) break;
        }
        if (rows.length < 2 || Math.max(...rows.map(r => r.length)) < 2) continue;
        const cap = tb.querySelector ? tb.querySelector('caption') : null;
        let caption = cap ? clip(textOf(cap), 160) : '';
        if (!caption) { let p = tb.previousElementSibling; for (let i = 0; p && i < 3; i++, p = p.previousElementSibling) if (/^H[1-6]$/.test(tag(p))) { caption = clip(textOf(p), 160); break; } }
        out.push({ caption, rows });
        if (out.length >= 20) break;
      }
      return { tables: out };
    }
    if (kind === 'prices') {
      const blocks = [];
      const structured = [];
      for (const el of els) {
        const ip = attr(el, 'itemprop');
        if (ip === 'price' || ip === 'lowPrice' || ip === 'highPrice') {
          const cur = el.closest && el.closest('[itemscope]');
          const ce = cur && cur.querySelector ? cur.querySelector('[itemprop=priceCurrency]') : null;
          const nm = cur && cur.querySelector ? cur.querySelector('[itemprop=name]') : null;
          structured.push({ amount: attr(el, 'content') || clean(textOf(el)), currency: ce ? (attr(ce, 'content') || clean(textOf(ce))) : '', context: nm ? clip(textOf(nm), 120) : '', source: 'microdata' });
        }
        if (tag(el) === 'META') {
          const p = attr(el, 'property') || attr(el, 'name') || '';
          if (/^(product|og):price:amount$/.test(p)) {
            const c = doc.querySelector && doc.querySelector('meta[property="' + p.replace('amount', 'currency') + '"]');
            structured.push({ amount: attr(el, 'content') || '', currency: c ? attr(c, 'content') || '' : '', context: doc.title || '', source: 'meta' });
          }
        }
        if (tag(el) === 'SCRIPT' && attr(el, 'type') === 'application/ld+json') {
          try {
            const walk = (o, name) => {
              if (!o || typeof o !== 'object') return;
              if (Array.isArray(o)) { o.forEach(x => walk(x, name)); return; }
              const nm = typeof o.name === 'string' ? o.name : name;
              if (o.price != null || o.lowPrice != null) structured.push({ amount: String(o.price != null ? o.price : o.lowPrice), currency: o.priceCurrency || '', context: clip(nm || '', 120), source: 'json-ld' });
              for (const k of Object.keys(o)) if (typeof o[k] === 'object') walk(o[k], nm);
            };
            walk(JSON.parse(el.textContent || 'null'), '');
          } catch (e) { /* malformed JSON-LD */ }
        }
        if (!visible(el) || blocks.length >= 400) continue;
        const own = Array.from(el.childNodes || []).filter(n => n.nodeType === 3).map(n => n.nodeValue).join(' ');
        const text = clean(textOf(el));
        if (text.length > 200 || !/\d/.test(text)) continue;
        if (!/[$€£¥₹₨₩₪₫₱₦₴₺฿₽]|\b(USD|EUR|GBP|JPY|INR|PKR|AED|SAR|CAD|AUD|CHF|CNY|RMB|SEK|NOK|DKK|PLN|TRY|BRL|MXN|ZAR|SGD|HKD|NZD|KRW|Rs\.?|Rp|RM|kr|zł)\b/i.test(text)) continue;
        if (!/\d/.test(own) && el.children && el.children.length > 2) continue;
        let ctxText = '';
        let p = el.parentNode;
        for (let i = 0; p && isEl(p) && i < 6 && !ctxText; i++, p = p.parentNode) {
          const h = p.querySelector && p.querySelector('h1,h2,h3,h4,[itemprop=name],[class*="title"],[class*="name"]');
          if (h && h !== el && !h.contains(el)) ctxText = clip(textOf(h), 120);
        }
        blocks.push({ text, context: ctxText });
      }
      return { blocks, structured: structured.slice(0, 100) };
    }
    if (kind === 'contacts') {
      const links = [];
      for (const a of els) {
        const h = attr(a, 'href') || '';
        if (tag(a) === 'A' && /^(mailto|tel|sms|whatsapp):/i.test(h)) links.push({ href: h, text: clip(textOf(a), 80) });
        if (links.length >= 200) break;
      }
      const body = doc.body;
      return { links, text: body ? textOf(body).slice(0, 200000) : '' };
    }
    if (kind === 'outline') {
      const out = [];
      for (const h of els) {
        if (!/^H[1-6]$/.test(tag(h)) || !visible(h)) continue;
        const text = clip(textOf(h), 160);
        if (text) out.push({ level: Number(tag(h)[1]), text, ref: refOf(h), id: attr(h, 'id') || undefined });
        if (out.length >= 400) break;
      }
      return { outline: out };
    }
    if (kind === 'metadata') {
      const meta = {}; const og = {}; const twitter = {}; const jsonLd = []; const feeds = []; const icons = [];
      let canonical = '';
      for (const el of els) {
        const t = tag(el);
        if (t === 'META') {
          const k = attr(el, 'property') || attr(el, 'name') || attr(el, 'itemprop') || attr(el, 'http-equiv');
          const v = attr(el, 'content');
          if (!k || v == null) continue;
          if (/^og:/i.test(k)) og[k.slice(3)] = clip(v, 500);
          else if (/^twitter:/i.test(k)) twitter[k.slice(8)] = clip(v, 500);
          else if (Object.keys(meta).length < 60) meta[k] = clip(v, 500);
        } else if (t === 'LINK') {
          const rel = lower(attr(el, 'rel'));
          const href = abs(attr(el, 'href') || '', el);
          if (rel === 'canonical') canonical = href;
          if (rel.includes('alternate') && /rss|atom|feed/i.test(attr(el, 'type') || '')) feeds.push({ title: attr(el, 'title') || '', href });
          if (rel.includes('icon')) icons.push(href);
        } else if (t === 'SCRIPT' && attr(el, 'type') === 'application/ld+json' && jsonLd.length < 10) {
          try { jsonLd.push(JSON.parse(el.textContent || 'null')); } catch (e) { jsonLd.push({ error: 'unparseable JSON-LD' }); }
        }
      }
      const html = doc.documentElement;
      return { url: pageUrl(), title: doc.title || '', lang: html ? attr(html, 'lang') || '' : '', canonical, description: meta.description || og.description || '', meta, openGraph: og, twitter, jsonLd, feeds, icons: icons.slice(0, 6) };
    }
    return { error: 'Unknown kind ' + kind };
  };

  // ── Insights signals ──
  const insights = () => {
    const els = allElements(docRoot());
    const body = doc.body;
    const text = body ? textOf(body) : '';
    const vis = (el) => visible(el);
    let forms = 0; let passwords = 0; let inputs = 0; let search = 0; let links = 0; let images = 0; let videos = 0; let tables = 0; let articles = 0;
    const h1 = []; const jsonLdTypes = []; let cartButton = ''; let cookie = false; let paywallEl = false; let isFree = null;
    const buttons = [];
    const vw = real ? win.innerWidth : 1200; const vh = real ? win.innerHeight : 800;
    for (const el of els) {
      const t = tag(el);
      if (t === 'FORM') forms++;
      else if (t === 'A' && attr(el, 'href')) links++;
      else if (t === 'IMG') images++;
      else if (t === 'VIDEO' || (t === 'IFRAME' && /youtube|vimeo|player/i.test(attr(el, 'src') || ''))) videos++;
      else if (t === 'TABLE') tables++;
      else if (t === 'ARTICLE') articles++;
      else if (t === 'H1' && vis(el)) h1.push(clip(textOf(el), 120));
      else if (t === 'SCRIPT' && attr(el, 'type') === 'application/ld+json') {
        try {
          const walk = (o) => { if (!o || typeof o !== 'object') return; if (Array.isArray(o)) { o.forEach(walk); return; } if (o['@type']) jsonLdTypes.push([].concat(o['@type']).join('/')); if (o.isAccessibleForFree === false || o.isAccessibleForFree === 'False') isFree = false; if (o['@graph']) walk(o['@graph']); };
          walk(JSON.parse(el.textContent || 'null'));
        } catch (e) { /* ignore */ }
      }
      if (isField(el) && vis(el)) {
        inputs++;
        if (t === 'INPUT' && inputType(el) === 'password') passwords++;
        if ((t === 'INPUT' && inputType(el) === 'search') || /^(q|query|search|s|keywords?)$/i.test(attr(el, 'name') || '') || attr(el, 'role') === 'searchbox') search++;
      }
      const ci = classId(el);
      if (!cookie && /cookie|consent|gdpr|onetrust|cookiebot|didomi|qc-cmp|truste|usercentrics|sp_message|osano|termly|iubenda|cmp-container|cc-banner|cc-window/i.test(ci) && vis(el)) {
        const s = styleOf(el);
        const r = real ? el.getBoundingClientRect() : { width: 0, height: 0 };
        if (!real || (s && (s.position === 'fixed' || s.position === 'sticky')) || (r.width > vw * 0.5 && r.height > 60)) {
          if (/cookie|consent|privacy|accept|reject/i.test(textOf(el).slice(0, 2000))) cookie = true;
        }
      }
      if (!paywallEl && /paywall|piano-|tp-modal|tp-container|subscriber-only|premium-content|regwall|meteredContent/i.test(ci) && vis(el)) paywallEl = true;
      if (matches(el, 'button, a[href], [role=button], input[type=submit]') && vis(el) && buttons.length < 400) {
        const label = clip(nameOf(el), 50);
        if (!label) continue;
        if (!cartButton && /add to (cart|bag|basket)|buy now|add to trolley/i.test(label)) cartButton = label;
        if (real) {
          const r = el.getBoundingClientRect();
          if (r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw) buttons.push({ label, area: r.width * r.height, top: r.top, cls: ci, tag: lower(t) });
        } else buttons.push({ label, area: 1000, top: 0, cls: ci, tag: lower(t) });
      }
    }
    const ogType = doc.querySelector && doc.querySelector('meta[property="og:type"]');
    const status = doc.querySelector && doc.querySelector('meta[name="aico-status"]');
    return {
      url: pageUrl(), title: doc.title || '', contentType: doc.contentType || 'text/html',
      words: clean(text).split(' ').filter(Boolean).length, textStart: clean(text).slice(0, 3000),
      counts: { forms, passwords, inputs, search, links, images, videos, tables, articles },
      h1, ogType: ogType ? attr(ogType, 'content') || '' : '', jsonLdTypes: jsonLdTypes.slice(0, 20), isAccessibleForFree: isFree,
      cartButton, cookieBanner: cookie, paywallElement: paywallEl, buttons: buttons.slice(0, 120), statusMeta: status ? attr(status, 'content') : '',
      human: humanSignals(),
    };
  };

  // ── Find text ──
  const find = () => {
    const want = lower(clean(A.text || ''));
    if (!want) return { count: 0, matches: [] };
    const out = []; let count = 0;
    const limit = Math.min(Number(A.limit) || 20, 100);
    for (const el of allElements(docRoot())) {
      if (!rendered(el) || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE', 'HEAD'].includes(tag(el))) continue;
      for (const n of kids(el)) {
        if (n.nodeType !== 3) continue;
        const v = n.nodeValue || '';
        const low = lower(v.replace(/\s+/g, ' '));
        let i = low.indexOf(want);
        if (i >= 0 && hiddenDeep(el)) continue;
        while (i >= 0) {
          count++;
          if (out.length < limit) {
            let target = el;
            const ia = el.closest ? el.closest('a,button,label,[role=button],[role=link],summary,li,td,p,h1,h2,h3,h4,h5,h6') : null;
            if (ia) target = ia;
            if (visible(target) || visible(el)) {
              const flat = v.replace(/\s+/g, ' ');
              out.push({ ref: refOf(target), tag: lower(tag(target)), context: clean(flat.slice(Math.max(0, i - 60), i + want.length + 60)) });
            }
          }
          i = low.indexOf(want, i + want.length);
        }
      }
    }
    return { count, matches: out };
  };

  // ── Focused element (deep) ──
  const focused = () => {
    let el = doc.activeElement;
    for (let i = 0; el && i < 10; i++) {
      if (el.shadowRoot && el.shadowRoot.activeElement) { el = el.shadowRoot.activeElement; continue; }
      if ((tag(el) === 'IFRAME' || tag(el) === 'FRAME') && frameDoc(el) && frameDoc(el).activeElement) { el = frameDoc(el).activeElement; continue; }
      break;
    }
    if (!el || tag(el) === 'BODY' || tag(el) === 'HTML') return { none: true };
    return { field: describeField(el), isField: isField(el), tag: lower(tag(el)), label: clip(nameOf(el), 60) };
  };

  // ── Set a value (selects, dates, ranges, colours) ──
  const setValue = () => {
    const f = findTarget(A.target || {});
    if (f.error) return f;
    const el = f.el;
    const t = tag(el);
    const v = String(A.value == null ? '' : A.value);
    const fire = () => { el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
    if (t === 'SELECT') {
      const want = lower(v);
      const opts = Array.from(el.options);
      const opt = opts.find(o => lower(o.value) === want || lower(clean(o.text)) === want) || opts.find(o => lower(o.text).includes(want));
      if (!opt) return { error: 'No option matches "' + v + '". Options: ' + opts.map(o => clean(o.text)).slice(0, 40).join(', ') };
      el.value = opt.value; fire();
      return { ok: 'Selected "' + clean(opt.text) + '"' };
    }
    if (t === 'INPUT') {
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value') || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      if (desc && desc.set) desc.set.call(el, v); else el.value = v;
      fire();
      return { ok: 'Set to "' + el.value + '"' };
    }
    return { error: 'Cannot set a value on <' + lower(t) + '>.' };
  };

  switch (op) {
    case 'snapshot': return snapshot();
    case 'locate': return locate();
    case 'highlight': { const f = findTarget(A.target || {}); if (f.error) return f; highlight(rectOf(f.el), A.label); return { ok: true }; }
    case 'read': return read();
    case 'forms': return forms();
    case 'extract': return extract();
    case 'insights': return insights();
    case 'humanCheck': return humanSignals();
    case 'probe': return probe();
    case 'find': return find();
    case 'focused': return focused();
    case 'setValue': return setValue();
    // The element itself (evaluated with returnByValue: false, for DOM.setFileInputFiles).
    case 'element': { const f = findTarget(A.target || {}); return f.el || null; }
    default: return { error: 'unknown op ' + op };
  }
}
