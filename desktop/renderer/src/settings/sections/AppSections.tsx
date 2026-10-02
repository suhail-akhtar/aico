/**
 * The desktop's own settings: General, Application (with Updates and
 * Backup & restore), Appearance, Shortcuts, Browser and About.
 *
 * @module desktop/renderer/settings/sections/AppSections
 */

import React, { useEffect, useState } from 'react';
import { THEME_PRESETS, type ThemeColors } from '@desk/prefs';
import { PANES } from '@web/settings-schema';
import { MarkdownRenderer } from '@aico/ui';
import { useDesk, toast } from '@/state/desk';
import { desktop, invoke, type BackupPreview, type UpdateState } from '@/desktop';
import { useUpdates } from '@/updates';
import { useThemes, useCommands } from '@/plugins/registry';
import { applyContributedTheme } from '@/plugins/run-action';
import { Icon } from '@/lib/icons';
import { ago, bytes, cls, prettyKey } from '@/lib/util';
import { EnginePane, Row, Switch } from '../fields';
import { AutofillSettings } from '@/browser/AutofillSettings';
import { openImportWizard } from '@/browser/ImportWizard';
import { openPasswords } from '@/browser/PasswordsBar';

export function GeneralSection(): React.ReactElement {
  const prefs = useDesk(s => s.prefs);
  const set = useDesk(s => s.setPrefs);
  const engineGeneral = PANES.find(p => p.id === 'general');
  return (
    <div>
      <h3 className="set-heading">Composer</h3>
      <div className="set-group">
        <Row title="Send with" desc="Shift+Enter always adds a new line.">
          <div className="segmented">
            <button aria-pressed={prefs.sendKey === 'enter'} onClick={() => void set({ sendKey: 'enter' })}>Enter</button>
            <button aria-pressed={prefs.sendKey === 'ctrl-enter'} onClick={() => void set({ sendKey: 'ctrl-enter' })}>Ctrl+Enter</button>
          </div>
        </Row>
        <Row title="Show the agent's steps" desc="Expand reasoning and tool calls under every answer instead of folding them.">
          <Switch checked={prefs.verboseAgent} onChange={v => void set({ verboseAgent: v })} label="Show the agent's steps" />
        </Row>
        <Row title="Jump to the start of each reply" desc="When a reply finishes, scroll up to where it begins instead of leaving you at its last line. Not if you had scrolled away.">
          <Switch checked={prefs.jumpToAnswer} onChange={v => void set({ jumpToAnswer: v })} label="Jump to the start of each reply" />
        </Row>
      </div>
      <h3 className="set-heading">Notifications</h3>
      <div className="set-group">
        <Row title="When a reply finishes" desc="Only while AICO is not the window in front.">
          <Switch checked={prefs.notifications.turnEnd} onChange={v => void set({ notifications: { ...prefs.notifications, turnEnd: v } })} label="Notify when a reply finishes" />
        </Row>
        <Row title="When the agent needs you" desc="A permission to grant, a question, a plan to approve, a browser hand-over.">
          <Switch checked={prefs.notifications.attention} onChange={v => void set({ notifications: { ...prefs.notifications, attention: v } })} label="Notify when the agent needs you" />
        </Row>
        <Row title="Background work" desc="Scheduled jobs and background agents finishing, the morning brief being ready, and monitor alerts.">
          <Switch checked={prefs.notifications.background} onChange={v => void set({ notifications: { ...prefs.notifications, background: v } })} label="Notify about background work" />
        </Row>
        <Row title="Sound">
          <Switch checked={prefs.notifications.sound} onChange={v => void set({ notifications: { ...prefs.notifications, sound: v } })} label="Notification sound" />
        </Row>
      </div>
      {engineGeneral && <div className="mt-2"><EnginePane pane={{ ...engineGeneral, groups: engineGeneral.groups.filter(g => g.title !== 'Appearance') }} /></div>}
    </div>
  );
}

export function ApplicationSection(): React.ReactElement {
  const prefs = useDesk(s => s.prefs);
  const set = useDesk(s => s.setPrefs);
  const engine = useDesk(s => s.engine);
  const info = useDesk(s => s.info);
  return (
    <div>
      <h3 className="set-heading">General</h3>
      <div className="set-group">
        <Row title="Prevent sleep" desc="Keep the computer awake while AICO is open — long runs finish overnight.">
          <Switch checked={prefs.preventSleep} onChange={v => void set({ preventSleep: v })} label="Prevent sleep" />
        </Row>
        <Row title="Keep in the tray" desc="Closing the window keeps AICO running in the background; scheduled jobs keep firing.">
          <Switch checked={prefs.keepInTray} onChange={v => void set({ keepInTray: v })} label="Keep in the tray" />
        </Row>
        <Row title="Start at login">
          <Switch checked={prefs.launchAtLogin} onChange={v => void set({ launchAtLogin: v })} label="Start at login" />
        </Row>
        <Row title="Inspect element in right-click menus" desc="For plugin authors: adds the developer tools' inspector to the context menu.">
          <Switch checked={prefs.developerMenus} onChange={v => void set({ developerMenus: v })} label="Inspect element in right-click menus" />
        </Row>
      </div>
      <UpdatesGroup />
      <h3 className="set-heading">Engine</h3>
      <div className="set-group">
        <Row title={<span className="flex items-center gap-2"><span className={cls('h-2 w-2 rounded-full', engine.status === 'ready' ? 'bg-aico-success' : engine.status === 'crashed' ? 'bg-aico-danger' : 'bg-aico-warning')} />
          {engine.status === 'ready' ? 'Running' : engine.status === 'crashed' ? 'Stopped' : 'Starting'}</span>}
          desc="The AICO engine runs in its own process. Restarting stops a running turn; chats are kept.">
          <button className="btn-outline btn-sm" onClick={() => { void desktop.engine.restart(); toast.info('Restarting the engine…'); }}>Restart</button>
        </Row>
        <Row title="Open in the web client" desc="The same chats in your browser — handy on a second screen.">
          <button className="btn-outline btn-sm" onClick={() => void desktop.engine.webUrl().then(u => u && desktop.shell.openExternal(u))}>Open</button>
        </Row>
      </div>
      <h3 className="set-heading">Data</h3>
      <div className="set-group">
        <Row title="AICO folder" desc={<span className="font-mono">{info?.aicoHome}</span>}>
          <button className="btn-outline btn-sm" onClick={() => info && void desktop.shell.openPath(info.aicoHome)}>Reveal</button>
        </Row>
        <Row title="Plugins folder" desc={<span className="font-mono">{info?.pluginsDir}</span>}>
          <button className="btn-outline btn-sm" onClick={() => info && void desktop.shell.openPath(info.pluginsDir)}>Reveal</button>
        </Row>
      </div>
      <BackupGroup />
      <h3 className="set-heading">Version</h3>
      <div className="set-group">
        <Row title="App version"><span className="font-mono text-[12.5px] text-aico-muted">{info?.app}</span></Row>
        <Row title="Engine version"><span className="font-mono text-[12.5px] text-aico-muted">{info?.engine}</span></Row>
        <Row title="Runtime"><span className="font-mono text-[12.5px] text-aico-muted">Electron {info?.electron} · Chromium {info?.chrome} · Node {info?.node}</span></Row>
      </div>
    </div>
  );
}

/** What the updater is doing, in one sentence. */
function updateStatusText(u: UpdateState): string {
  switch (u.status) {
    case 'unsupported': return u.message ?? 'Automatic updates are not available for this copy.';
    case 'idle': return 'Not checked yet.';
    case 'checking': return 'Checking for updates…';
    case 'up-to-date': return 'You have the latest version.';
    case 'available': return `AICO ${u.version} is available.`;
    case 'downloading': return `Downloading AICO ${u.version ?? ''}… ${u.percent ?? 0}%`;
    case 'ready': return u.message ?? `AICO ${u.version} is ready — restart to install. It also installs the next time you quit.`;
    case 'waiting': return `Restarts to install AICO ${u.version} when this finishes: ${(u.busy ?? []).join('; ')}.`;
    case 'error': return u.message ?? 'The update check failed.';
  }
}

function UpdatesGroup(): React.ReactElement {
  const prefs = useDesk(s => s.prefs);
  const set = useDesk(s => s.setPrefs);
  const u = useUpdates(s => s.state);
  const [busy, setBusy] = useState(false);
  const act = (fn: () => Promise<unknown>): void => {
    setBusy(true);
    void fn().catch((e: Error) => toast.error('Updates', e.message)).finally(() => setBusy(false));
  };
  const age = u?.lastCheckedAt ? ago(u.lastCheckedAt) : '';
  const last = age ? `Last checked ${age === 'now' ? 'just now' : `${age} ago`}.` : '';
  const releasePage = u && <button className="btn-outline btn-sm" onClick={() => void desktop.shell.openExternal(u.releaseUrl)}>Release page</button>;
  return (
    <>
      <h3 className="set-heading">Updates</h3>
      <div className="set-group">
        <Row title="Update automatically" desc="Check GitHub releases at start and every 6 hours, and download new versions in the background. Nothing restarts without you.">
          <Switch checked={prefs.autoUpdate.enabled} onChange={v => void set({ autoUpdate: { ...prefs.autoUpdate, enabled: v } })} label="Update automatically"
            disabled={u?.status === 'unsupported'} />
        </Row>
        <Row title={<span>AICO <span className="font-mono text-[12.5px]">{u?.current ?? '…'}</span></span>}
          desc={<span data-testid="update-status">{u ? updateStatusText(u) : 'Loading…'}{last && u?.status !== 'unsupported' ? ` ${last}` : ''}</span>}>
          <div className="flex items-center gap-2">
            {u?.status === 'unsupported' && releasePage}
            {(u?.status === 'idle' || u?.status === 'up-to-date' || u?.status === 'error' || u?.status === 'checking') && (
              <button className="btn-outline btn-sm" disabled={busy || u.status === 'checking'} onClick={() => act(() => desktop.updates.check())}>
                {u.status === 'checking' ? 'Checking…' : 'Check now'}
              </button>
            )}
            {u?.status === 'error' && releasePage}
            {u?.status === 'available' && <button className="btn-primary btn-sm" disabled={busy} onClick={() => act(() => desktop.updates.download())}>Download</button>}
            {u?.status === 'ready' && <button className="btn-primary btn-sm" disabled={busy} onClick={() => act(() => desktop.updates.install())}>Restart</button>}
            {u?.status === 'waiting' && (
              <>
                <button className="btn-outline btn-sm" onClick={() => act(() => desktop.updates.cancelWait())}>Cancel</button>
                <button className="btn-danger btn-sm" onClick={() => act(() => desktop.updates.install('now'))}>Restart now</button>
              </>
            )}
          </div>
        </Row>
        {u?.status === 'downloading' && (
          <div className="px-4 pb-3">
            <div className="h-1.5 overflow-hidden rounded-full bg-aico-hover" role="progressbar" aria-valuenow={u.percent ?? 0} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full rounded-full bg-aico-accent transition-[width]" style={{ width: `${u.percent ?? 0}%` }} />
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function BackupGroup(): React.ReactElement {
  const [keys, setKeys] = useState(false);
  const [chats, setChats] = useState(false);
  const [working, setWorking] = useState<null | 'export' | 'pick' | 'restore'>(null);
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [restored, setRestored] = useState<string | null>(null);

  const exportNow = (): void => {
    setWorking('export');
    void desktop.backup.export({ includeApiKeys: keys, includeChats: chats })
      .then((r) => { if (r) toast.success('Backup saved', `${r.files} files, ${bytes(r.bytes)} — ${r.file}`); })
      .catch((e: Error) => toast.error('Could not export the backup', e.message))
      .finally(() => setWorking(null));
  };
  const pick = (): void => {
    setWorking('pick');
    void desktop.backup.pick()
      .then(p => setPreview(p))
      .catch((e: Error) => toast.error('Could not read the backup', e.message))
      .finally(() => setWorking(null));
  };
  const restore = (): void => {
    if (!preview) return;
    setWorking('restore');
    void desktop.backup.import(preview.file)
      .then((r) => {
        setPreview(null);
        setRestored(`Restored ${r.restored} files${r.keptKeys ? `, kept ${r.keptKeys === 1 ? 'the API key' : `${r.keptKeys} API keys`} already on this computer` : ''}. The files it replaced are saved in ${r.safetyCopy}. Reloading…`);
      })
      .catch((e: Error) => toast.error('Could not restore the backup', e.message))
      .finally(() => setWorking(null));
  };

  const m = preview?.manifest;
  const os = (p: string): string => (p === 'win32' ? 'Windows' : p === 'linux' ? 'Linux' : p === 'darwin' ? 'macOS' : p);
  return (
    <>
      <h3 className="set-heading">Backup &amp; restore</h3>
      <div className="set-group">
        <Row title="Export a backup" desc="Settings (with your projects and groups), desktop preferences and plugins, skills, agents, memory and knowledge, scheduled jobs — one .zip to move AICO to another computer.">
          <button className="btn-outline btn-sm" disabled={working !== null} onClick={exportNow}>{working === 'export' ? 'Exporting…' : 'Export…'}</button>
        </Row>
        <Row title="Include API keys" desc="Off by default: a backup file tends to travel (USB sticks, cloud folders). Restoring a backup without keys keeps the ones already on that computer.">
          <Switch checked={keys} onChange={setKeys} label="Include API keys" />
        </Row>
        <Row title="Include chats" desc="Every conversation with its attachments. Can be large.">
          <Switch checked={chats} onChange={setChats} label="Include chats" />
        </Row>
        <Row title="Restore from a backup" desc="Merges into this computer's AICO folder: files in the backup replace the ones here, everything else stays. What gets replaced is saved to backups/ first. The engine restarts.">
          <button className="btn-outline btn-sm" disabled={working !== null} onClick={pick}>{working === 'pick' ? 'Reading…' : 'Restore…'}</button>
        </Row>
      </div>
      {restored && <p className="mt-2 text-[12.5px] text-aico-success" role="status">{restored}</p>}
      {preview && m && (
        <div className="mt-3 rounded-xl border border-aico-border p-4" role="dialog" aria-label="Restore this backup?">
          <div className="text-[13.5px] font-medium text-aico-primary">Restore this backup?</div>
          <div className="mt-1 text-[12.5px] text-aico-muted">
            Made {new Date(m.createdAt).toLocaleString()} by AICO {m.app} on {os(m.platform)} · API keys {m.apiKeys ? 'included' : 'not included (the keys on this computer are kept)'}
          </div>
          <ul className="mt-3 space-y-1 text-[13px]">
            {preview.summary.map(s => (
              <li key={s.id} className="flex justify-between gap-4"><span>{s.label}</span><span className="font-mono text-[12px] text-aico-muted">{s.files} {s.files === 1 ? 'file' : 'files'}</span></li>
            ))}
            {preview.summary.length === 0 && <li className="text-aico-muted">Nothing to restore.</li>}
          </ul>
          {preview.ignored > 0 && <p className="mt-2 text-[12px] text-aico-muted">{preview.ignored} other entries are not part of a backup and will be skipped.</p>}
          {preview.busy.length > 0 && <p className="mt-2 text-[12.5px] text-aico-warning">Restoring restarts the engine and stops: {preview.busy.join('; ')}.</p>}
          <div className="mt-3 flex justify-end gap-2">
            <button className="btn-outline btn-sm" disabled={working === 'restore'} onClick={() => setPreview(null)}>Cancel</button>
            <button className="btn-primary btn-sm" disabled={working === 'restore' || preview.summary.length === 0} onClick={restore}>{working === 'restore' ? 'Restoring…' : 'Restore'}</button>
          </div>
        </div>
      )}
    </>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }): React.ReactElement {
  const [draft, setDraft] = useState(value.replace('#', ''));
  useEffect(() => setDraft(value.replace('#', '')), [value]);
  return (
    <Row title={label}>
      <label className="flex h-8 items-center gap-2 rounded-lg border border-aico-border px-2">
        <input type="color" value={value} onChange={e => onChange(e.target.value.toUpperCase())} className="h-4 w-4 cursor-pointer appearance-none rounded border-0 bg-transparent p-0" aria-label={`${label} colour`} />
        <span className="text-aico-muted">#</span>
        <input value={draft} onChange={e => setDraft(e.target.value)} className="w-16 bg-transparent font-mono text-[12.5px] uppercase outline-none"
          onBlur={() => { if (/^[0-9a-f]{6}$/i.test(draft)) onChange(`#${draft.toUpperCase()}`); else setDraft(value.replace('#', '')); }} aria-label={`${label} hex`} />
      </label>
    </Row>
  );
}

export function AppearanceSection(): React.ReactElement {
  const prefs = useDesk(s => s.prefs);
  const set = useDesk(s => s.setPrefs);
  const themes = useThemes();
  const setMode = (mode: 'light' | 'dark', patch: Partial<ThemeColors>): void => {
    void set({ [mode]: { ...prefs[mode], ...patch, preset: patch.preset ?? 'Custom' } } as never);
  };
  const block = (mode: 'light' | 'dark'): React.ReactElement => {
    const presets = { ...THEME_PRESETS[mode] };
    for (const t of themes.filter(x => x.mode === mode)) presets[t.label] = { background: t.background, foreground: t.foreground, accent: t.accent };
    const c = prefs[mode];
    return (
      <>
        <h3 className="set-heading">{mode === 'light' ? 'Light theme' : 'Dark theme'}</h3>
        <div className="set-group">
          <Row title="Preset">
            <select className="select w-48" value={presets[c.preset] ? c.preset : 'Custom'}
              onChange={e => { const p = presets[e.target.value]; if (p) setMode(mode, { ...p, preset: e.target.value }); }}>
              {!presets[c.preset] && <option value="Custom">Custom</option>}
              {Object.keys(presets).map(k => <option key={k} value={k}>{k}</option>)}
            </select>
          </Row>
          <ColorField label="Background" value={c.background} onChange={v => setMode(mode, { background: v })} />
          <ColorField label="Foreground" value={c.foreground} onChange={v => setMode(mode, { foreground: v })} />
          <ColorField label="Accent" value={c.accent} onChange={v => setMode(mode, { accent: v })} />
        </div>
      </>
    );
  };
  return (
    <div>
      <p className="-mt-2 mb-4 text-[13px] text-aico-muted">Configure the visual theme and how conversations are shown.</p>
      <h3 className="set-heading">Appearance</h3>
      <div className="set-group">
        <Row title="Theme">
          <div className="segmented">
            {(['system', 'light', 'dark'] as const).map(m => (
              <button key={m} aria-pressed={prefs.theme === m} onClick={() => { void set({ theme: m }); void desktop.win.setThemeSource(m); }} title={m} aria-label={`${m} theme`}>
                <Icon name={m === 'system' ? 'monitor' : m === 'light' ? 'sun' : 'moon'} size={15} />
              </button>
            ))}
          </div>
        </Row>
        <Row title="Contrast">
          <div className="segmented">
            <button aria-pressed={prefs.contrast === 'default'} onClick={() => void set({ contrast: 'default' })}>Default</button>
            <button aria-pressed={prefs.contrast === 'strong'} onClick={() => void set({ contrast: 'strong' })}>Strong</button>
          </div>
        </Row>
      </div>
      {block('light')}
      {block('dark')}
      {themes.length > 0 && (
        <>
          <h3 className="set-heading">Themes from plugins</h3>
          <div className="grid grid-cols-2 gap-2">
            {themes.map(t => (
              <button key={`${t.pluginId}:${t.id}`} className="flex items-center gap-3 rounded-xl border border-aico-border-subtle p-3 text-left hover:bg-aico-hover" onClick={() => void applyContributedTheme(t)}>
                <span className="flex h-8 w-12 overflow-hidden rounded-md border border-aico-border">
                  <span className="flex-1" style={{ background: t.background }} /><span className="w-3" style={{ background: t.accent }} />
                </span>
                <span className="text-[13px]">{t.label}<span className="block text-[11.5px] text-aico-muted">{t.mode}</span></span>
              </button>
            ))}
          </div>
        </>
      )}
      <div className="mt-5 rounded-xl border border-aico-border-subtle p-4 font-mono text-[13px]" aria-label="Preview">
        <MarkdownRenderer content={'```ts\n// Greet a user by name\nconst greet = (name: string) => {\n  return `Hello, ${name}!`;\n};\n```'} />
      </div>
      <h3 className="set-heading">Text and layout</h3>
      <div className="set-group">
        <Row title="Interface size">
          <div className="segmented">
            {[13, 14, 15, 16].map(n => <button key={n} aria-pressed={prefs.fontSize === n} onClick={() => void set({ fontSize: n })}>{n === 13 ? 'Small' : n === 14 ? 'Default' : n === 15 ? 'Large' : 'Larger'}</button>)}
          </div>
        </Row>
        <Row title="Conversation width">
          <div className="segmented">
            {(['default', 'wide', 'full'] as const).map(w => <button key={w} aria-pressed={prefs.conversationWidth === w} onClick={() => void set({ conversationWidth: w })}>{w[0]!.toUpperCase() + w.slice(1)}</button>)}
          </div>
        </Row>
        <Row title="Interface font" desc="Any installed font; falls back to the system font." stack>
          <input className="input" defaultValue={prefs.uiFont} onBlur={e => e.target.value.trim() && void set({ uiFont: e.target.value.trim() })} />
        </Row>
        <Row title="Code font" stack>
          <input className="input font-mono" defaultValue={prefs.codeFont} onBlur={e => e.target.value.trim() && void set({ codeFont: e.target.value.trim() })} />
        </Row>
      </div>
    </div>
  );
}

export function ShortcutsSection(): React.ReactElement {
  const commands = useCommands();
  const prefs = useDesk(s => s.prefs);
  const set = useDesk(s => s.setPrefs);
  const [recording, setRecording] = useState<string | null>(null);
  const fixed: Array<[string, string]> = [
    ['Command palette', 'Ctrl+K'], ['New chat', 'Ctrl+N'], ['Settings', 'Ctrl+,'], ['Toggle sidebar', 'Ctrl+B'],
    ['Toggle bottom panel', 'Ctrl+J'], ['Search chats', 'Ctrl+Shift+F'], ['Focus the composer', 'Ctrl+L'], ['Back / Forward', 'Alt+← / Alt+→'],
    ['Steer a running turn', 'Enter'], ['Queue a follow-up', 'Ctrl+Enter'],
  ];
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') { setRecording(null); return; }
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
      const spec = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta', e.key.length === 1 ? e.key.toUpperCase() : e.key].filter(Boolean).join('+');
      void set({ shortcuts: { ...prefs.shortcuts, [recording]: spec } });
      setRecording(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, prefs.shortcuts, set]);
  return (
    <div>
      <h3 className="set-heading">Built in</h3>
      <div className="set-group">
        {fixed.map(([t, k]) => <Row key={t} title={t}><span className="kbd">{k}</span></Row>)}
      </div>
      <h3 className="set-heading">Commands</h3>
      <p className="-mt-1 mb-2 text-[12px] text-aico-muted">Click a shortcut to record a new one. Esc cancels.</p>
      <div className="set-group">
        {commands.map(c => {
          const key = prefs.shortcuts[c.id] ?? c.keybinding;
          return (
            <Row key={c.id} title={c.title} desc={c.category}>
              <div className="flex items-center gap-1">
                <button className={cls('kbd h-7 min-w-[80px] px-2', recording === c.id && 'border-aico-accent text-aico-accent')} onClick={() => setRecording(c.id)}>
                  {recording === c.id ? 'Press keys…' : key ? prettyKey(key) : '—'}
                </button>
                {prefs.shortcuts[c.id] && (
                  <button className="icon-btn-sm" title="Reset" onClick={() => { const n = { ...prefs.shortcuts }; delete n[c.id]; void set({ shortcuts: n }); }}><Icon name="x" size={12} /></button>
                )}
              </div>
            </Row>
          );
        })}
      </div>
    </div>
  );
}

export function BrowserSection(): React.ReactElement {
  const prefs = useDesk(s => s.prefs);
  const set = useDesk(s => s.setPrefs);
  return (
    <div>
      <p className="-mt-2 mb-4 text-[13px] text-aico-muted">The built-in browser has its own profile: its sign-ins are not your everyday browser's and not the app's.</p>
      <div className="set-group">
        <Row title="Home page" stack><input className="input" defaultValue={prefs.browserHome} onBlur={e => e.target.value.trim() && void set({ browserHome: e.target.value.trim() })} /></Row>
        <Row title="On startup" desc="Continue where you left off: your tabs, and sites you were signed in to for the session, come back after a restart or an update.">
          <div className="segmented">
            <button aria-pressed={prefs.browserStartup !== 'newTab'} onClick={() => void set({ browserStartup: 'restore' })}>Continue where I left off</button>
            <button aria-pressed={prefs.browserStartup === 'newTab'} onClick={() => void set({ browserStartup: 'newTab' })}>Open a new tab</button>
          </div>
        </Row>
        <Row title="Agent access" desc="Whether the agent may drive the built-in browser (browse, click, type, screenshot) for testing and automation.">
          <div className="segmented">
            <button aria-pressed={prefs.browserAgentAccess === 'allow'} onClick={() => void set({ browserAgentAccess: 'allow' })}>Allow</button>
            <button aria-pressed={prefs.browserAgentAccess === 'deny'} onClick={() => void set({ browserAgentAccess: 'deny' })}>Never</button>
          </div>
        </Row>
        <Row title="Clear browsing data" desc="Cookies, sign-ins, storage and cache of the built-in browser.">
          <button className="btn-danger btn-sm" onClick={() => void desktop.dialog.confirm({ title: 'Clear browsing data', message: 'Sign out of every site in the built-in browser?', ok: 'Clear', danger: true })
            .then(ok => { if (ok) void invoke('browser:clearData').then(() => toast.success('Browsing data cleared')); })}>Clear</button>
        </Row>
        <Row title="Passwords" desc="Web logins the browser saves live in AICO's credential vault: encrypted on this computer, filled only into their own site, never shown to the agent, never in backups.">
          <div className="flex gap-2">
            <button className="btn-outline btn-sm" onClick={openPasswords}><Icon name="key" size={14} />Passwords</button>
            <button className="btn-ghost btn-sm" onClick={() => useDesk.getState().openSettings('credentials')}><Icon name="shield" size={14} />All credentials</button>
          </div>
        </Row>
        <Row title="Import browser data" desc="Bookmarks, history and addresses from Chrome, Edge, Brave, Vivaldi, Opera or Firefox — and passwords from a file you export yourself.">
          <button className="btn-outline btn-sm" onClick={() => openImportWizard()}><Icon name="download" size={14} />Import…</button>
        </Row>
      </div>
      <AutofillSettings />
    </div>
  );
}

export function AboutSection(): React.ReactElement {
  const info = useDesk(s => s.info);
  return (
    <div className="space-y-4 text-[13.5px] text-aico-secondary">
      <p><span className="font-semibold text-aico-primary">AICO Desktop</span> {info?.app} — the AICO coding agent as a native app, with a built-in IDE, browser, terminal and plugins.</p>
      <p>Engine {info?.engine}. Everything runs on this computer; providers are called directly with your own keys.</p>
      <div className="flex flex-wrap gap-2">
        <button className="btn-outline btn-sm" onClick={() => void desktop.shell.openExternal('https://github.com/suhail-akhtar/aico')}><Icon name="github" size={14} />Source</button>
        <button className="btn-outline btn-sm" onClick={() => void desktop.shell.openExternal('https://github.com/suhail-akhtar/aico/blob/main/CHANGELOG.md')}>Release notes</button>
        <button className="btn-outline btn-sm" onClick={() => void desktop.shell.openExternal('https://github.com/suhail-akhtar/aico/issues/new')}>Report an issue</button>
      </div>
      <p className="text-[12px] text-aico-muted">Free for personal use (PolyForm Noncommercial 1.0.0) — © Suhail Akhtar. Electron {info?.electron}, Chromium {info?.chrome}, Node {info?.node}, {info?.platform}/{info?.arch}.</p>
    </div>
  );
}
