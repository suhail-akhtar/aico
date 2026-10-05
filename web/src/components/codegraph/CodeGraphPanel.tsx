/**
 * The Code map's side panel: what the picture means, in words and lists a
 * person can act on — a file's exports and who uses each, its importers and
 * imports, history and owners; the impact by depth; a path hop by hop; the
 * cycles; the hotspots; the co-change pairs; the uncommitted change.
 *
 * Every list item selects its file on the map (and every file can be opened
 * in the editor), so the panel and the canvas are two views of one thing.
 *
 * Interfaces are explained, not just drawn: which types implement one,
 * whether declared or by matching method sets (Go, TypeScript), and each
 * method with where the implementation has it — a pointer receiver marked,
 * since then only `*T` satisfies it. Callers that reach a method only
 * through an interface are listed apart, and "Exact only" hides them.
 *
 * @module web/components/codegraph/CodeGraphPanel
 */

import React from 'react';
import { basename, dirname, splitUsers, type CgFileDetail, type CgImpl, type CgPayload, type CgSymbolDetail, type GraphModel, type Mode } from './model';
import { CgIcon } from './icons';

interface Props {
  model: GraphModel;
  payload: CgPayload;
  mode: Mode;
  selected: number;
  multi: Set<number>;
  detail: CgFileDetail | null;
  depths?: Map<number, number>;
  depth: number;
  symbol: CgSymbolDetail | null;
  pathIds?: number[];
  pathEnds: { from: number; to: number };
  cycleIdx: number;
  diff: { changed: string[]; ids: number[] } | null;
  group: number | null;
  canAsk: boolean;
  canOpen: boolean;
  askBusy: boolean;
  /** "Exact only": leave out what rests on an interface or a unique name. */
  exactOnly?: boolean;
  onSelect: (id: number) => void;
  onOpen: (path: string, line?: number) => void;
  /** The desktop's "Open in external editor". */
  onOpenExternal?: (path: string, line?: number) => void;
  onAsk: () => void;
  onMode: (m: Mode) => void;
  onSymbol: (file: number, name: string) => void;
  onPathEnd: (end: 'from' | 'to', id: number) => void;
  onCycle: (i: number) => void;
  onGroup: (id: number) => void;
}

export function CodeGraphPanel(p: Props): React.ReactElement {
  return (
    <aside className="flex w-[340px] shrink-0 flex-col border-l border-aico-border bg-aico-bg" aria-label="Details">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-[12.5px]">
        <ModeSection {...p} />
        {p.selected >= 0 && p.mode !== 'symbol' && <FileSection {...p} />}
        {p.selected < 0 && p.mode !== 'symbol' && p.group !== null && <GroupSection {...p} />}
        {p.selected < 0 && p.group === null && ['architecture', 'files'].includes(p.mode) && <Summary {...p} />}
      </div>
      {p.canAsk && (
        <div className="border-t border-aico-border p-3">
          <button className="flex w-full items-center justify-center gap-2 rounded-lg bg-aico-accent px-3 py-2 text-[13px] font-medium text-aico-on-accent hover:bg-aico-accent-hover disabled:opacity-50"
            onClick={p.onAsk} disabled={p.askBusy} title="Start a chat with the selection and its neighbourhood as context (A)">
            <CgIcon name="sparkles" size={15} />{p.askBusy ? 'Preparing context…' : askLabel(p)}
          </button>
        </div>
      )}
    </aside>
  );
}

function askLabel(p: Props): string {
  if (p.mode === 'symbol' && p.symbol) return `Ask AICO about ${p.symbol.name}`;
  if (p.mode === 'path' && p.pathIds?.length) return 'Ask AICO about this path';
  if (p.mode === 'changes') return 'Ask AICO to review this change';
  if (p.mode === 'impact' && p.selected >= 0) return 'Ask AICO about this impact';
  if (p.multi.size > 0) return `Ask AICO about ${p.multi.size + (p.selected >= 0 ? 1 : 0)} files`;
  if (p.selected >= 0) return 'Ask AICO about this file';
  if (p.group !== null) return 'Ask AICO about this module';
  return 'Ask AICO about this';
}

function H({ children, right }: { children: React.ReactNode; right?: React.ReactNode }): React.ReactElement {
  return <div className="mb-1.5 mt-4 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-aico-muted first:mt-0"><span>{children}</span>{right}</div>;
}

function FileRow({ p, id, note, line }: { p: Props; id: number; note?: React.ReactNode; line?: number }): React.ReactElement {
  const f = p.model.file(id);
  return (
    <div className="group flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-aico-hover">
      <button className="min-w-0 flex-1 truncate text-left" onClick={() => p.onSelect(id)} title={f.path}>
        <span className="font-medium">{basename(f.path)}</span>
        <span className="ml-1.5 text-aico-muted">{dirname(f.path)}</span>
        {note ? <span className="ml-1.5 text-aico-muted">{note}</span> : null}
      </button>
      {p.canOpen && (
        <button className="invisible shrink-0 rounded p-0.5 text-aico-muted hover:text-aico-primary group-hover:visible" onClick={() => p.onOpen(f.path, line)} title={p.onOpenExternal ? 'Open in the editor here' : 'Open in your editor'} aria-label={`Open ${f.path}`}>
          <CgIcon name="external" size={12} />
        </button>
      )}
      {p.onOpenExternal && (
        <button className="invisible shrink-0 rounded px-1 text-[10.5px] text-aico-muted hover:text-aico-primary group-hover:visible" onClick={() => p.onOpenExternal!(f.path, line)} title="Open in external editor (VS Code or editor.command)" aria-label={`Open ${f.path} in external editor`}>
          ext
        </button>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }): React.ReactElement {
  return (
    <div className="rounded-lg border border-aico-border px-2 py-1.5">
      <div className="text-[10.5px] text-aico-muted">{label}</div>
      <div className="text-[14px] font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function List({ p, ids, limit = 60, note }: { p: Props; ids: number[]; limit?: number; note?: (id: number) => React.ReactNode }): React.ReactElement {
  return (
    <div>
      {ids.slice(0, limit).map(id => <FileRow key={id} p={p} id={id} note={note?.(id)} />)}
      {ids.length > limit && <div className="px-1.5 py-1 text-aico-muted">… {ids.length - limit} more</div>}
    </div>
  );
}

function ModeSection(p: Props): React.ReactElement | null {
  const { model, payload } = p;
  switch (p.mode) {
    case 'impact': {
      if (p.selected < 0 || !p.depths) return <Hint>Select a file to see everything that depends on it, nearest first.</Hint>;
      const layers = byDepth(p.depths);
      const total = [...p.depths.values()].filter(d => d > 0).length;
      const tests = [...p.depths.entries()].filter(([id, d]) => d > 0 && model.file(id).test).map(([id]) => id);
      return (
        <>
          <H>Impact of {basename(model.file(p.selected).path)}</H>
          <div className="mb-2 grid grid-cols-3 gap-1.5">
            {[1, 2, 3].map(d => <Stat key={d} label={`Depth ${d}`} value={layers.get(d)?.length ?? 0} />)}
          </div>
          <div className="text-aico-muted">{total} file(s) within depth {p.depth}{tests.length ? `, ${tests.length} of them tests` : ''}.</div>
          {[...layers.entries()].filter(([d]) => d > 0).map(([d, ids]) => (
            <div key={d}><H>Depth {d} · {ids.length}</H><List p={p} ids={ids} limit={d === 1 ? 80 : 30} /></div>
          ))}
          {tests.length > 0 && <><H>Tests that reach it</H><List p={p} ids={tests} limit={20} /></>}
        </>
      );
    }
    case 'symbol': {
      if (!p.symbol) return <Hint>Find a symbol with the search box, or pick one from a file’s exports. Its users are found through imports, aliases, re-exports and receiver types (method calls) — same-named symbols elsewhere are not mixed in.</Hint>;
      const s = p.symbol;
      const { direct, viaInterface, reexports: reexp } = splitUsers(s.users, Boolean(p.exactOnly));
      return (
        <>
          <H>Symbol</H>
          <div className="font-mono text-[13px] font-semibold">{s.name}</div>
          <button className="text-left text-aico-muted hover:text-aico-primary" onClick={() => p.onOpen(model.file(s.file).path, s.line)}>{model.file(s.file).path}{s.line ? `:${s.line}` : ''}</button>
          {s.sig && <pre className="mt-1.5 whitespace-pre-wrap break-words rounded-md bg-aico-surface p-2 font-mono text-[11.5px]">{s.sig}</pre>}
          <H>Used in {direct.length} file(s)</H>
          {s.exactness?.mode === 'on-demand' && <div className="mb-1 text-[11.5px] text-aico-muted" data-exactness="on-demand"><Badge tone="accent">exact (on demand)</Badge> found by the TypeScript language service for this symbol{s.exactness.cached ? ' (cached)' : ` in ${(s.exactness.ms / 1000).toFixed(1)} s`} — the project is over the whole-project checker’s limit.</div>}
          {s.exactness?.mode === 'partial' && <div className="mb-1 text-[11.5px] text-aico-warning" data-exactness="partial"><Badge>partial</Badge> {s.exactness.note}</div>}
          {direct.length === 0 && <div className="text-aico-muted">No file uses it through a resolved import.</div>}
          {direct.slice(0, 150).map(u => (
            <FileRow key={u.id} p={p} id={u.id} line={u.lines[0]} note={<>{u.lines[0] ? `:${u.lines[0]}` : ''}{u.local !== s.name ? ` as ${u.local}` : ''}{u.via === 'inferred' || u.via === 'package' ? ` (${u.via})` : ''}</>} />
          ))}
          {viaInterface.length > 0 && (
            <>
              <H>Through an interface · {viaInterface.length}</H>
              <div className="mb-1 text-aico-muted">Calls on an interface or abstract method this implements: they may reach it, not certainly. “Exact only” hides them.</div>
              {viaInterface.slice(0, 80).map(u => <FileRow key={u.id} p={p} id={u.id} line={u.lines[0]} note={<>{u.lines[0] ? `:${u.lines[0]}` : ''}{u.local !== s.name ? ` via ${u.local}` : ''}</>} />)}
            </>
          )}
          {reexp.length > 0 && <><H>Re-exported by</H>{reexp.map(u => <FileRow key={u.id} p={p} id={u.id} note={u.local !== s.name ? `as ${u.local}` : undefined} />)}</>}
          {s.implementations && s.implementations.length > 0 && <><H>Implemented by · {s.implementations.length}</H>{s.implementations.map((i, k) => <ImplRow key={k} p={p} impl={i} side="impl" />)}</>}
          {s.implementing && s.implementing.length > 0 && <><H>Implements · {s.implementing.length}</H>{s.implementing.map((i, k) => <ImplRow key={k} p={p} impl={i} side="iface" />)}</>}
        </>
      );
    }
    case 'path': {
      const from = p.pathEnds.from >= 0 ? p.pathEnds.from : p.selected;
      return (
        <>
          <H>Path</H>
          <div className="space-y-1">
            <EndRow p={p} label="From" id={from} />
            <EndRow p={p} label="To" id={p.pathEnds.to} />
          </div>
          {from >= 0 && p.pathEnds.to >= 0 && (p.pathIds?.length
            ? <><H>{p.pathIds.length - 1} hop(s){p.pathIds[0] !== from ? ' — reversed: the destination depends on the start' : ''}</H>{p.pathIds.map((id, i) => <FileRow key={id} p={p} id={id} note={i === 0 ? 'start' : undefined} />)}</>
            : <div className="mt-2 text-aico-muted">No dependency path in either direction. Calls through events, HTTP or dependency injection by name are invisible to imports.</div>)}
        </>
      );
    }
    case 'cycles':
      if (!payload.cycles.length) return <Hint>No import cycles.</Hint>;
      return (
        <>
          <H>{payload.cycles.length} import cycle(s)</H>
          {payload.cycles.slice(0, 50).map((c, i) => (
            <button key={i} className={`mb-1 block w-full rounded-lg border px-2 py-1.5 text-left ${i === p.cycleIdx ? 'border-aico-danger/60 bg-aico-danger/5' : 'border-aico-border hover:bg-aico-hover'}`} onClick={() => p.onCycle(i)}>
              <div className="font-medium">{c.length} files</div>
              <div className="truncate text-aico-muted">{c.slice(0, 5).map(id => basename(model.file(id).path)).join(' · ')}{c.length > 5 ? ' …' : ''}</div>
            </button>
          ))}
          {payload.cycles[p.cycleIdx] && <><H>Files in this cycle</H><List p={p} ids={payload.cycles[p.cycleIdx]!} /></>}
        </>
      );
    case 'hotspots': {
      if (!payload.git.available) return <Hint>This folder has no git history, so there is no churn to score. Hotspots need commits.</Hint>;
      const top = payload.files.map((f, id) => ({ f, id })).filter(x => x.f.hotspot > 0).sort((a, b) => b.f.hotspot - a.f.hotspot).slice(0, 25);
      return (
        <>
          <H>Hotspots</H>
          <div className="mb-1 text-aico-muted">Files that change often, are depended on, and are large — where bugs and merge pain concentrate. Last {payload.git.commits} commits.</div>
          {top.map(({ f, id }) => <FileRow key={id} p={p} id={id} note={`${f.churn} commits · ${f.fanIn} importers`} />)}
        </>
      );
    }
    case 'cochange': {
      if (!payload.git.available) return <Hint>No git history here, so no co-change signal.</Hint>;
      const linked = new Set(payload.edges.map(e => `${Math.min(e[0], e[1])},${Math.max(e[0], e[1])}`));
      const pairs = payload.cochange.filter(([a, b]) => p.selected < 0 || a === p.selected || b === p.selected).slice(0, 60);
      return (
        <>
          <H>Changed together</H>
          <div className="mb-1 text-aico-muted">From the last {payload.git.commits} commits (commits touching more than 40 files ignored). Pairs with no import between them are the ones a search would miss.</div>
          {pairs.length === 0 && <div className="text-aico-muted">No files changed together more than once{p.selected >= 0 ? ' with this one' : ''}.</div>}
          {pairs.map(([a, b, count, conf]) => {
            const hidden = !linked.has(`${Math.min(a, b)},${Math.max(a, b)}`);
            return (
              <div key={`${a},${b}`} className="mb-1 rounded-lg border border-aico-border px-2 py-1">
                <div className="flex items-center gap-1 text-[11.5px] text-aico-muted">{count} commits · {Math.round(conf * 100)}%{hidden ? <span className="ml-auto rounded bg-aico-warning/15 px-1 text-aico-warning">no import</span> : null}</div>
                <FileRow p={p} id={a} /><FileRow p={p} id={b} />
              </div>
            );
          })}
        </>
      );
    }
    case 'changes': {
      if (!p.diff) return <Hint>Reading the working tree…</Hint>;
      if (!p.diff.changed.length) return <Hint>No uncommitted changes.</Hint>;
      const layers = p.depths ? byDepth(p.depths) : new Map<number, number[]>();
      const affected = [...(p.depths?.entries() ?? [])].filter(([, d]) => d > 0).map(([id]) => id);
      const tests = [...(p.depths?.keys() ?? [])].filter(id => model.file(id).test);
      return (
        <>
          <H>Your uncommitted change</H>
          <div className="mb-2 grid grid-cols-3 gap-1.5"><Stat label="Changed" value={p.diff.ids.length} /><Stat label="Affected" value={affected.length} /><Stat label="Tests" value={tests.length} /></div>
          <H>Changed</H><List p={p} ids={p.diff.ids} />
          {p.diff.changed.length > p.diff.ids.length && <div className="px-1.5 text-aico-muted">+ {p.diff.changed.length - p.diff.ids.length} non-source file(s)</div>}
          {[...layers.entries()].filter(([d]) => d > 0).map(([d, ids]) => <div key={d}><H>Affected · depth {d} · {ids.length}</H><List p={p} ids={ids} limit={40} /></div>)}
          {tests.length > 0 && <><H>Tests to run</H><List p={p} ids={tests} limit={30} /></>}
        </>
      );
    }
    default:
      return null;
  }
}

/**
 * One implementation, with why: declared, or by method set — each method
 * linked to where the implementation has it, a pointer receiver marked.
 */
function ImplRow({ p, impl, side }: { p: Props; impl: CgImpl; side: 'impl' | 'iface' }): React.ReactElement {
  const other = side === 'impl' ? impl.impl : impl.iface;
  return (
    <div className="mb-1.5 rounded-lg border border-aico-border px-2 py-1.5" data-impl={`${impl.iface.name}>${impl.impl.name}`}>
      <div className="flex items-center gap-1.5">
        <button className="min-w-0 flex-1 truncate text-left font-mono text-[12px] font-semibold" onClick={() => p.onSelect(other.id)} title={p.model.file(other.id).path}>
          {side === 'impl' && impl.pointer ? '*' : ''}{other.name}
        </button>
        <Badge tone={impl.how === 'structural' ? 'accent' : undefined}>{impl.how === 'structural' ? 'method set' : 'declared'}</Badge>
        {impl.pointer ? <Badge>pointer receiver</Badge> : null}
      </div>
      <div className="truncate text-[11px] text-aico-muted">{p.model.file(other.id).path}</div>
      <div className="mt-1 text-[11.5px] text-aico-secondary">{impl.why}</div>
      {impl.methods.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {impl.methods.map(m => (
            <button key={m.name} className="rounded border border-aico-border px-1.5 py-px font-mono text-[11px] hover:bg-aico-hover" onClick={() => p.onOpen(p.model.file(m.id).path, m.line)} title={`${p.model.file(m.id).path}:${m.line}${m.ptr ? ' — pointer receiver' : ''}`}>
              {m.name}{m.ptr ? '*' : ''}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function EndRow({ p, label, id }: { p: Props; label: string; id: number }): React.ReactElement {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-aico-border px-2 py-1.5">
      <span className="w-9 text-[11px] text-aico-muted">{label}</span>
      {id >= 0 ? <button className="min-w-0 flex-1 truncate text-left font-medium" onClick={() => p.onSelect(id)}>{p.model.file(id).path}</button> : <span className="text-aico-muted">click a file on the map</span>}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="mb-3 rounded-lg bg-aico-surface px-3 py-2 text-aico-secondary">{children}</div>;
}

function byDepth(depths: Map<number, number>): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const [id, d] of depths) { const l = out.get(d) ?? []; l.push(id); out.set(d, l); }
  return new Map([...out.entries()].sort((a, b) => a[0] - b[0]));
}

function FileSection(p: Props): React.ReactElement {
  const f = p.model.file(p.selected);
  const d = p.detail;
  return (
    <>
      <H right={p.canOpen ? <button className="flex items-center gap-1 normal-case tracking-normal text-aico-accent" onClick={() => p.onOpen(f.path)}><CgIcon name="external" size={12} />Open</button> : undefined}>File</H>
      <div className="break-all text-[13px] font-semibold">{basename(f.path)}</div>
      <div className="break-all text-aico-muted">{dirname(f.path) || '.'}</div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        <Badge>{f.lang}</Badge>
        {f.test ? <Badge>test</Badge> : null}
        {f.entry ? <Badge tone="accent">entry · {f.entry}</Badge> : null}
        {d?.community ? <Badge>{d.community}</Badge> : null}
        {p.payload.cycles.some(c => c.includes(p.selected)) ? <Badge tone="danger">in a cycle</Badge> : null}
      </div>
      <div className="mt-2 grid grid-cols-4 gap-1.5">
        <Stat label="Lines" value={f.loc.toLocaleString()} />
        <Stat label="Used by" value={f.fanIn} />
        <Stat label="Uses" value={f.fanOut} />
        <Stat label="Commits" value={f.churn} />
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        <Chip onClick={() => p.onMode('impact')}><CgIcon name="target" size={12} />Impact</Chip>
        <Chip onClick={() => p.onPathEnd('from', p.selected)}><CgIcon name="route" size={12} />Path from here</Chip>
        <Chip onClick={() => p.onPathEnd('to', p.selected)}>Path to here</Chip>
        {p.payload.git.available ? <Chip onClick={() => p.onMode('cochange')}><CgIcon name="git" size={12} />Changes with</Chip> : null}
      </div>
      {!d && <div className="mt-3 h-24 animate-pulse rounded-lg bg-aico-surface" />}
      {d && (
        <>
          {d.exports.length > 0 && (
            <>
              <H>Exports · users</H>
              {d.exports.slice(0, 40).map(e => (
                <button key={e.name} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-aico-hover" onClick={() => p.onSymbol(p.selected, e.name)} title={e.sig}>
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{e.name}</span>
                  <span className="text-[11px] text-aico-muted">{e.kind}</span>
                  <span className={`min-w-[2.5em] text-right tabular-nums ${e.users ? 'text-aico-primary' : 'text-aico-muted'}`}>{e.users}</span>
                </button>
              ))}
            </>
          )}
          {(d.implementedBy?.length ?? 0) > 0 && (
            <>
              <H>Interfaces here · implemented by {d.implementedBy!.length}</H>
              {d.implementedBy!.slice(0, 40).map((i, k) => <div key={k}><div className="px-1 font-mono text-[11px] text-aico-muted">{i.iface.name}</div><ImplRow p={p} impl={i} side="impl" /></div>)}
            </>
          )}
          {(d.implementing?.length ?? 0) > 0 && (
            <>
              <H>Implements · {d.implementing!.length}</H>
              {d.implementing!.slice(0, 40).map((i, k) => <ImplRow key={k} p={p} impl={i} side="iface" />)}
            </>
          )}
          <H>Used by · {d.importers.length}</H>
          {d.importers.length === 0 ? <div className="px-1.5 text-aico-muted">Nothing imports it{f.entry ? ' — it is an entry point' : ''}.</div>
            : d.importers.filter(x => !p.exactOnly || !x.inferred).slice(0, 60).map(x => <FileRow key={x.id} p={p} id={x.id} note={x.names.length ? `[${x.names.slice(0, 3).join(', ')}${x.names.length > 3 ? ', …' : ''}]${x.viaInterface ? ' via interface' : x.inferred ? ' inferred' : ''}` : x.viaInterface ? 'via interface' : x.inferred ? 'inferred' : undefined} />)}
          <H>Uses · {d.imports.length}</H>
          {d.imports.filter(x => !p.exactOnly || !x.inferred).slice(0, 60).map(x => <FileRow key={x.id} p={p} id={x.id} note={x.names.length ? `[${x.names.slice(0, 3).join(', ')}${x.names.length > 3 ? ', …' : ''}]${x.viaInterface ? ' via interface' : ''}` : x.viaInterface ? 'via interface' : undefined} />)}
          {d.external.length > 0 && <><H>Packages</H><div className="flex flex-wrap gap-1">{d.external.map(x => <Badge key={x}>{x}</Badge>)}</div></>}
          {d.cochange.length > 0 && <><H>Changes together with</H>{d.cochange.map(c => <FileRow key={c.id} p={p} id={c.id} note={`${c.count}× · ${Math.round(c.confidence * 100)}%`} />)}</>}
          {(d.authors.length > 0 || d.commits.length > 0) && (
            <>
              <H>History</H>
              {d.authors.length > 0 && <div className="mb-1 text-aico-muted">Mostly changed by {d.authors.map(([a, n]) => `${a} (${n})`).join(', ')}</div>}
              {d.commits.map(c => (
                <div key={c.hash} className="flex gap-2 py-0.5">
                  <span className="shrink-0 font-mono text-[11px] text-aico-muted">{c.hash.slice(0, 7)}</span>
                  <span className="min-w-0 flex-1 truncate" title={c.subject}>{c.subject}</span>
                  <span className="shrink-0 text-[11px] text-aico-muted">{relDate(c.at)}</span>
                </div>
              ))}
            </>
          )}
        </>
      )}
    </>
  );
}

function GroupSection(p: Props): React.ReactElement | null {
  const c = p.payload.communities.find(x => x.id === p.group);
  if (!c) return null;
  const files = [...c.files].sort((a, b) => p.model.file(b).fanIn - p.model.file(a).fanIn);
  const outward = new Map<number, number>();
  const inward = new Map<number, number>();
  const inC = new Set(c.files);
  for (const [a, b, , , pass] of p.payload.edges) {
    if (pass) continue;
    if (inC.has(a) && !inC.has(b)) { const k = p.model.file(b).community; outward.set(k, (outward.get(k) ?? 0) + 1); }
    if (!inC.has(a) && inC.has(b)) { const k = p.model.file(a).community; inward.set(k, (inward.get(k) ?? 0) + 1); }
  }
  const name = (id: number): string => p.payload.communities.find(x => x.id === id)?.label ?? '?';
  return (
    <>
      <H>Module</H>
      <div className="text-[13px] font-semibold">{c.label}</div>
      <div className="text-aico-muted">{c.files.length} files that depend mostly on each other.</div>
      {outward.size > 0 && <><H>Depends on</H>{[...outward.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => <button key={k} className="flex w-full justify-between rounded-md px-1.5 py-1 hover:bg-aico-hover" onClick={() => p.onGroup(k)}><span className="truncate">{name(k)}</span><span className="text-aico-muted">{n}</span></button>)}</>}
      {inward.size > 0 && <><H>Used by</H>{[...inward.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => <button key={k} className="flex w-full justify-between rounded-md px-1.5 py-1 hover:bg-aico-hover" onClick={() => p.onGroup(k)}><span className="truncate">{name(k)}</span><span className="text-aico-muted">{n}</span></button>)}</>}
      <H>Core files</H>
      <List p={p} ids={files} limit={25} note={id => `${p.model.file(id).fanIn} importers`} />
    </>
  );
}

function Summary(p: Props): React.ReactElement {
  const { payload, model } = p;
  const langs = new Map<string, number>();
  for (const f of payload.files) langs.set(f.lang, (langs.get(f.lang) ?? 0) + 1);
  const hubs = payload.files.map((f, id) => ({ f, id })).sort((a, b) => b.f.fanIn - a.f.fanIn).slice(0, 8);
  const entries = payload.files.map((f, id) => ({ f, id })).filter(x => x.f.entry && !x.f.test);
  return (
    <>
      <H>Project</H>
      <div className="grid grid-cols-3 gap-1.5">
        <Stat label="Files" value={payload.files.length.toLocaleString()} />
        <Stat label="Modules" value={payload.communities.length} />
        <Stat label="Cycles" value={payload.cycles.length} />
      </div>
      <div className="mt-2 flex flex-wrap gap-1">{[...langs.entries()].sort((a, b) => b[1] - a[1]).map(([l, n]) => <Badge key={l}>{l} {n}</Badge>)}</div>
      <H>Modules</H>
      {payload.communities.slice(0, 12).map(c => (
        <button key={c.id} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-aico-hover" onClick={() => p.onGroup(c.id)}>
          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#76b7b2', '#b07aa1', '#edc948', '#9c755f', '#ff9da7', '#5fa2ce', '#8cd17d', '#d37295', '#a0cbe8', '#c49c94', '#86bcb6', '#d4a6c8'][c.id % 16] }} />
          <span className="min-w-0 flex-1 truncate">{c.label}</span><span className="text-aico-muted">{c.files.length}</span>
        </button>
      ))}
      <H>Most depended on</H>
      {hubs.map(({ f, id }) => <FileRow key={id} p={p} id={id} note={`${f.fanIn}`} />)}
      {entries.length > 0 && <><H>Entry points · {entries.length}</H><List p={p} ids={entries.map(e => e.id)} limit={12} note={id => model.file(id).entry} /></>}
      {payload.violations.length > 0 && (
        <>
          <H>Layering violations · {payload.violations.length}</H>
          {payload.violations.slice(0, 12).map((v, i) => <div key={i} className="mb-1 rounded-md border border-aico-danger/30 px-2 py-1"><div className="text-[11px] text-aico-danger">{v.rule}</div><FileRow p={p} id={v.from} note={`→ ${basename(model.file(v.to).path)}`} /></div>)}
        </>
      )}
      {payload.orphans.length > 0 && <><H>Nothing imports · {payload.orphans.length}</H><div className="mb-1 text-aico-muted">Not entry points, tests or config — candidates for dead code.</div><List p={p} ids={payload.orphans} limit={15} /></>}
      {payload.external.length > 0 && <><H>Packages</H><div className="flex flex-wrap gap-1">{payload.external.slice(0, 24).map(([name, n]) => <Badge key={name}>{name} {n}</Badge>)}</div></>}
      <H>Keys</H>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-aico-muted">
        <span>/ search</span><span>arrows walk edges</span><span>1–9 views</span><span>Enter open</span><span>0 fit · F focus</span><span>A ask AICO</span><span>Shift-click add</span><span>Esc clear</span>
      </div>
    </>
  );
}

function Badge({ children, tone }: { children: React.ReactNode; tone?: 'accent' | 'danger' }): React.ReactElement {
  const cls = tone === 'accent' ? 'border-aico-accent/40 text-aico-accent' : tone === 'danger' ? 'border-aico-danger/40 text-aico-danger' : 'border-aico-border text-aico-secondary';
  return <span className={`rounded-full border px-1.5 py-px text-[11px] ${cls}`}>{children}</span>;
}

function Chip({ children, onClick }: { children: React.ReactNode; onClick: () => void }): React.ReactElement {
  return <button className="flex items-center gap-1 rounded-full border border-aico-border px-2 py-0.5 text-[11.5px] text-aico-secondary hover:border-aico-accent hover:text-aico-primary" onClick={onClick}>{children}</button>;
}

function relDate(ms: number): string {
  const d = (Date.now() - ms) / 86_400_000;
  if (d < 1) return 'today';
  if (d < 2) return 'yesterday';
  if (d < 60) return `${Math.round(d)}d ago`;
  return new Date(ms).toISOString().slice(0, 10);
}
