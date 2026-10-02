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
 * **Yours are editable in place** with the agent builder (`AgentBuilder`,
 * shared with the desktop): purpose, instructions, tools and MCP, skills,
 * autonomy, delegation, budget and write paths, validated by the engine as you
 * type, with the engine's own summary of what the agent can do beside it.
 * Everything except the name, which is the identity the rest of the system
 * refers to — renaming would be a create and a delete wearing one button.
 * Built-ins are read-only and say so rather than offering controls that
 * refuse; they can be duplicated as yours, and switched off, because "not
 * this one" is a real thing to mean and deleting something that returns on
 * the next install is not an answer.
 *
 * @module components/settings/AgentsPane
 */

import React, { useCallback, useEffect, useState } from 'react';
import { api, type AgentSpec } from '../../api';
import { useStore } from '../../store';
import { AgentBuilder } from './AgentBuilder';
import { AgentVerify, CertBadge } from './AgentVerify';
import { EMPTY_DRAFT, draftOf, duplicateDraft, type AgentDraft } from '../../agent-builder';

export function AgentsPane({ onClose }: { onClose?: () => void }): React.ReactElement {
  const [agents, setAgents] = useState<AgentSpec[]>([]);
  const [note, setNote] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  /** What the builder is showing: an agent being edited, or a new draft (key `+new`). */
  const [editing, setEditing] = useState<{ key: string; draft: AgentDraft; existing: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<Record<string, string>>({});
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

  /** The engine's own "what this agent can do", fetched when a row is opened. */
  const toggleOpen = (name: string): void => {
    setEditing(null);
    const next = open === name ? null : name;
    setOpen(next);
    if (next && !summary[next]) {
      void api.manage('agents', { action: 'effective', name: next })
        .then(r => setSummary(s => ({ ...s, [next]: r.result ?? r.error ?? '' })))
        .catch(() => {});
    }
  };

  const mine = agents.filter(a => a.source !== 'builtin');
  const builtin = agents.filter(a => a.source === 'builtin');

  const builder = (key: string): React.ReactElement | null => editing?.key === key ? (
    <div className="border-t border-aico-border px-3 py-2.5">
      <AgentBuilder
        initial={editing.draft}
        existing={editing.existing}
        onDone={async (saved, name) => {
          setEditing(null);
          if (saved) {
            setNote({ tone: 'good', text: `Saved @${name ?? editing.draft.name}.` });
            setSummary({});
            await refresh();
          }
        }}
      />
    </div>
  ) : null;

  const row = (agent: AgentSpec): React.ReactElement => (
    <li key={agent.name} className="rounded-xl border border-aico-border">
      <div className="flex items-start gap-2 px-3 py-2">
        <button onClick={() => toggleOpen(agent.name)} className="min-w-0 flex-1 text-left">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[12px] text-aico-primary">{agent.name}</span>
            {agent.source === 'project' && (
              <span className="rounded bg-aico-hover px-1.5 py-0.5 text-[10px] text-aico-muted">this project</span>
            )}
            {agent.autonomy && (
              <span className="rounded bg-aico-hover px-1.5 py-0.5 text-[10px] text-aico-muted">{agent.autonomy}</span>
            )}
            <CertBadge status={agent.certification?.status} {...(agent.certification?.text ? { text: agent.certification.text } : {})} />
            {agent.format === 'json' && (
              <span className="rounded bg-aico-hover px-1.5 py-0.5 text-[10px] text-aico-muted" title="Saved as .md the next time it is edited">legacy JSON</span>
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
              onClick={() => { setOpen(null); setEditing({ key: agent.name, draft: draftOf(agent), existing: true }); }}
              disabled={busy}
              className="rounded-lg px-2 py-1 text-[11px] text-aico-muted transition-colors
                         hover:bg-aico-hover hover:text-aico-primary disabled:opacity-40"
            >
              Edit
            </button>
          )}
          <button
            onClick={() => { setOpen(null); setEditing({ key: agent.name, draft: duplicateDraft(agent, agents.map(a => a.name)), existing: false }); }}
            disabled={busy}
            className="rounded-lg px-2 py-1 text-[11px] text-aico-muted transition-colors
                       hover:bg-aico-hover hover:text-aico-primary disabled:opacity-40"
          >
            Duplicate
          </button>
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

      {builder(agent.name)}

      {open === agent.name && (
        <div className="border-t border-aico-border px-3 py-2 text-[11px] leading-[18px]">
          <p className="mb-1 font-medium text-aico-secondary">What it can do</p>
          <pre className="whitespace-pre-wrap font-sans text-aico-secondary">{summary[agent.name] ?? 'Working it out…'}</pre>
          {agent.warnings?.length ? (
            <ul className="mt-1">{agent.warnings.map(w => <li key={w} className="text-aico-warning">⚠ {w}</li>)}</ul>
          ) : null}
          <div className="mt-2 border-t border-aico-border pt-2">
            <p className="mb-1 font-medium text-aico-secondary">Verify</p>
            <AgentVerify name={agent.name} {...(agent.certification ? { status: agent.certification.status, statusText: agent.certification.text } : {})} onDone={refresh} />
          </div>
          {agent.source === 'builtin' && (
            <p className="mt-1 text-aico-muted">
              Built in, so it cannot be edited or deleted — it would return on the next install.
              Duplicate it to make your own, or disable it.
            </p>
          )}
        </div>
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
          Ones you made. Saved as Markdown in Claude Code's agent format; their tools, autonomy,
          budget and write paths are enforced by the engine, not just described.
        </p>

        {mine.length > 0
          ? <ul className="mt-2 space-y-1">{mine.map(row)}</ul>
          : (
            <p className="mt-2 text-[12px] text-aico-muted">
              None yet. An agent is a file: a description that says when to hand it work, its
              instructions, and the tools it may use.
            </p>
          )}

        {note && (
          <p className={`mt-2 whitespace-pre-wrap rounded-lg px-2.5 py-1.5 text-[12px] ${
            note.tone === 'good' ? 'bg-aico-success/10 text-aico-success' : 'bg-aico-danger/10 text-aico-danger'
          }`}>
            {note.text}
          </p>
        )}

        <div className="mt-2 flex flex-wrap gap-3">
          <button
            onClick={() => { setOpen(null); setEditing({ key: '+new', draft: { ...EMPTY_DRAFT }, existing: false }); }}
            className="text-[12px] text-aico-accent underline underline-offset-2 hover:opacity-80"
          >
            Define one myself
          </button>
          {/*
            Defining an agent well is real work, and a conversation suits it:
            this hands over a brief in a chat of its own.
          */}
          <button
            onClick={() => {
              askAgentFor(
                'Create a new agent for me. Ask what kind of work it should take on, then use '
                + 'AgentManage to define it — a description precise enough that you would know when '
                + 'to hand it a task, its instructions, only the tools it needs, any skills it should '
                + 'reach for, an autonomy ceiling and a budget. Validate it first and show me what it can do.',
              );
              onClose?.();
            }}
            className="text-[12px] text-aico-accent underline underline-offset-2 hover:opacity-80"
          >
            Make one with the agent →
          </button>
        </div>
        {editing?.key === '+new' && <div className="mt-2">{builder('+new')}</div>}
      </section>

      <section>
        <h3 className="text-[13px] font-medium text-aico-primary">
          Built in <span className="text-aico-muted">({builtin.length})</span>
        </h3>
        <p className="mt-0.5 text-[12px] text-aico-muted">
          Shipped with AICO as examples of bounded specialists. Read-only — duplicate one to make it yours.
        </p>
        <ul className="mt-2 space-y-1">{builtin.map(row)}</ul>
      </section>
    </div>
  );
}
