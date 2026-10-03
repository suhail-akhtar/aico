/**
 * Terminal tabs in the bottom panel — xterm.js over a real pseudo-terminal.
 *
 * Opens one terminal in the active chat's project on first show. Other parts
 * of the app ask for a terminal with a `desk:terminal` event ({ cwd, run }),
 * queued by terminal-bus.ts until this lazily loaded panel can take it; a
 * plugin command or the agent uses the same door, and a command is always
 * visible in the tab it runs in.
 *
 * Since ADR 0019 the panel follows the work:
 *  - every tab shows the project it runs in (chip; the full path on hover),
 *    and when the active chat's project has no terminal the panel offers one
 *    there; a chat with no project says "Scratch workspace" and offers
 *    "Choose a project…";
 *  - a command that exits non-zero (shell integration's records, from main)
 *    gets a chip — Explain · Fix with AICO — that sends an ordinary chat
 *    message with the command, cwd, exit code and a redacted output tail.
 *    Nothing is sent until the person clicks;
 *  - "Watch with AICO" per tab: main matches error patterns (debounced,
 *    deduped) and this shows a suggestion card — again, only a click asks;
 *  - the Agent tab mirrors the chat's own shell commands, read-only;
 *  - History → Save as… turns commands (never output) into a script, a
 *    custom tool draft or a schedule request;
 *  - New SSH terminal… signs in from the vault without this window ever
 *    holding the secret.
 *
 * @module desktop/renderer/ide/TerminalPanel
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useStore } from '@web/store';
import { desktop, invoke, on, platform } from '@/desktop';
import { useDesk, toast } from '@/state/desk';
import { Icon } from '@/lib/icons';
import { ago, cls, duration } from '@/lib/util';
import { useProjects } from '@/lib/projects';
import { activePlace, placeOf, tabInPlace, type Place } from '@/lib/terminal-labels';
import { MenuButton, MenuItem, MenuSep, MenuSub } from '@/shell/Popover';
import { sendPrompt } from '@/chat/actions';
import { describeExit, failurePrompt, type CommandRecord } from '@desk/terminal-integration';
import { redactOutput } from '@desk/terminal-redact';
import { hasPendingTerminalRequest, onTerminalRequest, type TerminalRequest } from './terminal-bus';
import { themeFromCss } from './terminal-theme';
import { TerminalAgentView } from './TerminalAgentView';
import { TerminalSshDialog, type SshOpened } from './TerminalSshDialog';
import { TerminalSaveDialog } from './TerminalSaveDialog';

type Owner = 'user' | 'agent' | 'ssh';

interface Tab {
  id: string; title: string; cwd: string; exited?: boolean; owner: Owner; watching?: boolean;
  ssh?: { host: string; port: number; user: string }; lastCommand?: string; lastExit?: number | null;
}

interface Suggestion { key: string; id: string; title: string; kind: string; line: string; at: number }

const AGENT = 'agent';
/** Exit codes that mean the person pressed Ctrl+C — not a failure worth a chip. */
const INTERRUPTED = new Set([130, -1073741510, 3221225786]);

const loadBool = (k: string, d: boolean): boolean => { try { const v = localStorage.getItem(k); return v === null ? d : v === '1'; } catch { return d; } };
const saveBool = (k: string, v: boolean): void => { try { localStorage.setItem(k, v ? '1' : '0'); } catch { /* fine */ } };

/** Ask AICO about a failed command: an ordinary chat message, sent only on this click. */
function askAico(mode: 'explain' | 'fix', tab: Tab, rec: Pick<CommandRecord, 'command' | 'cwd' | 'exitCode' | 'outputTail'>): void {
  void sendPrompt(failurePrompt({ mode, tabTitle: tab.title, command: rec.command, cwd: rec.cwd, exitCode: rec.exitCode, output: rec.outputTail }))
    .catch((e: Error) => toast.error('Could not send', e.message));
}

export function TerminalPanel(): React.ReactElement {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [failures, setFailures] = useState<Record<string, CommandRecord>>({});
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showAgent, setShowAgent] = useState(() => loadBool('desk.term.agentTab', true));
  const [historyOpen, setHistoryOpen] = useState(false);
  const [records, setRecords] = useState<CommandRecord[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [saveOpen, setSaveOpen] = useState(false);
  const [sshOpen, setSshOpen] = useState(false);
  const project = useStore(s => s.project);
  const projects = useProjects();
  const agentRunning = useStore(s => [...s.draft.tools.values()].some(t => (t.toolName === 'Bash' || t.toolName === 'Terminal') && t.toolRunning));
  const created = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;

  const here = useMemo(() => activePlace(project, projects), [project, projects]);
  const hasTabHere = tabs.some(t => t.owner !== 'ssh' && !t.exited && tabInPlace(t.cwd, here));
  const activeTab = tabs.find(t => t.id === active);

  const create = useCallback(async (opts?: TerminalRequest) => {
    try {
      const t = await invoke<Tab>('term:create', { cwd: opts?.cwd ?? here.path ?? undefined });
      setTabs(ts => [...ts, { ...t, owner: 'user' }]);
      setActive(t.id);
      if (opts?.run) {
        // Typed once the shell has drawn its prompt (its integration mark), or after 5 s.
        const run = opts.run;
        let done = false;
        const off = on<{ id: string; data: string }>('term:data', (m) => {
          if (done || m.id !== t.id || !m.data.includes('\x1b]133;B')) return;
          done = true; off(); void invoke('term:write', t.id, `${run}\r`);
        });
        setTimeout(() => { if (!done) { done = true; off(); void invoke('term:write', t.id, `${run}\r`); } }, 5000);
      }
      return t.id;
    } catch (e) {
      toast.error('Could not open a terminal', (e as Error).message);
      return null;
    }
  }, [here.path]);

  // First show: the tabs main already has, or one terminal where the work is.
  useEffect(() => {
    if (created.current) return;
    created.current = true;
    void invoke<Tab[]>('term:list').then(list => {
      if (list.length) { setTabs(list); setActive(list[list.length - 1]!.id); }
      else if (!hasPendingTerminalRequest()) void create();
    }).catch(() => { if (!hasPendingTerminalRequest()) void create(); });
  }, [create]);

  useEffect(() => onTerminalRequest((r) => { void create(r); }), [create]);

  useEffect(() => {
    const offExit = on<{ id: string; code: number }>('term:exit', ({ id }) => setTabs(ts => ts.map(t => t.id === id ? { ...t, exited: true } : t)));
    const offCreated = on<Tab>('term:created', (t) => {
      setTabs(ts => ts.some(x => x.id === t.id) ? ts : [...ts, t]);
      setActive(t.id);
      useDesk.getState().setPanel({ open: true, tab: 'terminal' });
    });
    const offCommand = on<{ id: string; record: CommandRecord }>('term:command', ({ id, record }) => {
      setTabs(ts => ts.map(t => t.id === id ? { ...t, cwd: record.cwd || t.cwd, lastCommand: record.command, lastExit: record.exitCode } : t));
      const failed = record.exitCode !== null && record.exitCode !== 0 && !INTERRUPTED.has(record.exitCode);
      setFailures(f => {
        const next = { ...f };
        if (failed) next[id] = record; else delete next[id];
        return next;
      });
      if (id === activeRef.current) setRecords(rs => [...rs, record].slice(-100));
    });
    const offSuggest = on<Omit<Suggestion, 'key'>>('term:suggest', (s) => {
      setSuggestions(list => [...list.filter(x => x.id !== s.id), { ...s, key: `${s.id}-${s.at}` }].slice(-3));
    });
    return () => { offExit(); offCreated(); offCommand(); offSuggest(); };
  }, []);

  // History follows the active tab.
  useEffect(() => {
    setSelected(new Set());
    if (!active || active === AGENT) { setRecords([]); return; }
    void invoke<CommandRecord[]>('term:commands', active).then(setRecords).catch(() => setRecords([]));
  }, [active]);

  const close = (id: string): void => {
    void invoke('term:kill', id);
    setFailures(f => { const n = { ...f }; delete n[id]; return n; });
    setSuggestions(s => s.filter(x => x.id !== id));
    setTabs(ts => {
      const next = ts.filter(t => t.id !== id);
      if (active === id) setActive(next[next.length - 1]?.id ?? (showAgent ? AGENT : null));
      return next;
    });
  };

  const toggleWatch = async (t: Tab): Promise<void> => {
    const on_ = await invoke<boolean>('term:watch', t.id, !t.watching).catch(() => t.watching ?? false);
    setTabs(ts => ts.map(x => x.id === t.id ? { ...x, watching: on_ } : x));
    if (on_) toast.info('Watching with AICO', `AICO will suggest help when ${t.title} prints an error. It never acts or calls a model until you click.`);
  };

  const setAgentTab = (v: boolean): void => {
    setShowAgent(v); saveBool('desk.term.agentTab', v);
    if (v) setActive(AGENT);
    else if (active === AGENT) setActive(tabs[tabs.length - 1]?.id ?? null);
  };

  const pickFolder = async (): Promise<void> => {
    const dir = await desktop.dialog.pickFolder('Open a terminal in…');
    if (dir) void create({ cwd: dir });
  };

  const askFromSuggestion = async (s: Suggestion, mode: 'explain' | 'fix'): Promise<void> => {
    const tab = tabs.find(t => t.id === s.id);
    setSuggestions(list => list.filter(x => x.key !== s.key));
    if (!tab) return;
    const tail = await invoke<string>('term:tail', s.id).catch(() => '');
    askAico(mode, tab, { command: tab.lastCommand ?? '(output of a running process, seen while watching)', cwd: tab.cwd, exitCode: null, outputTail: redactOutput(tail, 3000).text });
  };

  const projectMenu = (close_: () => void): React.ReactNode => (
    <>
      {projects.filter(p => p.exists !== false).slice(0, 14).map(p => (
        <MenuItem key={p.path} icon={p.isWorkspace ? 'box' : 'folder'} label={p.isWorkspace ? 'Scratch workspace' : p.name} hint={undefined} title={p.path}
          onClick={() => { close_(); void create({ cwd: p.path }); }} />
      ))}
      <MenuSep />
      <MenuItem icon="folder-open" label="Other folder…" onClick={() => { close_(); void pickFolder(); }} />
    </>
  );

  const scriptKind: 'ps1' | 'sh' = activeTab?.owner === 'ssh' || platform !== 'win32' ? 'sh' : 'ps1';
  const activePlaceOf = activeTab ? (activeTab.owner === 'ssh' ? null : placeOf(activeTab.cwd, projects)) : null;
  const failure = activeTab ? failures[activeTab.id] : undefined;
  const chosen = useMemo(() => records.filter(r => selected.has(r.id)), [records, selected]);

  return (
    <div className="flex h-full">
      <div className="relative flex min-w-0 flex-1 flex-col">
        {activeTab && (
          <div className="flex h-8 shrink-0 items-center gap-2 border-b border-aico-border-subtle px-3 text-[12px]">
            {activeTab.owner === 'ssh'
              ? <span className="flex items-center gap-1.5 text-aico-secondary"><Icon name="cloud" size={13} />{activeTab.ssh ? `${activeTab.ssh.user}@${activeTab.ssh.host}${activeTab.ssh.port === 22 ? '' : `:${activeTab.ssh.port}`}` : activeTab.title}</span>
              : <PlaceChip place={activePlaceOf!} cwd={activeTab.cwd} />}
            {activeTab.owner !== 'ssh' && <span className="min-w-0 truncate text-aico-muted" title={activeTab.cwd}>{activeTab.cwd}</span>}
            {activeTab.owner === 'agent' && <span className="shrink-0 rounded bg-aico-hover px-1.5 py-px text-[10.5px] text-aico-muted" title="Started by AICO with ide_terminal_run — the only kind of tab AICO can type into">started by AICO</span>}
            {activePlaceOf?.scratch && (
              <MenuButton className="shrink-0 text-[12px] text-aico-accent hover:underline" button={<>Choose a project…</>} title="Open a terminal in a project instead" width={260}>
                {projectMenu}
              </MenuButton>
            )}
            <div className="flex-1" />
            {activeTab.exited && <span className="text-aico-muted">exited</span>}
            <button className={cls('btn-ghost btn-sm', activeTab.watching && 'text-aico-accent')} onClick={() => void toggleWatch(activeTab)} aria-pressed={Boolean(activeTab.watching)}
              title="Watch with AICO: suggest help when this terminal prints an error. Never acts on its own.">
              <Icon name={activeTab.watching ? 'eye' : 'eye-off'} size={13} />{activeTab.watching ? 'Watching' : 'Watch'}
            </button>
            <button className={cls('btn-ghost btn-sm', historyOpen && 'bg-aico-hover')} onClick={() => setHistoryOpen(v => !v)} title="Commands run in this terminal" aria-pressed={historyOpen}>
              <Icon name="history" size={13} />History
            </button>
          </div>
        )}
        {failure && activeTab && (
          <div className="flex shrink-0 items-center gap-2 border-b border-aico-border-subtle bg-aico-danger/[0.07] px-3 py-1 text-[12px]" role="status">
            <Icon name="x-circle" size={13} className="shrink-0 text-aico-danger" />
            <span className="shrink-0 font-medium text-aico-danger">Command failed ({describeExit(failure).split(' · ')[0]})</span>
            <code className="min-w-0 truncate font-mono text-[11.5px] text-aico-secondary" title={failure.command}>{failure.command}</code>
            <div className="flex-1" />
            <button className="btn-ghost btn-sm" onClick={() => askAico('explain', activeTab, failure)} title="Ask AICO in the chat why it failed (sends the command, exit code and masked output)"><Icon name="help" size={12} />Explain</button>
            <button className="btn-ghost btn-sm text-aico-accent" onClick={() => askAico('fix', activeTab, failure)} title="Ask AICO to fix it (normal approvals apply)"><Icon name="sparkles" size={12} />Fix with AICO</button>
            <button className="icon-btn-sm h-6 w-6" onClick={() => setFailures(f => { const n = { ...f }; delete n[activeTab.id]; return n; })} aria-label="Dismiss"><Icon name="x" size={12} /></button>
          </div>
        )}
        <div className="relative min-h-0 flex-1">
          {tabs.map(t => <XTerm key={t.id} id={t.id} visible={t.id === active} />)}
          {showAgent && <TerminalAgentView visible={active === AGENT} />}
          {tabs.length === 0 && active !== AGENT && (
            <div className="flex h-full flex-col items-center justify-center gap-2">
              <button className="btn-outline" onClick={() => void create()}><Icon name="terminal" size={15} />New terminal in {here.label}</button>
              {here.scratch && <span className="text-[12px] text-aico-muted">This chat has no project.</span>}
            </div>
          )}
          {historyOpen && activeTab && (
            <HistoryDrawer records={records} selected={selected} setSelected={setSelected} onSave={() => setSaveOpen(true)} onClose={() => setHistoryOpen(false)} integration={records.length > 0 || activeTab.owner !== 'ssh'} />
          )}
          {suggestions.length > 0 && (
            <div className={cls('pointer-events-none absolute bottom-3 z-20 flex w-80 flex-col gap-2', historyOpen && activeTab ? 'right-[23rem]' : 'right-3')}>
              {suggestions.map(s => (
                <div key={s.key} className="pointer-events-auto rounded-xl border border-aico-border-subtle bg-aico-bg p-3 text-[12.5px] shadow-[var(--desk-shadow)]" role="status">
                  <div className="flex items-start gap-2">
                    <Icon name="eye" size={14} className="mt-0.5 shrink-0 text-aico-accent" />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">AICO noticed {s.kind === 'non-zero exit' ? 'a failure' : `${/^[aeiou]/i.test(s.kind) ? 'an' : 'a'} ${s.kind}`} in {s.title}</div>
                      <div className="mt-0.5 line-clamp-2 font-mono text-[11.5px] text-aico-secondary" title={s.line}>{s.line}</div>
                    </div>
                    <button className="icon-btn-sm h-5 w-5" onClick={() => setSuggestions(l => l.filter(x => x.key !== s.key))} aria-label="Dismiss"><Icon name="x" size={11} /></button>
                  </div>
                  <div className="mt-2 flex gap-1.5 pl-6">
                    <button className="btn-ghost btn-sm" onClick={() => void askFromSuggestion(s, 'explain')}>Explain</button>
                    <button className="btn-ghost btn-sm text-aico-accent" onClick={() => void askFromSuggestion(s, 'fix')}>Fix</button>
                    <button className="btn-ghost btn-sm" onClick={() => { setActive(s.id); setSuggestions(l => l.filter(x => x.key !== s.key)); }}>Show</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex w-56 shrink-0 flex-col border-l border-aico-border-subtle">
        <div className="flex items-center px-2 py-1">
          <span className="flex-1 text-[11.5px] text-aico-muted">Terminals</span>
          <MenuButton className="icon-btn-sm" button={<Icon name="plus" size={14} />} title="New terminal" placement="bottom-end" width={270}>
            {(close_) => (
              <>
                <MenuItem icon="terminal" label={`New terminal in ${here.label}`} title={here.path ?? undefined} onClick={() => { close_(); void create(); }} />
                <MenuSub icon="folder" label="Choose a project…" width={260}>{projectMenu(close_)}</MenuSub>
                <MenuSep />
                <MenuItem icon="cloud" label="New SSH terminal…" hint="vault" onClick={() => { close_(); setSshOpen(true); }} />
                <MenuSep />
                <MenuItem icon="bot" label="Show agent commands" checked={showAgent} onClick={() => { close_(); setAgentTab(!showAgent); }} />
              </>
            )}
          </MenuButton>
        </div>
        <div className="thin-scroll flex-1 overflow-y-auto px-1 pb-1">
          {!hasTabHere && tabs.length > 0 && (
            <button className="mb-1 flex w-full items-center gap-1.5 rounded-md border border-dashed border-aico-border-subtle px-2 py-1 text-left text-[11.5px] text-aico-secondary hover:border-aico-accent hover:text-aico-accent"
              onClick={() => void create()} title={here.path ?? undefined}>
              <Icon name="plus" size={12} /><span className="truncate">New terminal in {here.label}</span>
            </button>
          )}
          {showAgent && (
            <div className={cls('group flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px]', active === AGENT ? 'bg-aico-hover text-aico-primary' : 'text-aico-secondary hover:bg-aico-hover')}>
              <button className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => setActive(AGENT)} title="The agent's shell commands in this chat (read-only)">
                <Icon name="bot" size={12} />
                <span className="truncate">Agent</span>
                {agentRunning && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-aico-accent" aria-label="running" />}
              </button>
            </div>
          )}
          {tabs.map(t => {
            const place = t.owner === 'ssh' ? null : placeOf(t.cwd, projects);
            return (
              <div key={t.id} className={cls('group flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px]', t.id === active ? 'bg-aico-hover text-aico-primary' : 'text-aico-secondary hover:bg-aico-hover')}>
                <button className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => setActive(t.id)}
                  title={t.owner === 'ssh' ? `${t.title} (SSH)` : `${t.title} — ${t.cwd}${t.owner === 'agent' ? ' (started by AICO)' : ''}`}>
                  <Icon name={t.owner === 'ssh' ? 'cloud' : t.owner === 'agent' ? 'bot' : 'terminal'} size={12} className={t.exited ? 'text-aico-muted' : ''} />
                  <span className={cls('min-w-0 truncate', t.exited && 'text-aico-muted line-through')}>{t.title}</span>
                  {place && <span className={cls('ml-auto max-w-[45%] shrink-0 truncate rounded px-1 py-px text-[10.5px]', place.scratch ? 'bg-aico-hover text-aico-muted' : 'bg-aico-accent/10 text-aico-accent')}>{place.scratch ? 'Scratch' : place.label}</span>}
                  {failures[t.id] && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-aico-danger" aria-label="last command failed" />}
                  {t.watching && <Icon name="eye" size={11} className="shrink-0 text-aico-accent" />}
                </button>
                <button className="icon-btn-sm h-5 w-5 opacity-0 group-hover:opacity-100 focus:opacity-100" onClick={() => close(t.id)} aria-label="Close terminal"><Icon name="x" size={11} /></button>
              </div>
            );
          })}
        </div>
      </div>

      <TerminalSshDialog open={sshOpen} onClose={() => setSshOpen(false)} onOpened={(t: SshOpened) => { setTabs(ts => [...ts, { ...t, owner: 'ssh' }]); setActive(t.id); }} />
      <TerminalSaveDialog open={saveOpen} onClose={() => setSaveOpen(false)} records={chosen} tabTitle={activeTab?.title ?? 'terminal'} scriptKind={scriptKind}
        projectDir={activePlaceOf?.project && !activePlaceOf.scratch ? activePlaceOf.project : null} />
    </div>
  );
}

function PlaceChip({ place, cwd }: { place: Place; cwd: string }): React.ReactElement {
  return (
    <span className={cls('flex shrink-0 items-center gap-1 rounded-md px-1.5 py-px text-[11.5px]', place.scratch ? 'bg-aico-hover text-aico-secondary' : 'bg-aico-accent/10 text-aico-accent')} title={cwd}>
      <Icon name={place.scratch ? 'box' : 'folder'} size={12} />{place.label}
    </span>
  );
}

function HistoryDrawer({ records, selected, setSelected, onSave, onClose, integration }: {
  records: CommandRecord[]; selected: Set<number>; setSelected: (s: Set<number>) => void; onSave: () => void; onClose: () => void; integration: boolean;
}): React.ReactElement {
  const toggle = (id: number): void => { const n = new Set(selected); if (n.has(id)) n.delete(id); else n.add(id); setSelected(n); };
  const list = [...records].reverse();
  return (
    <div className="absolute inset-y-0 right-0 z-10 flex w-[22rem] max-w-full flex-col border-l border-aico-border-subtle bg-aico-bg shadow-[var(--desk-shadow)]">
      <div className="flex h-8 shrink-0 items-center gap-2 px-3 text-[12px]">
        <span className="font-medium">History</span>
        <span className="text-aico-muted">{records.length} command{records.length === 1 ? '' : 's'}</span>
        <div className="flex-1" />
        {records.length > 0 && <button className="text-[11.5px] text-aico-accent hover:underline" onClick={() => setSelected(selected.size === records.length ? new Set() : new Set(records.map(r => r.id)))}>{selected.size === records.length ? 'Clear' : 'Select all'}</button>}
        <button className="icon-btn-sm h-6 w-6" onClick={onClose} aria-label="Close history"><Icon name="x" size={12} /></button>
      </div>
      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-1.5">
        {list.length === 0 && (
          <p className="px-2 py-3 text-[12px] text-aico-muted">
            {integration ? 'Commands you run here appear in this list, with their exit codes.' : 'This shell has no AICO integration (SSH or cmd), so its commands are not recorded.'}
          </p>
        )}
        {list.map(r => (
          <label key={r.id} className={cls('flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 text-[12px] hover:bg-aico-hover', selected.has(r.id) && 'bg-aico-hover')}>
            <input type="checkbox" className="mt-0.5" checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-[11.5px]" title={r.command}>{r.command}</span>
              <span className="block text-[10.5px] text-aico-muted">{ago(r.startedAt)} · {duration(r.durationMs)}</span>
            </span>
            <span className={cls('shrink-0 rounded px-1 py-px font-mono text-[10.5px]', r.exitCode === 0 ? 'text-aico-success' : r.exitCode === null ? 'text-aico-muted' : 'bg-aico-danger/10 text-aico-danger')}>
              {r.exitCode === null ? '?' : r.exitCode === 0 ? '✓' : r.exitCode}
            </span>
          </label>
        ))}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-aico-border-subtle px-3 py-2">
        <span className="text-[11.5px] text-aico-muted">{selected.size ? `${selected.size} selected` : 'Select commands to reuse'}</span>
        <div className="flex-1" />
        <button className="btn-primary btn-sm" disabled={!selected.size} onClick={onSave}><Icon name="save" size={12} />Save as…</button>
      </div>
    </div>
  );
}

function XTerm({ id, visible }: { id: string; visible: boolean }): React.ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const mode = useDesk(s => s.mode);
  const codeFont = useDesk(s => s.prefs.codeFont);

  useEffect(() => {
    const t = new Terminal({
      fontFamily: codeFont, fontSize: 13, lineHeight: 1.2, cursorBlink: true, allowProposedApi: true,
      scrollback: 10000, theme: themeFromCss(), convertEol: false,
    });
    const f = new FitAddon();
    t.loadAddon(f);
    term.current = t; fit.current = f;
    t.open(host.current!);
    void invoke<string>('term:tail', id).then(tail => { if (tail) t.write(tail); });
    const offData = on<{ id: string; data: string }>('term:data', (m) => { if (m.id === id) t.write(m.data); });
    const offExit = on<{ id: string; code: number }>('term:exit', (m) => { if (m.id === id) t.write(`\r\n\x1b[90m[process exited with code ${m.code}]\x1b[0m\r\n`); });
    // The person's own keystrokes. The agent never types here (main refuses it: ADR 0019).
    const disp = t.onData(d => void invoke('term:write', id, d));
    t.attachCustomKeyEventHandler((e) => {
      // Ctrl+C copies when there is a selection; otherwise it is an interrupt.
      if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && e.key === 'c' && t.hasSelection()) { void navigator.clipboard.writeText(t.getSelection()); return false; }
      if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && e.key === 'v') { void navigator.clipboard.readText().then(txt => invoke('term:write', id, txt)); return false; }
      return true;
    });
    const ro = new ResizeObserver(() => {
      if (!host.current || host.current.offsetParent === null) return;
      try { f.fit(); void invoke('term:resize', id, t.cols, t.rows); } catch { /* not laid out yet */ }
    });
    ro.observe(host.current!);
    return () => { offData(); offExit(); disp.dispose(); ro.disconnect(); t.dispose(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => { if (term.current) term.current.options.theme = themeFromCss(); }, [mode]);
  useEffect(() => {
    if (!visible) return;
    requestAnimationFrame(() => { try { fit.current?.fit(); term.current?.focus(); if (term.current) void invoke('term:resize', id, term.current.cols, term.current.rows); } catch { /* hidden */ } });
  }, [visible, id]);

  return <div ref={host} className={cls('h-full w-full px-2 pt-1', !visible && 'hidden')} />;
}
