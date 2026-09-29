/**
 * Skills and agents — made, brought in, sent out.
 *
 * **Skills** follow Claude's format, which is the one people actually have: a
 * folder whose `SKILL.md` carries `name` and `description` in frontmatter, with
 * the scripts, references and templates it mentions beside it. They come in as
 * a `.skill`/`.zip` archive, a bare `SKILL.md`, or a folder (the engine's
 * importer reads all three and runs nothing), and go out as a `.skill` archive
 * of that folder — so a skill exported here installs in Claude, and back.
 *
 * **Agents** are specialists the orchestrator hands work to: a description it
 * selects on, a role, goals, the tools it may use and the skills it reaches for.
 * An agent's own knowledge and scripts ride in a companion skill made with it —
 * reference files under `references/`, scripts under `scripts/` — because that
 * is what a skill is, and the engine already knows how to load, list and share
 * one. A second mechanism for "files an agent should know" would be one more
 * thing to keep in step.
 *
 * Both can also be made by the agent itself, from a conversation: a proper
 * skill or agent is a piece of work, and a brief suits it better than a form.
 *
 * @module desktop/renderer/settings/sections/SkillsAgents
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type SkillSummary, type AgentSpec } from '@web/api';
import { PANES } from '@web/settings-schema';
import { useStore } from '@web/store';
import { toast, useDesk } from '@/state/desk';
import { desktop, invoke, isDesktop } from '@/desktop';
import { Icon } from '@/lib/icons';
import { cls } from '@/lib/util';
import { MenuButton, MenuItem, MenuSep } from '@/shell/Popover';
import { ModelCombobox } from '@/shell/ModelCombobox';
import { newChat } from '@/chat/actions';
import { EnginePane, Row, Switch } from '../fields';

/** Start a chat that asks the agent to build something, and close settings so it is visible. */
function askAgent(prompt: string): void {
  useDesk.getState().closeSettings();
  newChat({ prompt, send: true });
}

function slugName(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Files under a folder, relative, for an upload — hidden and build folders are skipped by the main process. */
async function folderFiles(dir: string): Promise<Array<{ abs: string; rel: string }>> {
  const all = await invoke<string[]>('fs:find', dir, '', 2000);
  const root = dir.replace(/[\\/]+$/, '');
  return all.map(abs => ({ abs, rel: abs.slice(root.length + 1).replace(/\\/g, '/') }));
}

async function toUpload(files: Array<{ abs: string; rel: string }>): Promise<Array<{ path: string; base64: string }>> {
  const out: Array<{ path: string; base64: string }> = [];
  for (const f of files) out.push({ path: f.rel, base64: await desktop.dialog.readFileBase64(f.abs) });
  return out;
}

// ── Skills ─────────────────────────────────────────────────────────────

/** A skill's own folder — null for a single-file skill, which has none to archive. */
function skillDir(s: SkillSummary): string | null {
  if (!/\.md$/i.test(s.path)) return s.path;
  return /[\\/]SKILL\.md$/i.test(s.path) ? s.path.replace(/[\\/]SKILL\.md$/i, '') : null;
}
function skillFile(s: SkillSummary): string {
  return /\.md$/i.test(s.path) ? s.path : `${s.path}/SKILL.md`;
}

export function SkillsSection(): React.ReactElement {
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setSkills((await api.skills()).skills); }
    catch (e) { toast.error('Could not load skills', (e as Error).message); setSkills([]); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const toggle = async (s: SkillSummary): Promise<void> => {
    try { await api.manage('skills', { action: s.enabled ? 'disable' : 'enable', name: s.name }); await load(); }
    catch (e) { toast.error('Could not change the skill', (e as Error).message); }
  };

  /** Runs an import, and asks before replacing a skill that already exists. */
  const install = async (label: string, run: (overwrite: boolean) => Promise<{ ok: boolean; name?: string; error?: string; resources?: string[]; replaced?: boolean }>): Promise<void> => {
    setBusy(label);
    try {
      let r = await run(false);
      if (!r.ok && /exist/i.test(r.error ?? '')) {
        const ok = await desktop.dialog.confirm({ title: 'Replace skill', message: r.error ?? 'A skill with this name exists.', detail: 'Replace it with the one being imported?', ok: 'Replace' });
        if (!ok) return;
        r = await run(true);
      }
      if (!r.ok) { toast.error('Import failed', r.error); return; }
      toast.success(`Skill “${r.name}” ${r.replaced ? 'replaced' : 'installed'}`, r.resources?.length ? `${r.resources.length} file${r.resources.length === 1 ? '' : 's'} came with it. Nothing was run.` : undefined);
      await load();
    } catch (e) { toast.error('Import failed', (e as Error).message); }
    finally { setBusy(null); }
  };

  const importArchiveOrMd = async (): Promise<void> => {
    const picked = await desktop.dialog.pickFiles({ title: 'Import a skill', filters: [{ name: 'Skill', extensions: ['skill', 'zip', 'md'] }] });
    for (const p of picked) await install(p.name, overwrite => api.importSkill(p.path, overwrite));
  };
  const importFolder = async (): Promise<void> => {
    const dir = await desktop.dialog.pickFolder('Import a skill folder (the one with SKILL.md)');
    if (dir) await install(dir, overwrite => api.importSkill(dir, overwrite));
  };

  const exportSkill = async (s: SkillSummary): Promise<void> => {
    const dir = skillDir(s);
    if (!dir) { toast.info('A single-file skill has no folder to archive', skillFile(s)); return; }
    const dest = await desktop.dialog.saveFile({ defaultName: `${s.name}.skill`, content: '', filters: [{ name: 'Skill archive', extensions: ['skill', 'zip'] }] });
    if (!dest) return;
    try {
      await invoke('fs:zipDir', dir, dest, s.name);
      toast.success(`Exported “${s.name}”`, dest);
    } catch (e) { toast.error('Export failed', (e as Error).message); }
  };
  const exportAll = async (): Promise<void> => {
    const mine = (skills ?? []).filter(s => !s.builtin);
    if (!mine.length) { toast.info('No skills of your own to export', 'Built-in skills come with every install.'); return; }
    const folder = await desktop.dialog.pickFolder('Export your skills to…');
    if (!folder) return;
    let n = 0;
    for (const s of mine) {
      const dir = skillDir(s);
      if (!dir) continue;
      try { await invoke('fs:zipDir', dir, `${folder}/${s.name}.skill`, s.name); n++; }
      catch (e) { toast.error(`Could not export ${s.name}`, (e as Error).message); }
    }
    toast.success(`Exported ${n} skill${n === 1 ? '' : 's'}`, folder);
  };

  const remove = async (s: SkillSummary): Promise<void> => {
    const ok = await desktop.dialog.confirm({ title: 'Remove skill', message: `Remove “${s.name}”?`, detail: 'Its folder and bundled files are deleted.', ok: 'Remove', danger: true });
    if (!ok) return;
    const r = await api.removeSkill(s.name);
    if (!r.ok) toast.error('Not removed', r.error); else { toast.success('Skill removed'); await load(); }
  };

  const shown = (skills ?? []).filter(s => !q || s.name.toLowerCase().includes(q.toLowerCase()) || s.description.toLowerCase().includes(q.toLowerCase()));
  const mine = shown.filter(s => !s.builtin);
  const builtin = shown.filter(s => s.builtin);
  const pane = PANES.find(p => p.id === 'skills');

  const row = (s: SkillSummary): React.ReactElement => (
    <Row key={s.name}
      title={<span className="flex items-center gap-2">{s.name}{s.builtin && <span className="badge bg-aico-hover text-aico-muted">built in</span>}{s.resources.length > 0 && <span className="badge bg-aico-hover text-aico-muted" title={s.resources.join('\n')}>{s.resources.length} file{s.resources.length === 1 ? '' : 's'}</span>}</span>}
      desc={<span className="line-clamp-2">{s.description}</span>}>
      <div className="flex items-center gap-1">
        <MenuButton className="icon-btn-sm" title="More" placement="bottom-end" width={220} button={<Icon name="more" size={15} />}>
          {close => (
            <>
              <MenuItem icon="file-text" label="Open SKILL.md" onClick={() => { close(); useDesk.getState().closeSettings(); useDesk.getState().navigate({ view: 'files', params: { root: skillDir(s) ?? s.path.replace(/[\\/][^\\/]+$/, ''), open: skillFile(s) } }); }} />
              <MenuItem icon="folder" label="Show in folder" onClick={() => { close(); void desktop.shell.showItemInFolder(s.path); }} />
              <MenuItem icon="download" label="Export as .skill…" onClick={() => { close(); void exportSkill(s); }} />
              <MenuItem icon="sparkles" label="Improve with the agent" onClick={() => { close(); askAgent(`Review and improve my skill "${s.name}" (SkillManage read it first). Tighten its description so it is selected at the right time, fix unclear steps, and keep its bundled files working. Show me what you changed.`); }} />
              {!s.builtin && <><MenuSep /><MenuItem icon="trash" danger label="Remove…" onClick={() => { close(); void remove(s); }} /></>}
            </>
          )}
        </MenuButton>
        <Switch checked={s.enabled} onChange={() => void toggle(s)} label={`Enable ${s.name}`} />
      </div>
    </Row>
  );

  return (
    <div>
      <p className="-mt-2 mb-4 text-[13px] text-aico-muted">Procedures the agent reaches for when a task matches their description. Claude-compatible: a folder with <code>SKILL.md</code> and whatever scripts, references and templates it uses.</p>
      <div className="flex flex-wrap items-center gap-2">
        <input className="input min-w-[200px] flex-1" placeholder={`Search ${skills?.length ?? ''} skills`} value={q} onChange={e => setQ(e.target.value)} />
        <MenuButton className="btn-outline btn-sm" title="Import a skill" placement="bottom-end" width={290}
          button={<>{busy ? <span className="spinner h-3 w-3" /> : <Icon name="upload" size={13} />}Import</>}>
          {close => (
            <>
              <MenuItem icon="file" label="From a .skill, .zip or SKILL.md…" onClick={() => { close(); void importArchiveOrMd(); }} />
              <MenuItem icon="folder" label="From a folder…" hint="with SKILL.md" onClick={() => { close(); void importFolder(); }} />
            </>
          )}
        </MenuButton>
        <button className="btn-outline btn-sm" onClick={() => void exportAll()} disabled={!isDesktop}><Icon name="download" size={13} />Export mine</button>
        <MenuButton className="btn-primary btn-sm" title="Create a skill" placement="bottom-end" width={290}
          button={<><Icon name="plus" size={13} />New skill</>}>
          {close => (
            <>
              <MenuItem icon="sparkles" label="Create with the agent" hint="recommended" onClick={() => {
                close();
                askAgent('Help me create a new skill. First ask what procedure it should capture and when it should be used. Then write it in Claude\'s skill format with SkillManage: a precise `description` (what it does and when to use it), clear numbered steps in SKILL.md, and any scripts, reference files or templates it needs in the skill folder beside it. Keep SKILL.md focused and move long detail into reference files. Test any script you add, then show me the result.');
              }} />
              <MenuItem icon="edit" label="Write it myself" onClick={() => { close(); setCreating(true); }} />
            </>
          )}
        </MenuButton>
      </div>

      {creating && <SkillEditor onDone={async (saved) => { setCreating(false); if (saved) await load(); }} />}

      {mine.length > 0 && <h3 className="set-heading">Yours</h3>}
      {mine.length > 0 && <div className="set-group">{mine.map(row)}</div>}
      <h3 className="set-heading">Built in</h3>
      <div className="set-group">
        {skills === null && <div className="p-4"><div className="skeleton h-10" /></div>}
        {builtin.map(row)}
      </div>
      {pane && <div className="mt-6"><EnginePane pane={pane} /></div>}
    </div>
  );
}

function SkillEditor({ onDone }: { onDone: (saved: boolean) => void | Promise<void> }): React.ReactElement {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('## Steps\n\n1. \n');
  const [files, setFiles] = useState<Array<{ abs: string; rel: string }>>([]);
  const [saving, setSaving] = useState(false);

  const addFiles = async (kind: 'scripts' | 'references' | 'templates'): Promise<void> => {
    const picked = await desktop.dialog.pickFiles({ title: `Add ${kind}` });
    setFiles(f => [...f, ...picked.map(p => ({ abs: p.path, rel: `${kind}/${p.name}` }))]);
  };

  const save = async (): Promise<void> => {
    const n = slugName(name);
    if (!n || !description.trim()) { toast.warning('A name and a description are both needed', 'The description is what the agent selects the skill on.'); return; }
    setSaving(true);
    try {
      const md = `---\nname: ${n}\ndescription: ${description.trim().replace(/\n+/g, ' ')}\n---\n\n${body.trim()}\n`;
      const r = await api.uploadSkill({ files: [{ path: 'SKILL.md', base64: btoa(unescape(encodeURIComponent(md))) }, ...await toUpload(files)] });
      if (!r.ok) { toast.error('Not saved', r.error); return; }
      toast.success(`Skill “${r.name}” created`);
      await onDone(true);
    } catch (e) { toast.error('Not saved', (e as Error).message); }
    finally { setSaving(false); }
  };

  return (
    <div className="mt-4 space-y-3 rounded-xl border border-aico-border-subtle p-4">
      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1"><span className="label">Name</span>
          <input className="input font-mono" value={name} onChange={e => setName(e.target.value)} placeholder="release-notes" autoFocus />
        </label>
        <label className="space-y-1"><span className="label">When to use it</span>
          <input className="input" value={description} onChange={e => setDescription(e.target.value)} placeholder="Drafts release notes from commits since the last tag" />
        </label>
      </div>
      <label className="block space-y-1"><span className="label">Instructions (SKILL.md, Markdown)</span>
        <textarea className="input min-h-[160px] font-mono text-[12.5px]" value={body} onChange={e => setBody(e.target.value)} spellCheck={false} />
      </label>
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="label">Bundled files</span>
          <button className="btn-ghost btn-sm" onClick={() => void addFiles('scripts')}><Icon name="terminal" size={13} />Scripts</button>
          <button className="btn-ghost btn-sm" onClick={() => void addFiles('references')}><Icon name="book" size={13} />References</button>
          <button className="btn-ghost btn-sm" onClick={() => void addFiles('templates')}><Icon name="file" size={13} />Templates</button>
        </div>
        {files.length > 0 && (
          <ul className="mt-2 space-y-1 text-[12.5px]">
            {files.map((f, i) => (
              <li key={`${f.rel}${i}`} className="flex items-center gap-2 font-mono text-aico-secondary">
                <span className="truncate">{f.rel}</span>
                <button className="icon-btn-sm h-5 w-5" onClick={() => setFiles(x => x.filter((_, j) => j !== i))} aria-label={`Remove ${f.rel}`}><Icon name="x" size={11} /></button>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1 text-[12px] text-aico-muted">Mention them in the instructions by path (e.g. <code>scripts/check.py</code>). Nothing is run when the skill is saved.</p>
      </div>
      <div className="flex justify-end gap-2">
        <button className="btn-outline" onClick={() => void onDone(false)}>Cancel</button>
        <button className="btn-primary" onClick={() => void save()} disabled={saving}>{saving && <span className="spinner h-3 w-3" />}Create skill</button>
      </div>
    </div>
  );
}

// ── Agents ─────────────────────────────────────────────────────────────

/** The built-in tools an agent can be limited to. Anything else can be typed (MCP tools by name). */
const TOOL_CHOICES: Array<[string, string]> = [
  ['Read', 'read files'], ['Grep', 'search contents'], ['Glob', 'find files'], ['LS', 'list folders'],
  ['Write', 'create files'], ['Edit', 'change files'], ['Bash', 'run commands'], ['WebFetch', 'read web pages'],
  ['WebSearch', 'search the web'], ['Task', 'sub-tasks'], ['WorkspaceWrite', 'scratch files'], ['Git', 'version control'],
  ['RunChecks', 'tests and builds'], ['MCP', 'every MCP tool'],
];

interface AgentDraft {
  name: string; description: string; role: string; goals: string; model: string;
  skills: string[]; tools: string[]; canDelegate: boolean;
  knowledge: Array<{ abs: string; rel: string }>;
}

const EMPTY_AGENT: AgentDraft = { name: '', description: '', role: '', goals: '', model: '', skills: [], tools: ['Read', 'Grep', 'Glob', 'LS'], canDelegate: false, knowledge: [] };

export function AgentsSection(): React.ReactElement {
  const [agents, setAgents] = useState<AgentSpec[] | null>(null);
  const [editing, setEditing] = useState<{ draft: AgentDraft; existing: boolean } | null>(null);
  const load = useCallback(async () => { try { setAgents((await api.agents()).agents); } catch { setAgents([]); } }, []);
  useEffect(() => { void load(); }, [load]);
  const pane = PANES.find(p => p.id === 'agents');

  const act = async (input: Record<string, unknown>, success?: string): Promise<boolean> => {
    try {
      const r = await api.manage('agents', input) as { ok?: boolean; result?: string; error?: string };
      const text = r.result ?? r.error ?? '';
      if (r.ok === false || /^(Not |There is no|A name is required|A description is required|An agent called)/.test(text)) { toast.error('Not done', text || r.error); return false; }
      if (success) toast.success(success, text.split('\n')[0]);
      await load();
      return true;
    } catch (e) { toast.error('Not done', (e as Error).message); return false; }
  };

  const importAgents = async (): Promise<void> => {
    const picked = await desktop.dialog.pickFiles({ title: 'Import agents', filters: [{ name: 'Agents JSON', extensions: ['json'] }] });
    if (picked[0]) await act({ action: 'import', path: picked[0].path }, 'Agents imported');
  };
  const exportAgents = async (): Promise<void> => {
    const dest = await desktop.dialog.saveFile({ defaultName: 'aico-agents.json', content: '{}', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (dest) await act({ action: 'export', path: dest }, 'Agents exported');
  };

  const edit = (a: AgentSpec): void => setEditing({ existing: true, draft: {
    name: a.name, description: a.description, role: a.role ?? '', goals: (a.goals ?? []).join('\n'), model: a.model ?? '',
    skills: a.skills ?? [], tools: a.tools ?? [], canDelegate: a.canDelegate, knowledge: [],
  } });

  const mine = (agents ?? []).filter(a => a.source !== 'builtin');
  const builtin = (agents ?? []).filter(a => a.source === 'builtin');
  const row = (a: AgentSpec): React.ReactElement => (
    <Row key={a.name}
      title={<span className="flex items-center gap-2">@{a.name}<span className="badge bg-aico-hover text-aico-muted">{a.source}</span>{a.model && <span className="badge bg-aico-hover font-mono text-aico-muted">{a.model}</span>}</span>}
      desc={<span className="line-clamp-2">{a.description}{a.skills?.length ? <span className="text-aico-muted"> · skills: {a.skills.join(', ')}</span> : null}</span>}>
      <div className="flex items-center gap-1">
        <MenuButton className="icon-btn-sm" title="More" placement="bottom-end" width={220} button={<Icon name="more" size={15} />}>
          {close => (
            <>
              <MenuItem icon="chat" label="Talk to it" onClick={() => { close(); useDesk.getState().closeSettings(); newChat(); void useStore.getState().setSessionAgent(a.name); toast.success(`Talking to @${a.name}`); }} />
              {a.source !== 'builtin' && <MenuItem icon="edit" label="Edit" onClick={() => { close(); edit(a); }} />}
              <MenuItem icon="copy" label="Duplicate as mine" onClick={() => { close(); edit(a); setEditing(e => e && { existing: false, draft: { ...e.draft, name: `${a.name}-copy` } }); }} />
              {a.source !== 'builtin' && <><MenuSep /><MenuItem icon="trash" danger label="Delete…" onClick={async () => {
                close();
                if (await desktop.dialog.confirm({ title: 'Delete agent', message: `Delete @${a.name}?`, ok: 'Delete', danger: true })) await act({ action: 'delete', name: a.name }, 'Agent deleted');
              }} /></>}
            </>
          )}
        </MenuButton>
        <Switch checked={a.enabled} onChange={v => void act({ action: v ? 'enable' : 'disable', name: a.name })} label={`Enable ${a.name}`} />
      </div>
    </Row>
  );

  return (
    <div>
      <p className="-mt-2 mb-4 text-[13px] text-aico-muted">Specialists the orchestrator hands work to — each with its own instructions, tools, skills, model and knowledge. Talk to one directly with <code>@name</code> in the composer.</p>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex-1" />
        <button className="btn-outline btn-sm" onClick={() => void importAgents()}><Icon name="upload" size={13} />Import</button>
        <button className="btn-outline btn-sm" onClick={() => void exportAgents()}><Icon name="download" size={13} />Export</button>
        <MenuButton className="btn-primary btn-sm" title="Create an agent" placement="bottom-end" width={290} button={<><Icon name="plus" size={13} />New agent</>}>
          {close => (
            <>
              <MenuItem icon="sparkles" label="Create with the agent" hint="recommended" onClick={() => {
                close();
                askAgent('Create a new agent for me. First ask what kind of work it should take on. Then use AgentManage to define it: a description precise enough that you would know when to hand it a task, its role and goals, only the tools it needs, and the skills it should reach for. If it needs its own knowledge (reference documents) or scripts, create a skill for them with SkillManage first — references/ and scripts/ beside SKILL.md — and give the agent that skill. Show me the result and how to talk to it.');
              }} />
              <MenuItem icon="edit" label="Define it myself" onClick={() => { close(); setEditing({ existing: false, draft: { ...EMPTY_AGENT } }); }} />
            </>
          )}
        </MenuButton>
      </div>

      {editing && <AgentEditor initial={editing.draft} existing={editing.existing} onDone={async (saved) => { setEditing(null); if (saved) await load(); }} act={act} />}

      {mine.length > 0 && <><h3 className="set-heading">Yours</h3><div className="set-group">{mine.map(row)}</div></>}
      <h3 className="set-heading">Built in</h3>
      <div className="set-group">
        {agents === null && <div className="p-4"><div className="skeleton h-10" /></div>}
        {builtin.map(row)}
      </div>
      {pane && <div className="mt-6"><EnginePane pane={pane} /></div>}
    </div>
  );
}

function AgentEditor({ initial, existing, onDone, act }: {
  initial: AgentDraft; existing: boolean;
  onDone: (saved: boolean) => void | Promise<void>;
  act: (input: Record<string, unknown>, success?: string) => Promise<boolean>;
}): React.ReactElement {
  const [d, setD] = useState<AgentDraft>(initial);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [toolText, setToolText] = useState('');
  const [saving, setSaving] = useState(false);
  const system = useStore(s => s.system);
  useEffect(() => { void api.skills().then(r => setSkills(r.skills)).catch(() => {}); }, []);
  const set = (patch: Partial<AgentDraft>): void => setD(x => ({ ...x, ...patch }));
  const toggleIn = (list: string[], v: string): string[] => (list.includes(v) ? list.filter(x => x !== v) : [...list, v]);
  const mcpNames = useMemo(() => (system?.mcpServers ?? []).filter(s => s.enabled).map(s => s.name), [system]);

  const addKnowledge = async (kind: 'files' | 'folder' | 'scripts'): Promise<void> => {
    if (kind === 'folder') {
      const dir = await desktop.dialog.pickFolder('Add a folder of knowledge');
      if (!dir) return;
      const base = dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? 'docs';
      const files = await folderFiles(dir);
      set({ knowledge: [...d.knowledge, ...files.map(f => ({ abs: f.abs, rel: `references/${base}/${f.rel}` }))] });
      return;
    }
    const picked = await desktop.dialog.pickFiles({ title: kind === 'scripts' ? 'Add scripts' : 'Add knowledge files' });
    set({ knowledge: [...d.knowledge, ...picked.map(p => ({ abs: p.path, rel: `${kind === 'scripts' ? 'scripts' : 'references'}/${p.name}` }))] });
  };

  const save = async (): Promise<void> => {
    const name = slugName(d.name);
    if (!name || !d.description.trim()) { toast.warning('A name and a description are both needed', 'The description decides when the orchestrator hands this agent a task.'); return; }
    setSaving(true);
    try {
      let skillsFor = d.skills;
      // The agent's own knowledge and scripts become its companion skill.
      if (d.knowledge.length > 0) {
        const kit = `${name}-kit`;
        const refs = d.knowledge.filter(k => k.rel.startsWith('references/')).map(k => `- \`${k.rel}\``);
        const scripts = d.knowledge.filter(k => k.rel.startsWith('scripts/')).map(k => `- \`${k.rel}\``);
        const md = [
          '---', `name: ${kit}`, `description: Knowledge and scripts for the ${name} agent — read the references before answering questions in its area, and use the scripts instead of rewriting them.`, '---', '',
          `# ${name} kit`, '',
          ...(refs.length ? ['## Reference knowledge', '', 'Read the relevant file before answering; cite it by path.', '', ...refs, ''] : []),
          ...(scripts.length ? ['## Scripts', '', 'Run these rather than reimplementing them. Read a script before running it the first time.', '', ...scripts, ''] : []),
        ].join('\n');
        const r = await api.uploadSkill({ overwrite: true, files: [{ path: 'SKILL.md', base64: btoa(unescape(encodeURIComponent(md))) }, ...await toUpload(d.knowledge)] });
        if (!r.ok) { toast.error('Knowledge not saved', r.error); return; }
        skillsFor = [...new Set([...skillsFor, r.name ?? kit])];
      }
      const ok = await act({
        action: existing ? 'update' : 'create', name,
        description: d.description.trim(), role: d.role.trim() || undefined,
        goals: d.goals.split('\n').map(g => g.trim()).filter(Boolean),
        skills: skillsFor, tools: d.tools, canDelegate: d.canDelegate,
        ...(d.model.trim() ? { model: d.model.trim() } : {}),
      }, existing ? `Agent @${name} updated` : `Agent @${name} created`);
      if (ok) await onDone(true);
    } finally { setSaving(false); }
  };

  return (
    <div className="mt-4 space-y-3 rounded-xl border border-aico-border-subtle p-4">
      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1"><span className="label">Name</span>
          <input className="input font-mono" value={d.name} onChange={e => set({ name: e.target.value })} placeholder="security-reviewer" disabled={existing} autoFocus={!existing} />
        </label>
        <label className="space-y-1"><span className="label">Model <span className="text-aico-muted">(optional)</span></span>
          <ModelCombobox value={d.model} onChange={v => set({ model: v })} placeholder="same as the chat"
            load={async () => { const r = await api.providerModels(); return { models: r.models.map(id => ({ id, ...(r.capabilities?.[id] ?? {}) })), error: r.error }; }} />
        </label>
      </div>
      <label className="block space-y-1"><span className="label">When to hand it work</span>
        <input className="input" value={d.description} onChange={e => set({ description: e.target.value })} placeholder="Reviews changes for security problems: injection, secrets, auth, unsafe dependencies" />
      </label>
      <label className="block space-y-1"><span className="label">Instructions and role</span>
        <textarea className="input min-h-[90px] text-[13px]" value={d.role} onChange={e => set({ role: e.target.value })} placeholder="You are a meticulous application-security reviewer. Report findings with file:line, severity and a fix." />
      </label>
      <label className="block space-y-1"><span className="label">Goals <span className="text-aico-muted">(one per line)</span></span>
        <textarea className="input min-h-[60px] text-[13px]" value={d.goals} onChange={e => set({ goals: e.target.value })} />
      </label>

      <div className="space-y-1">
        <span className="label">Tools it may use</span>
        <div className="flex flex-wrap gap-1.5">
          {TOOL_CHOICES.map(([t, hint]) => (
            <button key={t} type="button" title={hint} onClick={() => set({ tools: toggleIn(d.tools, t) })}
              className={cls('chip', d.tools.includes(t) && 'border-aico-accent/50 bg-aico-accent-soft text-aico-accent')}>{d.tools.includes(t) && <Icon name="check" size={11} />}{t}</button>
          ))}
          {mcpNames.map(m => (
            <button key={m} type="button" title={`Tools from the ${m} MCP server`} onClick={() => set({ tools: toggleIn(d.tools, `mcp:${m}`) })}
              className={cls('chip', d.tools.includes(`mcp:${m}`) && 'border-aico-accent/50 bg-aico-accent-soft text-aico-accent')}><Icon name="plug" size={11} />{m}</button>
          ))}
          {d.tools.filter(t => !TOOL_CHOICES.some(([c]) => c === t) && !t.startsWith('mcp:')).map(t => (
            <button key={t} type="button" className="chip border-aico-accent/50 bg-aico-accent-soft text-aico-accent" onClick={() => set({ tools: toggleIn(d.tools, t) })}>{t}<Icon name="x" size={10} /></button>
          ))}
          <input className="input h-7 w-40 py-0 text-[12px]" placeholder="+ tool name" value={toolText} onChange={e => setToolText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && toolText.trim()) { e.preventDefault(); set({ tools: [...new Set([...d.tools, toolText.trim()])] }); setToolText(''); } }} />
        </div>
      </div>

      <div className="space-y-1">
        <span className="label">Skills it reaches for</span>
        <div className="flex max-h-[120px] flex-wrap gap-1.5 overflow-y-auto thin-scroll">
          {skills.filter(s => s.enabled).map(s => (
            <button key={s.name} type="button" title={s.description} onClick={() => set({ skills: toggleIn(d.skills, s.name) })}
              className={cls('chip', d.skills.includes(s.name) && 'border-aico-accent/50 bg-aico-accent-soft text-aico-accent')}>{d.skills.includes(s.name) && <Icon name="check" size={11} />}{s.name}</button>
          ))}
        </div>
      </div>

      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="label">Its own knowledge and scripts</span>
          <button className="btn-ghost btn-sm" onClick={() => void addKnowledge('files')}><Icon name="book" size={13} />Files</button>
          <button className="btn-ghost btn-sm" onClick={() => void addKnowledge('folder')}><Icon name="folder" size={13} />Folder</button>
          <button className="btn-ghost btn-sm" onClick={() => void addKnowledge('scripts')}><Icon name="terminal" size={13} />Scripts</button>
        </div>
        {d.knowledge.length > 0 && (
          <ul className="max-h-[120px] space-y-0.5 overflow-y-auto thin-scroll text-[12px]">
            {d.knowledge.map((k, i) => (
              <li key={`${k.rel}${i}`} className="flex items-center gap-2 font-mono text-aico-secondary">
                <span className="truncate">{k.rel}</span>
                <button className="icon-btn-sm h-5 w-5" onClick={() => set({ knowledge: d.knowledge.filter((_, j) => j !== i) })} aria-label={`Remove ${k.rel}`}><Icon name="x" size={11} /></button>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[12px] text-aico-muted">Saved as the skill <code>{slugName(d.name) || 'name'}-kit</code> (references/ and scripts/ beside a SKILL.md) and given to this agent. Nothing is run when it is saved.</p>
      </div>

      <label className="flex items-center gap-2 text-[13px]">
        <Switch checked={d.canDelegate} onChange={v => set({ canDelegate: v })} label="Can delegate" />
        May hand parts of its work to other agents
      </label>

      <div className="flex justify-end gap-2">
        <button className="btn-outline" onClick={() => void onDone(false)}>Cancel</button>
        <button className="btn-primary" onClick={() => void save()} disabled={saving}>{saving && <span className="spinner h-3 w-3" />}{existing ? 'Save agent' : 'Create agent'}</button>
      </div>
    </div>
  );
}
