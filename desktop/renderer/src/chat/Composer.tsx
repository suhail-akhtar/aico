/**
 * The composer.
 *
 * ChatGPT's pill — "+", the prompt, Think, and a round send button that turns
 * into Stop — with Antigravity's controls underneath: the model, how much the
 * agent asks before acting, the project the chat works in, and how full the
 * context is.
 *
 * While a turn runs, Enter *steers* it (delivered at the next step) and
 * Ctrl+Enter *queues* a follow-up for when it finishes — the same semantics as
 * every other AICO client.
 *
 * @module desktop/renderer/chat/Composer
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '@web/store';
import { api } from '@web/api';
import { useDesk, go, toast } from '@/state/desk';
import { Icon } from '@/lib/icons';
import { basename, bytes, cls } from '@/lib/util';
import { MenuButton, MenuItem, MenuSep, Popover } from '@/shell/Popover';
import { desktop, isDesktop } from '@/desktop';
import { setSendOptions, useSendOptions, type SendOptions } from './actions';
import { useCommands } from '@/plugins/registry';

export function Composer({ home }: { home?: boolean }): React.ReactElement {
  const busy = useStore(s => s.busy);
  const submit = useStore(s => s.submit);
  const steer = useStore(s => s.steer);
  const followup = useStore(s => s.followup);
  const cancel = useStore(s => s.cancel);
  const prefill = useStore(s => s.composerPrefill);
  const attachments = useStore(s => s.pendingAttachments);
  const attachFiles = useStore(s => s.attachFiles);
  const detachFile = useStore(s => s.detachFile);
  const sessionId = useStore(s => s.sessionId);
  const opts = useSendOptions();
  const sendKey = useDesk(s => s.prefs.sendKey);
  const [text, setText] = useState('');
  const [uploading, setUploading] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const [slashAnchor, setSlashAnchor] = useState<HTMLElement | null>(null);

  // Drafts survive switching chats.
  const draftKey = `desk.draft.${sessionId}`;
  useEffect(() => {
    try { setText(localStorage.getItem(draftKey) ?? ''); } catch { setText(''); }
  }, [draftKey]);
  useEffect(() => {
    try { if (text) localStorage.setItem(draftKey, text); else localStorage.removeItem(draftKey); } catch { /* fine */ }
  }, [text, draftKey]);

  useEffect(() => {
    if (!prefill) return;
    setText(prefill.text);
    requestAnimationFrame(() => { ta.current?.focus(); ta.current?.setSelectionRange(prefill.text.length, prefill.text.length); });
  }, [prefill]);

  // Grow with the text, up to a third of the window.
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.36))}px`;
  }, [text]);

  useEffect(() => {
    const focus = (): void => ta.current?.focus();
    window.addEventListener('desk:focus-composer', focus);
    return () => window.removeEventListener('desk:focus-composer', focus);
  }, []);

  const send = useCallback(async (mode: 'send' | 'steer' | 'followup') => {
    const content = text.trim();
    if (!content && attachments.length === 0) return;
    // Cleared here, not by the effect: sending from home swaps this composer
    // for the transcript's, which would otherwise read the stale draft back.
    try { localStorage.removeItem(draftKey); } catch { /* fine */ }
    setText('');
    try {
      if (mode === 'send') {
        go('chat', { id: useStore.getState().sessionId });
        await submit(content || 'See the attached files.', { approval: opts.approval, effort: opts.effort, planMode: opts.planMode });
      } else if (mode === 'steer') await steer(content);
      else await followup(content);
    } catch (err) {
      setText(content);
      toast.error('Not sent', (err as Error).message);
    }
  }, [text, attachments.length, submit, steer, followup, opts, draftKey]);

  const upload = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setUploading(n => n + files.length);
    try { await attachFiles(files); }
    catch (err) { toast.error('Could not attach', (err as Error).message); }
    finally { setUploading(n => Math.max(0, n - files.length)); }
  }, [attachFiles]);

  const pickFiles = async (images?: boolean): Promise<void> => {
    if (!isDesktop) return;
    const picked = await desktop.dialog.pickFiles(images
      ? { title: 'Attach images', filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }] }
      : { title: 'Attach files' });
    const files: File[] = [];
    for (const p of picked) {
      try {
        const b64 = await desktop.dialog.readFileBase64(p.path);
        const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        files.push(new File([bin], p.name));
      } catch (err) { toast.error(`Could not read ${p.name}`, (err as Error).message); }
    }
    await upload(files);
  };

  const mentionFolder = async (): Promise<void> => {
    const dir = await desktop.dialog.pickFolder('Mention a folder');
    if (dir) setText(t => `${t}${t && !t.endsWith(' ') ? ' ' : ''}@${dir} `);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === '/' && text === '') { setSlashAnchor(e.currentTarget); }
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (busy) {
      if (e.shiftKey) return;
      e.preventDefault();
      if (!text.trim()) return;
      void send(ctrl ? 'followup' : 'steer');
      return;
    }
    const wantsSend = sendKey === 'enter' ? !e.shiftKey && !ctrl || ctrl : ctrl;
    if (wantsSend) { e.preventDefault(); void send('send'); }
  };

  const onPaste = (e: React.ClipboardEvent): void => {
    const files = [...e.clipboardData.files];
    if (files.length) { e.preventDefault(); void upload(files); }
  };

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault();
    setDragOver(false);
    const files = [...e.dataTransfer.files];
    if (files.length) void upload(files);
  };

  const canSend = (text.trim().length > 0 || attachments.length > 0) && uploading === 0;

  return (
    <div className={cls('mx-auto w-full', home ? 'max-w-[760px]' : 'max-w-column')}>
      <div
        className={cls('composer-shell relative rounded-[28px] border border-aico-border-subtle transition-colors', dragOver && 'border-aico-accent ring-2 ring-aico-accent/30')}
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        {(attachments.length > 0 || uploading > 0) && (
          <div className="flex flex-wrap gap-2 px-4 pt-3">
            {attachments.map(a => (
              <span key={a.id} className="flex items-center gap-2 rounded-xl border border-aico-border-subtle bg-aico-surface py-1.5 pl-2.5 pr-1 text-[12.5px]">
                <Icon name={a.mimeType.startsWith('image/') ? 'image' : 'file'} size={14} className="text-aico-secondary" />
                <span className="max-w-[180px] truncate">{a.name}</span>
                <span className="text-aico-muted">{bytes(a.bytes)}</span>
                <button className="icon-btn-sm h-5 w-5" onClick={() => void detachFile(a.id)} aria-label={`Remove ${a.name}`}><Icon name="x" size={12} /></button>
              </span>
            ))}
            {uploading > 0 && <span className="flex items-center gap-2 rounded-xl border border-aico-border-subtle px-2.5 py-1.5 text-[12.5px] text-aico-muted"><span className="spinner h-3 w-3" />Uploading…</span>}
          </div>
        )}
        <div className="flex items-end gap-1.5 px-2.5 py-2.5">
          <MenuButton className="icon-btn h-9 w-9 shrink-0 rounded-full" title="Add files and more" placement="top-start" width={260} button={<Icon name="plus" size={20} />}>
            {close => (
              <>
                <MenuItem icon="paperclip" label="Add files" onClick={() => { close(); void pickFiles(); }} />
                <MenuItem icon="image" label="Add images" onClick={() => { close(); void pickFiles(true); }} />
                <MenuItem icon="folder" label="Mention a folder" onClick={() => { close(); void mentionFolder(); }} />
                <MenuSep />
                <MenuItem icon="list" label="Plan first" hint="the agent proposes, you approve" checked={opts.planMode}
                  onClick={() => { close(); setSendOptions({ planMode: !opts.planMode }); }} />
                <MenuItem icon="globe" label="Use the built-in browser" onClick={() => { close(); setText(t => `${t}${t ? '\n' : ''}Use the built-in browser (browser_* tools) for this. `); }} />
                <MenuItem icon="chart" label="Answer with visuals" onClick={() => { close(); setText(t => `${t}${t ? '\n' : ''}Show the answer with charts, tables and widgets where they help. `); }} />
              </>
            )}
          </MenuButton>
          <textarea
            ref={ta}
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            rows={1}
            placeholder={busy ? 'Steer the agent — Enter sends now, Ctrl+Enter queues' : home ? 'Ask anything' : 'Ask anything, @ to mention, / for actions'}
            aria-label="Message"
            className="max-h-[36vh] min-h-[40px] flex-1 resize-none bg-transparent px-1.5 py-2 text-[15px] leading-6 text-aico-primary outline-none placeholder:text-aico-muted"
          />
          <ThinkToggle opts={opts} />
          {busy && !text.trim() ? (
            <button className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-aico-primary text-aico-bg transition-opacity hover:opacity-85"
              onClick={() => void cancel()} title="Stop" aria-label="Stop">
              <Icon name="stop" size={14} strokeWidth={2.5} />
            </button>
          ) : (
            <button
              className={cls('flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-all',
                canSend ? 'bg-aico-primary text-aico-bg hover:opacity-85' : 'bg-aico-hover text-aico-muted')}
              onClick={() => void send(busy ? 'steer' : 'send')}
              disabled={!canSend}
              title={busy ? 'Steer now' : 'Send'}
              aria-label={busy ? 'Steer now' : 'Send'}
            >
              <Icon name="send" size={17} strokeWidth={2.2} />
            </button>
          )}
        </div>
      </div>
      <ComposerChips />
      <SlashMenu anchor={slashAnchor} onClose={() => setSlashAnchor(null)} onPick={(t) => { setSlashAnchor(null); setText(''); t(); }} />
    </div>
  );
}

function ThinkToggle({ opts }: { opts: SendOptions }): React.ReactElement {
  const levels: Array<[SendOptions['effort'], string]> = [
    ['auto', 'Auto'], ['off', 'Off'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max'],
  ];
  const on = opts.effort !== 'auto' && opts.effort !== 'off';
  const label = levels.find(l => l[0] === opts.effort)?.[1] ?? 'Auto';
  return (
    <MenuButton
      className={cls('mb-0.5 flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[13.5px] transition-colors',
        on ? 'bg-aico-accent-soft text-aico-accent' : 'text-aico-secondary hover:bg-aico-hover')}
      title="How hard to think"
      placement="top-end"
      button={<><Icon name="think" size={16} /><span>{on ? `Think · ${label}` : 'Think'}</span></>}
    >
      {close => (
        <>
          <div className="px-2.5 pb-1 pt-1.5 text-[12px] text-aico-muted">Reasoning effort</div>
          {levels.map(([v, l]) => (
            <MenuItem key={v} label={l} checked={opts.effort === v} onClick={() => { close(); setSendOptions({ effort: v }); }} />
          ))}
        </>
      )}
    </MenuButton>
  );
}

function ComposerChips(): React.ReactElement {
  const opts = useSendOptions();
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1 px-2 text-[12.5px]">
      <ModelChip />
      <ApprovalChip opts={opts} />
      {opts.planMode && (
        <button className="chip border-aico-accent/40 text-aico-accent" onClick={() => setSendOptions({ planMode: false })} title="Plan first is on — click to turn off">
          <Icon name="list" size={13} /> Plan first <Icon name="x" size={11} />
        </button>
      )}
      <ProjectChip />
      <div className="flex-1" />
      <ContextMeter />
    </div>
  );
}

export function ModelChip(): React.ReactElement {
  const model = useStore(s => s.model);
  const fallback = useStore(s => s.defaultModel);
  const setModel = useStore(s => s.setModel);
  const [models, setModels] = useState<string[] | null>(null);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const shown = model ?? fallback ?? 'default model';

  useEffect(() => {
    if (!open || models) return;
    api.providerModels().then(r => { setModels(r.models); if (r.error) setError(r.error); }).catch(e => { setError((e as Error).message); setModels([]); });
  }, [open, models]);

  const list = useMemo(() => (models ?? []).filter(m => !filter || m.toLowerCase().includes(filter.toLowerCase())).slice(0, 300), [models, filter]);

  return (
    <>
      <button ref={setAnchor} className="flex max-w-[260px] items-center gap-1 rounded-lg px-2 py-1 text-aico-secondary hover:bg-aico-hover hover:text-aico-primary"
        onClick={() => setOpen(v => !v)} aria-haspopup="listbox" title="Model for this chat">
        <Icon name="sparkles" size={13} />
        <span className="truncate">{shown}</span>
        <Icon name="chevron-down" size={12} />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="top-start" width={340}>
        <div className="p-1">
          <input className="input mb-1" placeholder="Search models" value={filter} onChange={e => setFilter(e.target.value)} autoFocus />
        </div>
        <MenuItem label={<span>Provider default <span className="text-aico-muted">· {fallback ?? '—'}</span></span>} checked={model === null}
          onClick={() => { setModel(null); setOpen(false); }} />
        <MenuSep />
        {models === null && <div className="flex items-center gap-2 px-3 py-2 text-aico-muted"><span className="spinner h-3.5 w-3.5" /> Loading models…</div>}
        {error && <div className="px-3 py-1.5 text-[12px] text-aico-warning">{error}</div>}
        {list.map(m => (
          <MenuItem key={m} label={<span className="font-mono text-[12.5px]">{m}</span>} checked={model === m} onClick={() => { setModel(m); setOpen(false); }} />
        ))}
        {models !== null && list.length === 0 && !error && <div className="px-3 py-2 text-aico-muted">No models match.</div>}
        <MenuSep />
        <MenuItem icon="settings" label="Providers and models…" onClick={() => { setOpen(false); useDesk.getState().openSettings('models'); }} />
      </Popover>
    </>
  );
}

function ApprovalChip({ opts }: { opts: SendOptions }): React.ReactElement {
  const LABEL: Record<SendOptions['approval'], string> = { auto: 'Auto-approve', edits: 'Ask before edits', ask: 'Ask every time' };
  return (
    <MenuButton className="flex items-center gap-1 rounded-lg px-2 py-1 text-aico-secondary hover:bg-aico-hover hover:text-aico-primary" title="How much the agent asks before acting" placement="top-start" width={300}
      button={<><Icon name={opts.approval === 'auto' ? 'zap' : 'shield'} size={13} /><span>{LABEL[opts.approval]}</span><Icon name="chevron-down" size={12} /></>}>
      {close => (
        <>
          <MenuItem icon="zap" label="Auto-approve" hint="acts, you watch" checked={opts.approval === 'auto'} onClick={() => { close(); setSendOptions({ approval: 'auto' }); }} />
          <MenuItem icon="edit" label="Ask before edits" hint="file writes need a yes" checked={opts.approval === 'edits'} onClick={() => { close(); setSendOptions({ approval: 'edits' }); }} />
          <MenuItem icon="shield" label="Ask every time" hint="every tool call" checked={opts.approval === 'ask'} onClick={() => { close(); setSendOptions({ approval: 'ask' }); }} />
        </>
      )}
    </MenuButton>
  );
}

export function ProjectChip({ large }: { large?: boolean }): React.ReactElement {
  const project = useStore(s => s.project);
  const projects = useStore(s => s.projects);
  const logged = useStore(s => s.logged);
  const retargetDraft = useStore(s => s.retargetDraft);
  const addProject = useStore(s => s.addProject);
  const locked = logged.size > 0;
  const current = projects.find(p => p.path === project);
  const name = current ? (current.isWorkspace ? 'Workspace' : current.name) : project ? basename(project) : 'Workspace';

  const choose = (path: string): void => {
    if (locked) { toast.info('This chat already has a folder', 'Start a new chat to work somewhere else.'); return; }
    retargetDraft(path);
  };

  return (
    <MenuButton
      className={cls('flex max-w-[240px] items-center gap-1.5 rounded-lg text-aico-secondary hover:bg-aico-hover hover:text-aico-primary',
        large ? 'px-2.5 py-1.5 text-[14px]' : 'px-2 py-1')}
      title={project ?? 'The folder this chat works in'}
      placement={large ? 'bottom-start' : 'top-start'}
      width={320}
      button={<><Icon name="folder" size={large ? 16 : 13} /><span className="truncate">{name}</span>{!locked && <Icon name="chevron-down" size={12} />}</>}
    >
      {close => (
        <>
          <div className="px-2.5 pb-1 pt-1.5 text-[12px] text-aico-muted">{locked ? 'This chat works in' : 'Work in'}</div>
          {projects.filter(p => p.exists).map(p => (
            <MenuItem key={p.path} icon={p.isWorkspace ? 'box' : 'folder'} label={p.isWorkspace ? 'Workspace (no project)' : p.name}
              hint={p.isWorkspace ? undefined : basename(p.path) !== p.name ? basename(p.path) : undefined}
              checked={p.path === project} disabled={locked && p.path !== project}
              onClick={() => { close(); choose(p.path); }} />
          ))}
          <MenuSep />
          <MenuItem icon="folder-plus" label="Open folder…" disabled={locked} onClick={async () => {
            close();
            const dir = await desktop.dialog.pickFolder('Open a project folder');
            if (!dir) return;
            await addProject(dir);
            choose(dir);
          }} />
          {project && <MenuItem icon="external" label="Open project page" onClick={() => { close(); go('project', { path: project }); }} />}
        </>
      )}
    </MenuButton>
  );
}

function ContextMeter(): React.ReactElement | null {
  const usage = useStore(s => s.usage);
  if (!usage.contextWindow || !usage.input) return null;
  const pct = Math.min(100, Math.round((usage.input / usage.contextWindow) * 100));
  const r = 7; const c = 2 * Math.PI * r;
  const tone = pct > 85 ? 'var(--aico-danger)' : pct > 65 ? 'var(--aico-warning)' : 'var(--aico-accent)';
  return (
    <span className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-aico-muted"
      title={`Context: ${usage.input.toLocaleString()} of ${usage.contextWindow.toLocaleString()} tokens (${pct}%)\nOutput: ${usage.output.toLocaleString()} · cached ${usage.cached.toLocaleString()}\nCost: $${usage.costUsd.toFixed(4)}${usage.costEstimated ? ' (estimated)' : ''}`}>
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
        <circle cx="9" cy="9" r={r} fill="none" stroke="var(--aico-border)" strokeWidth="2.2" />
        <circle cx="9" cy="9" r={r} fill="none" stroke={tone} strokeWidth="2.2" strokeDasharray={`${(pct / 100) * c} ${c}`} transform="rotate(-90 9 9)" strokeLinecap="round" />
      </svg>
      <span className="tabular-nums">{pct}%</span>
      {usage.costUsd > 0 && <span className="tabular-nums">· ${usage.costUsd < 0.01 ? usage.costUsd.toFixed(4) : usage.costUsd.toFixed(2)}</span>}
    </span>
  );
}

/** "/" at the start of an empty composer: chat and palette commands. */
function SlashMenu({ anchor, onClose, onPick }: {
  anchor: HTMLElement | null; onClose: () => void; onPick: (run: () => void) => void;
}): React.ReactElement {
  const commands = useCommands();
  const opts = useSendOptions();
  const items: Array<{ id: string; title: string; icon: string; run: () => void }> = [
    { id: 'plan', title: opts.planMode ? 'Turn off plan-first' : 'Plan first', icon: 'list', run: () => setSendOptions({ planMode: !opts.planMode }) },
    { id: 'new', title: 'New chat', icon: 'new-chat', run: () => useStore.getState().newSession() },
    { id: 'model', title: 'Change model…', icon: 'sparkles', run: () => useDesk.getState().openSettings('models') },
    ...commands.filter(c => c.category === 'Chat' || c.category === 'Agent').slice(0, 12).map(c => ({ id: c.id, title: c.title, icon: c.icon ?? 'zap', run: () => void c.run() })),
  ];
  return (
    <Popover anchor={anchor} open={Boolean(anchor)} onClose={onClose} placement="top-start" width={300}>
      <div className="px-2.5 pb-1 pt-1.5 text-[12px] text-aico-muted">Actions</div>
      {items.map(i => <MenuItem key={i.id} icon={i.icon} label={i.title} onClick={() => onPick(i.run)} />)}
    </Popover>
  );
}
