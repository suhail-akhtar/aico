/**
 * The Code map: a project's real dependency graph, drawn so a person can
 * find their way around it and hand precise context to the agent.
 *
 * One component for every client (the desktop page, the web workspace page):
 * it talks to the engine over `/api/codegraph/*` and asks its host only for
 * the two things a client owns — opening a file in its editor, and starting a
 * chat with a prepared prompt ("Ask AICO about this").
 *
 * ## How it stays fast
 *
 * The picture is drawn imperatively on a canvas (render.ts) from a scene
 * rebuilt only when something it depends on changed (scene.ts); React renders
 * the chrome around it. The layout runs in a Web Worker (layout.worker.ts)
 * and streams positions, starting from a module-seeded arrangement so the
 * first frame is already a map. The graph refreshes itself: the engine is
 * asked for its version every few seconds while the page is visible, and a
 * new version keeps every file where it was.
 *
 * @module web/components/codegraph/CodeGraphView
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import {
  askPrompt, basename, DEFAULT_FILTERS, exactPayload, GraphModel, MODES, toSvg,
  type CgFileDetail, type CgPayload, type CgSymbolDetail, type Filters, type Mode,
} from './model';
import { ForceLayout, initialPositions } from './layout';
import { buildScene, type ColorBy, type Scene, type SceneInput } from './scene';
import { draw, drawMinimap, fit, hitTest, toWorld, type Camera, type Theme } from './render';
import { CodeGraphPanel } from './CodeGraphPanel';
import { CgIcon } from './icons';

export interface CodeGraphHost {
  /**
   * Open a project-relative file (at a line) in the client's editor. May
   * resolve to a line to show ("Opened in VS Code at line 12").
   */
  openFile?: (relPath: string, line?: number) => void | Promise<string | void>;
  /** The desktop: also offer the person's external editor (server/editor). */
  openExternal?: (relPath: string, line?: number) => Promise<string | void>;
  /** Start a chat in this project with the prompt prepared. */
  ask?: (prompt: string) => void;
}

export interface CodeGraphViewProps {
  projectPath: string;
  projectName?: string;
  host?: CodeGraphHost;
  /** A file to select on open (project-relative). */
  initialFile?: string;
  initialMode?: Mode;
}

const POLL_MS = 5_000;

function readTheme(el: Element | null): Theme {
  const cs = getComputedStyle(el ?? document.documentElement);
  const v = (name: string, fallback: string): string => cs.getPropertyValue(name).trim() || fallback;
  const dark = document.documentElement.classList.contains('dark') || document.body.classList.contains('dark');
  return {
    bg: v('--aico-bg', dark ? '#0f1115' : '#ffffff'),
    surface: v('--aico-surface', dark ? '#16181d' : '#f7f7f8'),
    fg: v('--aico-text-primary', dark ? '#e8eaed' : '#0f1115'),
    muted: v('--aico-text-muted', '#8a8f98'),
    border: v('--aico-border', dark ? '#2a2d34' : '#e5e7eb'),
    accent: v('--aico-accent', '#4176e6'),
    danger: v('--aico-danger', '#dc2626'),
    warning: v('--aico-warning', '#d97706'),
    success: v('--aico-success', '#16a34a'),
    dark,
  };
}

function useTheme(ref: React.RefObject<HTMLElement | null>): Theme {
  const [theme, setTheme] = useState<Theme>(() => readTheme(null));
  useEffect(() => {
    const update = (): void => setTheme(readTheme(ref.current));
    update();
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    return () => mo.disconnect();
  }, [ref]);
  return theme;
}

/** Save a blob as a file through the browser (desktop and web both handle downloads). */
function saveBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

export function CodeGraphView({ projectPath, projectName, host, initialFile, initialMode }: CodeGraphViewProps): React.ReactElement {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const miniRef = useRef<HTMLCanvasElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const theme = useTheme(rootRef);

  const [payload, setPayload] = useState<CgPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [mode, setModeState] = useState<Mode>(initialMode ?? 'architecture');
  const [colorBy, setColorBy] = useState<ColorBy>('module');
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [depth, setDepth] = useState(2);
  const [selected, setSelected] = useState(-1);
  const [multi, setMulti] = useState<Set<number>>(new Set());
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [group, setGroup] = useState<number | null>(null);
  const [detail, setDetail] = useState<CgFileDetail | null>(null);
  const [symbol, setSymbol] = useState<{ file: number; name: string } | null>(null);
  const [symbolDetail, setSymbolDetail] = useState<CgSymbolDetail | null>(null);
  const [pathEnds, setPathEnds] = useState<{ from: number; to: number }>({ from: -1, to: -1 });
  const [cycleIdx, setCycleIdx] = useState(0);
  const [diff, setDiff] = useState<{ changed: string[]; ids: number[] } | null>(null);
  const [query, setQuery] = useState('');
  const [symbolHits, setSymbolHits] = useState<Array<{ file: number; name: string; kind: string; line: number }>>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchCursor, setSearchCursor] = useState(0);
  const [panelOpen, setPanelOpen] = useState(true);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [hover, setHover] = useState<{ idx: number; x: number; y: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [layoutState, setLayoutState] = useState<'idle' | 'running' | 'done'>('idle');
  const [askBusy, setAskBusy] = useState(false);

  // "Exact only" drops the links that rest on an interface or a unique name before anything is drawn.
  const model = useMemo(() => (payload ? new GraphModel(filters.exactOnly ? exactPayload(payload) : payload) : null), [payload, filters.exactOnly]);
  const mask = useMemo(() => (model ? model.visible(filters) : new Uint8Array()), [model, filters]);

  // ── Loading and staying fresh ────────────────────────────────────────────
  const load = useCallback(async (opts: { silent?: boolean; force?: boolean } = {}) => {
    if (!opts.silent) setError(null);
    setRefreshing(true);
    try {
      const next = await api.codeGraph(projectPath, opts.force);
      setPayload(prev => (prev && prev.version === next.version ? prev : next));
    } catch (err) {
      if (!opts.silent) setError((err as Error).message);
    } finally {
      setRefreshing(false);
    }
  }, [projectPath]);

  useEffect(() => {
    setPayload(null); setSelected(-1); setMulti(new Set()); setDetail(null); setSymbol(null); setExpanded(new Set()); setGroup(null);
    posByPath.current = new Map();
    void load();
  }, [load]);

  const versionRef = useRef<string | null>(null);
  versionRef.current = payload?.version ?? null;
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible' || !versionRef.current) return;
      void api.codeGraphVersion(projectPath).then(v => { if (v.version !== versionRef.current) void load({ silent: true }); }).catch(() => {});
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [projectPath, load]);

  const flash = useCallback((text: string) => { setNotice(text); setTimeout(() => setNotice(n => (n === text ? null : n)), 2_600); }, []);
  const openFile = useCallback((rel: string, line?: number) => {
    const r = host?.openFile?.(rel, line);
    if (r && typeof (r as Promise<string | void>).then === 'function') void (r as Promise<string | void>).then(t => { if (t) flash(t); }).catch(() => undefined);
  }, [host, flash]);
  const openExternal = useCallback((rel: string, line?: number) => {
    void host?.openExternal?.(rel, line).then(t => { if (t) flash(t); }).catch(err => flash(err instanceof Error ? err.message : String(err)));
  }, [host, flash]);

  // ── Layout (worker) ──────────────────────────────────────────────────────
  const posRef = useRef<Float32Array>(new Float32Array());
  const posByPath = useRef<Map<string, [number, number]>>(new Map());
  const camRef = useRef<Camera>({ x: 0, y: 0, k: 1 });
  const fittedRef = useRef(false);
  const dirty = useRef({ scene: true, draw: true });
  const sceneRef = useRef<Scene>({ nodes: [], edges: [], fileIndex: new Map() });
  const inputsRef = useRef<SceneInput | null>(null);
  const sizeRef = useRef({ w: 800, h: 600, dpr: 1 });
  const hoverRef = useRef(-1);

  useEffect(() => {
    if (!model) return;
    const n = model.n;
    const pairs: number[] = [];
    for (const [a, b, , , pass] of model.payload.edges) if (!pass) pairs.push(a, b);
    const edges = Int32Array.from(pairs);
    const groups = Int32Array.from(model.payload.files.map(f => f.community));
    const mass = Float32Array.from(model.payload.files.map(f => 1 + Math.sqrt(f.loc) / 25));
    // Keep files where they were when the graph refreshes; seed new ones by module.
    const seeded = initialPositions({ n, edges, groups, mass }).pos;
    const init = new Float32Array(n * 2);
    let kept = 0;
    model.payload.files.forEach((f, i) => {
      const old = posByPath.current.get(f.path);
      if (old) { init[i * 2] = old[0]; init[i * 2 + 1] = old[1]; kept++; } else { init[i * 2] = seeded[i * 2]!; init[i * 2 + 1] = seeded[i * 2 + 1]!; }
    });
    posRef.current = init;
    dirty.current.scene = true;
    const maxTicks = kept > n * 0.9 ? 60 : n > 3000 ? 260 : 320;
    const remember = (): void => { posByPath.current = new Map(model.payload.files.map((f, i) => [f.path, [posRef.current[i * 2]!, posRef.current[i * 2 + 1]!]])); };
    let worker: Worker | null = null;
    let cancelled = false;
    setLayoutState('running');
    const onPositions = (pos: Float32Array, done: boolean): void => {
      if (cancelled) return;
      posRef.current = pos;
      dirty.current.scene = true;
      if (!fittedRef.current) { fittedRef.current = true; fitView(); }
      if (done) { setLayoutState('done'); remember(); if (!userMoved.current) fitView(); }
    };
    try {
      worker = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (ev: MessageEvent<{ type: string; pos: Float32Array; done: boolean }>) => onPositions(ev.data.pos, ev.data.done);
      worker.onerror = () => { worker?.terminate(); worker = null; runInline(); };
      worker.postMessage({ type: 'start', n, edges, groups, mass, init, maxTicks });
    } catch {
      runInline();
    }
    // Where workers are unavailable: the same layout in slices on the main thread.
    function runInline(): void {
      const layout = new ForceLayout({ n, edges, groups, mass }, posRef.current);
      const step = (): void => {
        if (cancelled) return;
        const started = performance.now();
        while (performance.now() - started < 12 && layout.ticks < maxTicks) layout.tick();
        onPositions(Float32Array.from(layout.pos), layout.ticks >= maxTicks);
        if (layout.ticks < maxTicks) setTimeout(step, 16);
      };
      step();
    }
    return () => { cancelled = true; worker?.terminate(); remember(); };
    // fitView is stable for the model's lifetime (refs only).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  // ── Derived answers per mode ─────────────────────────────────────────────
  const depths = useMemo(() => {
    if (!model) return undefined;
    if (mode === 'impact' && selected >= 0) return model.impact([selected], depth);
    if (mode === 'changes' && diff) return model.impact(diff.ids, depth);
    if (mode === 'symbol' && symbolDetail) {
      // "Exact only": a caller reached only through an interface is not a user.
      const users = filters.exactOnly ? symbolDetail.users.filter(u => u.via !== 'interface' && u.via !== 'inferred') : symbolDetail.users;
      const first = [...new Set(users.map(u => u.id))];
      return model.impact([symbolDetail.file], Math.max(1, depth), first);
    }
    return undefined;
  }, [model, mode, selected, depth, diff, symbolDetail, filters.exactOnly]);

  const pathIds = useMemo(() => {
    if (!model || mode !== 'path') return undefined;
    const from = pathEnds.from >= 0 ? pathEnds.from : selected;
    if (from < 0 || pathEnds.to < 0) return undefined;
    return model.path(from, pathEnds.to) ?? model.path(pathEnds.to, from) ?? [];
  }, [model, mode, pathEnds, selected]);

  const inCycle = useMemo(() => new Set(payload?.cycles.flat() ?? []), [payload]);
  const cycle = mode === 'cycles' ? payload?.cycles[cycleIdx] : undefined;

  inputsRef.current = model ? {
    model, pos: posRef.current, mask, mode, colorBy, selected, expanded,
    ...(depths ? { depths } : {}), ...(pathIds ? { path: pathIds } : {}), ...(cycle ? { cycle } : {}), inCycle,
    accent: theme.accent, danger: theme.danger, warning: theme.warning, muted: theme.muted,
  } : null;
  dirty.current.scene = true;

  // ── The draw loop ────────────────────────────────────────────────────────
  useEffect(() => {
    let raf = 0;
    const frame = (): void => {
      raf = requestAnimationFrame(frame);
      const canvas = canvasRef.current;
      const inp = inputsRef.current;
      if (!canvas || !inp) return;
      if (dirty.current.scene) {
        sceneRef.current = buildScene({ ...inp, pos: posRef.current });
        dirty.current.scene = false;
        dirty.current.draw = true;
      }
      if (!dirty.current.draw) return;
      dirty.current.draw = false;
      const { w, h, dpr } = sizeRef.current;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const force = new Set<number>();
      const sel = sceneRef.current.fileIndex.get(inp.selected);
      if (sel !== undefined) force.add(sel);
      draw(ctx, w, h, camRef.current, sceneRef.current, themeRef.current, { hover: hoverRef.current, forceLabels: force, dpr });
      const mini = miniRef.current;
      const mctx = mini?.getContext('2d');
      if (mini && mctx) drawMinimap(mctx, 200, 128, sceneRef.current, camRef.current, w, h, themeRef.current, dpr);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  const themeRef = useRef(theme);
  themeRef.current = theme;
  useEffect(() => { dirty.current.draw = true; }, [theme]);

  // Canvas size follows its box.
  useEffect(() => {
    const canvas = canvasRef.current;
    const mini = miniRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => {
      const box = canvas.parentElement!.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      sizeRef.current = { w: box.width, h: box.height, dpr };
      canvas.width = Math.round(box.width * dpr);
      canvas.height = Math.round(box.height * dpr);
      canvas.style.width = `${box.width}px`;
      canvas.style.height = `${box.height}px`;
      if (mini) { mini.width = 200 * dpr; mini.height = 128 * dpr; }
      dirty.current.draw = true;
    });
    ro.observe(canvas.parentElement!);
    return () => ro.disconnect();
  }, [payload]);

  const fitView = useCallback((sceneIdx?: number[]) => {
    const inp = inputsRef.current;
    if (!inp) return;
    const scene = buildScene({ ...inp, pos: posRef.current });
    sceneRef.current = scene;
    const answer = sceneIdx ?? scene.nodes.map((n, i) => (n.emph === 2 ? i : -1)).filter(i => i >= 0);
    camRef.current = fit(scene, sizeRef.current.w, sizeRef.current.h, answer.length && answer.length < scene.nodes.length ? answer : undefined);
    dirty.current.draw = true;
  }, []);

  // A new answer (mode, impact, path, cycle, symbol, filters) is framed after it renders -
  // unless the person has since moved the camera themselves.
  const userMoved = useRef(false);
  useEffect(() => {
    if (!model) return;
    userMoved.current = false;
    const t = setTimeout(() => fitView(), 40);
    return () => clearTimeout(t);
  }, [model, mode, depths, pathIds, cycleIdx, mask, fitView]);

  const zoomBy = (f: number): void => { camRef.current = { ...camRef.current, k: Math.max(0.02, Math.min(12, camRef.current.k * f)) }; dirty.current.draw = true; };

  // ── Selection and modes ──────────────────────────────────────────────────
  const setMode = useCallback((m: Mode) => {
    setModeState(m);
    if (m === 'changes') void api.codeGraphDiff(projectPath).then(setDiff).catch(() => setDiff({ changed: [], ids: [] }));
  }, [projectPath]);

  useEffect(() => {
    setDetail(null);
    if (selected < 0) return;
    let live = true;
    void api.codeGraphFile(projectPath, selected).then(d => { if (live) setDetail(d); }).catch(() => {});
    return () => { live = false; };
  }, [projectPath, selected, payload?.version]);

  useEffect(() => {
    setSymbolDetail(null);
    if (!symbol) return;
    let live = true;
    void api.codeGraphSymbol(projectPath, symbol.file, symbol.name).then(d => { if (live) setSymbolDetail(d); }).catch(() => {});
    return () => { live = false; };
  }, [projectPath, symbol]);

  const select = useCallback((id: number, opts: { add?: boolean; center?: boolean } = {}) => {
    if (opts.add) {
      setMulti(m => { const next = new Set(m); if (next.has(id)) next.delete(id); else next.add(id); return next; });
      return;
    }
    setSelected(id);
    setMulti(new Set());
    if (id >= 0 && model) {
      // A selection inside a collapsed module opens that module in the architecture view.
      const c = model.file(id).community;
      setExpanded(e => (e.has(c) ? e : new Set([...e, c])));
      if (opts.center) {
        const x = posRef.current[id * 2]!;
        const y = posRef.current[id * 2 + 1]!;
        camRef.current = { x, y, k: Math.max(camRef.current.k, 1.4) };
        dirty.current.draw = true;
      }
    }
  }, [model]);

  // Select the requested file once the graph is in.
  const initialDone = useRef(false);
  useEffect(() => {
    if (!model || initialDone.current || !initialFile) return;
    initialDone.current = true;
    const q = initialFile.replace(/\\/g, '/').toLowerCase();
    const id = model.payload.files.findIndex(f => f.path.toLowerCase() === q || q.endsWith(`/${f.path.toLowerCase()}`));
    if (id >= 0) { select(id, { center: true }); if (!initialMode) setModeState('files'); }
  }, [model, initialFile, initialMode, select]);

  // ── Pointer and wheel ────────────────────────────────────────────────────
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean; node: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const node = hitTest(sceneRef.current, camRef.current, sizeRef.current.w, sizeRef.current.h, sx, sy);
    drag.current = { x: e.clientX, y: e.clientY, cx: camRef.current.x, cy: camRef.current.y, moved: false, node };
    e.currentTarget.setPointerCapture(e.pointerId);
    rootRef.current?.focus({ preventScroll: true });
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const d = drag.current;
    if (d) {
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
      if (d.moved) {
        userMoved.current = true;
        camRef.current = { ...camRef.current, x: d.cx - dx / camRef.current.k, y: d.cy - dy / camRef.current.k };
        dirty.current.draw = true;
        return;
      }
    }
    const idx = hitTest(sceneRef.current, camRef.current, sizeRef.current.w, sizeRef.current.h, sx, sy);
    if (idx !== hoverRef.current) {
      hoverRef.current = idx;
      dirty.current.draw = true;
    }
    setHover(idx >= 0 ? { idx, x: sx, y: sy } : null);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved) return;
    const node = sceneRef.current.nodes[d.node];
    if (!node) { if (!e.shiftKey) { setSelected(-1); setGroup(null); } return; }
    if (node.kind === 'group') {
      setGroup(node.ref);
      setExpanded(x => { const next = new Set(x); if (next.has(node.ref)) next.delete(node.ref); else next.add(node.ref); return next; });
      return;
    }
    if (mode === 'path') {
      setPathEnds(p => (p.from < 0 ? { from: node.ref, to: -1 } : p.to < 0 ? { ...p, to: node.ref } : { from: node.ref, to: -1 }));
    }
    select(node.ref, { add: e.shiftKey });
  };
  const onDoubleClick = (): void => {
    const node = sceneRef.current.nodes[hoverRef.current];
    if (node?.kind === 'file' && model) openFile(model.file(node.ref).path);
  };
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const { w, h } = sizeRef.current;
      const cam = camRef.current;
      const [wx, wy] = toWorld(cam, w, h, sx, sy);
      const k = Math.max(0.02, Math.min(12, cam.k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016))));
      // Keep the point under the cursor where it is.
      userMoved.current = true;
      camRef.current = { k, x: wx - (sx - w / 2) / k, y: wy - (sy - h / 2) / k };
      dirty.current.draw = true;
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [payload]);

  const onMiniClick = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mini = fit(sceneRef.current, 200, 128, undefined, 8);
    const [x, y] = toWorld(mini, 200, 128, e.clientX - rect.left, e.clientY - rect.top);
    camRef.current = { ...camRef.current, x, y };
    dirty.current.draw = true;
  };

  // ── Search ───────────────────────────────────────────────────────────────
  const fileHits = useMemo(() => (model && query.trim() ? model.search(query, 8) : []), [model, query]);
  useEffect(() => {
    const q = query.trim();
    // A path is a file search; `Class.method` is a symbol (methods are `Type.method` symbols).
    const method = /^[A-Za-z_$][\w$]*\.[A-Za-z_$#][\w$]*$/.test(q);
    if (q.length < 2 || (/[/\\.]/.test(q) && !method)) { setSymbolHits([]); return; }
    const t = setTimeout(() => { void api.codeGraphSymbols(projectPath, q).then(r => setSymbolHits(r.symbols.slice(0, 6))).catch(() => {}); }, 160);
    return () => clearTimeout(t);
  }, [projectPath, query]);
  type Hit = { kind: 'file'; id: number } | { kind: 'symbol'; file: number; name: string; kindName: string };
  const fileRows: Hit[] = fileHits.map(id => ({ kind: 'file' as const, id }));
  const symbolRows: Hit[] = symbolHits.map(s => ({ kind: 'symbol' as const, file: s.file, name: s.name, kindName: s.kind }));
  // A query that is exactly a symbol's name is a question about the symbol, not a file named like it.
  const hits: Hit[] = symbolHits.some(s => s.name === query.trim()) ? [...symbolRows, ...fileRows] : [...fileRows, ...symbolRows];
  const choose = (h: (typeof hits)[number]): void => {
    setSearchOpen(false);
    setQuery('');
    if (h.kind === 'file') {
      // In the path view a found file is the next end of the path, as a click would be.
      if (mode === 'path') setPathEnds(p => (p.from < 0 ? { from: h.id, to: -1 } : p.to < 0 ? { ...p, to: h.id } : { from: h.id, to: -1 }));
      select(h.id, { center: mode !== 'path' });
      if (mode === 'architecture') setModeState('files');
    }
    else { select(h.file, { center: true }); setSymbol({ file: h.file, name: h.name }); setModeState('symbol'); }
  };

  // ── Keyboard ─────────────────────────────────────────────────────────────
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return;
    const dirs: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (dirs[e.key] && model) {
      e.preventDefault();
      if (selected < 0) { const first = model.payload.files.findIndex((_, i) => mask[i]); if (first >= 0) select(first, { center: true }); return; }
      const [dx, dy] = dirs[e.key]!;
      const next = model.neighbourInDirection(selected, dx, dy, posRef.current, mask);
      if (next !== undefined) select(next, { center: true });
      return;
    }
    if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); return; }
    if (e.key === 'Escape') { setSelected(-1); setMulti(new Set()); setSymbol(null); setGroup(null); return; }
    if (e.key === 'Enter' && selected >= 0 && model) { openFile(model.file(selected).path); return; }
    if (e.key === '+' || e.key === '=') { zoomBy(1.25); return; }
    if (e.key === '-' || e.key === '_') { zoomBy(0.8); return; }
    if (e.key === '0') { fitView(); return; }
    if (e.key.toLowerCase() === 'f' && selected >= 0) {
      const idx = sceneRef.current.fileIndex.get(selected);
      if (idx !== undefined) fitView([idx]);
      return;
    }
    if (e.key.toLowerCase() === 'a') { void askAbout(); return; }
    const n = Number(e.key);
    if (n >= 1 && n <= MODES.length) setMode(MODES[n - 1]!.id);
  };

  // ── Actions ──────────────────────────────────────────────────────────────
  const selectionIds = useMemo(() => [...new Set([...(selected >= 0 ? [selected] : []), ...multi])], [selected, multi]);

  const askAbout = useCallback(async () => {
    if (!model || !host?.ask) return;
    setAskBusy(true);
    try {
      let ids = selectionIds;
      let what = ids.length === 1 ? model.file(ids[0]!).path : `${ids.length} files`;
      let extra = '';
      if (mode === 'symbol' && symbolDetail) {
        what = `\`${symbolDetail.name}\` (${model.file(symbolDetail.file).path})`;
        extra = `\`${symbolDetail.name}\` is used in ${symbolDetail.users.length} file(s): ${symbolDetail.users.slice(0, 40).map(u => `${model.file(u.id).path}${u.lines[0] ? `:${u.lines[0]}` : ''}${u.local !== symbolDetail.name ? ` (as ${u.local})` : ''}`).join(', ')}\n\n`;
        ids = [symbolDetail.file];
      } else if (mode === 'path' && pathIds?.length) {
        what = `the path ${model.file(pathIds[0]!).path} → ${model.file(pathIds[pathIds.length - 1]!).path}`;
        extra = `Dependency path: ${pathIds.map(i => model.file(i).path).join(' → ')}\n\n`;
        ids = pathIds.slice(0, 12);
      } else if ((mode === 'impact' || mode === 'changes') && depths) {
        const byDepth = new Map<number, number>();
        for (const d of depths.values()) byDepth.set(d, (byDepth.get(d) ?? 0) + 1);
        what = mode === 'changes' ? 'my uncommitted change' : `the impact of changing ${what}`;
        extra = `Affected files by depth: ${[...byDepth.entries()].filter(([d]) => d > 0).map(([d, c]) => `depth ${d}: ${c}`).join(', ')}. Depth 1: ${[...depths.entries()].filter(([, d]) => d === 1).slice(0, 30).map(([i]) => model.file(i).path).join(', ')}\n\n`;
        if (mode === 'changes' && diff) ids = diff.ids.slice(0, 12);
      } else if (mode === 'cycles' && cycle) {
        what = `the import cycle ${cycle.slice(0, 4).map(i => basename(model.file(i).path)).join(' → ')}${cycle.length > 4 ? ' …' : ''}`;
        ids = cycle.slice(0, 12);
      } else if (group !== null && ids.length === 0) {
        const c = model.payload.communities.find(x => x.id === group);
        if (c) { what = `the ${c.label} module (${c.files.length} files)`; ids = [...c.files].sort((a, b) => model.file(b).fanIn - model.file(a).fanIn).slice(0, 8); }
      }
      if (!ids.length) { flash('Select a file, symbol or path first.'); return; }
      const ctx = await api.codeGraphContext(projectPath, ids);
      host.ask(askPrompt(`${extra}${ctx.text}`, what));
    } catch (err) {
      flash(`Could not prepare the context: ${(err as Error).message}`);
    } finally {
      setAskBusy(false);
    }
  }, [model, host, selectionIds, mode, symbolDetail, pathIds, depths, diff, cycle, group, projectPath, flash]);

  const exportPng = (): void => {
    setExportOpen(false);
    canvasRef.current?.toBlob(b => { if (b) saveBlob(`code-map-${mode}.png`, b); });
  };
  const exportSvg = (): void => {
    setExportOpen(false);
    const s = sceneRef.current;
    const svg = toSvg(
      s.nodes.map(n => ({ x: n.x, y: n.y, r: n.r, color: n.color, dim: n.emph === 0, ...(n.kind === 'group' || n.emph === 2 ? { label: n.label ?? '' } : {}) })),
      s.edges.filter(e => e.emph > 0 || s.edges.length < 4000).map(e => ({ a: e.a, b: e.b, color: e.color ?? theme.muted, width: e.width, dim: e.emph === 0, ...(e.dashed ? { dashed: true } : {}) })),
      { bg: theme.bg, fg: theme.fg },
      `${projectName ?? basename(projectPath)} — ${MODES.find(m => m.id === mode)?.label}`,
    );
    saveBlob(`code-map-${mode}.svg`, new Blob([svg], { type: 'image/svg+xml' }));
  };
  const copyMermaid = async (): Promise<void> => {
    setExportOpen(false);
    try {
      const { mermaid } = await api.codeGraphMermaid(projectPath);
      await navigator.clipboard.writeText(`\`\`\`mermaid\n${mermaid}\n\`\`\``);
      flash('Architecture diagram copied as Mermaid');
    } catch (err) { flash(`Copy failed: ${(err as Error).message}`); }
  };

  // ── Render ───────────────────────────────────────────────────────────────
  const files = payload?.files.length ?? 0;
  const deps = payload ? payload.edges.filter(e => !e[4]).length : 0;
  const hoverNode = hover ? sceneRef.current.nodes[hover.idx] : undefined;
  const hoverFile = hoverNode?.kind === 'file' && model ? model.file(hoverNode.ref) : undefined;
  const hoverGroup = hoverNode?.kind === 'group' ? payload?.communities.find(c => c.id === hoverNode.ref) : undefined;

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col bg-aico-bg text-aico-primary outline-none" tabIndex={0} onKeyDown={onKeyDown} aria-label="Code map" data-testid="code-map">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-aico-border px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-aico-accent/10 text-aico-accent"><CgIcon name="map" size={16} /></span>
          <div className="min-w-0">
            <div className="truncate text-[14px] font-semibold leading-tight">Code map{projectName ? <span className="font-normal text-aico-muted"> · {projectName}</span> : null}</div>
            <div className="truncate text-[11.5px] leading-tight text-aico-muted">
              {payload ? <>{files.toLocaleString()} files · {deps.toLocaleString()} dependencies · {payload.communities.length} modules{payload.git.available ? ` · ${payload.git.commits} commit${payload.git.commits === 1 ? '' : 's'} of history` : ''}{payload.stats.truncated ? ' · truncated' : ''}{payload.stats.methods?.ts === 'pending' ? ' · type-checking methods…' : ''}{layoutState === 'running' ? ' · arranging…' : ''}</> : error ? 'Could not load' : 'Indexing the project…'}
            </div>
          </div>
        </div>
        <div className="relative ml-auto w-[min(360px,100%)]">
          <CgIcon name="search" size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-aico-muted" />
          <input
            ref={searchRef}
            className="h-8 w-full rounded-lg border border-aico-border bg-aico-surface pl-8 pr-14 text-[13px] text-aico-primary outline-none placeholder:text-aico-muted focus:border-aico-accent"
            placeholder="Find a file or symbol"
            value={query}
            onChange={e => { setQuery(e.target.value); setSearchOpen(true); setSearchCursor(0); }}
            onFocus={() => setSearchOpen(true)}
            onBlur={() => setTimeout(() => setSearchOpen(false), 150)}
            onKeyDown={e => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSearchCursor(c => Math.min(hits.length - 1, c + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setSearchCursor(c => Math.max(0, c - 1)); }
              else if (e.key === 'Enter' && hits[searchCursor]) { e.preventDefault(); choose(hits[searchCursor]!); (e.target as HTMLInputElement).blur(); }
              else if (e.key === 'Escape') { setQuery(''); (e.target as HTMLInputElement).blur(); rootRef.current?.focus(); }
            }}
            aria-label="Find a file or symbol"
          />
          <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-aico-border px-1.5 text-[10.5px] text-aico-muted">/</kbd>
          {searchOpen && query.trim() && (
            <div className="absolute left-0 right-0 top-9 z-30 max-h-80 overflow-y-auto rounded-xl border border-aico-border bg-aico-elevated p-1 shadow-xl" role="listbox">
              {hits.length === 0 && <div className="px-3 py-2 text-[12.5px] text-aico-muted">Nothing matches.</div>}
              {hits.map((h, i) => (
                <button key={h.kind === 'file' ? `f${h.id}` : `s${h.file}:${h.name}`} role="option" aria-selected={i === searchCursor}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] ${i === searchCursor ? 'bg-aico-hover' : 'hover:bg-aico-hover'}`}
                  onMouseDown={e => { e.preventDefault(); choose(h); }}>
                  <CgIcon name={h.kind === 'file' ? 'file' : 'symbol'} size={13} className="shrink-0 text-aico-muted" />
                  {h.kind === 'file' && model
                    ? <span className="min-w-0 truncate"><span className="font-medium">{basename(model.file(h.id).path)}</span> <span className="text-aico-muted">{model.file(h.id).path}</span></span>
                    : h.kind === 'symbol' && model ? <span className="min-w-0 truncate"><span className="font-medium font-mono">{h.name}</span> <span className="text-aico-muted">{h.kindName} · {model.file(h.file).path}</span></span> : null}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1">
          <IconButton label="Refresh" icon="refresh" spin={refreshing} onClick={() => void load({ force: true })} />
          <div className="relative">
            <IconButton label="Export" icon="download" onClick={() => setExportOpen(o => !o)} />
            {exportOpen && (
              <Menu onClose={() => setExportOpen(false)}>
                <MenuButton onClick={exportPng}>Picture (PNG)</MenuButton>
                <MenuButton onClick={exportSvg}>Vector (SVG)</MenuButton>
                <MenuButton onClick={() => void copyMermaid()}>Copy architecture as Mermaid</MenuButton>
              </Menu>
            )}
          </div>
          <IconButton label={panelOpen ? 'Hide details' : 'Show details'} icon="panel" active={panelOpen} onClick={() => setPanelOpen(o => !o)} />
        </div>
      </div>

      {/* Mode bar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-aico-border px-4 py-2">
        <div className="flex flex-wrap gap-0.5 rounded-lg bg-aico-surface p-0.5" role="tablist" aria-label="View">
          {MODES.map((m, i) => (
            <button key={m.id} role="tab" aria-selected={mode === m.id} title={`${m.hint} (${i + 1})`}
              className={`rounded-md px-2.5 py-1 text-[12.5px] transition-colors ${mode === m.id ? 'bg-aico-bg font-medium text-aico-primary shadow-sm' : 'text-aico-muted hover:text-aico-primary'}`}
              onClick={() => setMode(m.id)}>{m.label}</button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {(mode === 'impact' || mode === 'changes' || mode === 'symbol') && (
            <label className="flex items-center gap-1.5 text-[12px] text-aico-muted">Depth
              <select className="h-7 rounded-md border border-aico-border bg-aico-surface px-1.5 text-[12px] text-aico-primary" value={depth} onChange={e => setDepth(Number(e.target.value))} aria-label="Depth">
                {[1, 2, 3, 4, 5].map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
          )}
          {(mode === 'files' || mode === 'architecture') && (
            <label className="flex items-center gap-1.5 text-[12px] text-aico-muted">Colour
              <select className="h-7 rounded-md border border-aico-border bg-aico-surface px-1.5 text-[12px] text-aico-primary" value={colorBy} onChange={e => setColorBy(e.target.value as ColorBy)} aria-label="Colour by">
                <option value="module">Module</option><option value="language">Language</option><option value="hotspot">Hotspot</option>
              </select>
            </label>
          )}
          <div className="relative">
            <button className={`flex h-7 items-center gap-1.5 rounded-md border px-2 text-[12px] ${filtersActive(filters) ? 'border-aico-accent text-aico-accent' : 'border-aico-border text-aico-secondary hover:text-aico-primary'}`} onClick={() => setFiltersOpen(o => !o)} aria-expanded={filtersOpen}>
              <CgIcon name="filter" size={13} />Filters{filtersActive(filters) ? ' •' : ''}
            </button>
            {filtersOpen && model && (
              <Menu onClose={() => setFiltersOpen(false)} wide>
                <div className="px-2 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wide text-aico-muted">Languages</div>
                <div className="flex flex-wrap gap-1 px-2 pb-2">
                  {model.langs.map(l => {
                    const on = filters.langs.length === 0 || filters.langs.includes(l);
                    return (
                      <button key={l} className={`rounded-full border px-2 py-0.5 text-[11.5px] ${on ? 'border-aico-accent/50 bg-aico-accent/10 text-aico-primary' : 'border-aico-border text-aico-muted'}`}
                        onClick={() => setFilters(f => {
                          const current = f.langs.length ? f.langs : model.langs;
                          const next = current.includes(l) ? current.filter(x => x !== l) : [...current, l];
                          return { ...f, langs: next.length === model.langs.length ? [] : next };
                        })}>{l}</button>
                    );
                  })}
                </div>
                <label className="flex items-center gap-2 px-2 py-1 text-[12.5px]"><input type="checkbox" checked={filters.hideTests} onChange={e => setFilters(f => ({ ...f, hideTests: e.target.checked }))} />Hide tests</label>
                <label className="flex items-center gap-2 px-2 py-1 text-[12.5px]"><input type="checkbox" checked={filters.hideVendor} onChange={e => setFilters(f => ({ ...f, hideVendor: e.target.checked }))} />Hide vendored, generated and templates</label>
                <label className="flex items-center gap-2 px-2 py-1 text-[12.5px]" title="Hide links through interfaces (a call that may reach an implementation) and links by a unique name in scope"><input type="checkbox" checked={filters.exactOnly} onChange={e => setFilters(f => ({ ...f, exactOnly: e.target.checked }))} data-exact-only />Exact only (no links through interfaces)</label>
                <div className="px-2 pb-2 pt-1">
                  <input className="h-7 w-full rounded-md border border-aico-border bg-aico-surface px-2 text-[12px] text-aico-primary outline-none focus:border-aico-accent" placeholder="Only under folder, e.g. src/api" value={filters.folder} onChange={e => setFilters(f => ({ ...f, folder: e.target.value }))} />
                </div>
                <div className="flex justify-end border-t border-aico-border px-2 pt-1.5"><button className="text-[12px] text-aico-accent" onClick={() => setFilters(DEFAULT_FILTERS)}>Reset</button></div>
              </Menu>
            )}
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1 overflow-hidden">
          {!payload && !error && <Loading />}
          {error && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-8 text-center">
              <CgIcon name="alert" size={22} className="text-aico-danger" />
              <div className="max-w-md text-[13px] text-aico-secondary">{error}</div>
              <button className="rounded-lg border border-aico-border px-3 py-1.5 text-[12.5px] hover:bg-aico-hover" onClick={() => void load()}>Try again</button>
            </div>
          )}
          {payload && payload.files.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center p-8 text-center text-[13px] text-aico-muted">No source files here (TypeScript, JavaScript, Python, Go, Java, Kotlin, C#, PHP, Ruby or Rust).</div>
          )}
          <canvas ref={canvasRef} className={`absolute inset-0 touch-none ${hover ? 'cursor-pointer' : 'cursor-grab'} ${payload ? '' : 'invisible'}`}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={() => { hoverRef.current = -1; setHover(null); dirty.current.draw = true; }}
            onDoubleClick={onDoubleClick} aria-label="Dependency graph canvas" role="img" />
          {payload && (
            <>
              <ModeHint mode={mode} selected={selected} pathEnds={pathEnds} symbol={symbol} diff={diff} />
              <Legend mode={mode} colorBy={colorBy} model={model} theme={theme} />
              <div className="absolute bottom-3 right-3 flex flex-col items-end gap-2">
                <div className="flex gap-1 rounded-lg border border-aico-border bg-aico-elevated/95 p-0.5 shadow-sm">
                  <IconButton label="Zoom in (+)" icon="plus" onClick={() => zoomBy(1.25)} />
                  <IconButton label="Zoom out (−)" icon="minus" onClick={() => zoomBy(0.8)} />
                  <IconButton label="Fit (0)" icon="fit" onClick={() => fitView()} />
                </div>
                <canvas ref={miniRef} width={200} height={128} onClick={onMiniClick} className="h-[128px] w-[200px] cursor-crosshair rounded-lg border border-aico-border shadow-sm" aria-label="Minimap" />
              </div>
            </>
          )}
          {hover && (hoverFile || hoverGroup) && (
            <div className="pointer-events-none absolute z-20 max-w-[360px] rounded-lg border border-aico-border bg-aico-elevated px-2.5 py-1.5 text-[12px] shadow-lg" style={{ left: Math.min(hover.x + 14, sizeRef.current.w - 300), top: hover.y + 14 }}>
              {hoverFile ? (
                <>
                  <div className="truncate font-medium">{hoverFile.path}</div>
                  <div className="text-aico-muted">{hoverFile.lang} · {hoverFile.loc} lines · imported by {hoverFile.fanIn} · imports {hoverFile.fanOut}{hoverFile.churn ? ` · ${hoverFile.churn} commits` : ''}{hoverFile.entry ? ` · ${hoverFile.entry}` : ''}{hoverFile.test ? ' · test' : ''}</div>
                </>
              ) : hoverGroup ? (
                <>
                  <div className="font-medium">{hoverGroup.label}</div>
                  <div className="text-aico-muted">{hoverGroup.files.length} files · click to {expanded.has(hoverGroup.id) ? 'close' : 'open'}</div>
                </>
              ) : null}
            </div>
          )}
          {notice && <div className="absolute left-1/2 top-3 z-30 -translate-x-1/2 rounded-full border border-aico-border bg-aico-elevated px-3 py-1 text-[12.5px] shadow-md" role="status">{notice}</div>}
        </div>
        {panelOpen && payload && model && (
          <CodeGraphPanel
            model={model} payload={payload} mode={mode} selected={selected} multi={multi} detail={detail} depths={depths} depth={depth}
            symbol={symbolDetail} pathIds={pathIds} pathEnds={pathEnds} cycleIdx={cycleIdx} diff={diff} group={group}
            canAsk={Boolean(host?.ask)} canOpen={Boolean(host?.openFile)} askBusy={askBusy} exactOnly={filters.exactOnly}
            onSelect={(id) => select(id, { center: true })}
            onOpen={(path, line) => openFile(path, line)}
            {...(host?.openExternal ? { onOpenExternal: (path: string, line?: number) => openExternal(path, line) } : {})}
            onAsk={() => void askAbout()}
            onMode={setMode}
            onSymbol={(file, name) => { setSymbol({ file, name }); setModeState('symbol'); }}
            onPathEnd={(end, id) => { setPathEnds(p => ({ ...p, [end]: id })); setModeState('path'); }}
            onCycle={(i) => setCycleIdx(i)}
            onGroup={(id) => { setGroup(id); setExpanded(x => new Set([...x, id])); }}
          />
        )}
      </div>
    </div>
  );
}

function filtersActive(f: Filters): boolean {
  return f.langs.length > 0 || f.hideTests || !f.hideVendor || Boolean(f.folder.trim()) || f.exactOnly;
}

function IconButton({ label, icon, onClick, active, spin }: { label: string; icon: Parameters<typeof CgIcon>[0]['name']; onClick: () => void; active?: boolean; spin?: boolean }): React.ReactElement {
  return (
    <button className={`flex h-7 w-7 items-center justify-center rounded-md ${active ? 'bg-aico-hover text-aico-primary' : 'text-aico-secondary hover:bg-aico-hover hover:text-aico-primary'}`} onClick={onClick} title={label} aria-label={label}>
      <CgIcon name={icon} size={15} className={spin ? 'animate-spin' : undefined} />
    </button>
  );
}

function Menu({ children, onClose, wide }: { children: React.ReactNode; onClose: () => void; wide?: boolean }): React.ReactElement {
  useEffect(() => {
    const onDoc = (e: MouseEvent): void => { if (!(e.target as HTMLElement).closest('[data-cg-menu]')) onClose(); };
    const t = setTimeout(() => document.addEventListener('mousedown', onDoc), 0);
    return () => { clearTimeout(t); document.removeEventListener('mousedown', onDoc); };
  }, [onClose]);
  return <div data-cg-menu className={`absolute right-0 top-8 z-40 rounded-xl border border-aico-border bg-aico-elevated p-1 shadow-xl ${wide ? 'w-72' : 'w-56'}`}>{children}</div>;
}

function MenuButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }): React.ReactElement {
  return <button className="block w-full rounded-lg px-2.5 py-1.5 text-left text-[12.5px] hover:bg-aico-hover" onClick={onClick}>{children}</button>;
}

function Loading(): React.ReactElement {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-[13px] text-aico-muted" role="status">
      <svg width="64" height="40" viewBox="0 0 64 40" className="opacity-70" aria-hidden="true">
        {[[8, 20], [24, 8], [24, 32], [40, 14], [56, 26], [40, 30]].map(([x, y], i) => <circle key={i} cx={x} cy={y} r="3.5" fill="currentColor"><animate attributeName="opacity" values="0.25;1;0.25" dur="1.4s" begin={`${i * 0.18}s`} repeatCount="indefinite" /></circle>)}
        <path d="M8 20 24 8M8 20l16 12M24 8l16 6M24 32l16-2M40 14l16 12M40 30l16-4" stroke="currentColor" strokeOpacity="0.3" fill="none" />
      </svg>
      Reading imports and history…
    </div>
  );
}

function ModeHint({ mode, selected, pathEnds, symbol, diff }: { mode: Mode; selected: number; pathEnds: { from: number; to: number }; symbol: { file: number; name: string } | null; diff: { ids: number[] } | null }): React.ReactElement | null {
  let text: string | null = null;
  if (mode === 'impact' && selected < 0) text = 'Select a file to see what depends on it.';
  else if (mode === 'path' && (pathEnds.from < 0 && selected < 0)) text = 'Click a start file, then a destination.';
  else if (mode === 'path' && pathEnds.to < 0) text = 'Now click the destination file.';
  else if (mode === 'symbol' && !symbol) text = 'Find a symbol with search (/), or pick one from a file’s exports.';
  else if (mode === 'changes' && diff && diff.ids.length === 0) text = 'No uncommitted changes to source files.';
  else if (mode === 'architecture') text = 'Click a module to open it · double-click a file to open it in the editor';
  if (!text) return null;
  return <div className="pointer-events-none absolute left-3 top-3 rounded-lg border border-aico-border bg-aico-elevated/95 px-2.5 py-1 text-[12px] text-aico-secondary shadow-sm">{text}</div>;
}

function Legend({ mode, colorBy, model, theme }: { mode: Mode; colorBy: ColorBy; model: GraphModel | null; theme: Theme }): React.ReactElement | null {
  if (!model) return null;
  const items: Array<[string, string, boolean?]> = [];
  if (mode === 'impact' || mode === 'changes' || mode === 'symbol') items.push(['#2563eb', mode === 'changes' ? 'changed' : 'selected'], ['#dc2626', 'depth 1 — uses it directly'], ['#f97316', 'depth 2'], ['#eab308', 'depth 3+']);
  else if (mode === 'hotspots' || colorBy === 'hotspot') items.push(['rgb(148,163,184)', 'quiet'], ['rgb(250,204,21)', 'warm'], ['rgb(220,38,38)', 'hot (churn × importers × size)']);
  else if (mode === 'cochange') items.push([theme.warning, 'change together, no import', true], [theme.muted, 'change together, also imported', true]);
  else if (mode === 'cycles') items.push([theme.danger, 'in an import cycle']);
  else if (mode === 'path') items.push([theme.accent, 'on the path']);
  else if (colorBy === 'language') for (const l of model.langs.slice(0, 8)) items.push([({ ts: '#3178c6', js: '#e8b400', py: '#3e7cb1', go: '#00a7d0', java: '#e76f00', kotlin: '#a97bff', cs: '#68217a', php: '#777bb4', rb: '#cc342d', rs: '#c46a2a' } as Record<string, string>)[l] ?? '#94a3b8', l]);
  else items.push(['', 'colour = module · size = lines and importers · dashed = inferred or through an interface']);
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 max-w-[60%] rounded-lg border border-aico-border bg-aico-elevated/95 px-2.5 py-1.5 text-[11.5px] text-aico-secondary shadow-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {items.map(([c, label, dashed]) => (
          <span key={label} className="flex items-center gap-1.5">
            {c ? (dashed ? <span className="inline-block w-4 border-t-2 border-dashed" style={{ borderColor: c }} /> : <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: c }} />) : null}
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
