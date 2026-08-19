/**
 * Connecting an MCP server, without reading a spec first.
 *
 * MCP servers arrive in exactly two shapes and people already know which one
 * they have: a command to run, or a URL to call. Asking for that — rather than
 * for a transport type, an argv array and an env map — is the difference
 * between connecting a server and reading documentation about connecting one.
 *
 * The command form is a single line, pasted from whatever README sent you here,
 * and split the way a shell would. That is how the string arrives, so that is
 * what the field should take.
 *
 * Every connected server's tools become the agent's tools, which is the whole
 * reason to do this — so the panel says how many arrived, not merely that
 * something connected.
 *
 * @module components/settings/McpPane
 */

import React, { useCallback, useEffect, useState } from 'react';
import { api, type SystemSnapshot } from '../../api';

type Shape = 'command' | 'url';

/** Split a pasted command line the way a shell would, honouring quotes. */
export function splitCommand(line: string): { command: string; args: string[] } {
  const parts = line.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const clean = parts.map(p => p.replace(/^["']|["']$/g, ''));
  return { command: clean[0] ?? '', args: clean.slice(1) };
}

export function McpPane(): React.ReactElement {
  const [servers, setServers] = useState<SystemSnapshot['mcpServers']>([]);
  const [tools, setTools] = useState<number | null>(null);
  const [shape, setShape] = useState<Shape>('command');
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const snapshot = await api.system();
      setServers(snapshot.mcpServers ?? []);
    } catch { /* the panel is not worth an error of its own */ }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const connect = async (): Promise<void> => {
    const serverName = name.trim();
    const target = value.trim();
    if (!serverName || !target || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const payload = shape === 'url'
        ? { name: serverName, type: target.includes('/sse') ? 'sse' as const : 'http' as const, url: target }
        : { name: serverName, type: 'stdio' as const, ...splitCommand(target) };
      const result = await api.addMcpServer(payload);
      if (result.ok) {
        setNote({ tone: 'good', text: result.result ?? `Connected ${serverName}.` });
        setName('');
        setValue('');
        await refresh();
      } else {
        setNote({ tone: 'bad', text: result.error ?? 'could not connect' });
      }
    } finally { setBusy(false); }
  };

  const reload = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await api.reloadMcpServers();
      setNote(result.ok
        ? { tone: 'good', text: result.result ?? 'Reloaded.' }
        : { tone: 'bad', text: result.error ?? 'reload failed' });
      await refresh();
    } finally { setBusy(false); }
  };

  const disconnect = async (server: string): Promise<void> => {
    const result = await api.removeMcpServer(server);
    setNote(result.ok
      ? { tone: 'good', text: `Removed ${server}.` }
      : { tone: 'bad', text: result.error ?? 'could not remove it' });
    setConfirming(null);
    await refresh();
  };

  return (
    <div className="space-y-4">
      <section>
        <h3 className="text-[13px] font-medium text-aico-primary">Connect a server</h3>
        <p className="mt-0.5 text-[12px] text-aico-muted">
          Its tools become the agent's tools. Paste whatever the server's README gave you —
          a command to run, or a URL to call.
        </p>

        <div className="mt-2 flex gap-1">
          {(['command', 'url'] as Shape[]).map(option => (
            <button
              key={option}
              onClick={() => setShape(option)}
              className={`rounded-lg px-2.5 py-1 text-[12px] transition-colors ${
                shape === option
                  ? 'bg-aico-accent-soft text-aico-accent'
                  : 'text-aico-muted hover:bg-aico-hover'
              }`}
            >
              {option === 'command' ? 'A command' : 'A URL'}
            </button>
          ))}
        </div>

        <div className="mt-2 space-y-1.5">
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="name — letters, numbers, dashes"
            className="w-full rounded-lg border border-aico-border bg-aico-bg px-2.5 py-1.5
                       font-mono text-[12px] text-aico-primary placeholder:text-aico-muted
                       focus:border-aico-accent/40 focus:outline-none"
          />
          <input
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void connect(); }}
            placeholder={shape === 'command'
              ? 'npx -y @modelcontextprotocol/server-filesystem /some/path'
              : 'https://example.com/mcp'}
            className="w-full rounded-lg border border-aico-border bg-aico-bg px-2.5 py-1.5
                       font-mono text-[12px] text-aico-primary placeholder:text-aico-muted
                       focus:border-aico-accent/40 focus:outline-none"
          />
          <div className="flex gap-1.5">
            <button
              onClick={() => void connect()}
              disabled={busy || !name.trim() || !value.trim()}
              className="rounded-lg bg-aico-accent px-3 py-1.5 text-[12px] font-medium text-white
                         transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              Connect
            </button>
            <button
              onClick={() => void reload()}
              disabled={busy}
              className="rounded-lg px-3 py-1.5 text-[12px] text-aico-secondary
                         transition-colors hover:bg-aico-hover disabled:opacity-40"
            >
              Reload all
            </button>
          </div>
        </div>

        {note && (
          <p className={`mt-2 rounded-lg px-2.5 py-1.5 text-[12px] ${
            note.tone === 'good' ? 'bg-aico-success/10 text-aico-success' : 'bg-aico-danger/10 text-aico-danger'
          }`}>
            {note.text}
          </p>
        )}
      </section>

      <section>
        <h3 className="text-[13px] font-medium text-aico-primary">
          Connected <span className="text-aico-muted">({servers.length})</span>
        </h3>
        <ul className="mt-2 space-y-1">
          {servers.map(server => {
            const label = typeof server === 'string' ? server : String(server);
            return (
              <li key={label} className="rounded-xl border border-aico-border">
                <div className="flex items-center gap-2 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-aico-primary">
                    {label}
                  </span>
                  <button
                    onClick={() => setConfirming(label)}
                    className="shrink-0 rounded-lg px-2 py-1 text-[11px] text-aico-muted
                               transition-colors hover:bg-aico-danger/10 hover:text-aico-danger"
                  >
                    Remove
                  </button>
                </div>
                {confirming === label && (
                  <div className="border-t border-aico-border bg-aico-danger/5 px-3 py-2">
                    <p className="text-[12px] text-aico-primary">
                      Disconnect <span className="font-mono">{label}</span>? Its tools stop being
                      available to the agent.
                    </p>
                    <div className="mt-1.5 flex gap-1.5">
                      <button
                        onClick={() => void disconnect(label)}
                        className="rounded-lg bg-aico-danger px-2 py-1 text-[11px] font-medium text-white
                                   transition-opacity hover:opacity-90"
                      >
                        Disconnect
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
              </li>
            );
          })}
        </ul>
        {servers.length === 0 && (
          <p className="mt-2 text-[12px] text-aico-muted">
            None connected. The agent has its own tools regardless; MCP adds someone else's.
          </p>
        )}
        {tools !== null && <p className="mt-1 text-[11px] text-aico-muted">{tools} tools available.</p>}
      </section>
    </div>
  );
}
