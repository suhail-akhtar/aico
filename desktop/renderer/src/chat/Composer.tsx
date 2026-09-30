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
import { useProjects } from '@/lib/projects';
import { api } from '@web/api';
import { useDesk, go, toast } from '@/state/desk';
import { Icon } from '@/lib/icons';
import { basename, bytes, cls } from '@/lib/util';
import { MenuButton, MenuItem, MenuSep, Popover } from '@/shell/Popover';
import { desktop, isDesktop } from '@/desktop';
import { setSendOptions, useSendOptions, type SendOptions } from './actions';
import { SuggestMenu, groupRanked, rankItems, triggerAt, type SuggestItem, type Trigger } from './Suggest';
import { highlightMentions, mentionPath, useMentionItems, useSlashItems } from './composer-menus';

/** Drafts are kept per chat. The key prefix changed with the fix below, and the old keys — polluted by that bug — are dropped once. */
const DRAFT_PREFIX = 'desk.draft2.';
try {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k?.startsWith('desk.draft.')) localStorage.removeItem(k);
  }
} catch { /* fine */ }
function readDraft(key: string): string { try { return localStorage.getItem(key) ?? ''; } catch { return ''; } }

/**
 * A prefill (a home-screen prompt, "Ask AI about this file") is delivered once.
 * The store keeps the last one and the composer remounts when a chat starts;
 * without this the new box was filled with the same text again, which is how a
 * starter prompt seemed impossible to clear.
 */
let consumedPrefill = 0;

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
  const project = useStore(s => s.project);
  const logged = useStore(s => s.logged);
  const opts = useSendOptions();
  const sendKey = useDesk(s => s.prefs.sendKey);
  const [uploading, setUploading] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLDivElement>(null);

  /*
    The text and the chat it belongs to travel together. Held apart, switching
    chats saved the old chat's text under the new chat's key in the same render
    that loaded the new one — so whatever was in the box followed you into every
    new chat, and came back after clearing it and after a reload.
  */
  const draftKey = `${DRAFT_PREFIX}${sessionId}`;
  const [draft, setDraft] = useState(() => ({ key: draftKey, text: readDraft(draftKey) }));
  if (draft.key !== draftKey) setDraft({ key: draftKey, text: readDraft(draftKey) });
  const text = draft.key === draftKey ? draft.text : readDraft(draftKey);
  const setText = useCallback((next: string | ((prev: string) => string)) => {
    setDraft(d => {
      const prev = d.key === draftKey ? d.text : readDraft(draftKey);
      return { key: draftKey, text: typeof next === 'function' ? next(prev) : next };
    });
  }, [draftKey]);
  useEffect(() => {
    if (draft.key !== draftKey) return;
    try { if (draft.text) localStorage.setItem(draftKey, draft.text); else localStorage.removeItem(draftKey); } catch { /* fine */ }
  }, [draft, draftKey]);

  useEffect(() => {
    if (!prefill || prefill.at <= consumedPrefill) return;
    consumedPrefill = prefill.at;
    setText(prefill.text);
    requestAnimationFrame(() => { ta.current?.focus(); ta.current?.setSelectionRange(prefill.text.length, prefill.text.length); });
  }, [prefill, setText]);

  // Grow with the text, up to a third of the window.
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.36))}px`;
    if (mirror.current) mirror.current.scrollTop = el.scrollTop;
  }, [text]);

  useEffect(() => {
    const focus = (): void => ta.current?.focus();
    window.addEventListener('desk:focus-composer', focus);
    return () => window.removeEventListener('desk:focus-composer', focus);
  }, []);

  // ── "/" and "@" ─────────────────────────────────────────────────────
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const sync = (value: string, caret: number): void => {
    const t = triggerAt(value, caret);
    setTrigger(t);
    if (!t || `${t.kind}:${t.from}` !== dismissed) setDismissed(null);
  };
  const open = trigger && `${trigger.kind}:${trigger.from}` !== dismissed ? trigger : null;

  const send = useCallback(async (mode: 'send' | 'steer' | 'followup') => {
    const content = text.trim();
    if (!content && attachments.length === 0) return;
    // Cleared here, not by the effect: sending from home swaps this composer
    // for the transcript's, which would otherwise read the stale draft back.
    try { localStorage.removeItem(draftKey); } catch { /* fine */ }
    setText('');
    setTrigger(null);
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
  }, [text, attachments.length, submit, steer, followup, opts, draftKey, setText]);

  const upload = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setUploading(n => n + files.length);
    try { await attachFiles(files); }
    catch (err) { toast.error('Could not attach', (err as Error).message); }
    finally { setUploading(n => Math.max(0, n - files.length)); }
  }, [attachFiles]);

  const pickFiles = useCallback(async (images?: boolean): Promise<void> => {
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
    ta.current?.focus();
  }, [upload]);

  /** Puts `token` at the caret (or over `range`), spaced from what is before it, and keeps typing after it. */
  const insertAt = useCallback((token: string, range?: { from: number; to: number }) => {
    const el = ta.current;
    const current = el?.value ?? '';
    const from = range?.from ?? el?.selectionStart ?? current.length;
    const to = range?.to ?? el?.selectionEnd ?? current.length;
    const before = current.slice(0, from);
    const pad = before && !/\s$/.test(before) ? ' ' : '';
    setText(`${before}${pad}${token}${current.slice(to)}`);
    const caret = before.length + pad.length + token.length;
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(caret, caret); });
  }, [setText]);

  const mentionFolder = useCallback(async (range?: { from: number; to: number }): Promise<void> => {
    const dir = await desktop.dialog.pickFolder('Mention a folder');
    if (dir) insertAt(`@${mentionPath(dir, project)} `, range);
    else ta.current?.focus();
  }, [insertAt, project]);

  const mentionFile = useCallback(async (range?: { from: number; to: number }): Promise<void> => {
    const picked = await desktop.dialog.pickFiles({ title: 'Mention files' });
    if (picked.length) insertAt(`${picked.map(p => `@${mentionPath(p.path, project)}`).join(' ')} `, range);
    else ta.current?.focus();
  }, [insertAt, project]);

  const slashItems = useSlashItems({
    busy, hasChat: logged.size > 0, pickFiles,
    mentionFile: useCallback(() => mentionFile(), [mentionFile]),
    mentionFolder: useCallback(() => mentionFolder(), [mentionFolder]),
    insertText: insertAt,
  });
  const mention = useMentionItems(open?.kind === 'mention' ? open.query : null, project);
  const shown = useMemo(() => {
    if (!open) return [];
    return open.kind === 'slash' ? groupRanked(rankItems(slashItems, open.query)) : mention.items;
  }, [open, slashItems, mention.items]);
  useEffect(() => { setActive(0); }, [open?.kind, open?.query]);

  const pick = async (item: SuggestItem): Promise<void> => {
    const at = open;
    setTrigger(null);
    if (!at) return;
    try {
      let done: void | string;
      if (at.kind === 'slash') {
        // The "/query" goes; anything typed after it stays.
        const rest = text.slice(at.to).replace(/^\s+/, '');
        setText(rest);
        // An action that inserts text reads the box before React has re-rendered it.
        if (ta.current) { ta.current.value = rest; ta.current.setSelectionRange(0, 0); }
        done = await item.run();
      } else {
        done = await runMention(item, at);
      }
      if (typeof done === 'string' && done) toast.success(done);
    } catch (err) {
      toast.error(`${item.title} failed`, (err as Error).message);
    }
  };

  const runMention = async (item: SuggestItem, at: Trigger): Promise<string | void> => {
    const range = { from: at.from, to: at.to };
    const cut = item.id.indexOf(':');
    const kind = item.id.slice(0, cut);
    const value = item.id.slice(cut + 1);
    if (kind === 'file' || kind === 'dir') { insertAt(`@${mentionPath(value, project)} `, range); return; }
    if (kind === 'browse-file') return mentionFile(range);
    if (kind === 'browse-dir') return mentionFolder(range);
    if (kind === 'agent') {
      // Talking to an agent is a mode of the chat, not words in the message.
      setText(t => (t.slice(0, at.from) + t.slice(at.to)).replace(/^\s+/, ''));
      await useStore.getState().setSessionAgent(value);
      return `Talking to @${value}`;
    }
  };

  // ↑ in an empty box brings back what you last sent in this chat.
  const lastSent = useMemo(() => {
    let found = '';
    for (const m of logged.values()) {
      const e = m as { type?: string; content?: unknown };
      if (e.type === 'user' && typeof e.content === 'string') found = e.content;
    }
    return found.replace(/\n?<!--[\s\S]*?-->\s*$/, '').trim();
  }, [logged]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (open && !e.nativeEvent.isComposing) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => (shown.length ? (i + 1) % shown.length : 0)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => (shown.length ? (i - 1 + shown.length) % shown.length : 0)); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDismissed(`${open.kind}:${open.from}`); return; }
      if ((e.key === 'Enter' || e.key === 'Tab') && shown.length > 0) {
        e.preventDefault();
        void pick(shown[Math.min(active, shown.length - 1)]!);
        return;
      }
    }
    if (e.key === 'ArrowUp' && !text && lastSent && !busy) {
      e.preventDefault();
      setText(lastSent);
      requestAnimationFrame(() => ta.current?.setSelectionRange(lastSent.length, lastSent.length));
      return;
    }
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
    if (!files.length) return;
    e.preventDefault();
    // A pasted screenshot arrives as "image.png" every time; the time tells them apart.
    void upload(files.map(f => (f.name && f.name !== 'image.png') ? f
      : new File([f], `pasted-${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}.${f.type.split('/')[1] || 'png'}`, { type: f.type })));
  };

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault();
    setDragOver(false);
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    // Alt+drop mentions the files instead of attaching them: the agent reads them where they are.
    if (e.altKey && isDesktop) { insertAt(`${files.map(f => `@${mentionPath(desktop.pathForFile(f), project)}`).join(' ')} `); return; }
    void upload(files);
  };

  const canSend = (text.trim().length > 0 || attachments.length > 0) && uploading === 0;

  return (
    <div className={cls('mx-auto w-full', home ? 'max-w-[760px]' : 'max-w-column')}>
      <div
        className={cls('composer-shell relative rounded-[28px] border border-aico-border-subtle', dragOver && 'border-aico-accent ring-2 ring-aico-accent/30')}
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }}
        onDrop={onDrop}
      >
        {open && (
          <SuggestMenu
            title={open.kind === 'slash' ? 'Actions' : 'Mention'}
            items={shown}
            active={active}
            onHover={setActive}
            onPick={item => void pick(item)}
            loading={open.kind === 'mention' && mention.loading}
            empty={open.kind === 'slash' ? `No action matches “${open.query}”` : 'Nothing matches'}
          />
        )}
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
          <MenuButton className="icon-btn h-9 w-9 shrink-0 rounded-full" title="Add files and more" placement="top-start" width={280} button={<Icon name="plus" size={20} />}>
            {close => (
              <>
                <MenuItem icon="paperclip" label="Attach files" hint="sent with the message" onClick={() => { close(); void pickFiles(); }} />
                <MenuItem icon="image" label="Attach images" onClick={() => { close(); void pickFiles(true); }} />
                <MenuItem icon="at" label="Mention files" hint="the agent reads them" onClick={() => { close(); void mentionFile(); }} />
                <MenuItem icon="folder" label="Mention a folder" onClick={() => { close(); void mentionFolder(); }} />
                <MenuSep />
                <MenuItem icon="list" label="Plan first" hint="the agent proposes, you approve" checked={opts.planMode}
                  onClick={() => { close(); setSendOptions({ planMode: !opts.planMode }); toast.success(opts.planMode ? 'Plan first is off' : 'Plan first is on'); }} />
                <MenuItem icon="globe" label="Use the built-in browser" onClick={() => { close(); insertAt('Use the built-in browser (browser_* tools) for this. '); }} />
                <MenuItem icon="chart" label="Answer with visuals" onClick={() => { close(); insertAt('Show the answer with charts, tables and widgets where they help. '); }} />
              </>
            )}
          </MenuButton>
          <div className="relative min-w-0 flex-1">
            {/* Paints the @mentions behind the text; the textarea stays the only thing you type in. */}
            <div ref={mirror} aria-hidden className="composer-mirror pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-1.5 py-2 text-[15px] leading-6 text-transparent">
              {highlightMentions(text)}
            </div>
            <textarea
              ref={ta}
              value={text}
              onChange={e => { setText(e.target.value); sync(e.target.value, e.target.selectionStart ?? e.target.value.length); }}
              onSelect={e => { const el = e.currentTarget; sync(el.value, el.selectionStart ?? 0); }}
              onScroll={e => { if (mirror.current) mirror.current.scrollTop = e.currentTarget.scrollTop; }}
              onBlur={() => setTrigger(null)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              rows={1}
              spellCheck
              placeholder={busy ? 'Steer the agent — Enter sends now, Ctrl+Enter queues' : 'Ask anything, @ to mention, / for actions'}
              aria-label="Message"
              aria-autocomplete="list"
              aria-expanded={Boolean(open)}
              className="composer-textarea relative block max-h-[36vh] min-h-[40px] w-full resize-none break-words bg-transparent px-1.5 py-2 text-[15px] leading-6 text-aico-primary placeholder:text-aico-muted"
            />
          </div>
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
  const [caps, setCaps] = useState<Record<string, { input: string[]; chat: boolean }>>({});
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const shown = model ?? fallback ?? 'default model';
  useEffect(() => {
    const show = (): void => setOpen(true);
    window.addEventListener('desk:open-model-picker', show);
    return () => window.removeEventListener('desk:open-model-picker', show);
  }, []);

  useEffect(() => {
    if (!open || models) return;
    api.providerModels().then(r => { setModels(r.models); setCaps(r.capabilities ?? {}); if (r.error) setError(r.error); }).catch(e => { setError((e as Error).message); setModels([]); });
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
          <MenuItem key={m} label={<span className={cls('font-mono text-[12.5px]', caps[m]?.chat === false && 'opacity-60')}>{m}</span>}
            trailing={caps[m]?.input.includes('image') ? <span title="Reads images" className="text-aico-accent"><Icon name="eye" size={13} /></span> : undefined}
            title={caps[m]?.chat === false ? 'Listed by the provider, but cannot run the agent' : undefined}
            checked={model === m} onClick={() => { setModel(m); setOpen(false); }} />
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
  const projects = useProjects();
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
  if (!usage.contextWindow || !usage.context) return null;
  // Occupancy is the latest request's prompt; `input` is the chat's running total (spend).
  const pct = Math.min(100, Math.round((usage.context / usage.contextWindow) * 100));
  const r = 7; const c = 2 * Math.PI * r;
  const tone = pct > 85 ? 'var(--aico-danger)' : pct > 65 ? 'var(--aico-warning)' : 'var(--aico-accent)';
  return (
    <span className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-aico-muted"
      title={`Context: ${usage.context.toLocaleString()} of ${usage.contextWindow.toLocaleString()} tokens (${pct}%)\nThis chat: ${usage.input.toLocaleString()} in · ${usage.output.toLocaleString()} out · ${usage.cached.toLocaleString()} cached\nCost: $${usage.costUsd.toFixed(4)}${usage.costEstimated ? ' (estimated)' : ''}`}>
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
        <circle cx="9" cy="9" r={r} fill="none" stroke="var(--aico-border)" strokeWidth="2.2" />
        <circle cx="9" cy="9" r={r} fill="none" stroke={tone} strokeWidth="2.2" strokeDasharray={`${(pct / 100) * c} ${c}`} transform="rotate(-90 9 9)" strokeLinecap="round" />
      </svg>
      <span className="tabular-nums">{pct}%</span>
      {usage.costUsd > 0 && <span className="tabular-nums">· ${usage.costUsd < 0.01 ? usage.costUsd.toFixed(4) : usage.costUsd.toFixed(2)}</span>}
    </span>
  );
}
