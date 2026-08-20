/**
 * The specialists this installation can delegate to.
 *
 * An agent is a role you can hand work to, and the two things worth seeing at a
 * glance are what it is for and which skills it reaches for — the second is
 * what makes it a specialist rather than a system prompt with opinions.
 *
 * **Split into yours and built in**, because the two answer different
 * questions. Built-ins are the roster you were given and mostly want to know
 * exists; the ones you made are the ones you will come here to change. Mixing
 * them into one alphabetical list buries three of yours among seven of
 * somebody else's.
 *
 * **Yours are editable in place.** Everything except the name, which is the
 * identity the rest of the system refers to — renaming would be a create and a
 * delete wearing one button. Built-ins are read-only and say so rather than
 * offering controls that refuse; the switch is offered instead, because "not
 * this one" is a real thing to mean and deleting something that returns on the
 * next install is not an answer.
 *
 * @module components/settings/AgentsPane
 */

import React, { useCallback, useEffect, useState } from 'react';
import { api, type AgentSpec } from '../../api';
import { useStore } from '../../store';

/** The fields a person may change, as text the form can hold. */
interface Draft {
  description: string;
  role: string;
  goals: string;
  skills: string;
  tools: string;
  model: string;
  canDelegate: boolean;
}

const draftOf = (agent: AgentSpec): Draft => ({
  description: agent.description ?? '',
  role: agent.role ?? '',
  goals: (agent.goals ?? []).join('\n'),
  skills: (agent.skills ?? []).join(', '),
  tools: (agent.tools ?? []).join(', '),
  model: agent.model ?? '',
  canDelegate: Boolean(agent.canDelegate),
});

/** Comma or newline separated, with the empties dropped. */
const asList = (raw: string): string[] =>
  raw.split(/[,\n]/).map(s => s.trim()).filter(Boolean);

function Field({ label, hint, children }: {
  label: string; hint?: string; children: React.ReactNode;
}): React.ReactElement {
  return (
    <label className="block">
      <span className="text-[11px] font-medium text-aico-secondary">{label}</span>
      {hint && <span className="ml-1.5 text-[11px] text-aico-muted">{hint}</span>}
      <div className="mt-0.5">{children}</div>
    </label>
  );
}

const INPUT =
  'w-full rounded-lg border border-aico-border bg-aico-bg px-2.5 py-1.5 text-[12px] '
  + 'text-aico-primary placeholder:text-aico-muted focus:border-aico-accent/40 focus:outline-none';

export function AgentsPane({ onClose }: { onClose?: () => void }): React.ReactElement {
  const [agents, setAgents] = useState<AgentSpec[]>([]);
  const [note, setNote] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const askAgentFor = useStore(s => s.askAgentFor);

  const refresh = useCallback(async () => {
    try { setAgents((await api.agents()).agents); }
    catch (err) { setNote({ tone: 'bad', text: err instanceof Error ? err.message : String(err) }); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  /** Returns whether it worked, because callers have to know. */
  const act = async (input: Record<string, unknown>): Promise<boolean> => {
    setBusy(true);
    try {
      const result = await api.manage('agents', input);
      setNote({
        tone: result.ok ? 'good' : 'bad',
        text: result.result ?? result.error ?? 'nothing came back',
      });
      setConfirming(null);
      await refresh();
      return result.ok;
    } finally { setBusy(false); }
  };

  const startEditing = (agent: AgentSpec): void => {
    setEditing(agent.name);
    setDraft(draftOf(agent));
    setOpen(null);
  };

  const save = async (name: string): Promise<void> => {
    if (!draft) return;
    const saved = await act({
      action: 'update',
      name,
      description: draft.description,
      role: draft.role,
      goals: asList(draft.goals),
      skills: asList(draft.skills),
      tools: asList(draft.tools),
      canDelegate: draft.canDelegate,
      ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
    });
    // Kept open when it was refused. Closing on failure throws away everything
    // typed and leaves the person to reconstruct it from the error message —
    // watched happening with a skill name that did not exist.
    if (!saved) return;
    setEditing(null);
    setDraft(null);
  };

  const mine = agents.filter(a => a.source !== 'builtin');
  const builtin = agents.filter(a => a.source === 'builtin');

  const row = (agent: AgentSpec): React.ReactElement => (
    <li key={agent.name} className="rounded-xl border border-aico-border">
      <div className="flex items-start gap-2 px-3 py-2">
        <button
          onClick={() => { setEditing(null); setOpen(open === agent.name ? null : agent.name); }}
          className="min-w-0 flex-1 text-left"
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[12px] text-aico-primary">{agent.name}</span>
            {agent.source === 'project' && (
              <span className="rounded bg-aico-hover px-1.5 py-0.5 text-[10px] text-aico-muted">this project</span>
            )}
            {!agent.enabled && (
              <span className="rounded bg-aico-warning/15 px-1.5 py-0.5 text-[10px] text-aico-warning">off</span>
            )}
          </div>
          <p className="mt-0.5 text-[12px] leading-[17px] text-aico-secondary">{agent.description}</p>
          {agent.skills?.length > 0 && (
            <p className="mt-0.5 text-[11px] text-aico-muted">reaches for {agent.skills.join(', ')}</p>
          )}
        </button>

        <div className="flex shrink-0 gap-1">
          {agent.source !== 'builtin' && (
            <button
              onClick={() => startEditing(agent)}
              disabled={busy}
              className="rounded-lg px-2 py-1 text-[11px] text-aico-muted transition-colors
                         hover:bg-aico-hover hover:text-aico-primary disabled:opacity-40"
            >
              Edit
            </button>
          )}
          <button
            onClick={() => void act({ action: agent.enabled ? 'disable' : 'enable', name: agent.name })}
            disabled={busy}
            className="rounded-lg px-2 py-1 text-[11px] text-aico-muted transition-colors
                       hover:bg-aico-hover hover:text-aico-primary disabled:opacity-40"
          >
            {agent.enabled ? 'Disable' : 'Enable'}
          </button>
          {agent.source !== 'builtin' && (
            <button
              onClick={() => setConfirming(agent.name)}
              disabled={busy}
              className="rounded-lg px-2 py-1 text-[11px] text-aico-muted transition-colors
                         hover:bg-aico-danger/10 hover:text-aico-danger disabled:opacity-40"
            >
              Delete
            </button>
          )}
        </div>
      </div>

      {confirming === agent.name && (
        <div className="border-t border-aico-border bg-aico-danger/5 px-3 py-2">
          <p className="text-[12px] text-aico-primary">
            Delete <span className="font-mono">{agent.name}</span>? Disabling keeps the definition
            and stops it being offered.
          </p>
          <div className="mt-1.5 flex gap-1.5">
            <button
              onClick={() => void act({ action: 'delete', name: agent.name })}
              className="rounded-lg bg-aico-danger px-2 py-1 text-[11px] font-medium text-white
                         transition-opacity hover:opacity-90"
            >
              Delete it
            </button>
            <button
              onClick={() => void act({ action: 'disable', name: agent.name })}
              className="rounded-lg px-2 py-1 text-[11px] text-aico-secondary transition-colors hover:bg-aico-hover"
            >
              Just disable it
            </button>
            <button
              onClick={() => setConfirming(null)}
              className="rounded-lg px-2 py-1 text-[11px] text-aico-secondary transition-colors hover:bg-aico-hover"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {editing === agent.name && draft && (
        <div className="space-y-2 border-t border-aico-border bg-aico-hover/30 px-3 py-2.5">
          {/*
            The name is not here on purpose: it is the identity Task and
            AgentPrompt refer to, so renaming would be a create and a delete
            wearing one button.
          */}
          <p className="text-[11px] text-aico-muted">
            Editing <span className="font-mono text-aico-secondary">{agent.name}</span>. The name is
            fixed — it is what the rest of the system calls this agent.
          </p>

          <Field label="Description" hint="decides when it gets the task">
            <textarea
              value={draft.description}
              onChange={e => setDraft({ ...draft, description: e.target.value })}
              rows={2}
              className={`${INPUT} resize-y`}
            />
          </Field>

          <Field label="Role">
            <input value={draft.role} onChange={e => setDraft({ ...draft, role: e.target.value })}
              placeholder="e.g. senior backend engineer" className={INPUT} />
          </Field>

          <Field label="Goals" hint="one per line">
            <textarea
              value={draft.goals}
              onChange={e => setDraft({ ...draft, goals: e.target.value })}
              rows={2}
              className={`${INPUT} resize-y`}
            />
          </Field>

          <Field label="Skills" hint="checked — a name that does not exist is refused">
            <input value={draft.skills} onChange={e => setDraft({ ...draft, skills: e.target.value })}
              placeholder="commit, release-notes" className={`${INPUT} font-mono`} />
          </Field>

          <Field label="Tools" hint="blank means all of them">
            <input value={draft.tools} onChange={e => setDraft({ ...draft, tools: e.target.value })}
              placeholder="Read, Grep, Bash" className={`${INPUT} font-mono`} />
          </Field>

          <Field label="Model" hint="blank uses the session's model">
            <input value={draft.model} onChange={e => setDraft({ ...draft, model: e.target.value })}
              placeholder="deepseek-v4-flash" className={`${INPUT} font-mono`} />
          </Field>

          <label className="flex items-center gap-2 text-[12px] text-aico-secondary">
            <input
              type="checkbox"
              checked={draft.canDelegate}
              onChange={e => setDraft({ ...draft, canDelegate: e.target.checked })}
            />
            May spawn agents of its own
          </label>

          <div className="flex gap-1.5 pt-0.5">
            <button
              onClick={() => void save(agent.name)}
              disabled={busy || !draft.description.trim()}
              className="rounded-lg bg-aico-accent px-3 py-1.5 text-[12px] font-medium text-white
                         transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              Save
            </button>
            <button
              onClick={() => { setEditing(null); setDraft(null); }}
              className="rounded-lg px-3 py-1.5 text-[12px] text-aico-secondary transition-colors hover:bg-aico-hover"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {open === agent.name && (
        <dl className="border-t border-aico-border px-3 py-2 text-[11px] leading-[18px]">
          <div className="flex gap-2"><dt className="w-20 shrink-0 text-aico-muted">role</dt>
            <dd className="text-aico-secondary">{agent.role}</dd></div>
          {agent.model && (
            <div className="flex gap-2"><dt className="w-20 shrink-0 text-aico-muted">model</dt>
              <dd className="font-mono text-aico-secondary">{agent.model}</dd></div>
          )}
          {agent.goals?.length > 0 && (
            <div className="flex gap-2"><dt className="w-20 shrink-0 text-aico-muted">goals</dt>
              <dd className="text-aico-secondary">{agent.goals.join(' · ')}</dd></div>
          )}
          {agent.tools?.length > 0 && (
            <div className="flex gap-2"><dt className="w-20 shrink-0 text-aico-muted">tools</dt>
              <dd className="font-mono text-aico-secondary">{agent.tools.join(', ')}</dd></div>
          )}
          <div className="flex gap-2"><dt className="w-20 shrink-0 text-aico-muted">delegates</dt>
            <dd className="text-aico-secondary">{agent.canDelegate ? 'yes' : 'no'}</dd></div>
          {agent.source === 'builtin' && (
            <p className="mt-1 text-aico-muted">
              Built in, so it cannot be edited or deleted — it would return on the next install.
              Disable it, or make your own with a different name.
            </p>
          )}
        </dl>
      )}
    </li>
  );

  return (
    <div className="space-y-4">
      <section>
        <h3 className="text-[13px] font-medium text-aico-primary">
          Your agents <span className="text-aico-muted">({mine.length})</span>
        </h3>
        <p className="mt-0.5 text-[12px] text-aico-muted">
          Ones you made. Editable, and yours to remove.
        </p>

        {mine.length > 0
          ? <ul className="mt-2 space-y-1">{mine.map(row)}</ul>
          : (
            <p className="mt-2 text-[12px] text-aico-muted">
              None yet. The built-ins below cover most work; make your own when you keep handing out
              the same kind of task.
            </p>
          )}

        {note && (
          <p className={`mt-2 whitespace-pre-wrap rounded-lg px-2.5 py-1.5 text-[12px] ${
            note.tone === 'good' ? 'bg-aico-success/10 text-aico-success' : 'bg-aico-danger/10 text-aico-danger'
          }`}>
            {note.text}
          </p>
        )}

        {/*
          Defining an agent properly means goals, tools, and what it may
          delegate — real work, and a blank form is the wrong shape for it. This
          hands over a brief, in a conversation of its own.
        */}
        <button
          onClick={() => {
            askAgentFor(
              'Create a new agent for me. Ask what kind of work it should take on, then use '
              + 'AgentManage to define it — a description precise enough that you would know when '
              + 'to hand it a task, the goals it is working towards, the tools it needs, and any '
              + 'skills it should reach for.',
            );
            onClose?.();
          }}
          className="mt-2 text-[12px] text-aico-accent underline underline-offset-2 hover:opacity-80"
        >
          Make one with the agent →
        </button>
      </section>

      <section>
        <h3 className="text-[13px] font-medium text-aico-primary">
          Built in <span className="text-aico-muted">({builtin.length})</span>
        </h3>
        <p className="mt-0.5 text-[12px] text-aico-muted">
          Shipped with AICO. Read-only, but you can switch any of them off.
        </p>
        <ul className="mt-2 space-y-1">{builtin.map(row)}</ul>
      </section>
    </div>
  );
}
