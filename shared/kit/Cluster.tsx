/**
 * A `widgets` fence: several kit widgets laid out on a 12-column grid.
 *
 *   ```widgets
 *   { "title": "Release health", "widgets": [
 *     { "widget": "stat", "title": "Build time", "span": { "w": 4 }, "options": { "label": "p50", "value": 142, "unit": "s", "previous": 171, "lowIsGood": true } },
 *     { "widget": "timeseries", "title": "Errors", "span": { "w": 8, "h": 2 }, "options": { ... } }
 *   ] }
 *   ```
 *
 * Forgiving about the envelope (a bare array works; `type`/`id`/`kind` name
 * the widget as well as `widget`; `@1.0.0` is optional; span can be a number)
 * and strict about what matters: an unknown widget or a widget that throws
 * shows its own error in its own cell — the rest of the grid still draws — and
 * the error names the valid ids, so a repair has what it needs.
 *
 * @module shared/kit/Cluster
 */

import React from 'react';
import { kitComponent } from './registry';
import { KIT_CATALOG, kitEntry } from './catalog';
import './kit.css';
import './kit-frame.css';

interface Placement {
  widget: string;
  title?: string;
  span: { w: number; h: number };
  options: Record<string, unknown>;
  thresholds?: Array<{ level: 'info' | 'warn' | 'crit'; gt?: number; lt?: number }>;
  note?: string;
  section?: string;
}

export interface ClusterSpec { title?: string; widgets: Placement[] }

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.round(n)));

/** Parse a fence body into placements. Throws a message a model can act on. */
export function parseCluster(source: string): ClusterSpec {
  let raw: unknown;
  try { raw = JSON.parse(source); }
  catch (err) { throw new Error(`the widgets block is not valid JSON — ${(err as Error).message}`); }
  const env = Array.isArray(raw) ? { widgets: raw } : raw as { title?: unknown; widgets?: unknown; panels?: unknown };
  const list = (env as { widgets?: unknown }).widgets ?? (env as { panels?: unknown }).panels;
  if (!Array.isArray(list) || list.length === 0) throw new Error('expected { "widgets": [ ... ] } with at least one widget');
  const widgets = list.map((item, i): Placement => {
    if (!item || typeof item !== 'object') throw new Error(`widget ${i + 1} is not an object`);
    const o = item as Record<string, unknown>;
    const ref = String(o.widget ?? o.type ?? o.kind ?? o.id ?? '').trim();
    if (!ref) throw new Error(`widget ${i + 1} does not say which widget it is ("widget": "stat")`);
    const span = typeof o.span === 'number' ? { w: o.span, h: 1 } : (o.span as { w?: number; h?: number } | undefined) ?? {};
    const options = (o.options && typeof o.options === 'object' ? o.options : Object.fromEntries(Object.entries(o).filter(([k]) =>
      !['widget', 'type', 'kind', 'id', 'title', 'span', 'thresholds', 'note', 'section', 'w', 'h'].includes(k)))) as Record<string, unknown>;
    return {
      widget: ref,
      title: typeof o.title === 'string' ? o.title : kitEntry(ref)?.name,
      span: { w: clamp(Number(span.w ?? o.w ?? 4) || 4, 1, 12), h: clamp(Number(span.h ?? o.h ?? 1) || 1, 1, 8) },
      options,
      thresholds: Array.isArray(o.thresholds) ? o.thresholds as Placement['thresholds'] : undefined,
      note: typeof o.note === 'string' ? o.note : undefined,
      section: typeof o.section === 'string' ? o.section : undefined,
    };
  });
  return { title: typeof (env as { title?: unknown }).title === 'string' ? (env as { title: string }).title : undefined, widgets };
}

class CellBoundary extends React.Component<{ id: string; children: React.ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(err: Error): { error: string } { return { error: err.message }; }
  render(): React.ReactNode {
    if (this.state.error) {
      return <div className="wg-error" role="alert"><b>{this.props.id} could not draw</b>{this.state.error}</div>;
    }
    return this.props.children;
  }
}

const HEIGHT = [0, 132, 236, 330, 420, 520, 620, 720, 820];

export function Cluster({ source, streaming = false }: { source: string; streaming?: boolean }): React.ReactElement {
  let spec: ClusterSpec;
  try {
    spec = parseCluster(source);
  } catch (err) {
    if (streaming) return <div className="px-3 py-4 text-[12px] text-aico-muted">Widgets arriving…</div>;
    throw err;
  }
  let lastSection: string | undefined;
  return (
    <div className="aico-kit">
      {spec.title && <div className="kit-title">{spec.title}</div>}
      <div className="dgrid kit-grid">
        {spec.widgets.map((p, i) => {
          const C = kitComponent(p.widget);
          const header = p.section && p.section !== lastSection ? p.section : null;
          lastSection = p.section ?? lastSection;
          return (
            <React.Fragment key={i}>
              {header && <div className="kit-section">{header}</div>}
              <section className={`wg s${p.span.w}`} style={{ gridColumn: `span ${p.span.w}`, minHeight: HEIGHT[p.span.h] }} aria-label={p.title}>
                {p.title && <div className="wg-h"><h5>{p.title}</h5></div>}
                <div className="wg-b">
                  {C ? (
                    <CellBoundary id={p.widget}>
                      <C options={p.options as never} provenance="free_text" thresholds={p.thresholds} />
                    </CellBoundary>
                  ) : (
                    <div className="wg-error" role="alert">
                      <b>No widget called “{p.widget}”</b>
                      Use one of: {KIT_CATALOG.slice(0, 36).map(e => e.id).join(', ')}…
                    </div>
                  )}
                </div>
                {p.note && <div className="wg-f">{p.note}</div>}
              </section>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
