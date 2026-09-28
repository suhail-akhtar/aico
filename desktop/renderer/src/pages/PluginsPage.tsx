/**
 * Plugins — every piece of the IDE, switchable.
 *
 * Built-in features are listed as plugins because they are plugins: each
 * registers its pages, commands and settings through the same API a plugin you
 * write does. Switch one off and all of it goes. User plugins live as folders
 * in ~/.aico/desktop/plugins; the orchestrator can write them for you ("make me
 * a plugin that…"), and so can you, by hand or from a template here.
 *
 * @module desktop/renderer/pages/PluginsPage
 */

import React, { useMemo, useState } from 'react';
import type { PluginManifest } from '@desk/plugin-types';
import { useRegistry } from '@/plugins/registry';
import { useDesk, toast } from '@/state/desk';
import { invoke } from '@/desktop';
import { Icon } from '@/lib/icons';
import { cls } from '@/lib/util';
import { Switch } from '@/settings/fields';
import { Modal } from '@/shell/Modal';
import { newChat } from '@/chat/actions';

const TEMPLATES: Array<{ id: string; title: string; description: string; manifest: PluginManifest; files?: Record<string, string> }> = [
  {
    id: 'prompts',
    title: 'Prompt board',
    description: 'A page of one-click prompts for tasks you repeat.',
    manifest: {
      id: 'my.prompt-board', name: 'My prompts', version: '0.1.0', icon: 'sparkles', category: 'Productivity',
      description: 'One-click prompts for tasks I repeat.',
      contributes: {
        navItems: [{ id: 'board', title: 'My prompts', icon: 'sparkles', view: 'board' }],
        views: [{ id: 'board', title: 'My prompts', kind: 'prompt-board', description: 'Click one to start a chat.', prompts: [
          { title: 'Review my changes', prompt: 'Review the uncommitted changes in this project for bugs and risky edits.', icon: 'check' },
          { title: 'Write tests', prompt: 'Find the least-tested module here and write thorough tests for it.', icon: 'flask' },
          { title: 'Explain this codebase', prompt: 'Give me a map of this codebase: modules, data flow, and where to start reading.', icon: 'map' },
        ] }],
        commands: [{ id: 'review', title: 'Review uncommitted changes', category: 'Chat', icon: 'check', action: { type: 'prompt', prompt: 'Review the uncommitted changes for bugs.' } }],
      },
    },
  },
  {
    id: 'theme',
    title: 'Theme',
    description: 'A light and a dark colour scheme.',
    manifest: {
      id: 'my.theme', name: 'My theme', version: '0.1.0', icon: 'palette', category: 'Themes',
      contributes: { themes: [
        { id: 'dusk', label: 'Dusk', mode: 'dark', background: '#1A1B26', foreground: '#C0CAF5', accent: '#7AA2F7' },
        { id: 'sand', label: 'Sand', mode: 'light', background: '#FBF7F0', foreground: '#2E2A24', accent: '#C2410C' },
      ] },
    },
  },
  {
    id: 'dashboard',
    title: 'Dashboard page',
    description: 'A page of charts and notes, written in Markdown with widgets.',
    manifest: {
      id: 'my.dashboard', name: 'My dashboard', version: '0.1.0', icon: 'chart', category: 'Pages',
      contributes: {
        navItems: [{ id: 'dash', title: 'Dashboard', icon: 'chart', view: 'dash', placement: 'more' }],
        views: [{ id: 'dash', title: 'Dashboard', kind: 'markdown', markdown: '# Dashboard\n\n```chart\n{"xAxis":{"type":"category","data":["Mon","Tue","Wed","Thu","Fri"]},"yAxis":{"type":"value"},"series":[{"type":"bar","data":[12,19,7,14,22]}]}\n```\n\nEdit this page in `~/.aico/desktop/plugins/my.dashboard/aico-plugin.json`, or ask the agent to.' }],
      },
    },
  },
  {
    id: 'frame',
    title: 'Custom page (HTML)',
    description: 'Your own HTML and script, in a sandbox.',
    manifest: {
      id: 'my.page', name: 'My page', version: '0.1.0', icon: 'code', category: 'Pages',
      contributes: {
        navItems: [{ id: 'page', title: 'My page', icon: 'code', view: 'page', placement: 'more' }],
        views: [{ id: 'page', title: 'My page', kind: 'frame', entry: 'view.html' }],
      },
    },
    files: {
      'view.html': `<!doctype html><html><body style="font-family:system-ui;padding:24px">
<h1>Hello from a plugin</h1>
<button id="ask">Ask the agent for a haiku</button>
<script>
  let n = 0; const calls = {};
  function call(method, params) { const id = ++n; parent.postMessage({ type: 'aico:call', id, method, params }, '*'); return new Promise(r => calls[id] = r); }
  addEventListener('message', e => {
    if (e.data?.type === 'aico:init') { document.body.style.background = e.data.theme.vars['--aico-bg']; document.body.style.color = e.data.theme.vars['--aico-text-primary']; }
    if (e.data?.type === 'aico:reply') calls[e.data.id]?.(e.data.result);
  });
  document.getElementById('ask').onclick = () => call('chat.ask', { prompt: 'Write a haiku about this project.' });
</script></body></html>`,
    },
  },
];

export function PluginsPage(): React.ReactElement {
  const builtins = useRegistry(s => s.builtins);
  const user = useRegistry(s => s.user);
  const reload = useRegistry(s => s.reloadUser);
  const prefs = useDesk(s => s.prefs);
  const setPrefs = useDesk(s => s.setPrefs);
  const [tab, setTab] = useState<'all' | 'builtin' | 'mine'>('all');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);

  const setEnabled = (id: string, on: boolean): void => {
    const disabled = new Set(prefs.plugins.disabled);
    if (on) disabled.delete(id); else disabled.add(id);
    void setPrefs({ plugins: { ...prefs.plugins, disabled: [...disabled] } });
  };

  const rows = useMemo(() => {
    const all = [
      ...builtins.map(b => ({ m: b.manifest, source: 'builtin' as const, error: undefined as string | undefined, hasScript: false, dir: undefined as string | undefined })),
      ...user.map(u => ({ m: u.manifest, source: 'user' as const, error: u.error, hasScript: u.hasScript, dir: u.dir })),
    ];
    const needle = q.trim().toLowerCase();
    return all.filter(r => (tab === 'all' || (tab === 'builtin') === (r.source === 'builtin'))
      && (!needle || r.m.name.toLowerCase().includes(needle) || (r.m.description ?? '').toLowerCase().includes(needle) || r.m.id.includes(needle)));
  }, [builtins, user, tab, q]);

  const byCategory = useMemo(() => {
    const map = new Map<string, typeof rows>();
    for (const r of rows) {
      const c = r.source === 'user' ? (r.m.category ?? 'Yours') : (r.m.category ?? 'Core');
      map.set(c, [...(map.get(c) ?? []), r]);
    }
    return [...map.entries()];
  }, [rows]);

  const install = async (t: typeof TEMPLATES[number]): Promise<void> => {
    try {
      await invoke('plugins:save', t.manifest, t.files ?? {});
      await reload();
      setCreating(false);
      toast.success(`“${t.manifest.name}” installed`, 'Edit it in the plugins folder, or ask the agent to change it.');
    } catch (err) { toast.error('Could not create it', (err as Error).message); }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-8 pb-16 pt-8">
        <div className="flex items-center gap-4">
          <h1 className="text-[26px] font-semibold tracking-tight">Plugins</h1>
          <div className="flex-1" />
          <div className="relative w-72">
            <Icon name="search" size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-aico-muted" />
            <input className="input rounded-full pl-9" placeholder="Search plugins" value={q} onChange={e => setQ(e.target.value)} />
          </div>
          <button className="btn-primary" onClick={() => setCreating(true)}>New</button>
        </div>
        <p className="mt-2 max-w-2xl text-[13.5px] text-aico-secondary">
          Every part of AICO is a plugin you can switch off. Add your own — pages, commands, themes, prompts, widgets — or ask the agent:
          <button className="ml-1 text-aico-accent hover:underline" onClick={() => newChat({ prompt: 'Make me an AICO Desktop plugin that ' })}>“make me a plugin that…”</button>
        </p>
        <div className="mt-6 flex items-center gap-2 border-b border-aico-border-subtle pb-3">
          {(['all', 'builtin', 'mine'] as const).map(t => (
            <button key={t} className={cls('rounded-full px-3.5 py-1.5 text-[13.5px]', tab === t ? 'bg-aico-hover font-medium text-aico-primary' : 'text-aico-secondary hover:text-aico-primary')} onClick={() => setTab(t)}>
              {t === 'all' ? 'All' : t === 'builtin' ? 'Built in' : 'Created by you'}
            </button>
          ))}
          <div className="flex-1" />
          <button className="btn-ghost btn-sm" onClick={() => void invoke('plugins:openFolder')}><Icon name="folder-open" size={14} />Plugins folder</button>
          <button className="btn-ghost btn-sm" onClick={() => void reload().then(() => toast.info('Plugins reloaded'))}><Icon name="refresh" size={14} />Reload</button>
        </div>
        {rows.length === 0 && (
          <div className="flex flex-col items-center py-20 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-aico-hover"><Icon name="puzzle" size={24} /></span>
            <div className="mt-3 text-[15px] font-medium">{tab === 'mine' ? 'No plugins yet' : 'Nothing matches'}</div>
            {tab === 'mine' && <button className="btn-outline mt-4" onClick={() => setCreating(true)}>Create one</button>}
          </div>
        )}
        {byCategory.map(([cat, list]) => (
          <section key={cat} className="mt-6">
            <h2 className="mb-2 text-[13px] font-medium text-aico-muted">{cat}</h2>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {list.map(r => {
                const enabled = r.m.required || !prefs.plugins.disabled.includes(r.m.id);
                const c = r.m.contributes;
                const parts = [
                  c.views?.length && `${c.views.length} page${c.views.length > 1 ? 's' : ''}`,
                  c.commands?.length && `${c.commands.length} command${c.commands.length > 1 ? 's' : ''}`,
                  c.themes?.length && `${c.themes.length} theme${c.themes.length > 1 ? 's' : ''}`,
                  c.prompts?.length && `${c.prompts.length} prompt${c.prompts.length > 1 ? 's' : ''}`,
                  c.widgets?.length && `${c.widgets.length} widget${c.widgets.length > 1 ? 's' : ''}`,
                  c.instructions?.length && 'agent instructions',
                ].filter(Boolean);
                return (
                  <div key={r.m.id} className={cls('card flex gap-3 p-4', !enabled && 'opacity-70')}>
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-aico-hover">
                      <Icon name={r.m.icon ?? 'puzzle'} size={19} className={enabled ? 'text-aico-accent' : 'text-aico-muted'} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[14px] font-medium">{r.m.name}</span>
                        {r.source === 'builtin' ? <span className="badge bg-aico-hover text-aico-muted">built in</span> : <span className="badge bg-aico-accent-soft text-aico-accent">yours</span>}
                        {r.hasScript && <span className="badge bg-aico-warning/15 text-aico-warning" title="Runs its own script in a sandbox">script</span>}
                      </div>
                      <div className="mt-0.5 line-clamp-2 text-[12.5px] text-aico-muted">{r.error ? <span className="text-aico-danger">{r.error}</span> : r.m.description}</div>
                      {parts.length > 0 && <div className="mt-1.5 text-[11.5px] text-aico-muted">{parts.join(' · ')}</div>}
                      {r.source === 'user' && (
                        <div className="mt-2 flex gap-1.5">
                          <button className="btn-ghost btn-sm px-2" onClick={() => newChat({ prompt: `Change my AICO plugin "${r.m.id}" so that ` })}><Icon name="sparkles" size={13} />Change with AI</button>
                          <button className="btn-ghost btn-sm px-2" onClick={() => r.dir && void invoke('shell:openPath', r.dir)}><Icon name="folder" size={13} />Files</button>
                          <button className="btn-ghost btn-sm px-2 text-aico-danger" onClick={() => void invoke('dialog:confirm', { title: 'Remove plugin', message: `Remove “${r.m.name}”?`, detail: 'Its folder is deleted.', ok: 'Remove', danger: true })
                            .then(ok => ok && invoke('plugins:remove', r.m.id).then(() => reload()))}><Icon name="trash" size={13} />Remove</button>
                        </div>
                      )}
                    </div>
                    {!r.m.required ? <Switch checked={enabled} onChange={v => setEnabled(r.m.id, v)} label={`Enable ${r.m.name}`} disabled={Boolean(r.error)} />
                      : <span className="text-[11.5px] text-aico-muted">Always on</span>}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
      <Modal open={creating} onClose={() => setCreating(false)} title="New plugin" width={620}>
        <div className="grid grid-cols-2 gap-3 px-5 pb-5 pt-2">
          <button className="card col-span-2 flex items-center gap-3 p-4 text-left hover:bg-aico-hover" onClick={() => { setCreating(false); newChat({ prompt: 'Make me an AICO Desktop plugin that ' }); }}>
            <Icon name="sparkles" size={20} className="text-aico-accent" />
            <span><span className="block text-[14px] font-medium">Describe it to the agent</span><span className="text-[12.5px] text-aico-muted">It knows the plugin format and installs it for you.</span></span>
          </button>
          {TEMPLATES.map(t => (
            <button key={t.id} className="card flex flex-col items-start gap-1 p-4 text-left hover:bg-aico-hover" onClick={() => void install(t)}>
              <Icon name={t.manifest.icon ?? 'puzzle'} size={18} className="text-aico-secondary" />
              <span className="text-[14px] font-medium">{t.title}</span>
              <span className="text-[12.5px] text-aico-muted">{t.description}</span>
            </button>
          ))}
        </div>
      </Modal>
    </div>
  );
}
