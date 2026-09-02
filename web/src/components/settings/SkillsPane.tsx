/**
 * The skills this installation has, and how to get more.
 *
 * A skill is a procedure someone already worked out. The value is in not
 * working it out again — which means the cost of *getting* one has to be near
 * zero, or people retype the knowledge instead of installing it.
 *
 * So: paste a path. A folder, a `.zip` someone published, a bare `SKILL.md`.
 * The name comes from the skill's own frontmatter rather than the filename,
 * because `download (2).zip` is not a skill name.
 *
 * **The description is shown as prominently as the name**, because it is the
 * whole of the selection decision. It is the only part the agent sees before
 * choosing, so a vague one makes a skill unreachable no matter how good the
 * procedure inside it is — and a person editing their skills should be looking
 * at the sentence that decides.
 *
 * @module components/settings/SkillsPane
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, type SkillSummary } from '../../api';
import { SkillLab } from './SkillLab';
import { useStore } from '../../store';

/** What a SKILL.md looks like, for the paste box. */
const SKILL_TEMPLATE = [
  '---',
  'name: my-skill',
  'description: what it does and when to reach for it',
  '---',
  '',
  'The procedure…',
].join('\n');

/** A short line about what a skill ships with. */
function Extras({ skill }: { skill: SkillSummary }): React.ReactElement | null {
  const bits: string[] = [];
  if (skill.resources.length > 0) {
    bits.push(`${skill.resources.length} bundled file${skill.resources.length === 1 ? '' : 's'}`);
  }
  if (skill.allowedTools.length > 0) bits.push(`expects ${skill.allowedTools.join(', ')}`);
  if (skill.aliases.length > 0) bits.push(`also ${skill.aliases.map(a => `/${a}`).join(' ')}`);
  if (bits.length === 0) return null;
  return <p className="mt-0.5 text-[11px] text-aico-muted">{bits.join(' · ')}</p>;
}

export function SkillsPane({ onClose }: { onClose?: () => void }): React.ReactElement {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);
  /** Which skill has its measuring bench open. One at a time: each is a job. */
  const [lab, setLab] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState('');
  const folderInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const askAgentFor = useStore(s => s.askAgentFor);

  const refresh = useCallback(async () => {
    try { setSkills((await api.skills()).skills); }
    catch (err) { setNote({ tone: 'bad', text: err instanceof Error ? err.message : String(err) }); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  /** One place that turns an import result into something readable. */
  const report = async (
    result: { ok: boolean; name?: string; resources?: string[]; replaced?: boolean; error?: string },
  ): Promise<void> => {
    if (result.ok) {
      setNote({
        tone: 'good',
        text: `Installed ${result.name}${result.replaced ? ' (replaced the previous one)' : ''}`
          + `${result.resources?.length ? ` with ${result.resources.length} bundled file(s)` : ''}.`,
      });
      await refresh();
    } else {
      setNote({ tone: 'bad', text: result.error ?? 'import failed' });
    }
  };

  const install = async (overwrite = false): Promise<void> => {
    const path = source.trim();
    if (!path || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const result = await api.importSkill(path, overwrite);
      if (result.ok) setSource('');
      await report(result);
    } finally { setBusy(false); }
  };

  const show = async (name: string): Promise<void> => {
    if (open === name) { setOpen(null); setBody(''); return; }
    setOpen(name);
    setBody('');
    try { setBody((await api.readSkill(name)).body); }
    catch { setBody('Could not read this skill.'); }
  };

  /** Switch a skill off without losing it — it leaves the catalogue, not the disk. */
  const toggle = async (skill: SkillSummary): Promise<void> => {
    const result = await api.manage('skills', {
      action: skill.enabled === false ? 'enable' : 'disable',
      name: skill.name,
    });
    setNote({
      tone: result.ok ? 'good' : 'bad',
      text: result.result ?? result.error ?? 'nothing came back',
    });
    await refresh();
  };

  /**
   * What a picked folder should not carry.
   *
   * A skill directory sits inside a repository as often as not, and picking it
   * with the OS folder chooser takes everything under it — including the git
   * history and any node_modules, which are megabytes of things no skill needs
   * and which would blow the request limit before the skill got installed.
   */
  const IGNORED = /(^|\/)(\.git|node_modules|__pycache__|\.venv|\.DS_Store|__MACOSX)(\/|$)/;

  /** Bytes as base64, without loading a 50 MB file into a string first. */
  const encode = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('could not read the file'));
    reader.onload = () => {
      const result = String(reader.result);
      // A data: URL, and everything after the comma is the base64.
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });

  /** Send whatever the file chooser handed back. */
  const uploadFiles = async (list: FileList | null): Promise<void> => {
    if (!list || list.length === 0 || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const chosen = Array.from(list)
        .map(file => ({
          file,
          // webkitRelativePath is set for a folder pick and empty for a single
          // file, where the name is the whole path.
          path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
        }))
        .filter(entry => !IGNORED.test(`/${entry.path}`));

      if (chosen.length === 0) {
        setNote({ tone: 'bad', text: 'Nothing usable in there — it was all git or build files.' });
        return;
      }

      // The server caps a request at 8 MB and base64 adds a third, so the limit
      // is stated in the terms the person can act on rather than as a failure
      // after a long upload.
      const total = chosen.reduce((sum, entry) => sum + entry.file.size, 0);
      if (total > 5 * 1024 * 1024) {
        setNote({
          tone: 'bad',
          text: `That folder is ${(total / 1024 / 1024).toFixed(1)} MB, which is far more than a `
            + 'skill needs — check you picked the skill itself and not the repository around it. '
            + 'For something genuinely large, give the server a path instead.',
        });
        return;
      }

      const files = await Promise.all(
        chosen.map(async entry => ({ path: entry.path, base64: await encode(entry.file) })),
      );
      const result = await api.uploadSkill({ files });
      report(result);
    } catch (err) {
      setNote({ tone: 'bad', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
      // Cleared so choosing the same file twice fires change again.
      if (folderInput.current) folderInput.current.value = '';
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const installPasted = async (): Promise<void> => {
    if (!pasted.trim() || busy) return;
    setBusy(true);
    setNote(null);
    try {
      report(await api.uploadSkill({ markdown: pasted }));
      setPasted('');
      setPasting(false);
    } finally { setBusy(false); }
  };

  const remove = async (name: string): Promise<void> => {
    const result = await api.removeSkill(name);
    setNote(result.ok
      ? { tone: 'good', text: `Removed ${name}.` }
      : { tone: 'bad', text: result.error ?? 'could not remove it' });
    setConfirming(null);
    await refresh();
  };

  return (
    <div className="space-y-4">
      <section>
        <h3 className="text-[13px] font-medium text-aico-primary">Install a skill</h3>
        <p className="mt-0.5 text-[12px] text-aico-muted">
          A folder, a <code className="font-mono">.zip</code> or{' '}
          <code className="font-mono">.skill</code>, or a single{' '}
          <code className="font-mono">SKILL.md</code>. Claude skills work exactly as they are — the
          scripts and references beside the markdown come with them, and nothing is run on import.
        </p>

        {/*
          Three ways in, because people arrive holding three different things: a
          folder they already unpacked, an archive they just downloaded, or the
          text of a SKILL.md someone pasted at them. Typing an absolute path was
          the only option and is the one nobody has to hand.
        */}
        <div className="mt-2 flex flex-wrap gap-1.5">
          <button
            onClick={() => folderInput.current?.click()}
            disabled={busy}
            className="rounded-lg border border-aico-border px-3 py-1.5 text-[12px] text-aico-primary
                       transition-colors hover:bg-aico-hover disabled:opacity-40"
          >
            Choose a folder…
          </button>
          <button
            onClick={() => fileInput.current?.click()}
            disabled={busy}
            className="rounded-lg border border-aico-border px-3 py-1.5 text-[12px] text-aico-primary
                       transition-colors hover:bg-aico-hover disabled:opacity-40"
          >
            Choose a .skill / .zip / SKILL.md…
          </button>
          <button
            onClick={() => setPasting(p => !p)}
            className="rounded-lg px-3 py-1.5 text-[12px] text-aico-secondary transition-colors hover:bg-aico-hover"
          >
            {pasting ? 'Cancel paste' : 'Paste a SKILL.md'}
          </button>
        </div>

        <input
          ref={folderInput}
          type="file"
          // Not in the React types, and the whole point of the button above.
          {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
          multiple
          onChange={e => void uploadFiles(e.target.files)}
          className="hidden"
        />
        <input
          ref={fileInput}
          type="file"
          accept=".skill,.zip,.md,application/zip"
          onChange={e => void uploadFiles(e.target.files)}
          className="hidden"
        />

        {pasting && (
          <div className="mt-2">
            <textarea
              value={pasted}
              onChange={e => setPasted(e.target.value)}
              rows={8}
              placeholder={SKILL_TEMPLATE}
              className="w-full resize-y rounded-lg border border-aico-border bg-aico-bg px-2.5 py-1.5
                         font-mono text-[11px] leading-[17px] text-aico-primary
                         placeholder:text-aico-muted focus:border-aico-accent/40 focus:outline-none"
            />
            <button
              onClick={() => void installPasted()}
              disabled={busy || !pasted.trim()}
              className="mt-1.5 rounded-lg bg-aico-accent px-3 py-1.5 text-[12px] font-medium text-white
                         transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              Install it
            </button>
          </div>
        )}

        <p className="mt-2.5 text-[11px] text-aico-muted">
          Or give the server a path directly — useful for something already on the machine AICO is
          running on.
        </p>
        <div className="mt-1 flex gap-1.5">
          <input
            value={source}
            onChange={e => setSource(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void install(); }}
            placeholder="/path/to/skill-folder, or …/pdf-forms.zip"
            className="min-w-0 flex-1 rounded-lg border border-aico-border bg-aico-bg px-2.5 py-1.5
                       font-mono text-[12px] text-aico-primary placeholder:text-aico-muted
                       focus:border-aico-accent/40 focus:outline-none"
          />
          <button
            onClick={() => void install()}
            disabled={busy || !source.trim()}
            className="shrink-0 rounded-lg bg-aico-accent px-3 py-1.5 text-[12px] font-medium text-white
                       transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            Install
          </button>
        </div>

        {note && (
          <div className={`mt-2 rounded-lg px-2.5 py-1.5 text-[12px] ${
            note.tone === 'good' ? 'bg-aico-success/10 text-aico-success' : 'bg-aico-danger/10 text-aico-danger'
          }`}>
            {note.text}
            {note.tone === 'bad' && /already installed/.test(note.text) && (
              <button
                onClick={() => void install(true)}
                className="ml-2 underline underline-offset-2 hover:opacity-80"
              >
                Replace it
              </button>
            )}
          </div>
        )}

        {/*
          Writing a good skill is a real piece of work — that is the point of
          having one — so the offer is to do it with the agent rather than to
          fill in a form. This hands over a brief, not a template.
        */}
        <button
          onClick={() => {
            // A fresh conversation, and Settings out of the way: writing a skill
            // is its own task, and burying it inside whatever chat happened to
            // be open loses both the request and the result.
            askAgentFor(
              'Write me a new skill. Ask me what the procedure is for, then use SkillManage to '
              + 'draft it — a name, a description precise enough that you would know when to pick '
              + 'it over anything else, and the steps in the order they should happen. Ship a '
              + 'script or a reference alongside it if the procedure needs one. Try it on a real '
              + 'example before registering it.',
            );
            onClose?.();
          }}
          className="mt-2 text-[12px] text-aico-accent underline underline-offset-2 hover:opacity-80"
        >
          Or write one with the agent →
        </button>
      </section>

      <section>
        <h3 className="text-[13px] font-medium text-aico-primary">
          Installed <span className="text-aico-muted">({skills.length})</span>
        </h3>
        <p className="mt-0.5 text-[12px] text-aico-muted">
          Every one of these is offered to the agent by name and description, on every turn. The
          description is what decides whether it gets used.
        </p>

        <ul className="mt-2 space-y-1">
          {skills.map(skill => (
            <li key={skill.name} className="rounded-xl border border-aico-border">
              <div className="flex items-start gap-2 px-3 py-2">
                <button onClick={() => void show(skill.name)} className="min-w-0 flex-1 text-left">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[12px] text-aico-primary">{skill.name}</span>
                    {skill.builtin && (
                      <span className="rounded bg-aico-hover px-1.5 py-0.5 text-[10px] text-aico-muted">
                        built in
                      </span>
                    )}
                    {skill.enabled === false && (
                      <span className="rounded bg-aico-warning/15 px-1.5 py-0.5 text-[10px] text-aico-warning">
                        off
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[12px] leading-[17px] text-aico-secondary">
                    {skill.description}
                  </p>
                  <Extras skill={skill} />
                </button>
                <div className="flex shrink-0 gap-1">
                  {/*
                    Offered for built-ins too, and that is the point of having a
                    switch at all: a built-in cannot be deleted, so without this
                    there is no way to say "not this one".
                  */}
                  <button
                    onClick={() => setLab(lab === skill.name ? null : skill.name)}
                    title="Score this skill against tasks with known answers, or improve it"
                    className={`rounded-lg px-2 py-1 text-[11px] transition-colors ${
                      lab === skill.name
                        ? 'bg-aico-accent-soft text-aico-accent'
                        : 'text-aico-muted hover:bg-aico-hover hover:text-aico-primary'
                    }`}
                  >
                    Measure
                  </button>
                  <button
                    onClick={() => void toggle(skill)}
                    className="rounded-lg px-2 py-1 text-[11px] text-aico-muted transition-colors
                               hover:bg-aico-hover hover:text-aico-primary"
                  >
                    {skill.enabled === false ? 'Enable' : 'Disable'}
                  </button>
                  {!skill.builtin && (
                    <button
                      onClick={() => setConfirming(skill.name)}
                      className="rounded-lg px-2 py-1 text-[11px] text-aico-muted
                                 transition-colors hover:bg-aico-danger/10 hover:text-aico-danger"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>

              {confirming === skill.name && (
                <div className="border-t border-aico-border bg-aico-danger/5 px-3 py-2">
                  <p className="text-[12px] text-aico-primary">
                    Delete <span className="font-mono">{skill.name}</span> and everything it ships with?
                  </p>
                  <div className="mt-1.5 flex gap-1.5">
                    <button
                      onClick={() => void remove(skill.name)}
                      className="rounded-lg bg-aico-danger px-2 py-1 text-[11px] font-medium text-white
                                 transition-opacity hover:opacity-90"
                    >
                      Delete it
                    </button>
                    <button
                      onClick={() => setConfirming(null)}
                      className="rounded-lg px-2 py-1 text-[11px] text-aico-secondary
                                 transition-colors hover:bg-aico-hover"
                    >
                      Keep it
                    </button>
                  </div>
                </div>
              )}

              {open === skill.name && (
                <pre className="max-h-72 overflow-auto border-t border-aico-border bg-aico-code px-3 py-2
                                font-mono text-[11px] leading-[17px] text-aico-secondary selectable">
                  {body || 'Reading…'}
                </pre>
              )}

              {lab === skill.name && (
                <SkillLab skill={skill.name} onAdopted={() => void refresh()} />
              )}
            </li>
          ))}
        </ul>

        {skills.length === 0 && (
          <p className="mt-2 text-[12px] text-aico-muted">
            No skills installed. The agent works fine without any — a skill is for a procedure you
            expect to repeat.
          </p>
        )}
      </section>
    </div>
  );
}
