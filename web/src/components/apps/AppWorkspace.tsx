/**
 * The app beside the conversation.
 *
 * A bound conversation used to show one line — "Reading Log · page app" — and a
 * link that opened the app somewhere else. Everything the person needed to
 * judge the work was a tab switch away, which is where Lovable and Replit
 * differ most from a chat window: the thing being built is on screen while
 * it is being built.
 *
 * So this panel sits to the right of the chat when a session is about an app:
 * a live **Preview** at phone, tablet or desktop width; the **Backlog** the
 * agent keeps, with progress; **Decisions**; the **Files** (read-only, two
 * levels); and **Logs** from the app's process and its last deploy. The
 * header carries Start / Stop / Deploy / Open. Suggested first messages sit
 * under the header so a fresh app is one click from its next iteration.
 *
 * The preview is an iframe of a *different origin* — the apps host or the
 * app's own process — and the host names the portal in `frame-ancestors`.
 * A framed page cannot read its parent, so this is the safe direction.
 *
 * @module components/apps/AppWorkspace
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type MiniAppProcess, type MiniAppSummary } from '../../api';
import { useStore } from '../../store';
import { Icon } from '../Icon';
import { KindBadge, ownsProcess } from '../AppsPane';
import { nextStory, parseBacklog, type Backlog } from './backlog';

type Tab = 'preview' | 'backlog' | 'decisions' | 'files' | 'logs';
type Device = 'desktop' | 'tablet' | 'phone';

const DEVICE_WIDTH: Record<Device, number | undefined> = { desktop: undefined, tablet: 820, phone: 390 };
const MIN_PANEL = 360;
const MAX_PANEL = 1100;
const PANEL_KEY = 'aico.appPanel';

function readPanel(): { width: number; open: boolean; tab: Tab } {
  try {
    const raw = JSON.parse(localStorage.getItem(PANEL_KEY) ?? '{}') as Partial<{ width: number; open: boolean; tab: Tab }>;
    return {
      width: Math.min(MAX_PANEL, Math.max(MIN_PANEL, Number(raw.width) || 560)),
      open: raw.open !== false,
      tab: (['preview', 'backlog', 'decisions', 'files', 'logs'] as Tab[]).includes(raw.tab as Tab) ? (raw.tab as Tab) : 'preview',
    };
  } catch {
    return { width: 560, open: true, tab: 'preview' };
  }
}
function writePanel(p: { width: number; open: boolean; tab: Tab }): void {
  try { localStorage.setItem(PANEL_KEY, JSON.stringify(p)); } catch { /* no storage, no memory */ }
}

export function AppWorkspace(): React.ReactElement | null {
  const slug = useStore(s => s.miniApp);
  const apps = useStore(s => s.apps);
  const connectApps = useStore(s => s.connectApps);
  const refreshApps = useStore(s => s.refreshApps);
  const busy = useStore(s => s.busy);
  const submit = useStore(s => s.submit);

  const [{ width, open, tab }, setPanel] = useState(readPanel);
  const set = (patch: Partial<{ width: number; open: boolean; tab: Tab }>) =>
    setPanel(p => { const next = { ...p, ...patch }; writePanel(next); return next; });

  useEffect(() => connectApps(), [connectApps]);
  // The turn may have built the page: refresh the list (and the preview) when it ends.
  useEffect(() => { if (!busy) void refreshApps(); }, [busy, refreshApps]);

  const app: MiniAppSummary | undefined = apps?.apps.find(a => a.slug === slug);
  const process: MiniAppProcess | undefined = apps?.processes?.find(p => p.slug === slug);
  const deploy: MiniAppProcess | undefined = apps?.processes?.find(p => p.slug === `${slug}#deploy`);
  const host = apps?.host ?? null;

  if (!slug || !app) return null;

  const isProcess = ownsProcess(app.kind);
  const isCli = app.kind === 'cli';
  const url = isCli ? null : isProcess ? (process?.state === 'running' ? process.url ?? null : null) : host ? `${host}/${slug}/` : null;

  if (!open) {
    return (
      <button
        onClick={() => set({ open: true })}
        className="hidden w-9 shrink-0 flex-col items-center gap-2 border-l border-aico-border-subtle py-3 text-aico-muted hover:text-aico-primary lg:flex"
        title="Show the app"
        data-app-panel-toggle
      >
        <Icon name="grid" size={16} />
        <span className="text-[10px] [writing-mode:vertical-rl]">App</span>
      </button>
    );
  }

  return (
    <aside
      className="relative hidden shrink-0 flex-col border-l border-aico-border-subtle bg-aico-surface lg:flex"
      style={{ width, maxWidth: '55vw' }}
      data-app-panel
    >
      <Resizer onResize={w => set({ width: Math.min(MAX_PANEL, Math.max(MIN_PANEL, w)) })} width={width} />

      <header className="flex flex-wrap items-center gap-2 border-b border-aico-border-subtle px-3 py-2">
        <span className="min-w-0 truncate text-[13px] font-medium text-aico-primary">{app.title}</span>
        <KindBadge kind={app.kind} />
        <StateDot app={app} process={process} hostUp={Boolean(host)} />
        <div className="flex-1" />
        {isProcess && (
          <button
            onClick={async () => { await api.runMiniApp(slug, process?.state === 'running' ? 'stop' : 'start').catch(() => undefined); void refreshApps(); }}
            disabled={process?.state === 'installing' || process?.state === 'starting'}
            className="rounded-lg px-2 py-1 text-[12px] text-aico-secondary hover:bg-aico-hover hover:text-aico-primary disabled:opacity-50"
            data-panel-run
          >
            {process?.state === 'running' ? 'Stop' : process?.state === 'installing' ? 'Installing…' : process?.state === 'starting' ? 'Starting…' : 'Start'}
          </button>
        )}
        {(app.deploy?.length ?? 0) > 0 && app.built && (
          <button
            onClick={() => void api.deployApp(slug, app.deploy![0]!.id).catch(() => undefined)}
            disabled={deploy?.state === 'working'}
            className="rounded-lg px-2 py-1 text-[12px] text-aico-secondary hover:bg-aico-hover hover:text-aico-primary disabled:opacity-50"
            title={app.deploy![0]!.label}
          >
            {deploy?.state === 'working' ? 'Deploying…' : 'Deploy'}
          </button>
        )}
        {url && (
          <a href={url} target="_blank" rel="noreferrer noopener" className="rounded-lg px-2 py-1 text-[12px] text-aico-accent hover:bg-aico-accent/10" title="Open in a new tab">
            Open ↗
          </a>
        )}
        <button onClick={() => set({ open: false })} className="rounded-lg p-1 text-aico-muted hover:text-aico-primary" title="Hide the app" aria-label="Hide the app panel">
          <Icon name="close" size={14} />
        </button>
      </header>

      <nav className="flex items-center gap-1 border-b border-aico-border-subtle px-2 py-1" role="tablist">
        {(['preview', 'backlog', 'decisions', 'files', 'logs'] as Tab[]).map(t => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => set({ tab: t })}
            className={`rounded-md px-2 py-1 text-[12px] capitalize ${tab === t ? 'bg-aico-hover text-aico-primary' : 'text-aico-muted hover:text-aico-primary'}`}
            data-panel-tab={t}
          >
            {t}
            {t === 'backlog' && app.backlog && app.backlog.total > 0 && (
              <span className="ml-1 text-[10px] tabular-nums text-aico-muted">{app.backlog.done}/{app.backlog.total}</span>
            )}
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === 'preview' && <PreviewTab app={app} url={url} process={process} hostUp={Boolean(host)} slug={slug} onStart={async () => { await api.runMiniApp(slug, 'start').catch(() => undefined); void refreshApps(); }} />}
        {tab === 'backlog' && <BacklogTab slug={slug} busy={busy} onAsk={text => void submit(text)} />}
        {tab === 'decisions' && <TextFileTab slug={slug} path=".aico/decisions.md" busy={busy} empty="No decisions recorded yet. The agent appends one line per settled design choice." />}
        {tab === 'files' && <FilesTab slug={slug} busy={busy} />}
        {tab === 'logs' && <LogsTab process={process} deploy={deploy} isProcess={isProcess} />}
      </div>
    </aside>
  );
}

function StateDot({ app, process, hostUp }: { app: MiniAppSummary; process?: MiniAppProcess; hostUp: boolean }): React.ReactElement {
  const isProcess = ownsProcess(app.kind);
  const label = app.kind === 'cli' ? 'command-line tool'
    : isProcess ? (process ? process.state : 'not running')
    : hostUp ? 'served' : 'host off';
  const tone = label === 'running' || label === 'served' ? 'bg-emerald-500'
    : label === 'failed' || label === 'host off' ? 'bg-aico-danger'
    : label === 'installing' || label === 'starting' ? 'bg-amber-400 animate-pulse'
    : 'bg-aico-border';
  return (
    <span className="flex items-center gap-1 text-[11px] text-aico-muted" title={label} data-panel-state={label}>
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${tone}`} />
      {label}
    </span>
  );
}

function Resizer({ onResize, width }: { onResize: (w: number) => void; width: number }): React.ReactElement {
  const start = useRef<{ x: number; w: number } | null>(null);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the app panel"
      onMouseDown={e => {
        start.current = { x: e.clientX, w: width };
        const move = (ev: MouseEvent) => { if (start.current) onResize(start.current.w + (start.current.x - ev.clientX)); };
        const up = () => { start.current = null; window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      }}
      className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-aico-accent/30"
    />
  );
}

// ── Preview ─────────────────────────────────────────────────────────────────

function PreviewTab({ app, url, process, hostUp, slug, onStart }: {
  app: MiniAppSummary; url: string | null; process?: MiniAppProcess; hostUp: boolean; slug: string; onStart: () => void;
}): React.ReactElement {
  const [device, setDevice] = useState<Device>('desktop');
  const [nonce, setNonce] = useState(0);
  const busy = useStore(s => s.busy);
  // Reload when a turn ends: the agent has probably just changed the page.
  useEffect(() => { if (!busy) setNonce(n => n + 1); }, [busy]);

  if (app.kind === 'cli') {
    return <Empty>A command-line tool has nothing to preview. Its tests are the check — see Logs after a RunChecks, or run it with the agent.</Empty>;
  }
  if (!url) {
    if (ownsProcess(app.kind)) {
      return (
        <Empty>
          {process?.state === 'failed'
            ? <>The app failed to start{process.error ? `: ${process.error}` : ''}. See Logs.</>
            : process?.state === 'installing' ? 'Installing dependencies — a first install takes a few minutes.'
            : process?.state === 'starting' ? 'Starting…'
            : <>Not running. <button onClick={onStart} className="rounded-lg bg-aico-accent px-2.5 py-1 text-[12px] font-medium text-white" data-preview-start>Start the app</button></>}
        </Empty>
      );
    }
    if (!hostUp) return <Empty>The Apps host is off, so nothing is served. Turn it on in Settings → Apps.</Empty>;
    if (!app.built) return <Empty>Not built yet — there is no page to show. Ask the agent to build the first screen.</Empty>;
    return <Empty>No URL for this app yet.</Empty>;
  }
  const w = DEVICE_WIDTH[device];
  const src = `${url}${url.includes('?') ? '&' : '?'}_aico=${nonce}`;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-aico-border-subtle px-2 py-1">
        {(['desktop', 'tablet', 'phone'] as Device[]).map(d => (
          <button key={d} onClick={() => setDevice(d)} className={`rounded px-2 py-0.5 text-[11px] capitalize ${device === d ? 'bg-aico-hover text-aico-primary' : 'text-aico-muted hover:text-aico-primary'}`} data-device={d}>{d}</button>
        ))}
        <span className="ml-2 min-w-0 flex-1 truncate font-mono text-[10px] text-aico-muted" title={url}>{url}</span>
        <button onClick={() => setNonce(n => n + 1)} className="rounded px-2 py-0.5 text-[11px] text-aico-muted hover:text-aico-primary" title="Reload the preview" data-preview-reload>Reload</button>
      </div>
      <div className="flex min-h-0 flex-1 justify-center overflow-auto bg-aico-bg p-2">
        <iframe
          key={src}
          src={src}
          title={`Preview of ${app.title}`}
          className="h-full rounded-lg border border-aico-border-subtle bg-white"
          style={{ width: w ?? '100%', maxWidth: '100%' }}
          sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-modals"
          data-preview-frame={slug}
        />
      </div>
    </div>
  );
}

// ── Backlog ─────────────────────────────────────────────────────────────────

function useAppFile(slug: string, path: string, busy: boolean): { text: string | null; error: string | null } {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.appFile(slug, path)
      .then(r => { if (live) { setText(r.content); setError(null); } })
      .catch(err => { if (live) { setText(null); setError(err instanceof Error ? err.message : String(err)); } });
    return () => { live = false; };
  }, [slug, path, busy]);
  return { text, error };
}

function BacklogTab({ slug, busy, onAsk }: { slug: string; busy: boolean; onAsk: (text: string) => void }): React.ReactElement {
  const { text, error } = useAppFile(slug, '.aico/backlog.md', busy);
  const backlog: Backlog | null = useMemo(() => (text ? parseBacklog(text) : null), [text]);
  if (error && /no file/.test(error)) {
    return (
      <Empty>
        No backlog yet.{' '}
        <button onClick={() => onAsk('Use the app-plan skill: ask me what you need to know, then write docs/PRD.md and the first iteration of .aico/backlog.md for this app.')} className="text-aico-accent hover:underline" disabled={busy}>
          Ask the agent to plan the first iteration
        </button>
      </Empty>
    );
  }
  if (!backlog) return <Empty>{error ?? 'Loading…'}</Empty>;
  const next = nextStory(backlog);
  return (
    <div className="h-full overflow-y-auto p-3" data-backlog>
      {backlog.total > 0 && (
        <div className="mb-3 flex items-center gap-2" title={`${backlog.done} of ${backlog.total} stories done`}>
          <div className="h-1.5 flex-1 overflow-hidden rounded bg-aico-hover"><div className="h-full bg-aico-accent" style={{ width: `${Math.round((backlog.done / backlog.total) * 100)}%` }} /></div>
          <span className="text-[11px] tabular-nums text-aico-muted">{backlog.done}/{backlog.total}</span>
        </div>
      )}
      {next && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-aico-border-subtle bg-aico-hover/40 px-3 py-2">
          <span className="min-w-0 flex-1 text-[12px] text-aico-primary"><span className="text-aico-muted">Next: </span>{next.story.text}</span>
          <button onClick={() => onAsk(`Build the next story from .aico/backlog.md: "${next.story.text}". Done when: ${next.story.doneWhen ?? 'as the story says'}. Run the checks, start the app if needed, verify it in the browser, then tick the story.`)} disabled={busy} className="rounded-lg bg-aico-accent px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-50" data-build-next>
            Build it
          </button>
        </div>
      )}
      {backlog.iterations.map(it => (
        <section key={it.title} className="mb-4">
          <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-aico-muted">{it.title}</h4>
          <ul className="space-y-1.5">
            {it.stories.map((s, i) => (
              <li key={i} className="flex items-start gap-2 text-[12px]">
                <span className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] ${s.done ? 'border-aico-accent bg-aico-accent text-white' : 'border-aico-border text-transparent'}`}>✓</span>
                <div className="min-w-0">
                  <div className={s.done ? 'text-aico-muted line-through' : 'text-aico-primary'}>{s.text}</div>
                  {s.doneWhen && <div className="text-[11px] text-aico-muted">Done when: {s.doneWhen}</div>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

// ── Decisions and other text files ─────────────────────────────────────────

function TextFileTab({ slug, path, busy, empty }: { slug: string; path: string; busy: boolean; empty: string }): React.ReactElement {
  const { text, error } = useAppFile(slug, path, busy);
  if (error && /no file/.test(error)) return <Empty>{empty}</Empty>;
  if (text === null) return <Empty>{error ?? 'Loading…'}</Empty>;
  const bullets = text.split('\n').filter(l => l.trim().startsWith('- '));
  if (path.endsWith('decisions.md') && bullets.length > 0) {
    return (
      <ul className="h-full space-y-2 overflow-y-auto p-3 text-[12px] text-aico-primary" data-decisions>
        {bullets.map((b, i) => <li key={i} className="border-l-2 border-aico-accent/40 pl-2">{b.replace(/^- /, '')}</li>)}
      </ul>
    );
  }
  return <pre className="h-full overflow-auto whitespace-pre-wrap p-3 font-mono text-[11px] leading-relaxed text-aico-secondary">{text || empty}</pre>;
}

// ── Files ───────────────────────────────────────────────────────────────────

function FilesTab({ slug, busy }: { slug: string; busy: boolean }): React.ReactElement {
  const [files, setFiles] = useState<Array<{ path: string; dir: boolean; size?: number }> | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.appFiles(slug).then(r => { if (live) setFiles(r.files); }).catch(() => { if (live) setFiles([]); });
    return () => { live = false; };
  }, [slug, busy]);
  const openFile = useCallback(async (p: string) => {
    setOpenPath(p);
    setContent(null);
    try { setContent((await api.appFile(slug, p)).content); } catch (err) { setContent(err instanceof Error ? err.message : String(err)); }
  }, [slug]);
  if (!files) return <Empty>Loading…</Empty>;
  return (
    <div className="flex h-full min-h-0">
      <ul className="w-48 shrink-0 overflow-y-auto border-r border-aico-border-subtle py-1 text-[11px]" data-files>
        {files.map(f => (
          <li key={f.path}>
            {f.dir ? (
              <div className="px-2 py-0.5 font-medium text-aico-secondary" style={{ paddingLeft: 8 + f.path.split('/').length * 8 }}>{f.path.split('/').pop()}/</div>
            ) : (
              <button onClick={() => void openFile(f.path)} className={`w-full truncate px-2 py-0.5 text-left font-mono hover:bg-aico-hover ${openPath === f.path ? 'bg-aico-hover text-aico-primary' : 'text-aico-secondary'}`} style={{ paddingLeft: 8 + f.path.split('/').length * 8 }} title={f.path}>
                {f.path.split('/').pop()}
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="min-w-0 flex-1 overflow-auto">
        {openPath ? (
          <>
            <div className="border-b border-aico-border-subtle px-3 py-1 font-mono text-[10px] text-aico-muted">{openPath}</div>
            <pre className="whitespace-pre p-3 font-mono text-[11px] leading-relaxed text-aico-secondary">{content ?? 'Loading…'}</pre>
          </>
        ) : <Empty>Pick a file to read it. Editing is the agent's job — ask for the change.</Empty>}
      </div>
    </div>
  );
}

// ── Logs ────────────────────────────────────────────────────────────────────

function LogsTab({ process, deploy, isProcess }: { process?: MiniAppProcess; deploy?: MiniAppProcess; isProcess: boolean }): React.ReactElement {
  if (!process && !deploy) {
    return <Empty>{isProcess ? 'Nothing has run yet. Start the app to see its output here.' : 'A page app has no process of its own; the shared host serves it. Deploy output appears here.'}</Empty>;
  }
  return (
    <div className="h-full overflow-auto p-3 text-[11px]" data-logs>
      {process && (
        <section className="mb-3">
          <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-aico-muted">Process · {process.state}{process.url ? ` · ${process.url}` : ''}{process.error ? ` · ${process.error}` : ''}</h4>
          <pre className="whitespace-pre-wrap rounded bg-aico-bg p-2 font-mono leading-relaxed text-aico-secondary">{process.output.slice(-200).join('\n') || 'no output yet'}</pre>
        </section>
      )}
      {deploy && (
        <section>
          <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-aico-muted">Deploy · {deploy.state}{deploy.error ? ` · ${deploy.error}` : ''}</h4>
          <pre className="whitespace-pre-wrap rounded bg-aico-bg p-2 font-mono leading-relaxed text-aico-secondary">{deploy.output.slice(-200).join('\n') || 'no output yet'}</pre>
        </section>
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="flex h-full items-center justify-center p-6 text-center text-[12px] text-aico-muted">{children}</div>;
}
