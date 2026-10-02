/**
 * Settings → Tools: the custom tools a person has (design §5.2, §7.4) — list,
 * read, enable or disable, and test one.
 *
 * Deliberately minimal: there is no form editor here yet. A tool is a JSON
 * file the agent drafts with `ToolManage` (or a person writes); this panel is
 * where a person *reads* it — effect, the exact command with secrets by name,
 * validation errors — and decides. Enabling and testing go with the proof of
 * a person (decision gate), so the model, which can reach the API, cannot do
 * either for itself. Shared by the web portal and the desktop app.
 *
 * Test runs a read tool with the arguments typed here; any other effect shows
 * the exact argv and stops — it runs only from a turn, through its approval.
 *
 * @module components/settings/ToolsPane
 */

import React, { useCallback, useEffect, useState } from 'react';
import { api, type CustomToolRow } from '../../api';

const EFFECT_NOTE: Record<string, string> = {
  read: 'Read — runs without asking.',
  write: 'Write — follows the session\'s approval mode.',
  exec: 'Exec — runs a local process; follows the session\'s approval mode.',
  external: 'External — changes something off this machine; asked on first use (every use after web content).',
  destructive: 'Destructive — a person approves every call, with its preview; unattended (L4) runs park it in the inbox for you.',
};

const STATUS_LABEL: Record<CustomToolRow['status'], string> = {
  enabled: 'Enabled', draft: 'Draft', changed: 'Changed since enabled',
  disabled: 'Disabled', invalid: 'Invalid', untrusted: 'Project not trusted',
};

export function ToolsPane(): React.ReactElement {
  const [tools, setTools] = useState<CustomToolRow[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [args, setArgs] = useState('{}');
  const [out, setOut] = useState<{ name: string; ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try { setTools((await api.customTools()).tools); } catch { setTools([]); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const act = async (action: 'enable' | 'disable' | 'test' | 'delete', name: string): Promise<void> => {
    setBusy(true);
    try {
      let parsed: Record<string, unknown> | undefined;
      if (action === 'test') {
        try { parsed = JSON.parse(args || '{}') as Record<string, unknown>; } catch {
          setOut({ name, ok: false, text: 'Arguments must be a JSON object, e.g. {"path": "src"}.' });
          return;
        }
      }
      const r = await api.customToolAction(action, name, parsed);
      setOut({ name, ok: r.ok, text: r.result ?? r.error ?? '' });
      await refresh();
    } catch (e) {
      setOut({ name, ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (tools === null) return <p className="text-[12px] text-aico-muted">Loading…</p>;
  if (tools.length === 0) {
    return (
      <p className="max-w-xl text-[12px] leading-relaxed text-aico-secondary">
        No custom tools yet. A custom tool wraps one command or one HTTP call with typed parameters and an
        effect class — ask the agent to create one (it starts as a draft you enable here), or write
        <code className="mx-1 font-mono">~/.aico/tools/&lt;pack&gt;/&lt;name&gt;.tool.json</code>yourself.
        Anything with state is better written as an MCP server.
      </p>
    );
  }

  return (
    <ul className="space-y-1.5">
      {tools.map(t => {
        const key = `${t.scope}:${t.file}`;
        const expanded = open === key;
        const usable = t.status === 'enabled';
        return (
          <li key={key} className="rounded-xl border border-aico-border">
            <button
              type="button"
              onClick={() => { setOpen(expanded ? null : key); setOut(null); setArgs('{}'); }}
              aria-expanded={expanded}
              className="flex w-full items-center gap-2 px-3 py-2 text-left"
            >
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-[13px] text-aico-primary">{t.name}</span>
                  <span className="rounded bg-aico-hover px-1.5 text-[11px] text-aico-secondary">{t.scope === 'project' ? 'project' : 'yours'} · {t.pack}</span>
                  {t.def && <span className="rounded bg-aico-hover px-1.5 text-[11px] text-aico-secondary">{t.def.effect}</span>}
                </span>
                <span className={`block text-[12px] ${usable ? 'text-aico-muted' : 'text-aico-warning'}`}>
                  {usable ? '● ' : '○ '}{STATUS_LABEL[t.status]}{t.reason ? ` — ${t.reason}` : ''}
                </span>
              </span>
            </button>
            {expanded && (
              <div className="space-y-2 border-t border-aico-border px-3 py-2 text-[12px]">
                {t.def && <p className="text-aico-secondary">{t.def.description}</p>}
                {t.def && <p className="text-aico-muted">{EFFECT_NOTE[t.def.effect] ?? t.def.effect}{t.def.preview ? ` Preview on approval: ${t.def.preview.tool}.` : ''}</p>}
                {t.command && (
                  <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-aico-code px-2.5 py-1.5 font-mono text-[11.5px] text-aico-primary">{t.command}</pre>
                )}
                {t.errors.length > 0 && (
                  <ul className="space-y-0.5 text-aico-danger">{t.errors.map(e => <li key={e}>Error: {e}</li>)}</ul>
                )}
                {t.warnings.length > 0 && (
                  <ul className="space-y-0.5 text-aico-muted">{t.warnings.map(w => <li key={w}>Warning: {w}</li>)}</ul>
                )}
                <p className="font-mono text-[11px] text-aico-muted">{t.file}</p>
                {t.def && (
                  <div className="space-y-1.5">
                    <label className="block text-[11px] text-aico-muted" htmlFor={`args-${key}`}>
                      Test arguments (JSON){t.def.input_schema.properties ? ` — fields: ${Object.keys(t.def.input_schema.properties).join(', ') || 'none'}` : ''}
                    </label>
                    <textarea
                      id={`args-${key}`}
                      value={args}
                      onChange={e => setArgs(e.target.value)}
                      spellCheck={false}
                      className="h-16 w-full resize-y rounded-lg border border-aico-border bg-aico-bg px-2.5 py-1.5 font-mono text-[12px] text-aico-primary"
                    />
                  </div>
                )}
                <div className="flex flex-wrap gap-1.5">
                  {t.def && t.status !== 'enabled' && t.status !== 'untrusted' && (
                    <button type="button" disabled={busy} onClick={() => void act('enable', t.name)}
                      className="rounded-lg bg-aico-accent px-3 py-1.5 text-[12px] font-medium text-aico-on-accent transition-colors hover:bg-aico-accent-hover disabled:opacity-50">
                      {t.status === 'changed' ? 'Review and re-enable' : 'Enable'}
                    </button>
                  )}
                  {usable && (
                    <button type="button" disabled={busy} onClick={() => void act('disable', t.name)}
                      className="rounded-lg px-3 py-1.5 text-[12px] text-aico-secondary transition-colors hover:bg-aico-hover hover:text-aico-primary disabled:opacity-50">
                      Disable
                    </button>
                  )}
                  {t.def && (
                    <button type="button" disabled={busy} onClick={() => void act('test', t.name)}
                      className="rounded-lg px-3 py-1.5 text-[12px] text-aico-secondary transition-colors hover:bg-aico-hover hover:text-aico-primary disabled:opacity-50">
                      Test
                    </button>
                  )}
                  {t.scope === 'user' && (
                    <button type="button" disabled={busy} onClick={() => void act('delete', t.name)}
                      className="rounded-lg px-3 py-1.5 text-[12px] text-aico-secondary transition-colors hover:bg-aico-hover hover:text-aico-danger disabled:opacity-50">
                      Delete
                    </button>
                  )}
                </div>
                {out?.name === t.name && (
                  <pre role="status" className={`max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg px-2.5 py-1.5 font-mono text-[11.5px] ${
                    out.ok ? 'bg-aico-code text-aico-primary' : 'bg-aico-hover text-aico-danger'}`}>{out.text}</pre>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
