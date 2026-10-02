/**
 * Skills and agents — made, brought in, sent out.
 *
 * **Skills** follow Claude's format, which is the one people actually have: a
 * folder whose `SKILL.md` carries `name` and `description` in frontmatter, with
 * the scripts, references and templates it mentions beside it. They come in as
 * a `.skill`/`.zip` archive, a bare `SKILL.md`, a folder, a pack (a folder of
 * skills) or a Claude plugin folder, and go out as Claude's `.skill` archive
 * (the engine packs and validates it) — so a skill exported here installs in
 * Claude, and back.
 *
 * **Every import is reviewed first** (design §5.1, §7.2): the engine stages it,
 * scans every file and validates it to the spec, and the review screen
 * (web/src/components/settings/SkillReview, shared with the web client) shows
 * files, scripts, findings and provenance. "Install and enable" is the
 * person's yes — main attaches a one-time grant to that request
 * (protocol.ts HUMAN_ROUTES), so the engine can tell it from the API token.
 * Anything else installs unreviewed: on disk, out of the catalogue, marked
 * "needs review" here.
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
import { api, type SkillSummary, type AgentSpec, type ImportReview, type ReviewedSkill, type SkillProvenance } from '@web/api';
import { InstalledSkillReview, SkillImportReview } from '@web/components/settings/SkillReview';
import { sourceLabel, trustLabel } from '@web/skill-review';
import { Modal } from '@/shell/Modal';
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
import { AgentBuilder } from '@web/components/settings/AgentBuilder';
import { AgentVerify, CertBadge } from '@web/components/settings/AgentVerify';
import { EMPTY_DRAFT, draftOf, duplicateDraft, type AgentDraft } from '@web/agent-builder';

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

/** One line saying where an imported skill came from and what its scan found. */
function provenanceLine(s: SkillSummary): string | null {
  const p = s.provenance;
  if (!p) return null;
  const from = p.source.split(/[\\/]/).slice(-2).join('/');
  const f = p.findings;
  const scan = !f ? '' : f.high ? ` · ${f.high} high scan finding${f.high === 1 ? '' : 's'}` : f.warn ? ` · ${f.warn} scan finding${f.warn === 1 ? '' : 's'} to check` : ' · scan: nothing flagged';
  return `${sourceLabel(p.sourceKind)} from ${from}${scan} · sha256 ${p.sha256.slice(0, 12)}…`;
}

export function SkillsSection(): React.ReactElement {
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  /** The import on the review screen; nothing is installed while it is open. */
  const [review, setReview] = useState<ImportReview | null>(null);
  /** An installed skill on the review screen (to enable it, or to look). */
  const [installed, setInstalled] = useState<{ skill: ReviewedSkill & { provenance?: SkillProvenance }; trust: string; trustReason?: string } | null>(null);
  const load = useCallback(async () => {
    try { setSkills((await api.skills()).skills); }
    catch (e) { toast.error('Could not load skills', (e as Error).message); setSkills([]); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  /** An installed skill's review screen. */
  const openReview = async (s: SkillSummary): Promise<void> => {
    try {
      const r = await api.reviewInstalledSkill(s.name);
      setInstalled({ skill: r.skill, trust: r.trust, ...(r.trustReason ? { trustReason: r.trustReason } : {}) });
    } catch (e) { toast.error('Could not review the skill', (e as Error).message); }
  };

  const toggle = async (s: SkillSummary): Promise<void> => {
    // An unreviewed import is enabled from its review screen, never by a bare switch.
    if (s.trust === 'unreviewed') { await openReview(s); return; }
    try {
      const r = await api.setSkillEnabled(s.name, !s.enabled);
      if (!r.ok) toast.error('Could not change the skill', r.result ?? r.error);
      await load();
    } catch (e) { toast.error('Could not change the skill', (e as Error).message); }
  };

  /** Stage an import in the engine and open the review screen. Nothing is installed yet. */
  const stage = async (source: string): Promise<void> => {
    setBusy(source);
    try {
      const r = await api.reviewSkillImport({ source });
      if (!r.review) { toast.error('Not imported', r.error); return; }
      setReview(r.review);
    } catch (e) { toast.error('Not imported', (e as Error).message); }
    finally { setBusy(null); }
  };

  /** The review screen's answer. `enable` is the person's "Install and enable". */
  const installReviewed = async (select: string[], enable: boolean, overwrite: boolean): Promise<void> => {
    if (!review) return;
    setBusy('install');
    try {
      const out = await api.installSkillImport({ id: review.id, select, enable, overwrite });
      const names = out.installed.map(x => x.name);
      if (names.length) {
        toast.success(
          enable ? `${names.length === 1 ? `Skill “${names[0]}”` : `${names.length} skills`} installed and enabled` : `Installed without enabling: ${names.join(', ')}`,
          enable ? `Try it: ask the agent to use ${names[0]}. Nothing was run.` : 'Review and enable it from the list when you are ready.',
        );
      }
      for (const x of out.skipped) toast.warning(`Skipped ${x.name}`, x.reason);
      if (!names.length && !out.skipped.length) toast.error('Nothing was installed', out.error);
      setReview(null);
      await load();
    } catch (e) { toast.error('Install failed', (e as Error).message); }
    finally { setBusy(null); }
  };

  const cancelReview = (): void => {
    if (review) void api.discardSkillImport(review.id).catch(() => undefined);
    setReview(null);
  };

  const importFile = async (kind: 'archive' | 'markdown'): Promise<void> => {
    const picked = await desktop.dialog.pickFiles(kind === 'archive'
      ? { title: 'Import a .skill or .zip', filters: [{ name: 'Skill archive', extensions: ['skill', 'zip'] }] }
      : { title: 'Import a SKILL.md', filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (picked[0]) await stage(picked[0].path);
  };
  const importFolder = async (kind: 'skill' | 'pack' | 'plugin'): Promise<void> => {
    const title = kind === 'skill' ? 'Import a skill folder (the one with SKILL.md)'
      : kind === 'pack' ? 'Import a pack (a folder of skill folders)'
        : 'Import a Claude plugin (the folder with .claude-plugin/)';
    const dir = await desktop.dialog.pickFolder(title);
    if (dir) await stage(dir);
  };

  /** Claude's `.skill`, packed and validated by the engine. */
  const exportSkill = async (s: SkillSummary): Promise<void> => {
    if (!skillDir(s)) { toast.info('A single-file skill has no folder to archive', skillFile(s)); return; }
    const dest = await desktop.dialog.saveFile({ defaultName: `${s.name}.skill`, content: '', filters: [{ name: 'Skill archive', extensions: ['skill', 'zip'] }] });
    if (!dest) return;
    try {
      const r = await api.exportSkill(s.name, { dest });
      if (!r.ok) { toast.error('Not exported', r.error); return; }
      toast.success(`Exported “${s.name}”`, `${r.path ?? dest}${r.warnings?.length ? ` — ${r.warnings[0]}` : ''}`);
    } catch (e) { toast.error('Not exported', (e as Error).message); }
  };
  const exportAll = async (): Promise<void> => {
    const mine = (skills ?? []).filter(s => !s.builtin);
    if (!mine.length) { toast.info('No skills of your own to export', 'Built-in skills come with every install.'); return; }
    const folder = await desktop.dialog.pickFolder('Export your skills to…');
    if (!folder) return;
    let n = 0;
    for (const s of mine) {
      if (!skillDir(s)) continue;
      try {
        const r = await api.exportSkill(s.name, { dest: `${folder}/${s.name}.skill` });
        if (r.ok) n++; else toast.error(`Could not export ${s.name}`, r.error);
      } catch (e) { toast.error(`Could not export ${s.name}`, (e as Error).message); }
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
      title={<span className="flex flex-wrap items-center gap-2">{s.name}
        {s.builtin && <span className="badge bg-aico-hover text-aico-muted">built in</span>}
        {s.trust === 'unreviewed' && <span className="badge bg-aico-warning/15 text-aico-warning" title={s.trustReason}><Icon name="alert" size={11} />{trustLabel(s.trust)}</span>}
        {s.trust === 'reviewed' && <span className="badge bg-aico-hover text-aico-muted" title={s.provenance?.reviewedAt ? `Reviewed ${new Date(s.provenance.reviewedAt).toLocaleString()}` : undefined}>{trustLabel(s.trust)}</span>}
        {(s.provenance?.findings?.high ?? 0) > 0 && <span className="badge bg-aico-danger/10 text-aico-danger">{s.provenance!.findings!.high} high finding{s.provenance!.findings!.high === 1 ? '' : 's'}</span>}
        {s.resources.length > 0 && <span className="badge bg-aico-hover text-aico-muted" title={s.resources.join('\n')}>{s.resources.length} file{s.resources.length === 1 ? '' : 's'}</span>}
        {(s.warnings?.length ?? 0) > 0 && <span className="badge bg-aico-hover text-aico-muted" title={s.warnings!.join('\n')}>{s.warnings!.length} spec warning{s.warnings!.length === 1 ? '' : 's'}</span>}
      </span>}
      desc={<span className="block"><span className="line-clamp-2">{s.description}</span>{provenanceLine(s) && <span className="mt-0.5 block truncate text-[11.5px] text-aico-muted" title={s.provenance?.source}>{provenanceLine(s)}</span>}</span>}>
      <div className="flex items-center gap-1">
        {s.trust === 'unreviewed' && <button className="btn-outline btn-sm" onClick={() => void openReview(s)}>Review and enable</button>}
        <MenuButton className="icon-btn-sm" title="More" placement="bottom-end" width={220} button={<Icon name="more" size={15} />}>
          {close => (
            <>
              {!s.builtin && skillDir(s) && <MenuItem icon="shield" label={s.trust === 'unreviewed' ? 'Review and enable…' : 'Files and scan findings…'} onClick={() => { close(); void openReview(s); }} />}
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

  const unreviewed = (skills ?? []).filter(s => s.trust === 'unreviewed').length;

  return (
    <div>
      <p className="-mt-2 mb-4 text-[13px] text-aico-muted">Procedures the agent reaches for when a task matches their description. Claude-compatible: a folder with <code>SKILL.md</code> and whatever scripts, references and templates it uses.</p>
      <div className="flex flex-wrap items-center gap-2">
        <input className="input min-w-[200px] flex-1" placeholder={`Search ${skills?.length ?? ''} skills`} value={q} onChange={e => setQ(e.target.value)} />
        <MenuButton className="btn-outline btn-sm" title="Import skills" placement="bottom-end" width={300}
          button={<>{busy ? <span className="spinner h-3 w-3" /> : <Icon name="upload" size={13} />}Import</>}>
          {close => (
            <>
              <MenuItem icon="file" label="From a .skill or .zip file…" onClick={() => { close(); void importFile('archive'); }} />
              <MenuItem icon="file-text" label="From a SKILL.md…" onClick={() => { close(); void importFile('markdown'); }} />
              <MenuItem icon="folder" label="From a skill folder…" hint="with SKILL.md" onClick={() => { close(); void importFolder('skill'); }} />
              <MenuItem icon="folder" label="From a pack…" hint="a folder of skills" onClick={() => { close(); void importFolder('pack'); }} />
              <MenuItem icon="plug" label="From a Claude plugin…" hint=".claude-plugin/" onClick={() => { close(); void importFolder('plugin'); }} />
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
                askAgent('Help me create a new skill. Open the skill-author skill and follow it: first ask what procedure it should capture and when it should be used, draft it with its evals, show me the tasks, measure it with and without the skill, and show me the results before anything is registered.');
              }} />
              <MenuItem icon="edit" label="Write it myself" onClick={() => { close(); setCreating(true); }} />
            </>
          )}
        </MenuButton>
      </div>

      {creating && <SkillEditor onDone={async (saved) => { setCreating(false); if (saved) await load(); }} />}

      {unreviewed > 0 && (
        <p className="mt-3 rounded-lg bg-aico-warning/10 px-3 py-2 text-[12.5px] text-aico-warning">
          <span className="font-semibold">{unreviewed} skill{unreviewed === 1 ? '' : 's'} need{unreviewed === 1 ? 's' : ''} review.</span> Imported skills reach the agent only after you look at their files and scan findings and enable them.
        </p>
      )}

      <Modal open={!!review} onClose={cancelReview} width={720} title="Review before installing" className="max-h-[86vh]">
        {review && (
          <div className="flex min-h-0 flex-1 flex-col px-5 pb-4 pt-1">
            <SkillImportReview review={review} busy={busy === 'install'} onInstall={(sel, en, ow) => void installReviewed(sel, en, ow)} onCancel={cancelReview} />
          </div>
        )}
      </Modal>
      <Modal open={!!installed} onClose={() => setInstalled(null)} width={720} title={installed ? `${installed.skill.name} — files and scan findings` : ''} className="max-h-[86vh]">
        {installed && (
          <div className="flex min-h-0 flex-1 flex-col px-5 pb-4 pt-1">
            <InstalledSkillReview skill={installed.skill} trust={installed.trust} {...(installed.trustReason ? { trustReason: installed.trustReason } : {})}
              busy={busy === 'enable'} onCancel={() => setInstalled(null)}
              {...(installed.trust === 'unreviewed' ? {
                onEnable: async () => {
                  setBusy('enable');
                  try {
                    const r = await api.setSkillEnabled(installed.skill.name, true);
                    if (r.ok) { toast.success(`“${installed.skill.name}” reviewed and enabled`, 'It is in the agent\'s catalogue now.'); setInstalled(null); }
                    else toast.error('Not enabled', r.result ?? r.error);
                    await load();
                  } catch (e) { toast.error('Not enabled', (e as Error).message); }
                  finally { setBusy(null); }
                },
              } : {})} />
          </div>
        )}
      </Modal>

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
      // Written here by the person, so it installs as theirs — no review needed.
      const r = await api.saveAuthoredSkill([{ path: 'SKILL.md', base64: btoa(unescape(encodeURIComponent(md))) }, ...await toUpload(files)]);
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

/**
 * Agents are edited with the shared builder (`@web/components/settings/
 * AgentBuilder`): the engine validates as you type and generates the summary,
 * so the desktop and the web panel cannot disagree. What only the desktop can
 * do rides in the builder's slots — the model picker, and the agent's own
 * knowledge files, saved as its companion skill before the agent is.
 */
type Knowledge = Array<{ abs: string; rel: string }>;

export function AgentsSection(): React.ReactElement {
  const [agents, setAgents] = useState<AgentSpec[] | null>(null);
  const [editing, setEditing] = useState<{ draft: AgentDraft; existing: boolean } | null>(null);
  const [verifying, setVerifying] = useState<string | null>(null);
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
    const picked = await desktop.dialog.pickFiles({ title: 'Import agents (AICO .json, or Claude Code / Copilot .md)', filters: [{ name: 'Agents', extensions: ['json', 'md'] }] });
    if (picked[0]) await act({ action: 'import', path: picked[0].path }, 'Agents imported');
  };
  const importFolder = async (): Promise<void> => {
    const dir = await desktop.dialog.pickFolder('Import a folder of agents (.claude/agents, .github/agents)');
    if (dir) await act({ action: 'import', path: dir }, 'Agents imported');
  };
  const exportAgents = async (): Promise<void> => {
    const dest = await desktop.dialog.saveFile({ defaultName: 'aico-agents.json', content: '{}', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (dest) await act({ action: 'export', path: dest }, 'Agents exported');
  };
  const effective = async (a: AgentSpec): Promise<void> => {
    const r = await api.manage('agents', { action: 'effective', name: a.name });
    toast.info(`What @${a.name} can do`, r.result ?? r.error ?? '');
  };

  const mine = (agents ?? []).filter(a => a.source !== 'builtin');
  const builtin = (agents ?? []).filter(a => a.source === 'builtin');
  const row = (a: AgentSpec): React.ReactElement => (
    <Row key={a.name}
      title={<span className="flex items-center gap-2">@{a.name}<span className="badge bg-aico-hover text-aico-muted">{a.source}</span>{a.autonomy && <span className="badge bg-aico-hover text-aico-muted">{a.autonomy}</span>}{a.format === 'json' && <span className="badge bg-aico-hover text-aico-muted" title="Saved as .md the next time it is edited">legacy JSON</span>}{a.model && <span className="badge bg-aico-hover font-mono text-aico-muted">{a.model}</span>}<CertBadge status={a.certification?.status} {...(a.certification?.text ? { text: a.certification.text } : {})} /></span>}
      desc={<span className="line-clamp-2">{a.description}{a.skills?.length ? <span className="text-aico-muted"> · skills: {a.skills.join(', ')}</span> : null}</span>}>
      <div className="flex items-center gap-1">
        <MenuButton className="icon-btn-sm" title="More" placement="bottom-end" width={220} button={<Icon name="more" size={15} />}>
          {close => (
            <>
              <MenuItem icon="chat" label="Talk to it" onClick={() => { close(); useDesk.getState().closeSettings(); newChat(); void useStore.getState().setSessionAgent(a.name); toast.success(`Talking to @${a.name}`); }} />
              <MenuItem icon="info" label="What it can do" onClick={() => { close(); void effective(a); }} />
              <MenuItem icon="check" label="Verify and certify…" hint="for unattended runs" onClick={() => { close(); setEditing(null); setVerifying(a.name); }} />
              {a.source !== 'builtin' && <MenuItem icon="edit" label="Edit" onClick={() => { close(); setEditing({ existing: true, draft: draftOf(a) }); }} />}
              <MenuItem icon="copy" label="Duplicate as mine" onClick={() => { close(); setEditing({ existing: false, draft: duplicateDraft(a, (agents ?? []).map(x => x.name)) }); }} />
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
      <p className="-mt-2 mb-4 text-[13px] text-aico-muted">Specialists the orchestrator hands work to — each a Markdown file in Claude Code's agent format with its own instructions, tools, skills, model, autonomy ceiling, budget and write paths, enforced by the engine. Talk to one directly with <code>@name</code> in the composer.</p>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex-1" />
        <MenuButton className="btn-outline btn-sm" title="Import agents" placement="bottom-end" width={260} button={<><Icon name="upload" size={13} />Import</>}>
          {close => (
            <>
              <MenuItem icon="file" label="A file…" hint=".json, .md" onClick={() => { close(); void importAgents(); }} />
              <MenuItem icon="folder" label="A folder…" hint=".claude/agents" onClick={() => { close(); void importFolder(); }} />
            </>
          )}
        </MenuButton>
        <button className="btn-outline btn-sm" onClick={() => void exportAgents()}><Icon name="download" size={13} />Export</button>
        <MenuButton className="btn-primary btn-sm" title="Create an agent" placement="bottom-end" width={290} button={<><Icon name="plus" size={13} />New agent</>}>
          {close => (
            <>
              <MenuItem icon="sparkles" label="Create with the agent" hint="recommended" onClick={() => {
                close();
                askAgent('Create a new agent for me. First ask what kind of work it should take on. Then use AgentManage to define it: a description precise enough that you would know when to hand it a task, its instructions, only the tools it needs, the skills it should reach for, an autonomy ceiling and a budget. If it needs its own knowledge (reference documents) or scripts, create a skill for them with SkillManage first — references/ and scripts/ beside SKILL.md — and give the agent that skill. Validate it, then show me what it can do and how to talk to it.');
              }} />
              <MenuItem icon="edit" label="Define it myself" onClick={() => { close(); setEditing({ existing: false, draft: { ...EMPTY_DRAFT } }); }} />
            </>
          )}
        </MenuButton>
      </div>

      {editing && <div className="mt-4"><DesktopAgentBuilder key={`${editing.draft.name}-${editing.existing}`} initial={editing.draft} existing={editing.existing} onDone={async (saved, savedName) => {
        const name = savedName ?? editing.draft.name;
        setEditing(null);
        if (saved) { toast.success(editing.existing ? `Agent @${name} updated` : `Agent @${name} created`); await load(); }
      }} /></div>}

      {verifying && (() => {
        const a = (agents ?? []).find(x => x.name === verifying);
        return (
          <div className="mt-4 rounded-xl border border-aico-border p-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-[13px] font-medium">Verify @{verifying}</span>
              <div className="flex-1" />
              <button className="icon-btn-sm" onClick={() => setVerifying(null)} aria-label="Close"><Icon name="x" size={13} /></button>
            </div>
            <AgentVerify name={verifying} {...(a?.certification ? { status: a.certification.status, statusText: a.certification.text } : {})} onDone={load} />
          </div>
        );
      })()}

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

/** The shared builder, with the desktop's model picker and knowledge files. */
function DesktopAgentBuilder({ initial, existing, onDone }: {
  initial: AgentDraft; existing: boolean;
  onDone: (saved: boolean, name?: string) => void | Promise<void>;
}): React.ReactElement {
  const [knowledge, setKnowledge] = useState<Knowledge>([]);

  const addKnowledge = async (kind: 'files' | 'folder' | 'scripts'): Promise<void> => {
    if (kind === 'folder') {
      const dir = await desktop.dialog.pickFolder('Add a folder of knowledge');
      if (!dir) return;
      const base = dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? 'docs';
      const files = await folderFiles(dir);
      setKnowledge(k => [...k, ...files.map(f => ({ abs: f.abs, rel: `references/${base}/${f.rel}` }))]);
      return;
    }
    const picked = await desktop.dialog.pickFiles({ title: kind === 'scripts' ? 'Add scripts' : 'Add knowledge files' });
    setKnowledge(k => [...k, ...picked.map(p => ({ abs: p.path, rel: `${kind === 'scripts' ? 'scripts' : 'references'}/${p.name}` }))]);
  };

  // The agent's own knowledge and scripts become its companion skill, saved first.
  const beforeSave = async (d: AgentDraft): Promise<string[] | false> => {
    if (knowledge.length === 0) return [];
    const name = slugName(d.name);
    const kit = `${name}-kit`;
    const refs = knowledge.filter(k => k.rel.startsWith('references/')).map(k => `- \`${k.rel}\``);
    const scripts = knowledge.filter(k => k.rel.startsWith('scripts/')).map(k => `- \`${k.rel}\``);
    const md = [
      '---', `name: ${kit}`, `description: Knowledge and scripts for the ${name} agent — read the references before answering questions in its area, and use the scripts instead of rewriting them.`, '---', '',
      `# ${name} kit`, '',
      ...(refs.length ? ['## Reference knowledge', '', 'Read the relevant file before answering; cite it by path.', '', ...refs, ''] : []),
      ...(scripts.length ? ['## Scripts', '', 'Run these rather than reimplementing them. Read a script before running it the first time.', '', ...scripts, ''] : []),
    ].join('\n');
    const r = await api.saveAuthoredSkill([{ path: 'SKILL.md', base64: btoa(unescape(encodeURIComponent(md))) }, ...await toUpload(knowledge)], true);
    if (!r.ok) { toast.error('Knowledge not saved', r.error); return false; }
    return [r.name ?? kit];
  };

  return (
    <AgentBuilder
      initial={initial}
      existing={existing}
      onDone={onDone}
      beforeSave={beforeSave}
      modelField={(value, onChange) => (
        <ModelCombobox value={value} onChange={onChange} placeholder="same as the chat"
          load={async () => { const r = await api.providerModels(); return { models: r.models.map(id => ({ id, ...(r.capabilities?.[id] ?? {}) })), error: r.error }; }} />
      )}
      extra={(d) => (
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="label">Its own knowledge and scripts</span>
            <button className="btn-ghost btn-sm" onClick={() => void addKnowledge('files')}><Icon name="book" size={13} />Files</button>
            <button className="btn-ghost btn-sm" onClick={() => void addKnowledge('folder')}><Icon name="folder" size={13} />Folder</button>
            <button className="btn-ghost btn-sm" onClick={() => void addKnowledge('scripts')}><Icon name="terminal" size={13} />Scripts</button>
          </div>
          {knowledge.length > 0 && (
            <ul className="max-h-[120px] space-y-0.5 overflow-y-auto thin-scroll text-[12px]">
              {knowledge.map((k, i) => (
                <li key={`${k.rel}${i}`} className="flex items-center gap-2 font-mono text-aico-secondary">
                  <span className="truncate">{k.rel}</span>
                  <button className="icon-btn-sm h-5 w-5" onClick={() => setKnowledge(knowledge.filter((_, j) => j !== i))} aria-label={`Remove ${k.rel}`}><Icon name="x" size={11} /></button>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[12px] text-aico-muted">Saved as the skill <code>{slugName(d.name) || 'name'}-kit</code> (references/ and scripts/ beside a SKILL.md) and given to this agent. Nothing is run when it is saved.</p>
        </div>
      )}
    />
  );
}
