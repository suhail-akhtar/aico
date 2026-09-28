/**
 * The 18 built-in registry widgets.
 *
 * Ported from the aetnic-ops-v3 prototype, with two deliberate changes:
 *
 *   1. REACT, NOT innerHTML. The prototype built every widget by string
 *      concatenation into innerHTML. That is fine for a mock with static data
 *      and an injection surface the moment `logs.text`, an alert title or a
 *      table cell carries real output from a customer's estate. React escapes
 *      by default, so the same content is inert here.
 *   2. NO FETCHING. A widget renders what it is handed. Bindings resolve
 *      upstream, which keeps widgets pure, testable without a network, and
 *      unable to reach a credential.
 *
 * Colours come from CSS custom properties so a theme plugin can restyle every
 * widget without any of them knowing a theme exists.
 */
import { useMemo, useState } from 'react';
import type { WidgetProps } from './types';

// ── shared helpers ──────────────────────────────────────────────────────────

const num = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

/**
 * Read a widget's rows from the PUBLISHED CONTRACT shape, falling back to the
 * legacy positional one.
 *
 * These widgets were written against `options.data` holding positional tuples —
 * `[sev, title, host, age]` for an alert. The contracts published to authors
 * and to the orchestrator describe named objects under a named key —
 * `{ items: [{ title, host, sev, age }] }`. Nobody reconciled the two, and ten
 * of nineteen widgets disagreed with their own documentation.
 *
 * The consequence was not a crash. It was an alerts panel rendering "No alerts"
 * while holding three findings, one critical, because the author had followed
 * the contract exactly. A crash gets reported; an empty state gets BELIEVED,
 * and the operator stops looking.
 *
 * THE CONTRACT WINS, because it is what we tell authors and what the model
 * writes, and because named fields are what anyone reaches for unprompted. The
 * tuple form still works so saved views keep rendering — a dashboard someone
 * kept must not go blank because we corrected our own documentation.
 */
function contractRows<T>(
  options: Record<string, unknown>,
  key: string,
  fromObject: (o: Record<string, unknown>) => T,
): T[] {
  const named = options[key];
  if (Array.isArray(named)) {
    return named.map((row) =>
      // A contract array of primitives (uptime's `bars: number[]`) or a legacy
      // tuple inside the named key both pass straight through.
      (row && typeof row === 'object' && !Array.isArray(row))
        ? fromObject(row as Record<string, unknown>)
        : (row as T));
  }
  return arr<T>(options['data']);
}

/** Map a series to SVG polyline points inside a w×h box. */
function points(series: number[], w: number, h: number): string {
  if (series.length === 0) return '';
  const mn = Math.min(...series);
  const mx = Math.max(...series);
  const span = mx - mn || 1;
  const step = series.length > 1 ? w / (series.length - 1) : 0;
  return series
    .map((v, i) => `${(i * step).toFixed(1)},${(h - ((v - mn) / span) * h).toFixed(1)}`)
    .join(' ');
}

const sevColor = (s: string): string =>
  s === 'c' || s === 'crit' ? 'var(--crit)'
    : s === 'w' || s === 'warn' ? 'var(--warn)'
      : s === 'ok' ? 'var(--ok)' : 'var(--info)';

const fmtMs = (ms: number): string =>
  ms < 1000 ? `${Math.round(ms)}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 60_000)}m`;

/** Shown instead of data when a binding failed. Never silently blank. */
function ErrorState({ error }: { error: string }) {
  return (
    <div className="wg-error" role="alert">
      <span aria-hidden>⚠</span> {error}
    </div>
  );
}

/** Wraps every widget body so an error path exists in exactly one place. */
function Body({ error, children }: { error?: string | undefined; children: React.ReactNode }) {
  if (error) return <ErrorState error={error} />;
  return <>{children}</>;
}

/**
 * A widget was given the wrong option shape.
 *
 * DISTINCT FROM A BINDING FAILURE, and that distinction is the whole point.
 * "the host is unreachable" is about the estate; "this panel was handed a shape
 * it does not read" is about the message that drew it. Collapsing them sent an
 * operator hunting a network problem that did not exist.
 *
 * The message names the widget, the field and what was expected, because the
 * reader is an operator who did not write the panel and an agent that has to
 * fix it on the next turn. `s.map is not a function` served neither.
 */
function OptionsMismatch({ widget, expected, got }: { widget: string; expected: string; got: string }) {
  return (
    <div className="wg-error wg-optionerr" role="alert">
      <b><span aria-hidden>⚠</span> {widget}: wrong options</b>
      <div>expected <code>{expected}</code></div>
      <div>got <code>{got}</code></div>
    </div>
  );
}

/** Short, honest description of what actually arrived. */
function describe(v: unknown): string {
  if (v === undefined) return 'nothing';
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    const first = v[0];
    const inner = v.length === 0 ? '' : Array.isArray(first) ? 'array' : typeof first === 'object' && first !== null ? 'object' : typeof first;
    return `array of ${v.length}${inner ? ` ${inner}${v.length === 1 ? '' : 's'}` : ''}`;
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v as object);
    return `object { ${keys.slice(0, 4).join(', ')}${keys.length > 4 ? ', …' : ''} }`;
  }
  return typeof v;
}

// ── Metrics ─────────────────────────────────────────────────────────────────

export function StatTile({ options, error }: WidgetProps) {
  const label = str(options.label, 'Value');
  const value = str(options.value, '—');
  const delta = str(options.delta);
  const sub = str(options.sub);
  const color = str(options.color, 'var(--ink)');
  const spark = arr<number>(options.spark);
  return (
    <Body error={error}>
      <div className="kpi-l">{label}</div>
      <div className="kpi-v" style={{ color }}>{value}</div>
      <div className="kpi-d">
        {delta && <span className="mono" style={{ color: str(options.dcolor, 'var(--ink3)') }}>{delta}</span>}
        {sub && <span>{sub}</span>}
      </div>
      {spark.length > 1 && (
        <svg className="svg" height={24} viewBox="0 0 100 24" preserveAspectRatio="none" style={{ marginTop: 8 }}>
          <polyline className="ser" style={{ stroke: color, strokeWidth: 1.2 }} points={points(spark, 100, 22)} />
        </svg>
      )}
    </Body>
  );
}

export function TimeSeries({ options, thresholds, error }: WidgetProps) {
  const data = arr<number>(options.data);
  const color = str(options.color, 'var(--info)');
  const p = points(data, 300, 80);
  const thr = thresholds?.find((t) => t.gt !== undefined)?.gt;
  return (
    <Body error={error}>
      <svg className="svg" viewBox="0 0 310 108" preserveAspectRatio="none" style={{ height: '100%' }}>
        {thr !== undefined && (
          <>
            <rect x={0} y={80 - thr * 0.8} width={300} height={thr * 0.8} fill="var(--crit-w)" />
            <line className="thr" x1={0} y1={80 - thr * 0.8} x2={300} y2={80 - thr * 0.8} />
          </>
        )}
        {[0, 1, 2].map((i) => <line key={i} className="gr" x1={0} y1={i * 26 + 2} x2={300} y2={i * 26 + 2} />)}
        {p && <polygon className="ar" fill={color} points={`${p} 300,80 0,80`} />}
        {p && <polyline className="ser" style={{ stroke: color }} points={p} />}
        <text className="ax" x={0} y={98}>{str(options.t0, '-6h')}</text>
        <text className="ax" x={300} y={98} textAnchor="end">now</text>
      </svg>
    </Body>
  );
}

export function RadialGauge({ options, error }: WidgetProps) {
  const v = Math.max(0, Math.min(100, num(options.value)));
  const a = Math.PI * (1 - v / 100);
  const x = 50 + 38 * Math.cos(a);
  const y = 48 - 38 * Math.sin(a);
  const c = v > 95 ? 'var(--crit)' : v > 80 ? 'var(--warn)' : 'var(--ok)';
  return (
    <Body error={error}>
      <svg className="svg" viewBox="0 0 100 62" style={{ maxHeight: 88 }}>
        <path d="M12 48A38 38 0 0 1 88 48" fill="none" stroke="var(--line2)" strokeWidth={7} strokeLinecap="round" />
        <path d={`M12 48A38 38 0 0 1 ${x.toFixed(1)} ${y.toFixed(1)}`} fill="none" stroke={c} strokeWidth={7} strokeLinecap="round" />
        <text x={50} y={44} textAnchor="middle" fontFamily="var(--mono)" fontSize={17} fill={c}>{v}%</text>
        <text x={50} y={58} textAnchor="middle" fontSize={7.5} fill="var(--ink4)">{str(options.sub)}</text>
      </svg>
    </Body>
  );
}

export function BarChart({ options, error }: WidgetProps) {
  const data = contractRows<[string, number]>(options, 'items',
    (o) => [str(o['label']), num(o['value'])]);
  const mx = Math.max(1, ...data.map((d) => num(d[1])));
  const color = str(options.color, 'var(--info)');
  return (
    <Body error={error}>
      <div className="rows">
        {data.map(([label, value], i) => (
          <div key={`${label}-${i}`} className="row">
            <span className="row-l">{label}</span>
            <div className="bar"><i style={{ width: `${(num(value) / mx) * 100}%`, background: color }} /></div>
            <span className="mono row-v">{num(value)}</span>
          </div>
        ))}
      </div>
    </Body>
  );
}

export function LatencyHistogram({ options, error }: WidgetProps) {
  const d = contractRows<number>(options, 'bars', (o) => num(o['value']));
  const mx = Math.max(1, ...d);
  return (
    <Body error={error}>
      <svg className="svg" viewBox="0 0 300 84" style={{ height: '100%' }}>
        {d.map((v, i) => (
          <rect key={i} x={i * 30 + 3} y={68 - (v / mx) * 60} width={24} height={(v / mx) * 60} rx={1.5} fill="var(--info)" opacity={0.72} />
        ))}
        <text className="ax" x={3} y={80}>0</text>
        <text className="ax" x={297} y={80} textAnchor="end">{str(options.max, '250ms')}</text>
      </svg>
    </Body>
  );
}

export function Heatmap({ options, error }: WidgetProps) {
  const cells = arr<number>(options.data);
  return (
    <Body error={error}>
      <div className="heat">
        {cells.map((v, i) => (
          <div key={i} style={{ opacity: (0.12 + Math.max(0, Math.min(1, num(v))) * 0.85).toFixed(2) }} />
        ))}
      </div>
      <div className="heat-ax mono"><span>00:00</span><span>12:00</span><span>23:00</span></div>
    </Body>
  );
}

export function HeadlineFigure({ options, error }: WidgetProps) {
  return (
    <Body error={error}>
      <div className="bignum">
        <div className="kpi-l">{str(options.label)}</div>
        <div className="bignum-v" style={{ color: str(options.color, 'var(--ink)') }}>{str(options.value, '—')}</div>
        <div className="kpi-d center">{str(options.sub)}</div>
      </div>
    </Body>
  );
}

// ── Alerting ────────────────────────────────────────────────────────────────

export function SeverityDonut({ options, error }: WidgetProps) {
  const data = contractRows<[number, string]>(options, 'slices',
    (o) => [num(o['value']), str(o['label'])]);
  const total = data.reduce((a, b) => a + num(b[0]), 0);
  let offset = 0;
  return (
    <Body error={error}>
      <svg className="svg" viewBox="0 0 100 100" style={{ maxHeight: 112 }}>
        {data.map(([v, c], i) => {
          const dash = total > 0 ? (num(v) / total) * 251.2 : 0;
          const el = (
            <circle key={i} cx={50} cy={50} r={40} fill="none" stroke={c} strokeWidth={12}
              strokeDasharray={`${dash.toFixed(1)} 251.2`} strokeDashoffset={-offset}
              transform="rotate(-90 50 50)" />
          );
          offset += dash;
          return el;
        })}
        <text x={50} y={48} textAnchor="middle" fontFamily="var(--mono)" fontSize={19} fill="var(--ink)">{total}</text>
        <text x={50} y={60} textAnchor="middle" fontSize={7} fill="var(--ink4)">{str(options.sub, 'open')}</text>
      </svg>
    </Body>
  );
}

export function AlertList({ options, error }: WidgetProps) {
  const rows = contractRows<[string, string, string, string]>(options, 'items',
    (o) => [str(o['sev'], 'info'), str(o['title']), str(o['host']), str(o['age'])]);
  return (
    <Body error={error}>
      <div className="alist">
        {rows.map(([sev, title, host, age], i) => (
          <div key={i} className="al">
            <span className="dot" style={{ background: sevColor(str(sev)) }} />
            <span className="t">{title}</span>
            <span className="mono host">{host}</span>
            <span className="ti">{age}</span>
          </div>
        ))}
        {rows.length === 0 && <div className="empty">No alerts</div>}
      </div>
    </Body>
  );
}

// ── Health ──────────────────────────────────────────────────────────────────

export function StatusGrid({ options, error }: WidgetProps) {
  const cells = contractRows<[string, string]>(options, 'items',
    (o) => [str(o['label']), str(o['state'], 'unknown')]);
  return (
    <Body error={error}>
      <div className="sgrid">
        {cells.map(([name, state], i) => (
          <div key={i} className="sq" title={name}
            style={{ background: state === 'c' ? 'var(--crit)' : state === 'w' ? 'var(--warn)' : state === 'o' ? 'var(--line2)' : 'var(--ok)' }}>
            {name.slice(-2)}
          </div>
        ))}
      </div>
    </Body>
  );
}

export function AvailabilityStrip({ options, error }: WidgetProps) {
  const d = arr<number>(options.data);
  return (
    <Body error={error}>
      <div className="upt">
        {d.map((v, i) => (
          <i key={i} style={{
            height: `${Math.max(30, num(v) * 100)}%`,
            background: v < 0.9 ? 'var(--crit)' : v < 0.99 ? 'var(--warn)' : 'var(--ok)',
          }} />
        ))}
      </div>
      <div className="upt-ax mono">
        {/* `label`/`sub` are the contract's names; t0/pct were the internal
            ones. Both read, contract first — the published names are what an
            author writes, and silently dropping them left the strip unlabelled
            with no hint as to why. */}
        <span>{str(options.label, str(options.t0, '30d'))}</span>
        <span style={{ color: 'var(--ok)' }}>{str(options.sub, str(options.pct, '—'))}</span>
        <span>now</span>
      </div>
    </Body>
  );
}

// ── Data ────────────────────────────────────────────────────────────────────

/**
 * A table.
 *
 * THIS IS THE WIDGET THAT CRASHED. An author sent `columns: [{key,label}]` and
 * `rows: [{…}]` — a perfectly reasonable table shape, and not this one — so
 * `row.map` ran against an object and threw `s.map is not a function` into the
 * operator's chat.
 *
 * Two fixes, and both were needed. The contract is now published so an author
 * does not have to guess (contracts.ts), and this validates before it renders
 * so a mismatch names the problem instead of throwing. Neither alone is
 * enough: publishing a contract does not stop a wrong shape arriving, and
 * validating does not tell anyone what the right shape was.
 *
 * It also ACCEPTS the shape it was mistakenly given. Rows of objects keyed by
 * column name is a normal way to think about a table, the mapping is
 * unambiguous once `cols` is known, and refusing it would be pedantry that
 * costs the operator their panel.
 */
/** A column's kind decides alignment, sorting and decoration. Given by `columns[]`, else inferred from the cells. */
type ColKind = 'text' | 'number' | 'state' | 'bar' | 'pct';
interface ColSpec { label: string; kind: ColKind; unit: string; max: number | undefined }

const STATE_WORDS = /^(up|ok|online|healthy|running|ready|active|pass(ing)?|resolved|success|succeeded|down|offline|failed|critical|crit|error|unreachable|dead|warn(ing)?|degraded|pending|paused|maintenance|unknown|stale)$/i;
const stateTone = (v: string): string => {
  const x = v.toLowerCase();
  if (/^(up|ok|online|healthy|running|ready|active|pass|passing|resolved|success|succeeded)$/.test(x)) return 'ok';
  if (/^(down|offline|failed|critical|crit|error|unreachable|dead)$/.test(x)) return 'crit';
  if (/^(warn|warning|degraded|pending|paused|maintenance|stale)$/.test(x)) return 'warn';
  return 'unknown';
};
const cellNum = (v: string): number | undefined => { const m = /^\s*(-?\d+(?:[.,]\d+)?)\s*(%|[a-zA-Z/]{0,6})?\s*$/.exec(v); if (!m) return undefined; const n = Number(m[1]!.replace(',', '.')); return Number.isFinite(n) ? n : undefined; };

function inferKind(values: string[]): ColKind {
  const filled = values.filter((v) => v !== '');
  if (filled.length === 0) return 'text';
  if (filled.every((v) => STATE_WORDS.test(v))) return 'state';
  if (filled.every((v) => cellNum(v) !== undefined)) return filled.every((v) => /%\s*$/.test(v)) ? 'pct' : 'number';
  return 'text';
}

/**
 * The table body, with its own sort and filter state. Hooks live HERE, not in
 * DataTable, so the hostile-input test can still call DataTable as a plain
 * function; DataTable parses and hands the rows over as an element.
 */
function SortableTable({ cols, rows, sort0, filterable, limit }: { cols: ColSpec[]; rows: string[][]; sort0: { col: number; dir: 1 | -1 } | undefined; filterable: boolean; limit: number }) {
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | undefined>(sort0);
  const [q, setQ] = useState('');
  const [showAll, setShowAll] = useState(false);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let out = needle ? rows.filter((r) => r.some((c) => c.toLowerCase().includes(needle))) : rows.slice();
    if (sort) {
      const k = cols[sort.col]?.kind;
      const key = (v: string): number | string => (k === 'number' || k === 'pct' || k === 'bar' ? (cellNum(v) ?? Number.NEGATIVE_INFINITY) : k === 'state' ? ({ crit: 0, warn: 1, unknown: 2, ok: 3 }[stateTone(v)] ?? 4) : v.toLowerCase());
      out = out.map((r, i) => [r, i] as const).sort(([a, ai], [b, bi]) => { const x = key(a[sort.col] ?? ''), y = key(b[sort.col] ?? ''); return (x < y ? -1 : x > y ? 1 : ai - bi) * sort.dir; }).map(([r]) => r);
    }
    return out;
  }, [rows, cols, sort, q]);
  const cut = !showAll && shown.length > limit ? shown.slice(0, limit) : shown;
  const maxes = cols.map((c, j) => c.max ?? (c.kind === 'bar' ? Math.max(1e-9, ...rows.map((r) => cellNum(r[j] ?? '') ?? 0)) : c.kind === 'pct' ? 100 : undefined));
  const click = (j: number) => setSort((s) => (s?.col === j ? (s.dir === 1 ? { col: j, dir: -1 } : undefined) : { col: j, dir: cols[j]?.kind === 'text' ? 1 : -1 }));
  return (
    <div className="tbw">
      {filterable && (
        <div className="tb-tools">
          <input className="tb-find" value={q} placeholder="Filter rows…" aria-label="Filter rows" onChange={(e) => setQ(e.target.value)} />
          <span className="tb-n mono">{q ? `${shown.length} of ${rows.length}` : `${rows.length} rows`}</span>
        </div>
      )}
      <table className="tb tb-x">
        <thead>
          <tr>
            {cols.map((c, j) => (
              <th key={j} className={`${c.kind === 'text' || c.kind === 'state' ? '' : 'r'}${sort?.col === j ? ' sorted' : ''}`} onClick={() => click(j)} title="Sort" aria-sort={sort?.col === j ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
                {c.label}{sort?.col === j ? <span className="tb-arrow">{sort.dir === 1 ? '▲' : '▼'}</span> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cut.map((r, i) => (
            <tr key={i}>
              {cols.map((c, j) => {
                const v = r[j] ?? '';
                if (c.kind === 'state') return <td key={j}><span className={`tb-state ${stateTone(v)}`}>{v}</span></td>;
                if (c.kind === 'bar' || c.kind === 'pct') { const n = cellNum(v); const w = n === undefined || !maxes[j] ? 0 : Math.max(0, Math.min(100, (n / maxes[j]!) * 100)); return <td key={j} className="r mono tb-barcell"><span className="tb-bar"><i style={{ width: `${w}%` }} className={w >= 90 ? 'crit' : w >= 75 ? 'warn' : ''} /></span><span>{v}{c.unit && n !== undefined && !v.endsWith(c.unit) ? c.unit : ''}</span></td>; }
                if (c.kind === 'number') return <td key={j} className="r mono">{v}{c.unit && v !== '' && !v.endsWith(c.unit) ? c.unit : ''}</td>;
                return <td key={j} className={j === 0 ? 'mono' : undefined}>{v}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {shown.length > limit && !showAll && <button type="button" className="tb-more" onClick={() => setShowAll(true)}>show all {shown.length} rows</button>}
      {shown.length === 0 && rows.length > 0 && <div className="empty">Nothing matches</div>}
    </div>
  );
}

export function DataTable({ options, error }: WidgetProps) {
  const rawCols = arr<unknown>(options.cols ?? options.columns);
  const cols = rawCols.map((c) => (
    // Tolerate `[{key,label}]` as well as `["Service"]` — the label is what
    // gets drawn either way.
    typeof c === 'object' && c !== null
      ? String((c as { label?: unknown; name?: unknown; key?: unknown }).label
        ?? (c as { name?: unknown }).name ?? (c as { key?: unknown }).key ?? '')
      : String(c)
  ));

  const rawRows = options.rows;
  if (rawRows !== undefined && !Array.isArray(rawRows)) {
    return (
      <Body error={error}>
        <OptionsMismatch widget="table@1.0.0" expected="rows: (string|number)[][]" got={describe(rawRows)} />
      </Body>
    );
  }

  const rows: string[][] = arr<unknown>(rawRows).map((r) => {
    if (Array.isArray(r)) return r.map((cell) => String(cell ?? ''));
    if (r && typeof r === 'object') {
      const o = r as Record<string, unknown>;
      // Keyed by column name where possible; otherwise take the values in
      // insertion order, which is what the author meant.
      const keys = rawCols.map((c, i) => (typeof c === 'object' && c !== null && typeof (c as { key?: unknown }).key === 'string' ? (c as { key: string }).key : cols[i]!));
      const byCol = keys.map((k) => o[k]);
      return byCol.some((v) => v !== undefined)
        ? byCol.map((v) => String(v ?? ''))
        : Object.values(o).map((v) => String(v ?? ''));
    }
    return [String(r ?? '')];
  });

  // A row longer than the header would silently lose cells.
  const width = Math.max(cols.length, ...rows.map((r) => r.length), 0);
  const header = width > cols.length
    ? [...cols, ...Array.from({ length: width - cols.length }, (_, i) => `col ${cols.length + i + 1}`)]
    : cols;

  // Column kinds: declared on `columns[{kind,unit,max}]`, else inferred from the cells.
  const specs: ColSpec[] = header.map((label, j) => {
    const c = rawCols[j];
    const decl = typeof c === 'object' && c !== null ? (c as { kind?: unknown; type?: unknown; unit?: unknown; max?: unknown }) : undefined;
    const k = typeof decl?.kind === 'string' ? decl.kind : typeof decl?.type === 'string' ? decl.type : undefined;
    const kind: ColKind = k === 'number' || k === 'state' || k === 'bar' || k === 'pct' || k === 'text' ? k : inferKind(rows.map((r) => r[j] ?? ''));
    return { label, kind, unit: typeof decl?.unit === 'string' ? decl.unit : '', max: typeof decl?.max === 'number' ? decl.max : undefined };
  });
  const sortOpt = options.sort;
  let sort0: { col: number; dir: 1 | -1 } | undefined;
  if (typeof sortOpt === 'string') { const j = header.findIndex((h) => h.toLowerCase() === sortOpt.replace(/^-/, '').toLowerCase()); if (j !== -1) sort0 = { col: j, dir: sortOpt.startsWith('-') ? -1 : 1 }; }
  else if (sortOpt && typeof sortOpt === 'object') { const so = sortOpt as { col?: unknown; dir?: unknown }; const j = typeof so.col === 'number' ? so.col : header.findIndex((h) => h.toLowerCase() === String(so.col ?? '').toLowerCase()); if (j >= 0 && j < header.length) sort0 = { col: j, dir: so.dir === 'desc' || so.dir === -1 ? -1 : 1 }; }
  const limit = typeof options.limit === 'number' && options.limit > 0 ? options.limit : 50;

  return (
    <Body error={error}>
      {rows.length > 0 && <SortableTable cols={specs} rows={rows} sort0={sort0} filterable={options.filter !== false && rows.length > 8} limit={limit} />}
      {rows.length === 0 && <div className="empty">No rows</div>}
    </Body>
  );
}

/** Log lines are the highest-risk content in the product — arbitrary bytes from
 *  a customer's estate. Rendered as text nodes, never as markup. */
const LEVEL_RE = /\b(FATAL|CRIT(?:ICAL)?|EMERG|ALERT|ERR(?:OR)?|PANIC|WARN(?:ING)?|INFO|NOTICE|DEBUG|TRACE)\b/i;
const levelOf = (line: string): 'crit' | 'warn' | 'info' | 'debug' | '' => {
  const m = LEVEL_RE.exec(line.slice(0, 160));
  if (!m) return '';
  const l = m[1]!.toUpperCase();
  if (/^(FATAL|CRIT|EMERG|ALERT|ERR|PANIC)/.test(l)) return 'crit';
  if (l.startsWith('WARN')) return 'warn';
  if (l === 'DEBUG' || l === 'TRACE') return 'debug';
  return 'info';
};

/** The log body with its own filter, level toggle and wrap state — hooks here, not in LogStream (see SortableTable). */
function LogBody({ lines, tail }: { lines: string[]; tail: number }) {
  const [q, setQ] = useState('');
  const [min, setMin] = useState<'all' | 'warn' | 'crit'>('all');
  const [wrap, setWrap] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const needle = q.trim().toLowerCase();
  const counts = { crit: 0, warn: 0 };
  const tagged = lines.map((l) => { const lv = levelOf(l); if (lv === 'crit') counts.crit++; else if (lv === 'warn') counts.warn++; return { l, lv }; });
  const shown = tagged.filter((x) => (min === 'all' || x.lv === 'crit' || (min === 'warn' && x.lv === 'warn')) && (!needle || x.l.toLowerCase().includes(needle)));
  const cut = showAll || shown.length <= tail ? shown : shown.slice(-tail);
  return (
    <div className="lsw">
      {lines.length > 5 && (
        <div className="tb-tools">
          <input className="tb-find" value={q} placeholder="Filter lines…" aria-label="Filter log lines" onChange={(e) => setQ(e.target.value)} />
          <span className="ls-lv">
            <button type="button" className={min === 'all' ? 'on' : ''} onClick={() => setMin('all')}>all</button>
            <button type="button" className={`${min === 'warn' ? 'on' : ''} warn`} onClick={() => setMin('warn')}>warn+ <span className="mono">{counts.warn + counts.crit}</span></button>
            <button type="button" className={`${min === 'crit' ? 'on' : ''} crit`} onClick={() => setMin('crit')}>errors <span className="mono">{counts.crit}</span></button>
            <button type="button" className={wrap ? 'on' : ''} onClick={() => setWrap((w) => !w)} title="Wrap long lines">wrap</button>
          </span>
          <span className="tb-n mono">{shown.length === lines.length ? `${lines.length} lines` : `${shown.length} of ${lines.length}`}</span>
        </div>
      )}
      <div className={`lstream mono${wrap ? '' : ' nowrap'}`}>
        {cut.length < shown.length && <button type="button" className="tb-more" onClick={() => setShowAll(true)}>show all {shown.length} lines (showing the last {tail})</button>}
        {cut.map((x, i) => <div key={i} className={`lline${x.lv ? ` lv-${x.lv}` : ''}`}>{x.l}</div>)}
        {shown.length === 0 && <div className="empty">Nothing matches</div>}
      </div>
    </div>
  );
}

/** Log lines are the highest-risk content in the product — arbitrary bytes from
 *  a customer's estate. Rendered as text nodes, never as markup. */
export function LogStream({ options, error }: WidgetProps) {
  const text = typeof options.text === 'string' ? options.text : Array.isArray(options.lines) ? options.lines.map((l) => String(l ?? '')).join('\n') : '';
  const lines = text ? text.split('\n') : [];
  const tail = typeof options.tail === 'number' && options.tail > 0 ? options.tail : 200;
  return (
    <Body error={error}>
      {lines.length > 0 ? <LogBody lines={lines} tail={tail} /> : <div className="lstream mono"><div className="empty">No output</div></div>}
    </Body>
  );
}

export function ProgressRows({ options, error }: WidgetProps) {
  const data = contractRows<[string, number, string | undefined]>(options, 'items',
    (o) => [str(o['label']), num(o['value']), o['color'] === undefined ? undefined : str(o['color'])]);
  return (
    <Body error={error}>
      <div className="rows">
        {data.map(([label, value, color], i) => (
          <div key={i} className="prow">
            <div className="prow-h">
              <span>{label}</span>
              <span className="mono" style={{ color: color ?? 'var(--ink3)' }}>{num(value)}%</span>
            </div>
            <div className="bar"><i style={{ width: `${Math.max(0, Math.min(100, num(value)))}%`, background: color ?? 'var(--info)' }} /></div>
          </div>
        ))}
      </div>
    </Body>
  );
}

// ── Topology / Change / Automation / Analysis ───────────────────────────────

export function DependencyMap({ options, error }: WidgetProps) {
  /*
   * The contract publishes `{ nodes, edges }`; this read `{ root, dependents }`.
   * A spec following the contract produced a map with one box labelled "root"
   * and nothing else — technically rendered, entirely uninformative.
   *
   * Contract form is folded onto the same shape: the node with the most edges
   * pointing at it is the root, everything reachable from it is a dependent.
   * That is what this widget draws, and it is a fair reading of a small graph.
   */
  const nodes = arr<Record<string, unknown>>(options['nodes']);
  const edges = arr<Record<string, unknown>>(options['edges']);
  let root: string;
  let deps: string[];
  if (nodes.length > 0) {
    const labelOf = (id: string): string => {
      const n = nodes.find((x) => str(x['id']) === id);
      return n ? str(n['label'], id) : id;
    };
    const inbound = new Map<string, number>();
    for (const e of edges) {
      const to = str(e['to']);
      if (to) inbound.set(to, (inbound.get(to) ?? 0) + 1);
    }
    const rootId = [...inbound.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
      ?? str(nodes[0]!['id']);
    root = labelOf(rootId);
    deps = edges
      .filter((e) => str(e['to']) === rootId || str(e['from']) === rootId)
      .map((e) => labelOf(str(e['to']) === rootId ? str(e['from']) : str(e['to'])));
    // A graph with no edges is still worth drawing: show the other nodes.
    if (deps.length === 0) {
      deps = nodes.map((n) => str(n['label'], str(n['id']))).filter((l) => l !== root);
    }
  } else {
    root = str(options['root'], 'root');
    deps = arr<string>(options['dependents']);
  }
  const spacing = deps.length > 0 ? 260 / (deps.length + 1) : 130;
  return (
    <Body error={error}>
      <svg className="svg" viewBox="0 0 260 104" style={{ height: '100%' }}>
        {deps.map((_, i) => (
          <line key={i} className="gr" style={{ stroke: 'var(--crit)' }}
            x1={130} y1={34} x2={spacing * (i + 1)} y2={76} />
        ))}
        <rect x={86} y={22} width={88} height={22} rx={3} fill="var(--warn-w)" stroke="var(--warn)" />
        <text x={130} y={37} textAnchor="middle" fontFamily="var(--mono)" fontSize={8} fill="var(--ink)">{root}</text>
        {deps.map((n, i) => (
          <g key={i}>
            <rect x={spacing * (i + 1) - 24} y={66} width={48} height={20} rx={3} fill="var(--crit-w)" stroke="var(--crit)" />
            <text x={spacing * (i + 1)} y={80} textAnchor="middle" fontFamily="var(--mono)" fontSize={7.5} fill="var(--ink2)">{n}</text>
          </g>
        ))}
        <text x={130} y={100} textAnchor="middle" fontSize={7.5} fill="var(--ink4)">
          {deps.length} dependents{options.sessions ? ` · ${num(options.sessions)} users` : ''}
        </text>
      </svg>
    </Body>
  );
}

export function ChangeTimeline({ options, error }: WidgetProps) {
  /*
   * The contract publishes `{ at, title, kind }` where `at` is a human time
   * ("14:02"). This wanted a NUMBER — an x coordinate in the 0..300 viewBox —
   * so a spec written against the contract put a string where a position went
   * and every marker landed at 0, stacked on the left edge.
   *
   * Contract items are spread evenly across the axis instead. Even spacing is
   * a deliberate choice over parsing `at`: the times are free-form strings and
   * a wrong parse would place an event at a confidently wrong moment, which is
   * worse on a change timeline than showing order without exact spacing.
   */
  const named = arr<Record<string, unknown>>(options['items']);
  const events: Array<[number, string, string | undefined]> = named.length > 0
    ? named.map((o, i) => [
        16 + (268 * (named.length === 1 ? 0.5 : i / (named.length - 1))),
        str(o['kind'], 'info'),
        [str(o['at']), str(o['title'])].filter(Boolean).join(' · ') || undefined,
      ])
    : arr<[number, string, string | undefined]>(options['data']);
  return (
    <Body error={error}>
      <svg className="svg" viewBox="0 0 300 62">
        <line className="gr" x1={8} y1={32} x2={292} y2={32} />
        {events.map(([x, kind, label], i) => {
          const c = sevColor(str(kind));
          return (
            <g key={i}>
              <line x1={num(x)} y1={22} x2={num(x)} y2={42} stroke={c} strokeWidth={2} />
              <circle cx={num(x)} cy={32} r={3.2} fill={c}><title>{label ?? kind}</title></circle>
              {/* Visible, not only a tooltip: a row of unlabelled dots tells an
                  operator nothing without hovering each one. */}
              {label && (
                <text x={num(x)} y={16} textAnchor="middle" fontSize={6} fill="var(--ink3)">
                  {label.length > 22 ? `${label.slice(0, 21)}…` : label}
                </text>
              )}
            </g>
          );
        })}
        <text className="ax" x={8} y={56}>24h ago</text>
        <text className="ax" x={292} y={56} textAnchor="end">now</text>
      </svg>
    </Body>
  );
}

export function AutomationRuns({ options, error }: WidgetProps) {
  const runs = contractRows<[string, string, number]>(options, 'runs',
    (o) => [str(o['name']), str(o['outcome'], 'ok'), num(o['duration'])]);
  return (
    <Body error={error}>
      <div className="alist">
        {runs.map(([state, title, ms], i) => (
          <div key={i} className="al">
            <span className="dot" style={{ background: sevColor(str(state)) }} />
            <span className="t">{title}</span>
            <span className="ti mono">{fmtMs(num(ms))}</span>
          </div>
        ))}
        {runs.length === 0 && <div className="empty">No runs yet</div>}
      </div>
    </Body>
  );
}

/**
 * Orchestrator-written prose. Always `free_text` provenance, so the shell marks
 * it — this is the one widget whose content is a model's words rather than a
 * measurement, and it must never look like a reading.
 */
export function NarrativePanel({ options, error }: WidgetProps) {
  const text = str(options.text);
  return (
    <Body error={error}>
      <div className="narrative">
        {text.split('\n\n').map((p, i) => <p key={i}>{p}</p>)}
      </div>
    </Body>
  );
}

// ── the page widgets (2026-09-05) ───────────────────────────────────────────
//
// WHY THESE TWO EXIST. Every widget until now draws a MEASUREMENT, which is
// right for a dashboard and wrong for a page. When the orchestrator builds a
// place to hold something an operator just integrated — three Nutanix clusters,
// a warehouse WMS, a Kafka estate — the panels answer "what are the numbers"
// and nothing answers "what is this, what did we agree, and what do I do next".
// The operator then keeps that half in a wiki nobody updates, or in the chat
// transcript, which is worse.
//
// Neither of these can act on the estate. `DocPanel` draws text. `ActionRow`
// dispatches a UI event — open a surface, or put words in the chat box — and
// that is the whole of its power: no command, no credential, no write path. A
// button that could change something would have to go through the Safety
// Kernel like everything else, and then it would not be a widget.

/** http/https only. A page is authored by a model; `javascript:` is not a link. */
function safeHref(raw: string): string | null {
  try {
    const u = new URL(raw, 'https://x.invalid');
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch { return null; }
}

/** Inline markdown: `code`, **bold**, *italic*, [text](url). Returns nodes,
 *  never HTML — the input is escaped by React because it stays a string. */
function inlineMd(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${keyBase}-${n++}`;
    if (m[1] !== undefined) out.push(<code key={k} className="mono">{m[1]}</code>);
    else if (m[2] !== undefined) out.push(<b key={k}>{m[2]}</b>);
    else if (m[3] !== undefined) out.push(<i key={k}>{m[3]}</i>);
    else if (m[4] !== undefined && m[5] !== undefined) {
      const href = safeHref(m[5]);
      out.push(href
        ? <a key={k} href={href} target="_blank" rel="noreferrer noopener">{m[4]}</a>
        : <span key={k}>{m[4]}</span>);
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * The written half of a page: what this system is, who owns it, what was
 * agreed, what to check first. A DELIBERATELY SMALL markdown subset —
 * headings, lists, paragraphs, fenced code and the inline marks above —
 * rendered as React elements. No HTML is parsed and none is injected, so a
 * model that writes a `<script>` tag gets a paragraph containing that text.
 */
export function DocPanel({ options, error }: WidgetProps) {
  const text = str(options.text ?? options.markdown);
  const blocks = useMemo(() => {
    const lines = text.split('\n');
    const out: React.ReactNode[] = [];
    let para: string[] = [];
    let list: { ordered: boolean; items: string[] } | null = null;
    let fence: string[] | null = null;
    const flushPara = (): void => {
      if (!para.length) return;
      out.push(<p key={`p${out.length}`}>{inlineMd(para.join(' '), `p${out.length}`)}</p>);
      para = [];
    };
    const flushList = (): void => {
      if (!list) return;
      const items = list.items.map((t, i) => <li key={i}>{inlineMd(t, `l${out.length}-${i}`)}</li>);
      out.push(list.ordered ? <ol key={`l${out.length}`}>{items}</ol> : <ul key={`l${out.length}`}>{items}</ul>);
      list = null;
    };
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '');
      if (fence !== null) {
        if (/^\s*```/.test(line)) { out.push(<pre key={`c${out.length}`}><code>{fence.join('\n')}</code></pre>); fence = null; }
        else fence.push(raw);
        continue;
      }
      if (/^\s*```/.test(line)) { flushPara(); flushList(); fence = []; continue; }
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) {
        flushPara(); flushList();
        const level = Math.min(4, h[1]!.length);
        const Tag = (['h3', 'h4', 'h5', 'h6'] as const)[level - 1]!;
        out.push(<Tag key={`h${out.length}`}>{inlineMd(h[2]!, `h${out.length}`)}</Tag>);
        continue;
      }
      const li = /^\s*([-*]|\d+[.)])\s+(.*)$/.exec(line);
      if (li) {
        flushPara();
        const ordered = !/^[-*]$/.test(li[1]!);
        if (!list || list.ordered !== ordered) { flushList(); list = { ordered, items: [] }; }
        list.items.push(li[2]!);
        continue;
      }
      if (!line.trim()) { flushPara(); flushList(); continue; }
      flushList();
      para.push(line.trim());
    }
    if (fence !== null) out.push(<pre key={`c${out.length}`}><code>{fence.join('\n')}</code></pre>);
    flushPara(); flushList();
    return out;
  }, [text]);

  return (
    <Body error={error}>
      <div className="wg-doc">
        {blocks.length ? blocks : <div className="empty">Nothing written here yet</div>}
      </div>
    </Body>
  );
}

/**
 * The next step, as a button instead of a sentence an operator has to retype.
 *
 * WHAT A BUTTON CAN DO, exhaustively: open one of this console's surfaces, or
 * put a prompt in the chat box for the operator to read and send. `send: true`
 * submits that prompt instead of composing it — allowed only because a prompt
 * is a REQUEST to an agent that is itself gated, never an instruction to the
 * estate. Anything that touches a system still goes through the Safety Kernel
 * with a human decision, exactly as if it had been typed.
 */
/**
 * WHAT A PANEL BUTTON ACTUALLY DOES — decided here, as data, so it can be tested.
 *
 * The dispatch used to be three lines inside the click handler and it was
 * wrong in a way nothing could catch: it fired `aiops:compose` (or
 * `aiops:send`) and THEN `aiops:open-surface`. Those two events are listened
 * for by the CHAT, in a `useEffect`, so they only exist while the chat is
 * mounted — and a panel button is pressed from a dashboard, where it is not.
 * The prompt went nowhere, the surface switched, and every action button on
 * every dashboard, doc panel and agent-built page opened an EMPTY composer.
 *
 * This is the same defect the console already fixed once for its own surfaces:
 * `askOrchestrator` exists precisely because "dispatch an event in the same
 * tick as the switch" loses the message. That fix lives in the desktop app and
 * this package cannot import it, so the answer is one DURABLE event —
 * `aiops:ask` — that the always-mounted shell turns into `askOrchestrator`.
 * One place owns handing a question to the chat, and this is not it.
 */
export type ActionEvent =
  | { kind: 'surface'; id: string }
  | { kind: 'href'; url: string }
  | { kind: 'ask'; text: string; send: boolean }
  | { kind: 'none' };

export function actionEvent(a: { prompt?: unknown; surface?: unknown; href?: unknown; send?: unknown }): ActionEvent {
  const surface = str(a.surface);
  if (surface) return { kind: 'surface', id: surface };
  const href = str(a.href) ? safeHref(str(a.href)) : null;
  if (href) return { kind: 'href', url: href };
  // Trimmed: a whitespace-only prompt is not a question, and handing one over
  // would open the chat with a blank composer — the very thing this fixes.
  const text = str(a.prompt).trim();
  // Compose by default: the operator reads it before anything runs.
  return text ? { kind: 'ask', text, send: a.send === true } : { kind: 'none' };
}

export function ActionRow({ options, error }: WidgetProps) {
  type Act = { label?: unknown; prompt?: unknown; surface?: unknown; href?: unknown; send?: unknown; hint?: unknown };
  const items = contractRows<Act>(options, 'actions', (o) => o as Act)
    .filter((a): a is Act => Boolean(a) && typeof a === 'object');
  const fire = (a: { prompt?: unknown; surface?: unknown; href?: unknown; send?: unknown }): void => {
    const ev = actionEvent(a);
    if (ev.kind === 'surface') { window.dispatchEvent(new CustomEvent('aico:open-view', { detail: { id: ev.id } })); return; }
    if (ev.kind === 'href') { window.open(ev.url, '_blank', 'noopener,noreferrer'); return; }
    if (ev.kind === 'none') return;
    // ONE event. The shell stages it and switches surfaces, in that order,
    // through the store that survives the chat not being mounted yet.
    window.dispatchEvent(new CustomEvent('aico:ask', { detail: { text: ev.text, send: ev.send, source: 'panel' } }));
  };
  return (
    <Body error={error}>
      <div className="wg-actions">
        {items.map((a, i) => (
          <button key={i} type="button" className="wg-act" title={str(a.hint) || undefined} onClick={() => fire(a)}>
            <span className="wg-act-l">{str(a.label) || 'Do it'}</span>
            {str(a.hint) && <span className="wg-act-h">{str(a.hint)}</span>}
          </button>
        ))}
        {items.length === 0 && <div className="empty">No actions offered</div>}
      </div>
    </Body>
  );
}
