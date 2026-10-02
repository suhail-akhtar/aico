// @ts-nocheck — this function runs inside web pages (serialised with toString), not in main.
/**
 * Teach AICO, the in-page half: the recorder that watches the person, and the
 * candidate list replay scores against.
 *
 * Like browser-page.ts it is SELF-CONTAINED (serialised with toString and run
 * through the DevTools protocol), reports raw facts only, and leaves every
 * verdict to main (browser-teach-core.ts): main decides roles, names, what is
 * a secret and what matches.
 *
 * `record` runs in AICO's own isolated world (browser-teach.ts installs it
 * there for every document of the recorded tab), so the page cannot see the
 * recorder, call its reporting binding, or forge steps: only trusted events
 * (`isTrusted` — the person's own input) are reported, through a binding that
 * exists only in that world.
 *
 * IT NEVER READS A SECRET. A field that looks like a password, card, CVV or
 * one-time code is reported without its value — main re-checks with the
 * browser's own rule and drops any value anyway (belt and braces). Text
 * fields are read once, when the person leaves them (`change`) or presses
 * Enter — never keystroke by keystroke.
 *
 * Operations: record (args { binding }), candidates, value (args { ref }), url.
 *
 * @module desktop/electron/browser-teach-page
 */

export function aicoTeachPage(op, args, envIn) {
  const env = envIn || { document: document, window: window };
  const doc = env.document;
  const win = env.window || {};
  const A = args || {};

  const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const clip = (s, n) => { const t = clean(s); return t.length > n ? t.slice(0, n) : t; };
  const attr = (el, n) => (el && el.getAttribute ? el.getAttribute(n) : null);
  const tagOf = (el) => String((el && el.tagName) || '').toLowerCase();
  const textOf = (el) => (el ? clip(typeof el.innerText === 'string' ? el.innerText : el.textContent, 120) : '');
  const typeOf = (el) => String(attr(el, 'type') || (tagOf(el) === 'input' ? 'text' : '')).toLowerCase();
  const esc = (s) => { try { return win.CSS && win.CSS.escape ? win.CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'); } catch (e) { return String(s); } };
  const TEXTLIKE = ['text', 'email', 'tel', 'url', 'search', 'number', 'password', 'date', 'time', 'datetime-local', 'month', 'week', ''];
  const isTextField = (el) => (tagOf(el) === 'input' && TEXTLIKE.includes(typeOf(el))) || tagOf(el) === 'textarea';
  /** A quick, generous check made BEFORE a value is read: when in doubt, the value is not sent. */
  const looksSecret = (el) => {
    const t = typeOf(el);
    if (t === 'password') return true;
    const ac = String(attr(el, 'autocomplete') || '').toLowerCase();
    if (/password|cc-|one-time-code/.test(ac)) return true;
    const words = `${attr(el, 'name') || ''} ${attr(el, 'id') || ''} ${attr(el, 'aria-label') || ''} ${attr(el, 'placeholder') || ''}`.toLowerCase();
    return /passw|passcode|passphrase|\bpwd\b|cvv|cvc|\bcsc\b|\botp\b|one.?time|card.?(num|no)|cardnumber|security.?code|verification.?code|\bpin\b/.test(words);
  };

  /** A label's own words: a <label> wrapping a <select> would otherwise read out every option. */
  const labelWords = (l) => {
    try {
      const c = l.cloneNode(true);
      Array.prototype.forEach.call(c.querySelectorAll('select, textarea, option, datalist'), (x) => x.remove());
      return clip(c.textContent, 120);
    } catch (e) { return textOf(l); }
  };
  const labelText = (el) => {
    try { if (el.labels && el.labels.length) return clip(Array.prototype.map.call(el.labels, (l) => labelWords(l)).join(' '), 120); } catch (e) { /* no labels API */ }
    const id = attr(el, 'id');
    if (id) { try { const l = doc.querySelector('label[for="' + esc(id) + '"]'); if (l) return labelWords(l); } catch (e) { /* bad id */ } }
    const wrap = el.closest ? el.closest('label') : null;
    return wrap ? labelWords(wrap) : '';
  };
  const labelledBy = (el) => {
    const ids = attr(el, 'aria-labelledby');
    if (!ids) return '';
    return clip(ids.split(/\s+/).map((i) => { const x = doc.getElementById(i); return x ? textOf(x) : ''; }).join(' '), 120);
  };
  const nearby = (el) => {
    const fs = el.closest ? el.closest('fieldset') : null;
    if (fs) { const lg = fs.querySelector('legend'); if (lg) return textOf(lg); }
    let n = el;
    for (let depth = 0; n && depth < 6; depth++) {
      let s = n.previousElementSibling; let hops = 0;
      while (s && hops < 12) {
        if (/^H[1-6]$/.test(String(s.tagName))) return textOf(s);
        const h = s.querySelector ? s.querySelector('h1,h2,h3,h4,h5,h6,legend') : null;
        if (h) return textOf(h);
        s = s.previousElementSibling; hops++;
      }
      n = n.parentElement;
    }
    return '';
  };
  const formOf = (el) => {
    const f = el.form || (el.closest ? el.closest('form') : null);
    if (!f) return '';
    const action = attr(f, 'action');
    let path = '';
    if (action) { try { path = new URL(action, doc.baseURI).pathname; } catch (e) { path = action; } }
    return clip(attr(f, 'id') || attr(f, 'name') || attr(f, 'aria-label') || (path ? 'action ' + path : 'form'), 80);
  };
  const generated = (id) => /\d{3,}|[a-f0-9]{8,}|^(ember|react|radix|mui|headlessui|:r)/i.test(id);
  const cssOf = (el) => {
    const id = attr(el, 'id');
    if (id && !generated(id)) return '#' + esc(id);
    const parts = [];
    let n = el;
    for (let i = 0; n && n.nodeType === 1 && i < 6 && tagOf(n) !== 'html'; i++) {
      let p = tagOf(n);
      const nm = attr(n, 'name');
      if (nm && i === 0) p += '[name="' + esc(nm) + '"]';
      const parent = n.parentElement;
      if (parent) {
        const same = Array.prototype.filter.call(parent.children, (c) => c.tagName === n.tagName);
        if (same.length > 1) p += ':nth-of-type(' + (same.indexOf(n) + 1) + ')';
      }
      parts.unshift(p);
      n = parent;
    }
    return parts.join(' > ');
  };
  const xpathOf = (el) => {
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1) {
      const parent = n.parentElement;
      const same = parent ? Array.prototype.filter.call(parent.children, (c) => c.tagName === n.tagName) : [n];
      parts.unshift(tagOf(n) + (same.length > 1 ? '[' + (same.indexOf(n) + 1) + ']' : ''));
      n = parent;
    }
    return '/' + parts.join('/');
  };
  const hrefOf = (el) => {
    const h = attr(el, 'href');
    if (!h) return '';
    try { const u = new URL(h, doc.baseURI); return u.origin === (doc.location && doc.location.origin) ? u.pathname + u.search : u.href; } catch (e) { return h; }
  };

  /** Raw facts about one element. Never a text field's value. */
  const rawOf = (el) => {
    const tag = tagOf(el);
    const type = tag === 'input' || tag === 'button' ? typeOf(el) : '';
    const field = tag === 'input' || tag === 'textarea' || tag === 'select';
    const out = {
      tag, ...(type ? { type } : {}),
      roleAttr: attr(el, 'role') || undefined, ariaLabel: clip(attr(el, 'aria-label'), 120) || undefined,
      labelledBy: labelledBy(el) || undefined, labelText: labelText(el) || undefined,
      placeholder: clip(attr(el, 'placeholder'), 80) || undefined, title: clip(attr(el, 'title'), 80) || undefined, alt: clip(attr(el, 'alt'), 80) || undefined,
      text: field ? undefined : (textOf(el) || undefined),
      buttonValue: tag === 'input' && ['submit', 'button', 'reset'].includes(type) ? clip(el.value, 80) : undefined,
      id: attr(el, 'id') || undefined, name: attr(el, 'name') || undefined,
      testId: attr(el, 'data-testid') || attr(el, 'data-test') || attr(el, 'data-qa') || attr(el, 'data-cy') || undefined,
      href: tag === 'a' ? hrefOf(el) || undefined : undefined,
      autocomplete: attr(el, 'autocomplete') || undefined, inputmode: attr(el, 'inputmode') || undefined,
      maxLength: field && el.maxLength > 0 ? el.maxLength : undefined,
      nearby: nearby(el) || undefined, form: formOf(el) || undefined,
      css: cssOf(el), xpath: xpathOf(el),
      checked: type === 'checkbox' || type === 'radio' ? Boolean(el.checked) : (attr(el, 'aria-checked') ? attr(el, 'aria-checked') === 'true' : undefined),
      disabled: Boolean(el.disabled) || attr(el, 'aria-disabled') === 'true' || undefined,
    };
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out;
  };
  const rectOf = (el) => { try { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; } catch (e) { return undefined; } };
  const visible = (el) => {
    try {
      const r = el.getBoundingClientRect();
      const st = (el.ownerDocument.defaultView || win).getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') return false;
      if (r.width > 0 && r.height > 0) return true;
      // A styled checkbox/radio hides the input; its label is what shows.
      const t = typeOf(el);
      if (t === 'checkbox' || t === 'radio') { const l = (el.labels && el.labels[0]) || null; return Boolean(l && l.getBoundingClientRect().width > 0); }
      return false;
    } catch (e) { return true; }
  };
  const SELECTOR = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],[role=textbox],[contenteditable="true"]';
  const nextRef = () => { win.__aicoRefSeq = (win.__aicoRefSeq || 0) + 1; return 'e' + win.__aicoRefSeq; };
  const refOf = (el) => { let r = attr(el, 'data-aico-ref'); if (!r) { r = nextRef(); try { el.setAttribute('data-aico-ref', r); } catch (e) { /* read-only */ } } return r; };

  if (op === 'candidates') {
    const els = Array.prototype.slice.call(doc.querySelectorAll(SELECTOR), 0, 1500);
    return { url: doc.location ? doc.location.href : '', cands: els.map((el) => ({ ...rawOf(el), ref: refOf(el), visible: visible(el) })) };
  }

  if (op === 'url') return { url: doc.location ? doc.location.href : '' };

  if (op === 'value') {
    const el = doc.querySelector('[data-aico-ref="' + String(A.ref).replace(/"/g, '') + '"]');
    if (!el) return { missing: true, url: doc.location ? doc.location.href : '' };
    const out = { url: doc.location ? doc.location.href : '' };
    const t = typeOf(el);
    if (t === 'checkbox' || t === 'radio') out.checked = Boolean(el.checked);
    else if (attr(el, 'aria-checked')) out.checked = attr(el, 'aria-checked') === 'true';
    if (looksSecret(el)) out.sensitive = true;
    else if (tagOf(el) === 'select') { out.value = el.value; const o = el.options && el.options[el.selectedIndex]; out.selectedText = o ? clean(o.text) : ''; }
    else if (isTextField(el)) out.value = el.value;
    return out;
  }

  if (op === 'record') {
    if (win.__aicoTeachOn) return 'already';
    if (win.top !== win) return 'frame';
    win.__aicoTeachOn = true;
    const send = (o) => { try { win[A.binding](JSON.stringify({ ...o, url: doc.location ? doc.location.href : '', vw: win.innerWidth, vh: win.innerHeight })); } catch (e) { /* the recording stopped */ } };
    const sentValue = new WeakMap();
    let lastClick = { el: null, at: 0 };
    const target = (e) => { const p = e.composedPath ? e.composedPath() : []; return (p && p[0] && p[0].nodeType === 1) ? p[0] : e.target; };
    const CLICKABLE = 'a[href],button,input[type=submit],input[type=button],input[type=reset],input[type=image],input[type=checkbox],input[type=radio],summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],label';
    const reportType = (el) => {
      const secret = looksSecret(el);
      const value = secret ? undefined : String(el.value == null ? '' : el.value);
      if (!secret && sentValue.get(el) === value) return;
      sentValue.set(el, secret ? '\u0000' : value);
      send({ kind: 'type', target: rawOf(el), ...(secret ? { secret: true } : { value }), rect: rectOf(el) });
    };
    const clickOn = (el) => {
      const now = Date.now();
      if (lastClick.el === el && now - lastClick.at < 400) return;
      lastClick = { el, at: now };
      send({ kind: 'click', target: rawOf(el), rect: rectOf(el) });
    };
    doc.addEventListener('pointerdown', (e) => {
      if (!e.isTrusted) return;
      const el = target(e);
      const c = el && el.closest ? el.closest(CLICKABLE) || el : el;
      send({ kind: 'pre', rect: c ? rectOf(c) : undefined });
    }, true);
    doc.addEventListener('click', (e) => {
      if (!e.isTrusted) return;
      const el = target(e);
      const c = el && el.closest ? el.closest(CLICKABLE) : null;
      if (!c) return;
      if (tagOf(c) === 'label') {
        const ctl = c.control;
        if (!ctl) return;
        const t = typeOf(ctl);
        // The label forwards the click to its checkbox/radio; report the control once its state has changed.
        if (t === 'checkbox' || t === 'radio') setTimeout(() => clickOn(ctl), 0);
        return;
      }
      if (isTextField(c) || tagOf(c) === 'select') return;
      clickOn(c);
    }, true);
    doc.addEventListener('change', (e) => {
      if (!e.isTrusted) return;
      const el = target(e);
      const tag = tagOf(el);
      if (tag === 'select') {
        const secret = looksSecret(el);
        const o = el.options && el.options[el.selectedIndex];
        send({ kind: 'select', target: rawOf(el), ...(secret ? { secret: true } : { value: el.value, optionText: o ? clean(o.text) : '' }), rect: rectOf(el) });
      } else if (tag === 'input' && typeOf(el) === 'file') {
        send({ kind: 'upload', target: rawOf(el), files: el.files ? el.files.length : 0, rect: rectOf(el) });
      } else if (isTextField(el)) {
        reportType(el);
      }
    }, true);
    doc.addEventListener('keydown', (e) => {
      if (!e.isTrusted || e.key !== 'Enter') return;
      const el = target(e);
      if (!(tagOf(el) === 'input' && isTextField(el))) return;
      reportType(el);
      send({ kind: 'press', key: 'Enter', target: rawOf(el) });
    }, true);
    return 'recording';
  }
  return { error: 'unknown op ' + op };
}
