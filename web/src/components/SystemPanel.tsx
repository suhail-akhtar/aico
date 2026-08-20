/**
 * Everything running outside the current turn.
 *
 * The engine can start work that outlives the conversation that asked for it —
 * background agents, scheduled jobs, worktrees held open for parallel edits.
 * Without a view like this those are invisible: an agent burning tokens in the
 * background is indistinguishable from nothing happening at all, and a
 * scheduled job that has been failing nightly for a week leaves no trace a user
 * would ever look at.
 *
 * Polled rather than streamed. These change on the order of seconds and are not
 * worth a second event channel with its own reconnect semantics.
 *
 * @module components/SystemPanel
 */

import React, { useEffect, useState } from 'react';
import { api, type AgentSpec } from '../api';
import { useStore } from '../store';

const POLL_MS = 3000;

export function SystemPanel(): React.ReactElement {
  const system = useStore(s => s.system);
  const refreshSystem = useStore(s => s.refreshSystem);

  useEffect(() => {
    void refreshSystem();
    const timer = setInterval(() => void refreshSystem(), POLL_MS);
    return () => clearInterval(timer);
  }, [refreshSystem]);

  if (!system) {
    return <div className="p-8 text-sm text-aico-muted">Loading system state…</div>;
  }

  const { backgroundAgents, cron, worktrees, skills, mcpServers, workspace } = system;

  return (
    <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6">
      <div className="mx-auto w-full max-w-5xl space-y-8">
        <header>
          <h1 className="text-xl font-semibold text-aico-primary">System</h1>
          <p className="mt-1 text-sm text-aico-secondary">
            Work the engine is doing outside this conversation.
          </p>
        </header>

        {workspace && (
          <section>
            <h2 className="mb-2 text-sm font-medium text-aico-secondary">Workspace</h2>
            <Row>
              <div className="text-xs text-aico-secondary">
                Where AICO writes artifacts, reports and scratch files that are not part of
                your project.
              </div>
              <div className="mt-1.5 break-all font-mono text-[11px] text-aico-primary">
                {workspace.root}
              </div>
              {workspace.sessionDir && (
                <div className="mt-1 break-all font-mono text-[11px] text-aico-muted">
                  this session: {workspace.sessionDir}
                </div>
              )}
              <div className="mt-1.5 text-[11px] text-aico-muted">
                {workspace.configured
                  ? 'Set by workspace.path in your settings.'
                  : 'Default location. Set workspace.path in settings to move it.'}
              </div>
            </Row>
          </section>
        )}

        <Section title="Background agents" count={backgroundAgents.length}>
          {backgroundAgents.length === 0 && <Empty>No background agents.</Empty>}
          {backgroundAgents.map(agent => (
            <Row key={agent.agentId}>
              <div className="flex items-start gap-3">
                <StatusDot status={agent.status} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-aico-primary">{agent.description}</div>
                  <div className="mt-0.5 text-xs text-aico-muted">
                    <span className="font-mono">{agent.model}</span>
                    {' · '}{agent.status}
                    {agent.currentTool && <> · {agent.currentTool}</>}
                    {' · '}{agent.toolCallCount} tool calls
                    {' · '}{elapsed(agent.startedAt, agent.completedAt)}
                  </div>
                  {agent.statusMessage && (
                    <div className="mt-1 text-xs text-aico-secondary">{agent.statusMessage}</div>
                  )}
                  {agent.error && (
                    <div className="mt-1 text-xs text-aico-danger">{agent.error}</div>
                  )}
                  {agent.resultPreview && (
                    <pre className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap rounded
                                    bg-aico-elevated p-2 font-mono text-[11px] text-aico-secondary">
                      {agent.resultPreview}
                    </pre>
                  )}
                </div>
                {(agent.status === 'running' || agent.status === 'queued') && (
                  <button
                    onClick={async () => {
                      await api.cancelBackgroundAgent(agent.agentId);
                      void refreshSystem();
                    }}
                    className="shrink-0 rounded border border-aico-danger/40 px-2 py-1 text-xs
                               text-aico-danger hover:bg-aico-danger/10"
                  >
                    Cancel
                  </button>
                )}
              </div>
            </Row>
          ))}
        </Section>

        <Section title="Scheduled jobs" count={cron.length}>
          {cron.length === 0 && <Empty>No scheduled jobs.</Empty>}
          {cron.map(job => (
            <Row key={job.id}>
              <div className="flex items-center gap-3">
                <span className={job.paused ? 'text-aico-muted' : 'text-aico-success'}>
                  {job.paused ? '⏸' : '●'}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-aico-primary">
                    {job.prompt ?? job.task ?? job.id}
                  </div>
                  <div className="mt-0.5 text-xs text-aico-muted">
                    <span className="font-mono">{job.schedule}</span>
                    {job.nextRun ? <> · next {new Date(job.nextRun).toLocaleString()}</> : null}
                  </div>
                </div>
                <button
                  onClick={async () => {
                    await api.cronAction(job.paused ? 'resume' : 'pause', job.id);
                    void refreshSystem();
                  }}
                  className="shrink-0 rounded border border-aico-hover px-2 py-1 text-xs
                             text-aico-secondary hover:bg-aico-hover"
                >
                  {job.paused ? 'Resume' : 'Pause'}
                </button>
                <button
                  onClick={async () => {
                    await api.cronAction('delete', job.id);
                    void refreshSystem();
                  }}
                  className="shrink-0 rounded border border-aico-danger/40 px-2 py-1 text-xs
                             text-aico-danger hover:bg-aico-danger/10"
                >
                  Delete
                </button>
              </div>
            </Row>
          ))}
        </Section>

        <Section title="Worktrees" count={worktrees.length}>
          {worktrees.length === 0 && <Empty>No worktrees checked out.</Empty>}
          {worktrees.map((tree, i) => (
            <Row key={String(tree.path ?? i)}>
              <div className="text-sm text-aico-primary">{String(tree.branch ?? 'detached')}</div>
              <div className="mt-0.5 truncate font-mono text-xs text-aico-muted">
                {String(tree.path ?? '')}
              </div>
            </Row>
          ))}
        </Section>

        <SubagentCatalog />

        <div className="grid gap-8 sm:grid-cols-2">
          <Section title="Skills" count={skills.length}>
            {skills.length === 0 && <Empty>No skills loaded.</Empty>}
            {skills.map(skill => (
              <Row key={skill.name}>
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-sm text-aico-primary">/{skill.name}</span>
                  {skill.builtin && (
                    <span className="rounded bg-aico-hover px-1.5 py-0.5 text-[10px] text-aico-muted">
                      built-in
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-xs text-aico-secondary">{skill.description}</div>
              </Row>
            ))}
          </Section>

          <Section title="MCP servers" count={mcpServers.length}>
            {mcpServers.length === 0 && <Empty>No MCP servers configured.</Empty>}
            {mcpServers.map(server => (
              <Row key={server.name}>
                <span className="font-mono text-sm text-aico-primary">{server.name}</span>
                {/* What it is contributing, not merely that it is configured. */}
                <span className="ml-auto text-xs text-aico-muted">
                  {server.enabled
                    ? `${server.health} · ${server.toolCount} tool${server.toolCount === 1 ? '' : 's'}`
                    : 'disabled'}
                </span>
              </Row>
            ))}
          </Section>
        </div>
      </div>
    </div>
  );
}

/**
 * The agents this harness can delegate to.
 *
 * Fetched once rather than polled: the catalogue changes when someone edits a
 * spec on disk, not while you watch. Each row expands because a one-line
 * description does not tell you whether an agent may delegate further or which
 * tools it is allowed — which is exactly what you need before handing it work.
 */
function SubagentCatalog(): React.ReactElement {
  const [agents, setAgents] = useState<AgentSpec[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    void api.agents().then(r => setAgents(r.agents)).catch(() => setAgents([]));
  }, []);

  return (
    <Section title="Subagents" count={agents?.length ?? 0}>
      {agents === null && <p className="text-xs text-aico-muted">Loading…</p>}
      {agents?.length === 0 && <p className="text-xs text-aico-muted">No agents defined.</p>}
      {agents?.map(agent => {
        const open = expanded === agent.name;
        return (
          <Row key={agent.name}>
            <button
              onClick={() => setExpanded(open ? null : agent.name)}
              className="flex w-full items-center gap-2 text-left"
            >
              <span className="text-aico-muted">{open ? '▾' : '▸'}</span>
              <span className="font-mono text-sm text-aico-primary">{agent.name}</span>
              {agent.canDelegate && (
                <span
                  className="rounded bg-aico-accent/15 px-1.5 py-0.5 text-[10px] text-aico-accent"
                  title="This agent may spawn further agents"
                >
                  delegates
                </span>
              )}
              {agent.source !== 'builtin' && (
                <span className="rounded bg-aico-info/15 px-1.5 py-0.5 text-[10px] text-aico-info">
                  {agent.source}
                </span>
              )}
              <div className="flex-1" />
              <span className="shrink-0 text-[10px] text-aico-muted">{agent.tools.length} tools</span>
            </button>
            <div className="mt-1 pl-5 text-xs text-aico-secondary">{agent.description}</div>

            {open && (
              <div className="mt-2 space-y-2 pl-5">
                <Detail label="Role">{agent.role}</Detail>
                {agent.goals.length > 0 && (
                  <Detail label="Goals">
                    <ul className="list-disc space-y-0.5 pl-4">
                      {agent.goals.map(goal => <li key={goal}>{goal}</li>)}
                    </ul>
                  </Detail>
                )}
                {agent.skills.length > 0 && (
                  <Detail label="Skills"><Chips items={agent.skills} /></Detail>
                )}
                <Detail label="Allowed tools"><Chips items={agent.tools} /></Detail>
              </div>
            )}
          </Row>
        );
      })}
    </Section>
  );
}

function Detail(
  { label, children }: { label: string; children: React.ReactNode },
): React.ReactElement {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-aico-muted">{label}</div>
      <div className="mt-0.5 text-xs text-aico-secondary">{children}</div>
    </div>
  );
}

function Chips({ items }: { items: string[] }): React.ReactElement {
  return (
    <div className="flex flex-wrap gap-1">
      {items.map(item => (
        <span key={item} className="rounded bg-aico-elevated px-1.5 py-0.5 font-mono text-[10px]">
          {item}
        </span>
      ))}
    </div>
  );
}

function Section(
  { title, count, children }: { title: string; count: number; children: React.ReactNode },
): React.ReactElement {
  return (
    <section>
      <h2 className="mb-2 flex items-center gap-2 text-sm font-medium text-aico-secondary">
        {title}
        <span className="rounded bg-aico-hover px-1.5 py-0.5 text-[10px] text-aico-muted">{count}</span>
      </h2>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function Row({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="rounded-lg border border-aico-hover bg-aico-surface p-3">{children}</div>;
}

function Empty({ children }: { children: React.ReactNode }): React.ReactElement {
  return <p className="text-xs text-aico-muted">{children}</p>;
}

function StatusDot({ status }: { status: string }): React.ReactElement {
  const colour =
    status === 'running' ? 'text-aico-success'
    : status === 'queued' ? 'text-aico-warning'
    : status === 'failed' ? 'text-aico-danger'
    : status === 'cancelled' ? 'text-aico-muted'
    : 'text-aico-info';
  return <span className={`${colour} ${status === 'running' ? 'animate-pulse-soft' : ''}`}>●</span>;
}

function elapsed(startedAt: number, completedAt?: number): string {
  const ms = (completedAt ?? Date.now()) - startedAt;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}
