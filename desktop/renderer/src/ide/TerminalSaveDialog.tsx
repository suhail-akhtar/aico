/**
 * "Save as…" for commands picked from a terminal's history: a script file, a
 * custom tool draft, or a request to schedule them. Everything is previewed
 * here before anything is written; the builders are pure
 * (desktop/shared/terminal-export.ts) and mask secret-looking values.
 *
 * A custom tool is written as a DRAFT through the same `manage` route the
 * agent uses — it does nothing until a person enables it in Settings → Tools
 * (ADR 0009). A schedule is a chat request; the agent's scheduling tool
 * confirms it.
 *
 * @module desktop/renderer/ide/TerminalSaveDialog
 */

import React, { useEffect, useMemo, useState } from 'react';
import { api } from '@web/api';
import { Modal } from '@/shell/Modal';
import { invoke } from '@/desktop';
import { Icon } from '@/lib/icons';
import { cls } from '@/lib/util';
import { toast, useDesk } from '@/state/desk';
import { newChat } from '@/chat/actions';
import type { CommandRecord } from '@desk/terminal-integration';
import {
  buildCustomTool, buildSchedulePrompt, buildScript, suggestToolName, tokenizeCommand, type ToolDraft,
} from '@desk/terminal-export';
import { samePath } from '@/lib/project-paths';

type Mode = 'script' | 'tool' | 'schedule';
const EFFECTS: Array<ToolDraft['effect']> = ['read', 'write', 'exec', 'external', 'destructive'];

export function TerminalSaveDialog({ open, onClose, records, tabTitle, scriptKind, projectDir }: {
  open: boolean; onClose: () => void; records: CommandRecord[]; tabTitle: string; scriptKind: 'ps1' | 'sh'; projectDir: string | null;
}): React.ReactElement | null {
  const [mode, setMode] = useState<Mode>('script');
  const [kind, setKind] = useState<'ps1' | 'sh'>(scriptKind);
  const [toolName, setToolName] = useState('');
  const [description, setDescription] = useState('');
  const [effect, setEffect] = useState<ToolDraft['effect']>('exec');
  const [params, setParams] = useState<Record<number, string>>({});
  const [schedule, setSchedule] = useState('every weekday at 9:00');
  const [busy, setBusy] = useState(false);

  const one = records.length === 1 ? records[0]! : null;
  const tokens = useMemo(() => (one ? tokenizeCommand(one.command) : null), [one]);
  // Reset when the dialog opens — only then: `records` is a fresh array on
  // every parent render, and resetting on it snapped the tab back to Script
  // whenever anything re-rendered (found in the live walkthrough).
  useEffect(() => {
    if (!open) return;
    setKind(scriptKind); setParams({}); setBusy(false); setMode('script');
    setToolName(tokens?.ok ? suggestToolName(tokens.argv) : '');
    setDescription(one ? `Runs \`${one.command.slice(0, 80)}\`.` : '');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const script = useMemo(() => buildScript({
    commands: records.map(r => ({ command: r.command, cwd: r.cwd })), kind, title: tabTitle, date: new Date().toISOString().slice(0, 10),
  }), [records, kind, tabTitle]);
  const tool = useMemo(() => (one ? buildCustomTool({
    command: one.command, name: toolName, description, effect,
    params: Object.entries(params).map(([i, name]) => ({ index: Number(i), name })),
    cwd: projectDir && samePath(one.cwd, projectDir) ? '${workspace}' : one.cwd,
  }) : null), [one, toolName, description, effect, params, projectDir]);
  const sched = useMemo(() => buildSchedulePrompt({ commands: records.map(r => ({ command: r.command, cwd: r.cwd })), schedule }), [records, schedule]);

  if (!open) return null;

  const saveScript = async (): Promise<void> => {
    setBusy(true);
    try {
      const file = await invoke<string | null>('term:save-script', { defaultDir: projectDir ?? undefined, name: `commands.${kind}`, content: script.text });
      if (file) { toast.success('Script saved', file); onClose(); }
    } catch (e) { toast.error('Could not save', (e as Error).message); } finally { setBusy(false); }
  };
  const saveTool = async (): Promise<void> => {
    if (!tool?.ok) return;
    setBusy(true);
    try {
      const r = await api.manage('tools', { action: 'create', pack: 'terminal', definition: tool.def as unknown as Record<string, unknown> });
      const text = r.error ?? r.result ?? '';
      if (!r.ok || /^Not written/i.test(text)) { toast.error('Tool not saved', text.slice(0, 300) || 'The engine refused it.'); return; }
      useDesk.getState().toast({ kind: 'success', title: 'Custom tool draft saved', body: 'Review and enable it in Settings → Tools before the agent can use it.', action: { label: 'Open', run: () => useDesk.getState().openSettings('tools') } });
      onClose();
    } catch (e) { toast.error('Could not save the tool', (e as Error).message); } finally { setBusy(false); }
  };
  const askSchedule = (): void => {
    newChat({ prompt: sched.text, send: true });
    onClose();
  };

  const masked = mode === 'script' ? script.masked : mode === 'schedule' ? sched.masked : 0;
  const preview = mode === 'script' ? script.text : mode === 'schedule' ? sched.text : tool?.ok ? JSON.stringify(tool.def, null, 2) : '';

  return (
    <Modal open={open} onClose={onClose} title={`Save ${records.length} command${records.length === 1 ? '' : 's'} as…`} width={720}>
      <div className="flex min-h-0 flex-col gap-3 px-5 pb-5 pt-2 text-[13px]">
        <div className="flex gap-1 rounded-lg bg-aico-hover/60 p-1" role="tablist">
          {([['script', 'Script file', 'file-text'], ['tool', 'Custom tool', 'wrench'], ['schedule', 'Scheduled job', 'clock']] as const).map(([id, label, icon]) => (
            <button key={id} role="tab" aria-selected={mode === id}
              className={cls('flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[12.5px]', mode === id ? 'bg-aico-bg text-aico-primary shadow-sm' : 'text-aico-muted hover:text-aico-primary')}
              onClick={() => setMode(id)}>
              <Icon name={icon} size={13} />{label}
            </button>
          ))}
        </div>

        {mode === 'script' && (
          <div className="flex items-center gap-2">
            <span className="text-aico-muted">Format</span>
            <select className="input h-8 w-48" value={kind} onChange={e => setKind(e.target.value as 'ps1' | 'sh')}>
              <option value="ps1">PowerShell (.ps1)</option>
              <option value="sh">bash (.sh)</option>
            </select>
            <span className="text-[12px] text-aico-muted">You choose where to save it next.</span>
          </div>
        )}

        {mode === 'tool' && !one && <p className="text-aico-secondary">A custom tool wraps one command. Select a single command in the history — or save these as a script first and wrap the script.</p>}
        {mode === 'tool' && one && tokens && !tokens.ok && <p className="rounded-lg border border-aico-border-subtle p-2.5 text-aico-secondary">{tokens.error}</p>}
        {mode === 'tool' && one && tokens?.ok && (
          <div className="space-y-2.5">
            <div>
              <div className="mb-1 text-[12px] text-aico-muted">Click an argument to make it a parameter the agent fills in (the program itself stays fixed).</div>
              <div className="flex flex-wrap gap-1.5 font-mono text-[12px]">
                {tokens.argv.map((tok, i) => (
                  params[i] !== undefined ? (
                    <span key={i} className="flex items-center gap-1 rounded-md border border-aico-accent/60 bg-aico-accent/10 px-1.5 py-0.5">
                      <span className="text-aico-accent">{'{'}</span>
                      <input className="w-24 bg-transparent outline-none" value={params[i]} aria-label={`Parameter name for ${tok}`}
                        onChange={e => setParams(p => ({ ...p, [i]: e.target.value.replace(/[^A-Za-z0-9_]/g, '') }))} />
                      <span className="text-aico-accent">{'}'}</span>
                      <button className="text-aico-muted hover:text-aico-primary" aria-label="Keep as fixed text" onClick={() => setParams(p => { const n = { ...p }; delete n[i]; return n; })}><Icon name="x" size={11} /></button>
                    </span>
                  ) : (
                    <button key={i} disabled={i === 0} title={i === 0 ? 'The program is fixed' : 'Make this a parameter'}
                      className={cls('rounded-md border border-aico-border-subtle px-1.5 py-0.5', i === 0 ? 'opacity-70' : 'hover:border-aico-accent hover:text-aico-accent')}
                      onClick={() => setParams(p => ({ ...p, [i]: `arg${i}` }))}>{tok}</button>
                  )
                ))}
              </div>
            </div>
            <div className="flex gap-2">
              <label className="block flex-1"><span className="mb-1 block text-[12px] text-aico-muted">Name</span>
                <input className="input h-8 w-full font-mono" value={toolName} onChange={e => setToolName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))} /></label>
              <label className="block w-40"><span className="mb-1 block text-[12px] text-aico-muted">Effect</span>
                <select className="input h-8 w-full" value={effect} onChange={e => setEffect(e.target.value as ToolDraft['effect'])}>
                  {EFFECTS.map(x => <option key={x} value={x}>{x}</option>)}
                </select></label>
            </div>
            <label className="block"><span className="mb-1 block text-[12px] text-aico-muted">What it does (the agent reads this)</span>
              <input className="input h-8 w-full" value={description} onChange={e => setDescription(e.target.value)} /></label>
            {tool && !tool.ok && <p className="text-[12.5px] text-aico-danger">{tool.error}</p>}
          </div>
        )}

        {mode === 'schedule' && (
          <label className="block"><span className="mb-1 block text-[12px] text-aico-muted">How often</span>
            <input className="input h-8 w-full" value={schedule} onChange={e => setSchedule(e.target.value)} placeholder="every weekday at 9:00" /></label>
        )}

        {preview && (
          <div className="min-h-0">
            <div className="mb-1 flex items-center gap-2 text-[12px] text-aico-muted">
              Preview{mode === 'tool' ? ' — a draft; enable it in Settings → Tools' : mode === 'schedule' ? ' — sent to the agent, which confirms the schedule' : ''}
              {masked > 0 && <span className="rounded bg-aico-hover px-1.5 py-px text-aico-secondary">{masked} secret-looking value{masked === 1 ? '' : 's'} masked</span>}
            </div>
            <pre className="thin-scroll max-h-64 overflow-auto rounded-lg border border-aico-border-subtle bg-aico-hover/40 p-3 font-mono text-[12px] leading-relaxed">{preview}</pre>
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <span className="mr-auto text-[12px] text-aico-muted">Commands only — output is never saved.</span>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          {mode === 'script' && <button className="btn-primary" disabled={busy || !records.length} onClick={() => void saveScript()}><Icon name="save" size={14} />Save script…</button>}
          {mode === 'tool' && <button className="btn-primary" disabled={busy || !tool?.ok} onClick={() => void saveTool()}><Icon name="wrench" size={14} />Save tool draft</button>}
          {mode === 'schedule' && <button className="btn-primary" disabled={!records.length} onClick={askSchedule}><Icon name="clock" size={14} />Ask AICO to schedule</button>}
        </div>
      </div>
    </Modal>
  );
}
