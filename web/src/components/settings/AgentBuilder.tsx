/**
 * The agent builder (design §7.6), shared by web Settings → Agents and the
 * desktop's Settings → Agents.
 *
 * One form in six numbered parts — purpose, instructions, tools & MCP,
 * skills, autonomy & budget, verify — with the engine's "what this agent can do"
 * summary pinned beside it. Every keystroke (debounced) asks the engine to
 * validate the definition as it stands (`AgentManage validate`); errors are
 * shown at their field, Save is disabled while there are any, warnings never
 * block (§7.8). The client validates nothing itself, so the panel cannot
 * disagree with what the engine will save or enforce.
 *
 * Part 6, "Verify" (Phase 4), is the shared `AgentVerify`: the agent's
 * certification status, the plan and its cost, and Certify — for a saved
 * agent only, since a certificate is bound to the saved file. Deliberately
 * not here: Bash narrowing to command prefixes, which the engine does not
 * enforce yet, so the form does not offer it.
 *
 * Slots let the desktop keep what only it can do: its model picker, and the
 * agent's own knowledge files (saved as a companion skill before the agent).
 *
 * @module components/settings/AgentBuilder
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, type AgentCheck, type CustomToolRow, type SkillSummary } from '../../api';
import { useStore } from '../../store';
import { AgentVerify } from './AgentVerify';
import {
  AUTONOMY_CHOICES, fieldOf, inputOf, readCheck, toggle, type AgentDraft,
} from '../../agent-builder';

/** Built-ins worth a chip, grouped by what they do. Anything else can be typed. */
const TOOL_GROUPS: ReadonlyArray<{ label: string; effect: string; tools: ReadonlyArray<[string, string]> }> = [
  { label: 'Read', effect: 'runs without asking at every level', tools: [
    ['Read', 'read files'], ['Grep', 'search contents'], ['Glob', 'find files'], ['LS', 'list folders'],
    ['CodebaseMap', 'project map'], ['WebFetch', 'read web pages'], ['WebSearch', 'search the web'], ['DependencyAudit', 'audit packages'],
  ] },
  { label: 'Write', effect: 'asks at L1, runs at L2 and above', tools: [
    ['Write', 'create files'], ['Edit', 'change files'], ['MultiEdit', 'several edits'], ['NotebookEdit', 'notebooks'],
  ] },
  { label: 'Run', effect: 'asks at L1–L2, runs at L3', tools: [
    ['Bash', 'any shell command'], ['RunChecks', 'tests and builds'], ['Git', 'version control'],
  ] },
];
const CHIP_TOOLS = new Set(TOOL_GROUPS.flatMap(g => g.tools.map(([t]) => t)));

const INPUT =
  'w-full rounded-lg border border-aico-border bg-aico-bg px-2.5 py-1.5 text-[12px] '
  + 'text-aico-primary placeholder:text-aico-muted focus:border-aico-accent/40 focus:outline-none';
const CHIP = 'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors';
const chipCls = (on: boolean): string => `${CHIP} ${on
  ? 'border-aico-accent/50 bg-aico-accent/10 text-aico-accent'
  : 'border-aico-border text-aico-secondary hover:bg-aico-hover'}`;

function Part({ n, title, hint, children }: { n: number; title: string; hint?: string; children: React.ReactNode }): React.ReactElement {
  return (
    <section className="space-y-1.5">
      <h4 className="text-[12px] font-medium text-aico-primary">
        <span className="mr-1.5 text-aico-muted">{n}.</span>{title}
        {hint && <span className="ml-1.5 font-normal text-aico-muted">{hint}</span>}
      </h4>
      {children}
    </section>
  );
}

/** Errors for one field, in words, with a marker that is not colour alone. */
function FieldErrors({ messages }: { messages: string[] }): React.ReactElement | null {
  if (!messages.length) return null;
  return (
    <ul className="space-y-0.5" role="alert">
      {messages.map(m => <li key={m} className="text-[11px] text-aico-danger">✕ {m}</li>)}
    </ul>
  );
}

export interface AgentBuilderProps {
  initial: AgentDraft;
  /** Editing a saved agent: the name is fixed and Save updates it. */
  existing: boolean;
  /** `name` is the saved agent's name. */
  onDone: (saved: boolean, name?: string) => void | Promise<void>;
  /** The model field; defaults to a text input. */
  modelField?: (value: string, onChange: (v: string) => void) => React.ReactNode;
  /** Extra content inside part 2 (the desktop's knowledge files). */
  extra?: (draft: AgentDraft) => React.ReactNode;
  /** Runs before the agent is saved; returns skills to add, or false to stop. */
  beforeSave?: (draft: AgentDraft) => Promise<string[] | false>;
}

export function AgentBuilder({ initial, existing, onDone, modelField, extra, beforeSave }: AgentBuilderProps): React.ReactElement {
  const [d, setD] = useState<AgentDraft>(initial);
  const [check, setCheck] = useState<AgentCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [custom, setCustom] = useState<CustomToolRow[]>([]);
  const [agentNames, setAgentNames] = useState<string[]>([]);
  const [toolText, setToolText] = useState('');
  const [cert, setCert] = useState<{ status?: string; text?: string } | null>(null);
  const system = useStore(s => s.system);
  const set = (patch: Partial<AgentDraft>): void => setD(x => ({ ...x, ...patch }));

  useEffect(() => {
    void api.skills().then(r => setSkills(r.skills.filter(s => s.enabled && s.trust !== 'unreviewed'))).catch(() => {});
    void api.customTools().then(r => setCustom(r.tools)).catch(() => {});
    void api.agents().then(r => setAgentNames(r.agents.map(a => a.name))).catch(() => {});
  }, []);
  const loadCert = (): void => {
    if (!existing || !initial.name) return;
    void api.manage('agents', { action: 'status', name: initial.name })
      .then(r => { try { setCert(JSON.parse(r.result ?? '{}') as { status?: string; text?: string }); } catch { setCert(null); /* not JSON: an error line */ } })
      .catch(() => {});
  };
  useEffect(loadCert, [existing, initial.name]);
  const mcpNames = useMemo(() => (system?.mcpServers ?? []).filter(s => s.enabled).map(s => s.name), [system]);

  // The engine judges the draft as it stands, on a debounce; a stale answer is dropped.
  const seq = useRef(0);
  useEffect(() => {
    const mine = ++seq.current;
    setChecking(true);
    const t = setTimeout(() => {
      void api.manage('agents', { action: 'validate', ...inputOf(d) })
        .then(r => { if (mine === seq.current) setCheck(readCheck(r.result, r.error)); })
        .catch(err => { if (mine === seq.current) setCheck({ ok: false, errors: [String(err?.message ?? err)], warnings: [] }); })
        .finally(() => { if (mine === seq.current) setChecking(false); });
    }, 350);
    return () => clearTimeout(t);
  }, [d]);

  const errorsFor = (field: keyof AgentDraft | 'other'): string[] => (check?.errors ?? []).filter(e => fieldOf(e) === field);
  const otherErrors = (check?.errors ?? []).filter(e => {
    const f = fieldOf(e);
    return f === 'other' || f === 'model' || f === 'delegateTo' || f === 'allTools';
  });
  const blocked = saving || checking || !check || check.errors.length > 0;

  const save = async (): Promise<void> => {
    setSaving(true);
    setNote(null);
    try {
      const more = beforeSave ? await beforeSave(d) : [];
      if (more === false) return;
      const input = inputOf(d);
      const r = await api.manage('agents', {
        action: existing ? 'update' : 'create',
        ...input,
        skills: [...new Set([...(input.skills as string[]), ...more])],
        scope: 'user',
      });
      if (!r.ok) { setNote(r.result ?? r.error ?? 'Not saved.'); return; }
      await onDone(true, String(input.name));
    } finally { setSaving(false); }
  };

  const chosen = (t: string): boolean => d.tools.includes(t);
  const customChoices = custom.filter(t => t.status !== 'invalid');

  return (
    <div className="grid gap-4 rounded-xl border border-aico-border p-3 lg:grid-cols-[1fr_260px]">
      <div className="min-w-0 space-y-4">
        <Part n={1} title="Purpose" hint="what it is called and when to hand it work">
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block">
              <span className="text-[11px] text-aico-secondary">Name</span>
              <input className={`${INPUT} font-mono`} value={d.name} disabled={existing} autoFocus={!existing}
                onChange={e => set({ name: e.target.value })} placeholder="security-reviewer" aria-label="Agent name" />
            </label>
            <label className="block">
              <span className="text-[11px] text-aico-secondary">Model <span className="text-aico-muted">(blank: the chat's)</span></span>
              {modelField ? modelField(d.model, v => set({ model: v }))
                : <input className={`${INPUT} font-mono`} value={d.model} onChange={e => set({ model: e.target.value })} placeholder="deepseek-v4-flash" aria-label="Model" />}
            </label>
          </div>
          <FieldErrors messages={errorsFor('name')} />
          <label className="block">
            <span className="text-[11px] text-aico-secondary">When to hand it work</span>
            <textarea className={`${INPUT} resize-y`} rows={2} value={d.description} onChange={e => set({ description: e.target.value })}
              placeholder="Reviews changes for security problems. Use before merging anything touching auth or input handling." aria-label="Description" />
          </label>
          <FieldErrors messages={errorsFor('description')} />
        </Part>

        <Part n={2} title="Instructions" hint="how it works and what it reports (Markdown)">
          <textarea className={`${INPUT} min-h-[110px] resize-y font-mono text-[12px]`} value={d.instructions}
            onChange={e => set({ instructions: e.target.value })} aria-label="Instructions"
            placeholder={'You are …\n\nHow to work:\n1. …\n\nReport: …'} />
          <p className="text-[11px] text-aico-muted">{d.instructions.split('\n').length} lines · ~{Math.ceil(d.instructions.length / 4).toLocaleString()} tokens per turn with this agent</p>
          <FieldErrors messages={errorsFor('instructions')} />
          {extra?.(d)}
        </Part>

        <Part n={3} title="Tools & MCP" hint="enforced: it is offered nothing else">
          <label className="flex items-center gap-2 text-[12px] text-aico-secondary">
            <input type="checkbox" checked={d.allTools} onChange={e => set({ allTools: e.target.checked })} />
            Every tool (no allow-list)
          </label>
          {!d.allTools && (
            <div className="space-y-2">
              {TOOL_GROUPS.map(g => (
                <div key={g.label}>
                  <p className="text-[11px] text-aico-muted"><span className="font-medium text-aico-secondary">{g.label}</span> — {g.effect}</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {g.tools.map(([t, hint]) => (
                      <button key={t} type="button" title={hint} aria-pressed={chosen(t)} className={chipCls(chosen(t))}
                        onClick={() => set({ tools: toggle(d.tools, t) })}>{chosen(t) ? '✓ ' : ''}{t}</button>
                    ))}
                  </div>
                </div>
              ))}
              {customChoices.length > 0 && (
                <div>
                  <p className="text-[11px] text-aico-muted"><span className="font-medium text-aico-secondary">Custom tools</span> — each asks by its declared effect</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {customChoices.map(t => {
                      const id = `custom:${t.name}`;
                      return (
                        <button key={id} type="button" aria-pressed={chosen(id)} className={chipCls(chosen(id))}
                          title={`${t.def?.effect ?? ''} · ${t.status}`} onClick={() => set({ tools: toggle(d.tools, id) })}>
                          {chosen(id) ? '✓ ' : ''}{t.name}{t.status !== 'enabled' ? ` (${t.status})` : ''}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {mcpNames.length > 0 && (
                <div>
                  <p className="text-[11px] text-aico-muted"><span className="font-medium text-aico-secondary">MCP servers</span> — all of a server's tools</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {mcpNames.map(m => {
                      const id = `mcp__${m}__*`;
                      return (
                        <button key={id} type="button" aria-pressed={chosen(id)} className={chipCls(chosen(id))}
                          onClick={() => set({ tools: toggle(d.tools, id), mcpServers: chosen(id) ? d.mcpServers.filter(x => x !== m) : [...new Set([...d.mcpServers, m])] })}>
                          {chosen(id) ? '✓ ' : ''}⧉ {m}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-1">
                {d.tools.filter(t => !CHIP_TOOLS.has(t) && !t.startsWith('custom:') && !/^mcp__.+__\*$/.test(t)).map(t => (
                  <button key={t} type="button" className={chipCls(true)} onClick={() => set({ tools: toggle(d.tools, t) })} aria-label={`Remove ${t}`}>{t} ✕</button>
                ))}
                <input className={`${INPUT} h-7 w-48 py-0`} placeholder="+ tool (e.g. mcp__docs__search)" value={toolText}
                  onChange={e => setToolText(e.target.value)} aria-label="Add a tool by name"
                  onKeyDown={e => { if (e.key === 'Enter' && toolText.trim()) { e.preventDefault(); set({ tools: [...new Set([...d.tools, toolText.trim()])] }); setToolText(''); } }} />
              </div>
            </div>
          )}
          <FieldErrors messages={errorsFor('tools')} />
          <label className="block">
            <span className="text-[11px] text-aico-secondary">Never allow <span className="text-aico-muted">(applied after the list)</span></span>
            <input className={`${INPUT} font-mono`} value={d.disallowedTools.join(', ')} placeholder="Write, mcp__prod__*"
              onChange={e => set({ disallowedTools: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} aria-label="Disallowed tools" />
          </label>
          <FieldErrors messages={[...errorsFor('disallowedTools'), ...errorsFor('mcpServers')]} />
        </Part>

        <Part n={4} title="Skills" hint="preloaded in full; reviewed skills only">
          <div className="flex max-h-[120px] flex-wrap gap-1 overflow-y-auto">
            {skills.map(s => (
              <button key={s.name} type="button" title={s.description} aria-pressed={d.skills.includes(s.name)} className={chipCls(d.skills.includes(s.name))}
                onClick={() => set({ skills: toggle(d.skills, s.name) })}>{d.skills.includes(s.name) ? '✓ ' : ''}{s.name}</button>
            ))}
            {skills.length === 0 && <span className="text-[11px] text-aico-muted">No reviewed skills installed.</span>}
          </div>
          <FieldErrors messages={errorsFor('skills')} />
        </Part>

        <Part n={5} title="Autonomy, delegation & budget" hint="a ceiling: the session can only lower it">
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Autonomy ceiling">
            {AUTONOMY_CHOICES.map(c => (
              <button key={c.id} type="button" role="radio" aria-checked={d.autonomy === c.id} title={c.hint}
                className={chipCls(d.autonomy === c.id)} onClick={() => set({ autonomy: d.autonomy === c.id ? '' : c.id })}>
                {d.autonomy === c.id ? '● ' : '○ '}{c.label}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-aico-muted">{AUTONOMY_CHOICES.find(c => c.id === d.autonomy)?.hint ?? 'No ceiling: the session\'s level applies.'}</p>
          <FieldErrors messages={errorsFor('autonomy')} />

          <div className="flex flex-wrap items-center gap-2 text-[12px] text-aico-secondary">
            <span>Delegation</span>
            <select className={`${INPUT} w-auto`} value={d.delegate} onChange={e => set({ delegate: e.target.value as AgentDraft['delegate'] })} aria-label="Delegation">
              <option value="none">none — does the work itself</option>
              <option value="readonly">read-only research only</option>
              <option value="named">only to named agents</option>
            </select>
          </div>
          {d.delegate === 'named' && (
            <div className="flex flex-wrap gap-1">
              {agentNames.filter(n => n !== d.name).map(n => (
                <button key={n} type="button" aria-pressed={d.delegateTo.includes(n)} className={chipCls(d.delegateTo.includes(n))}
                  onClick={() => set({ delegateTo: toggle(d.delegateTo, n) })}>{d.delegateTo.includes(n) ? '✓ ' : ''}@{n}</button>
              ))}
            </div>
          )}
          <FieldErrors messages={errorsFor('delegate')} />

          <div className="grid grid-cols-3 gap-2">
            {([['maxUsd', 'Max $ per run'], ['maxIterations', 'Max steps'], ['maxMinutes', 'Max minutes']] as const).map(([k, label]) => (
              <label key={k} className="block">
                <span className="text-[11px] text-aico-secondary">{label}</span>
                <input className={INPUT} inputMode="decimal" value={d[k]} onChange={e => set({ [k]: e.target.value } as Partial<AgentDraft>)} aria-label={label} />
              </label>
            ))}
          </div>
          <FieldErrors messages={errorsFor('maxUsd')} />
          <label className="block">
            <span className="text-[11px] text-aico-secondary">May write only <span className="text-aico-muted">(globs, one per line — AICO's file tools only; Bash is not bound)</span></span>
            <textarea className={`${INPUT} resize-y font-mono`} rows={2} value={d.writePaths} onChange={e => set({ writePaths: e.target.value })}
              placeholder={'docs/**\n**/*.test.*'} aria-label="Write paths" />
          </label>
          <FieldErrors messages={errorsFor('writePaths')} />
        </Part>

        <Part n={6} title="Verify" hint="certification: needed only for unattended (L4) runs">
          {existing
            ? <AgentVerify name={initial.name} {...(cert?.status ? { status: cert.status } : {})} {...(cert?.text ? { statusText: cert.text } : {})} onDone={loadCert} />
            : <p className="text-[11px] text-aico-muted">Save the agent first: a certificate is bound to the saved file, its skills, tools and model.</p>}
          {existing && <p className="text-[11px] text-aico-muted">Saving a change makes it "changed since certification" until it is certified again.</p>}
        </Part>

        <FieldErrors messages={otherErrors} />
        {note && <p className="whitespace-pre-wrap rounded-lg bg-aico-danger/10 px-2.5 py-1.5 text-[12px] text-aico-danger">{note}</p>}
        <div className="flex gap-1.5">
          <button onClick={() => void save()} disabled={blocked}
            className="rounded-lg bg-aico-accent px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40">
            {saving ? 'Saving…' : existing ? 'Save agent' : 'Create agent'}
          </button>
          <button onClick={() => void onDone(false)} className="rounded-lg px-3 py-1.5 text-[12px] text-aico-secondary transition-colors hover:bg-aico-hover">Cancel</button>
          <span className="self-center text-[11px] text-aico-muted">
            {checking ? 'Checking…' : check?.errors.length ? `${check.errors.length} to fix before saving` : check ? 'Ready to save' : ''}
          </span>
        </div>
      </div>

      <aside className="space-y-2 rounded-lg bg-aico-hover/40 p-2.5 text-[12px] lg:sticky lg:top-2 lg:self-start" aria-label="What this agent can do">
        <h4 className="text-[12px] font-medium text-aico-primary">What this agent can do</h4>
        {!check?.summary && <p className="text-aico-muted">{checking ? 'Working it out…' : 'Fill in a name and description.'}</p>}
        {check?.summary && (
          <>
            <p className="text-aico-muted">Generated by the engine from these settings — what the run will enforce.</p>
            <p><span className="font-medium text-aico-secondary">Can, without asking:</span> {check.summary.runsWithoutAsking.join(', ') || 'nothing'}</p>
            {check.summary.asksFirst.length > 0 && <p><span className="font-medium text-aico-secondary">Asks you before:</span> {check.summary.asksFirst.join(', ')}</p>}
            {check.summary.cannot.length > 0 && <p><span className="font-medium text-aico-secondary">Cannot:</span> {check.summary.cannot.join('; ')}</p>}
            <p><span className="font-medium text-aico-secondary">Delegation:</span> {check.summary.delegation}</p>
            <p><span className="font-medium text-aico-secondary">Budget:</span> {check.summary.budget}</p>
            <p><span className="font-medium text-aico-secondary">Writes:</span> {check.summary.writes}</p>
            <p><span className="font-medium text-aico-secondary">Unattended:</span> {check.summary.unattended}</p>
          </>
        )}
        {check && check.warnings.length > 0 && (
          <ul className="space-y-0.5 border-t border-aico-border pt-1.5">
            {check.warnings.map(w => <li key={w} className="text-[11px] text-aico-warning">⚠ {w}</li>)}
          </ul>
        )}
      </aside>
    </div>
  );
}
