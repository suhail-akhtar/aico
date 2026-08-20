/**
 * The specialists this installation can delegate to.
 *
 * An agent is a role you can hand work to, and the two things worth seeing at a
 * glance are what it is for and which skills it reaches for — the second is
 * what makes it a specialist rather than a system prompt with opinions.
 *
 * **Built-ins are shown but not editable**, and say so rather than offering
 * buttons that refuse. The switch is offered instead, because "I do not want
 * this one" is a real and common thing to mean, and deleting something that
 * comes back on the next install is not an answer.
 *
 * Creating one properly means writing goals, choosing tools, deciding what it
 * may delegate — real work, and a form is the wrong shape for it. So the offer
 * is to do it with the agent, which hands over a brief instead of a blank form.
 *
 * @module components/settings/AgentsPane
 */

import React, { useCallback, useEffect, useState } from 'react';
import { api, type AgentSpec } from '../../api';
import { useStore } from '../../store';

export function AgentsPane(): React.ReactElement {
  const [agents, setAgents] = useState<AgentSpec[]>([]);
  const [note, setNote] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const prefillComposer = useStore(s => s.prefillComposer);

  const refresh = useCallback(async () => {
    try { setAgents((await api.agents()).agents); }
    catch (err) { setNote({ tone: 'bad', text: err instanceof Error ? err.message : String(err) }); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const act = async (input: Record<string, unknown>): Promise<void> => {
    setBusy(true);
    try {
      const result = await api.manage('agents', input);
      setNote({
        tone: result.ok ? 'good' : 'bad',
        text: result.result ?? result.error ?? 'nothing came back',
      });
      setConfirming(null);
      await refresh();
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <section>
        <h3 className="text-[13px] font-medium text-aico-primary">
          Agents <span className="text-aico-muted">({agents.length})</span>
        </h3>
        <p className="mt-0.5 text-[12px] text-aico-muted">
          Each one can be handed a task on its own. The skills listed against an agent are the
          procedures it reaches for first.
        </p>

        <ul className="mt-2 space-y-1">
          {agents.map(agent => (
            <li key={agent.name} className="rounded-xl border border-aico-border">
              <div className="flex items-start gap-2 px-3 py-2">
                <button
                  onClick={() => setOpen(open === agent.name ? null : agent.name)}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-[12px] text-aico-primary">{agent.name}</span>
                    {agent.source === 'builtin' && (
                      <span className="rounded bg-aico-hover px-1.5 py-0.5 text-[10px] text-aico-muted">built in</span>
                    )}
                    {agent.source === 'project' && (
                      <span className="rounded bg-aico-hover px-1.5 py-0.5 text-[10px] text-aico-muted">this project</span>
                    )}
                    {!agent.enabled && (
                      <span className="rounded bg-aico-warning/15 px-1.5 py-0.5 text-[10px] text-aico-warning">off</span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[12px] leading-[17px] text-aico-secondary">{agent.description}</p>
                  {agent.skills?.length > 0 && (
                    <p className="mt-0.5 text-[11px] text-aico-muted">
                      reaches for {agent.skills.join(', ')}
                    </p>
                  )}
                </button>

                <div className="flex shrink-0 gap-1">
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
                    Delete <span className="font-mono">{agent.name}</span>? Disabling keeps the
                    definition and stops it being offered.
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
                </dl>
              )}
            </li>
          ))}
        </ul>

        {note && (
          <p className={`mt-2 whitespace-pre-wrap rounded-lg px-2.5 py-1.5 text-[12px] ${
            note.tone === 'good' ? 'bg-aico-success/10 text-aico-success' : 'bg-aico-danger/10 text-aico-danger'
          }`}>
            {note.text}
          </p>
        )}

        <button
          onClick={() => prefillComposer(
            'Create a new agent for me. Ask what kind of work it should take on, then use AgentManage '
            + 'to define it — a description precise enough that you would know when to hand it a task, '
            + 'the goals it is working towards, the tools it needs, and any skills it should reach for.',
          )}
          className="mt-2 text-[12px] text-aico-accent underline underline-offset-2 hover:opacity-80"
        >
          Or make one with the agent →
        </button>
      </section>
    </div>
  );
}
