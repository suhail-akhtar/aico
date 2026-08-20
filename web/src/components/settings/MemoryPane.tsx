/**
 * What the agent has been asked to remember, and how to make it forget.
 *
 * Memory that cannot be inspected is the worst kind: it changes answers for
 * reasons nobody can see, and the only way to find out what it holds is to
 * catch it acting on something. So the whole store is on one screen, plainly,
 * with a delete beside every line.
 *
 * **Scope is shown on every entry, not just filtered by.** The difference
 * between "everywhere", "this project" and "this chat" is the difference
 * between a useful memory and one that follows you into unrelated work, and it
 * is the thing most likely to be wrong. A badge is cheaper than finding out
 * later.
 *
 * @module components/settings/MemoryPane
 */

import React, { useCallback, useEffect, useState } from 'react';
import { api, type MemorySummary } from '../../api';

type Scope = 'all' | 'global' | 'project' | 'session';

const SCOPE_NOTE: Record<Exclude<Scope, 'all'>, string> = {
  global: 'applies everywhere',
  project: 'this project only',
  session: 'this conversation only',
};

export function MemoryPane(): React.ReactElement {
  const [memories, setMemories] = useState<MemorySummary[]>([]);
  const [scope, setScope] = useState<Scope>('all');
  const [text, setText] = useState('');
  const [newScope, setNewScope] = useState<Exclude<Scope, 'all'>>('project');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const refresh = useCallback(async (which: Scope) => {
    try { setMemories((await api.memories(which)).memories); }
    catch (err) { setNote({ tone: 'bad', text: err instanceof Error ? err.message : String(err) }); }
  }, []);

  useEffect(() => { void refresh(scope); }, [refresh, scope]);

  const act = async (input: Record<string, unknown>): Promise<void> => {
    setBusy(true);
    try {
      const result = await api.manage('memory', input);
      setNote({ tone: result.ok ? 'good' : 'bad', text: result.result ?? result.error ?? 'nothing came back' });
      setConfirming(null);
      await refresh(scope);
    } finally { setBusy(false); }
  };

  const save = async (): Promise<void> => {
    if (!text.trim() || busy) return;
    await act({ action: 'remember', text: text.trim(), scope: newScope });
    setText('');
  };

  return (
    <div className="space-y-4">
      <section>
        <h3 className="text-[13px] font-medium text-aico-primary">Remember something</h3>
        <p className="mt-0.5 text-[12px] text-aico-muted">
          A fact that will still be true next week. The agent reads these at the start of every turn.
        </p>

        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save(); }}
          rows={2}
          placeholder="e.g. this repo deploys on Fridays only"
          className="mt-2 w-full resize-y rounded-lg border border-aico-border bg-aico-bg px-2.5 py-1.5
                     text-[12px] text-aico-primary placeholder:text-aico-muted
                     focus:border-aico-accent/40 focus:outline-none"
        />

        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {(['global', 'project', 'session'] as const).map(option => (
            <button
              key={option}
              onClick={() => setNewScope(option)}
              title={SCOPE_NOTE[option]}
              className={`rounded-lg px-2.5 py-1 text-[12px] transition-colors ${
                newScope === option ? 'bg-aico-accent-soft text-aico-accent' : 'text-aico-muted hover:bg-aico-hover'
              }`}
            >
              {option}
            </button>
          ))}
          <span className="text-[11px] text-aico-muted">{SCOPE_NOTE[newScope]}</span>
          <button
            onClick={() => void save()}
            disabled={busy || !text.trim()}
            className="ml-auto rounded-lg bg-aico-accent px-3 py-1.5 text-[12px] font-medium text-white
                       transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            Remember
          </button>
        </div>

        {note && (
          <p className={`mt-2 whitespace-pre-wrap rounded-lg px-2.5 py-1.5 text-[12px] ${
            note.tone === 'good' ? 'bg-aico-success/10 text-aico-success' : 'bg-aico-danger/10 text-aico-danger'
          }`}>
            {note.text}
          </p>
        )}
      </section>

      <section>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[13px] font-medium text-aico-primary">
            Remembered <span className="text-aico-muted">({memories.length})</span>
          </h3>
          <div className="ml-auto flex gap-1">
            {(['all', 'global', 'project', 'session'] as const).map(option => (
              <button
                key={option}
                onClick={() => setScope(option)}
                className={`rounded-lg px-2 py-0.5 text-[11px] transition-colors ${
                  scope === option ? 'bg-aico-accent-soft text-aico-accent' : 'text-aico-muted hover:bg-aico-hover'
                }`}
              >
                {option}
              </button>
            ))}
          </div>
        </div>

        <ul className="mt-2 space-y-1">
          {memories.map(memory => (
            <li key={`${memory.scope}-${memory.id}`} className="rounded-xl border border-aico-border">
              <div className="flex items-start gap-2 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className={`text-[12px] leading-[17px] ${
                    memory.enabled ? 'text-aico-primary' : 'text-aico-muted line-through decoration-1'
                  }`}>{memory.text}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-aico-muted">
                    <span className="rounded bg-aico-hover px-1.5 py-0.5">{memory.scope}</span>
                    {!memory.enabled && (
                      <span className="rounded bg-aico-warning/15 px-1.5 py-0.5 text-aico-warning">silenced</span>
                    )}
                    <span className="font-mono">{memory.id}</span>
                    {memory.tags.map(tag => <span key={tag} className="text-aico-muted">#{tag}</span>)}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  {/*
                    Silencing sits beside forgetting because it is usually what
                    was meant: a fact that is true again next month costs
                    nothing to keep, and forgetting is the one action with
                    nothing to undo it.
                  */}
                  <button
                    onClick={() => void act({ action: memory.enabled ? 'disable' : 'enable', id: memory.id })}
                    className="rounded-lg px-2 py-1 text-[11px] text-aico-muted
                               transition-colors hover:bg-aico-hover hover:text-aico-primary"
                  >
                    {memory.enabled ? 'Silence' : 'Restore'}
                  </button>
                  <button
                    onClick={() => setConfirming(memory.id)}
                    className="rounded-lg px-2 py-1 text-[11px] text-aico-muted
                               transition-colors hover:bg-aico-danger/10 hover:text-aico-danger"
                  >
                    Forget
                  </button>
                </div>
              </div>

              {confirming === memory.id && (
                <div className="border-t border-aico-border bg-aico-danger/5 px-3 py-2">
                  <p className="text-[12px] text-aico-primary">
                    Forget this? It is deleted from disk. Silencing keeps it and stops the agent
                    being told it.
                  </p>
                  <div className="mt-1.5 flex gap-1.5">
                    <button
                      onClick={() => void act({ action: 'forget', id: memory.id })}
                      className="rounded-lg bg-aico-danger px-2 py-1 text-[11px] font-medium text-white
                                 transition-opacity hover:opacity-90"
                    >
                      Forget it
                    </button>
                    <button
                      onClick={() => setConfirming(null)}
                      className="rounded-lg px-2 py-1 text-[11px] text-aico-secondary transition-colors hover:bg-aico-hover"
                    >
                      Keep it
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>

        {memories.length === 0 && (
          <p className="mt-2 text-[12px] text-aico-muted">
            Nothing remembered {scope === 'all' ? 'that applies here' : `at ${scope} scope`}. The agent
            works fine without any — memory is for what you would otherwise have to repeat.
          </p>
        )}
      </section>
    </div>
  );
}
