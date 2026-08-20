/**
 * Who you are talking to.
 *
 * A session normally reaches the orchestrator, which decides for itself whether
 * to do the work or hand it to a specialist. Sometimes you already know which
 * specialist you want, and going through the orchestrator to get there means
 * explaining your way to a decision you have already made.
 *
 * Choosing one here is **sticky for the conversation**, not for one message.
 * That is the whole difference from delegating: the persona is in the system
 * prompt for every turn, its assigned skills are in front of it, and its tool
 * list applies — so it stays in role instead of drifting back after the first
 * reply.
 *
 * Disabled agents are left out. Offering something and then refusing it is the
 * same broken promise the skill catalogue avoids.
 *
 * @module components/AgentPicker
 */

import React, { useEffect, useRef, useState } from 'react';
import { api, type AgentSpec } from '../api';
import { useStore } from '../store';

export function AgentPicker(): React.ReactElement | null {
  const [agents, setAgents] = useState<AgentSpec[]>([]);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  const current = useStore(s => s.sessionAgent);
  const setSessionAgent = useStore(s => s.setSessionAgent);
  const busy = useStore(s => s.busy);

  useEffect(() => {
    void api.agents()
      .then(r => setAgents(r.agents.filter(a => a.enabled)))
      .catch(() => { /* the picker is not worth an error of its own */ });
  }, []);

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent): void => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  if (agents.length === 0) return null;

  const choose = async (name: string | null): Promise<void> => {
    setOpen(false);
    await setSessionAgent(name);
  };

  const mine = agents.filter(a => a.source !== 'builtin');
  const builtin = agents.filter(a => a.source === 'builtin');

  const item = (agent: AgentSpec): React.ReactElement => (
    <button
      key={agent.name}
      onClick={() => void choose(agent.name)}
      className={`block w-full px-3 py-1.5 text-left transition-colors hover:bg-aico-hover ${
        current === agent.name ? 'bg-aico-accent-soft' : ''
      }`}
    >
      <span className={`font-mono text-[12px] ${
        current === agent.name ? 'text-aico-accent' : 'text-aico-primary'
      }`}>
        {agent.name}
      </span>
      <span className="mt-0.5 block text-[11px] leading-[15px] text-aico-muted">
        {agent.description}
      </span>
    </button>
  );

  return (
    <div ref={wrap} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        disabled={busy}
        title={current
          ? `Talking to ${current} — every turn, not just the next one`
          : 'Talk to one specialist instead of the orchestrator'}
        className={`rounded-lg px-2.5 py-1 text-[13px] transition-colors disabled:opacity-40 ${
          current
            ? 'bg-aico-accent-soft text-aico-accent'
            : 'text-aico-muted hover:bg-aico-hover hover:text-aico-secondary'
        }`}
      >
        {current ?? 'Orchestrator'}
      </button>

      {open && (
        <div className="absolute bottom-full right-0 z-20 mb-1.5 max-h-80 w-72 overflow-y-auto
                        rounded-xl border border-aico-border bg-aico-bg py-1 shadow-lg">
          <button
            onClick={() => void choose(null)}
            className={`block w-full px-3 py-1.5 text-left transition-colors hover:bg-aico-hover ${
              current === null ? 'bg-aico-accent-soft' : ''
            }`}
          >
            <span className={`text-[12px] ${current === null ? 'text-aico-accent' : 'text-aico-primary'}`}>
              Orchestrator
            </span>
            <span className="mt-0.5 block text-[11px] leading-[15px] text-aico-muted">
              Decides for itself whether to do the work or hand it to a specialist.
            </span>
          </button>

          {mine.length > 0 && (
            <>
              <p className="mt-1 px-3 pb-0.5 pt-1.5 text-[10px] uppercase tracking-wide text-aico-muted">
                Yours
              </p>
              {mine.map(item)}
            </>
          )}

          <p className="mt-1 px-3 pb-0.5 pt-1.5 text-[10px] uppercase tracking-wide text-aico-muted">
            Built in
          </p>
          {builtin.map(item)}
        </div>
      )}
    </div>
  );
}
