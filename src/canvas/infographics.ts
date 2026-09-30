/**
 * Infographic blocks — `stats`, `timeline`, `steps`, `comparison`, `callout` —
 * parsed once for every export format.
 *
 * ## Why fenced JSON (and Markdown for callouts)
 *
 * The chat's widgets are fenced JSON, so a model already writes them reliably,
 * and a plain Markdown viewer shows a readable code block rather than garbage.
 * Callouts are prose, so their body stays Markdown with the kind in the info
 * string (```` ```callout warn ````). The syntax is the contract in
 * `docs/engineering/canvas-docs-contract.md`; the app renders the same blocks.
 *
 * Parsing is lenient where it costs nothing (an array alone means `items`,
 * numbers become strings) and strict where it matters (a block that yields no
 * items is an error, shown in the export as the source with the reason).
 *
 * @module canvas/infographics
 */

export type InfographicKind = 'stats' | 'timeline' | 'steps' | 'comparison' | 'callout';

export interface StatItem { value: string; label: string; delta?: string; trend: 'up' | 'down' | 'flat' }
export interface TimelineItem { date: string; title: string; text?: string }
export interface StepItem { title: string; text?: string }
export interface ComparisonColumn { title: string; items: string[]; highlight: boolean; footer?: string }
export interface Callout { type: 'info' | 'warn' | 'success'; title?: string; body: string }

export type Infographic =
  | { kind: 'stats'; items: StatItem[] }
  | { kind: 'timeline'; items: TimelineItem[] }
  | { kind: 'steps'; items: StepItem[] }
  | { kind: 'comparison'; columns: ComparisonColumn[] }
  | { kind: 'callout'; callout: Callout };

const KINDS: Record<string, InfographicKind> = {
  stats: 'stats', kpi: 'stats', kpis: 'stats', timeline: 'timeline', steps: 'steps', process: 'steps',
  comparison: 'comparison', compare: 'comparison', callout: 'callout',
};

export function infographicKind(lang: string | null | undefined): InfographicKind | undefined {
  return lang ? KINDS[lang.toLowerCase()] : undefined;
}

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v)).trim();

function items(source: string, key = 'items'): unknown[] {
  const parsed: unknown = JSON.parse(source);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    const list = (parsed as Record<string, unknown>)[key];
    if (Array.isArray(list)) return list;
  }
  throw new Error(`expected {"${key}": [...]}`);
}

function calloutType(v: string): Callout['type'] {
  const t = v.toLowerCase();
  if (t === 'warn' || t === 'warning' || t === 'caution' || t === 'danger') return 'warn';
  if (t === 'success' || t === 'ok' || t === 'tip' || t === 'done') return 'success';
  return 'info';
}

/** Parse a block, or say why not. */
export function parseInfographic(kind: InfographicKind, source: string, meta?: string | null):
  { ok: true; value: Infographic } | { ok: false; error: string } {
  try {
    switch (kind) {
      case 'stats': {
        const list = items(source).map((raw) => {
          const o = (raw ?? {}) as Record<string, unknown>;
          const delta = str(o.delta ?? o.change);
          const t = str(o.trend).toLowerCase();
          const trend: StatItem['trend'] = t === 'up' || t === 'down' || t === 'flat' ? t
            : /^\s*[-−–]/.test(delta) ? 'down' : delta ? 'up' : 'flat';
          return { value: str(o.value), label: str(o.label ?? o.title), ...(delta ? { delta } : {}), trend };
        }).filter(i => i.value || i.label).slice(0, 6);
        if (!list.length) throw new Error('no tiles');
        return { ok: true, value: { kind, items: list } };
      }
      case 'timeline': {
        const list = items(source).map((raw) => {
          const o = (raw ?? {}) as Record<string, unknown>;
          const text = str(o.text ?? o.description);
          return { date: str(o.date ?? o.when), title: str(o.title ?? o.event), ...(text ? { text } : {}) };
        }).filter(i => i.date || i.title);
        if (!list.length) throw new Error('no events');
        return { ok: true, value: { kind, items: list } };
      }
      case 'steps': {
        const list = items(source).map((raw) => {
          if (typeof raw === 'string') return { title: raw.trim() };
          const o = (raw ?? {}) as Record<string, unknown>;
          const text = str(o.text ?? o.description);
          return { title: str(o.title ?? o.step), ...(text ? { text } : {}) };
        }).filter(i => i.title);
        if (!list.length) throw new Error('no steps');
        return { ok: true, value: { kind, items: list } };
      }
      case 'comparison': {
        const cols = items(source, 'columns').map((raw) => {
          const o = (raw ?? {}) as Record<string, unknown>;
          const list = Array.isArray(o.items) ? o.items.map(str).filter(Boolean) : [];
          const footer = str(o.footer ?? o.verdict);
          return { title: str(o.title ?? o.name), items: list, highlight: o.highlight === true, ...(footer ? { footer } : {}) };
        }).filter(c => c.title || c.items.length).slice(0, 4);
        if (cols.length < 2) throw new Error('a comparison needs 2–4 columns');
        return { ok: true, value: { kind, columns: cols } };
      }
      case 'callout': {
        const trimmed = source.trim();
        if (trimmed.startsWith('{')) {
          const o = JSON.parse(trimmed) as Record<string, unknown>;
          const title = str(o.title);
          return { ok: true, value: { kind, callout: { type: calloutType(str(o.type ?? meta)), ...(title ? { title } : {}), body: str(o.text ?? o.body) } } };
        }
        const lines = trimmed.split('\n');
        const m = /^\*\*(.+?)\*\*\s*$/.exec(lines[0] ?? '');
        const title = m ? m[1]!.trim() : undefined;
        const body = (m ? lines.slice(1) : lines).join('\n').trim();
        return { ok: true, value: { kind, callout: { type: calloutType(str(meta).split(/\s+/)[0] ?? ''), ...(title ? { title } : {}), body } } };
      }
    }
  } catch (err) {
    return { ok: false, error: `${kind} block: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export const CALLOUT_COLORS: Record<Callout['type'], { fill: string; border: string; ink: string; label: string }> = {
  info: { fill: 'EFF6FF', border: '3B82F6', ink: '1E3A8A', label: 'Note' },
  warn: { fill: 'FFFBEB', border: 'F59E0B', ink: '78350F', label: 'Warning' },
  success: { fill: 'F0FDF4', border: '22C55E', ink: '14532D', label: 'Success' },
};

// ── HTML ────────────────────────────────────────────────────────────

function esc(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Render an infographic to HTML. `md` renders a callout body (Markdown → HTML). */
export function infographicHtml(g: Infographic, md: (source: string) => string): string {
  switch (g.kind) {
    case 'stats':
      return `<div class="ig-stats">${g.items.map(i => `<div class="ig-stat"><div class="ig-value">${esc(i.value)}</div>`
        + `<div class="ig-label">${esc(i.label)}</div>${i.delta ? `<div class="ig-delta ig-${i.trend}">${i.trend === 'up' ? '▲' : i.trend === 'down' ? '▼' : '■'} ${esc(i.delta)}</div>` : ''}</div>`).join('')}</div>`;
    case 'timeline':
      return `<ol class="ig-timeline">${g.items.map(i => `<li><div class="ig-date">${esc(i.date)}</div><div class="ig-body"><strong>${esc(i.title)}</strong>`
        + `${i.text ? `<div>${esc(i.text)}</div>` : ''}</div></li>`).join('')}</ol>`;
    case 'steps':
      return `<ol class="ig-steps">${g.items.map((i, n) => `<li><span class="ig-num">${n + 1}</span><div><strong>${esc(i.title)}</strong>`
        + `${i.text ? `<div>${esc(i.text)}</div>` : ''}</div></li>`).join('')}</ol>`;
    case 'comparison':
      return `<div class="ig-compare" style="grid-template-columns:repeat(${g.columns.length},1fr)">${g.columns.map(c =>
        `<div class="ig-col${c.highlight ? ' ig-hl' : ''}"><div class="ig-col-title">${esc(c.title)}</div><ul>${c.items.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`
        + `${c.footer ? `<div class="ig-col-foot">${esc(c.footer)}</div>` : ''}</div>`).join('')}</div>`;
    case 'callout': {
      const c = CALLOUT_COLORS[g.callout.type];
      return `<div class="ig-callout" style="background:#${c.fill};border-left-color:#${c.border};color:#${c.ink}">`
        + `<div class="ig-callout-title">${esc(g.callout.title ?? c.label)}</div>${md(g.callout.body)}</div>`;
    }
  }
}

export const INFOGRAPHIC_CSS = `
  .ig-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin: 0 0 1.2em; break-inside: avoid; }
  .ig-stat { border: 1px solid #e4e4e7; border-radius: 10px; padding: 14px 16px; background: #fafafa; }
  .ig-value { font-size: 1.7em; font-weight: 700; line-height: 1.15; }
  .ig-label { color: #52525b; font-size: 0.9em; margin-top: 2px; }
  .ig-delta { font-size: 0.85em; margin-top: 6px; font-weight: 600; }
  .ig-up { color: #15803d; } .ig-down { color: #b91c1c; } .ig-flat { color: #71717a; }
  .ig-timeline { list-style: none; padding: 0; margin: 0 0 1.2em; border-left: 2px solid #d4d4d8; break-inside: avoid; }
  .ig-timeline li { position: relative; padding: 0 0 12px 18px; display: flex; gap: 12px; }
  .ig-timeline li::before { content: ''; position: absolute; left: -6px; top: 6px; width: 10px; height: 10px; border-radius: 50%; background: #2563eb; }
  .ig-date { min-width: 90px; color: #2563eb; font-weight: 600; }
  .ig-steps { list-style: none; padding: 0; margin: 0 0 1.2em; break-inside: avoid; }
  .ig-steps li { display: flex; gap: 12px; margin-bottom: 10px; align-items: flex-start; }
  .ig-num { flex: none; width: 26px; height: 26px; border-radius: 50%; background: #2563eb; color: #fff; display: inline-flex; align-items: center; justify-content: center; font-weight: 700; font-size: 0.85em; }
  .ig-compare { display: grid; gap: 12px; margin: 0 0 1.2em; break-inside: avoid; }
  .ig-col { border: 1px solid #e4e4e7; border-radius: 10px; padding: 12px 14px; }
  .ig-col.ig-hl { border-color: #2563eb; box-shadow: 0 0 0 1px #2563eb inset; }
  .ig-col-title { font-weight: 700; margin-bottom: 6px; }
  .ig-col ul { margin: 0; padding-left: 1.1em; }
  .ig-col-foot { margin-top: 8px; font-size: 0.9em; color: #52525b; border-top: 1px solid #e4e4e7; padding-top: 6px; }
  .ig-callout { border-left: 4px solid; border-radius: 6px; padding: 10px 14px; margin: 0 0 1.2em; break-inside: avoid; }
  .ig-callout-title { font-weight: 700; margin-bottom: 4px; }
  .ig-callout p:last-child { margin-bottom: 0; }
`;

// ── Image attributes ────────────────────────────────────────────────

export interface ImageAttrs { width?: string; align?: 'left' | 'center' | 'right' }

/** Read a Pandoc-style `{width=60% align=center}` at the start of `text`. */
export function parseImageAttrs(text: string): { attrs: ImageAttrs; rest: string } | undefined {
  const m = /^\{([^{}\n]{1,200})\}/.exec(text);
  if (!m) return undefined;
  const attrs: ImageAttrs = {};
  for (const part of m[1]!.matchAll(/([a-z]+)\s*=\s*("([^"]*)"|[^\s]+)/gi)) {
    const key = part[1]!.toLowerCase();
    const value = (part[3] ?? part[2]!).trim();
    if (key === 'width' && /^\d{1,4}(\.\d+)?(%|px)?$/.test(value)) attrs.width = /\d$/.test(value) ? `${value}px` : value;
    if (key === 'align' && (value === 'left' || value === 'center' || value === 'right')) attrs.align = value;
  }
  return { attrs, rest: text.slice(m[0].length) };
}

// ── The editor's alternative spellings ──────────────────────────────

const ALERTS: Record<string, Callout['type']> = { NOTE: 'info', IMPORTANT: 'info', TIP: 'success', WARNING: 'warn', CAUTION: 'warn' };

/**
 * Rewrite the two spellings the canvas editor also reads — GitHub alerts
 * (`> [!WARNING]`) and the `#aico:w=60,align=center` image fragment — into the
 * contract's forms, so every writer handles one syntax. Fenced code is left alone.
 */
export function normalizeAlternateSyntax(markdown: string): string {
  const lines = markdown.split('\n');
  const out: string[] = [];
  let fence: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) { if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length) fence = undefined; out.push(line); continue; }
    if (f) { fence = f[1]!; out.push(line); continue; }
    const alert = /^ {0,3}>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i.exec(line);
    if (alert) {
      const body: string[] = alert[2] ? [alert[2]] : [];
      while (i + 1 < lines.length && /^ {0,3}>/.test(lines[i + 1]!)) body.push(lines[++i]!.replace(/^ {0,3}>\s?/, ''));
      const kind = alert[1]!.toUpperCase();
      out.push(`\`\`\`\`callout ${ALERTS[kind]}`, `**${kind.charAt(0)}${kind.slice(1).toLowerCase()}**`, ...body, '````');
      continue;
    }
    out.push(line.replace(/!\[([^\]]*)\]\(([^)\s#]+)#aico:([^)\s"]*)(\s+"[^"]*")?\)/g, (_m, alt: string, src: string, frag: string, title?: string) => {
      const kv = Object.fromEntries(frag.split(',').map(p => p.split('=').map(x => x.trim())).filter(p => p.length === 2));
      const attrs = [kv.w && /^\d{1,3}$/.test(kv.w) ? `width=${kv.w}%` : '', kv.align && /^(left|center|right)$/.test(kv.align) ? `align=${kv.align}` : '']
        .filter(Boolean).join(' ');
      return `![${alt}](${src}${title ?? ''})${attrs ? `{${attrs}}` : ''}`;
    }));
  }
  return out.join('\n');
}
