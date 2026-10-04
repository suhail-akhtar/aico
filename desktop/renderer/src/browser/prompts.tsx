/**
 * What the browser asks of you: a site wanting a permission, a page's
 * alert/confirm/prompt, an HTTP sign-in, a download or upload to allow, a
 * find-in-page box — and the agent's hand-over, when it needs you to do the
 * part it must not (a human check, a sign-in, a payment).
 *
 * Bars sit above the page (outside the native view's bounds); dialogs sit
 * over it, and the page steps aside for a still while they are open.
 *
 * @module desktop/renderer/browser/prompts
 */

import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '@/lib/icons';
import { cls } from '@/lib/util';
import { fire } from './ipc';
import { hostOf } from './urls';
import { closeFind, runFind, useActiveTab, useBrowser } from './store';
import type { AuthPrompt, ConfirmPrompt, DialogPrompt, PermissionPrompt } from './types';

const PERMISSION_TEXT: Record<string, string> = {
  geolocation: 'know your location', media: 'use your camera and microphone', camera: 'use your camera', microphone: 'use your microphone',
  notifications: 'show notifications', 'clipboard-read': 'see text and images copied to the clipboard', midi: 'use your MIDI devices',
  midiSysex: 'use your MIDI devices', pointerLock: 'lock your mouse', fullscreen: 'go full screen', openExternal: 'open another app',
  'idle-detection': 'know when you are actively using this device', 'window-management': 'manage windows on your displays',
  'storage-access': 'use cookies and site data it saved while embedded', hid: 'connect to HID devices', serial: 'connect to serial ports', usb: 'connect to USB devices',
};

export function PermissionBar(): React.ReactElement | null {
  const tab = useActiveTab();
  const perms = useBrowser(s => s.permissions);
  const [remember, setRemember] = useState(true);
  const p = perms.find(x => x.tabId === tab?.id);
  if (!p) return null;
  const answer = (allow: boolean): void => {
    fire('browser:permissionAnswer', p.id, allow, remember);
    useBrowser.setState(s => ({ permissions: s.permissions.filter(x => x.id !== p.id) }));
  };
  return (
    <div className="bx-bar bg-aico-bg" role="alertdialog" aria-label="Permission request">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-aico-accent-soft text-aico-accent"><Icon name="shield" size={14} /></span>
      <span className="min-w-0 flex-1">
        <b className="font-medium">{hostOf(p.origin) || p.origin}</b> wants to {PERMISSION_TEXT[p.permission] ?? `use “${p.permission}”`}
      </span>
      <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[12px] text-aico-secondary">
        <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} className="accent-[var(--aico-accent)]" />
        Remember for this site
      </label>
      <button className="btn-outline btn-sm" onClick={() => answer(false)}>Block</button>
      <button className="btn-primary btn-sm" onClick={() => answer(true)}>Allow</button>
    </div>
  );
}

/** The agent's hand-over: impossible to miss, one click to hand back. */
export function HandoffBanner(): React.ReactElement | null {
  const handoff = useBrowser(s => s.handoff);
  const done = (answer?: string): void => {
    if (!handoff) return;
    fire('browser:handoffDone', handoff.id, answer);
    useBrowser.setState({ handoff: null });
  };
  if (!handoff) return null;
  return (
    <div className="bx-handoff animate-fade-in" role="alertdialog" aria-label="AICO needs you">
      <span className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-aico-warning/20 text-aico-warning">
        <Icon name="hand" size={20} />
        <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-aico-warning live-dot" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-semibold">AICO needs you</div>
        <div className="text-[13px] text-aico-secondary selectable">{handoff.message}</div>
        <div className="mt-0.5 text-[11.5px] text-aico-muted">
          Do this part yourself in the page below — complete the human check or sign in — then press Done. AICO never solves these checks or types passwords, card details or codes.
        </div>
      </div>
      <button className="btn-ghost btn-sm shrink-0" onClick={() => done('The user could not complete it and handed the page back.')} title="Hand back without finishing">I can’t do it</button>
      <button className="btn-accent shrink-0" onClick={() => done()} autoFocus><Icon name="check" size={14} />Done — hand back</button>
    </div>
  );
}

/** A human check on the page when the agent has not asked: say what it is and whose job it is. */
export function HumanCheckBar(): React.ReactElement | null {
  const tab = useActiveTab();
  const handoff = useBrowser(s => s.handoff);
  const [hidden, setHidden] = useState<string | null>(null);
  if (!tab?.humanCheck || handoff || hidden === tab.url) return null;
  return (
    <div className="bx-bar bg-aico-warning/10" role="status">
      <Icon name="hand" size={15} className="shrink-0 text-aico-warning" />
      <span className="min-w-0 flex-1">This page is asking you to prove you’re human. Complete it yourself — AICO won’t solve it.</span>
      <button className="icon-btn-sm" onClick={() => setHidden(tab.url)} title="Dismiss"><Icon name="x" size={13} /></button>
    </div>
  );
}

export function FindBar(): React.ReactElement | null {
  const find = useBrowser(s => s.find);
  const tab = useActiveTab();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(find.text);
  useEffect(() => {
    const focus = (): void => { input.current?.focus(); input.current?.select(); };
    window.addEventListener('aico:browser-find', focus);
    return () => window.removeEventListener('aico:browser-find', focus);
  }, []);
  useEffect(() => { if (find.open) requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); }); }, [find.open]);
  useEffect(() => { if (find.open && text) void runFind(text); }, [tab?.url]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!find.open) return null;
  return (
    <div className="bx-bar justify-end bg-aico-bg !py-1.5" role="search">
      <div className="flex w-[380px] max-w-full items-center gap-1 rounded-full border border-aico-border px-3 py-0.5 focus-within:border-aico-accent/70">
        <Icon name="search" size={14} className="text-aico-muted" />
        <input ref={input} value={text} placeholder="Find on page" aria-label="Find on page"
          onChange={e => { setText(e.target.value); void runFind(e.target.value); }}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); void runFind(text, !e.shiftKey, true); }
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); }
          }}
          className="min-w-0 flex-1 bg-transparent py-1 text-[13px] outline-none placeholder:text-aico-muted" />
        <span className={cls('shrink-0 text-[12px] tabular-nums', text && find.matches === 0 ? 'text-aico-danger' : 'text-aico-muted')}>
          {text ? `${find.matches ? find.active : 0}/${find.matches}` : ''}
        </span>
        <span className="mx-1 h-4 border-l border-aico-border-subtle" />
        <button className="icon-btn-sm h-6 w-6" disabled={!find.matches} onClick={() => void runFind(text, false, true)} title="Previous (Shift+Enter)"><Icon name="chevron-up" size={14} /></button>
        <button className="icon-btn-sm h-6 w-6" disabled={!find.matches} onClick={() => void runFind(text, true, true)} title="Next (Enter)"><Icon name="chevron-down" size={14} /></button>
        <button className="icon-btn-sm h-6 w-6" onClick={closeFind} title="Close (Esc)"><Icon name="x" size={14} /></button>
      </div>
    </div>
  );
}

// ── Dialogs over the page ──

/** The first dialog waiting for the active tab (or a tab-less confirmation), for the pane to decide whether to cover the page. */
export function usePendingModal(): { kind: 'dialog'; p: DialogPrompt } | { kind: 'auth'; p: AuthPrompt } | { kind: 'confirm'; p: ConfirmPrompt } | null {
  const tab = useActiveTab();
  const dialog = useBrowser(s => s.dialogs.find(d => d.tabId === tab?.id));
  const auth = useBrowser(s => s.auths.find(d => d.tabId === tab?.id));
  const confirm = useBrowser(s => s.confirms[0]);
  if (confirm) return { kind: 'confirm', p: confirm };
  if (dialog) return { kind: 'dialog', p: dialog };
  if (auth) return { kind: 'auth', p: auth };
  return null;
}

export function PageModal(): React.ReactElement | null {
  const m = usePendingModal();
  const tab = useActiveTab();
  if (!m) return null;
  return (
    <div className="bx-modal-scrim">
      {m.kind === 'dialog' && <JsDialog key={m.p.id} p={m.p} host={m.p.source || hostOf(tab?.url ?? '')} site={hostOf(tab?.url ?? '')} />}
      {m.kind === 'auth' && <AuthDialog key={m.p.id} p={m.p} />}
      {m.kind === 'confirm' && <ConfirmDialog key={m.p.id} p={m.p} />}
    </div>
  );
}

function JsDialog({ p, host, site }: { p: DialogPrompt; host: string; site: string }): React.ReactElement {
  const [text, setText] = useState(p.defaultPrompt ?? '');
  const answer = (accept: boolean): void => {
    fire('browser:dialogAnswer', p.id, accept, p.type === 'prompt' && accept ? text : undefined);
    useBrowser.setState(s => ({ dialogs: s.dialogs.filter(d => d.id !== p.id) }));
  };
  const leave = p.type === 'beforeunload';
  return (
    <div className="bx-modal" role="alertdialog" aria-label={`${host} says`}
      onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); answer(false); } }}>
      <div className="mb-1 text-[14px] font-semibold">{leave ? 'Leave site?' : `${host || 'This page'} says`}</div>
      <div className="max-h-[40vh] overflow-y-auto whitespace-pre-wrap break-words text-[13.5px] text-aico-secondary selectable thin-scroll">
        {leave ? 'Changes you made may not be saved.' : p.message}
      </div>
      {p.embedded && <div className="mt-2 text-[11.5px] text-aico-muted">From a frame embedded in {site || 'this page'}, not the site itself.</div>}
      {p.byAgent && <div className="mt-2 flex items-center gap-1.5 text-[11.5px] text-aico-muted"><span className="bx-ai-badge">AI</span>Opened while AICO was working on this page</div>}
      {p.type === 'prompt' && (
        <input className="input mt-3" value={text} autoFocus onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') answer(true); }} />
      )}
      <div className="mt-4 flex justify-end gap-2">
        {p.type !== 'alert' && <button className="btn-outline" onClick={() => answer(false)}>{leave ? 'Stay' : 'Cancel'}</button>}
        <button className="btn-primary" autoFocus={p.type !== 'prompt'} onClick={() => answer(true)}>{leave ? 'Leave' : 'OK'}</button>
      </div>
    </div>
  );
}

function AuthDialog({ p }: { p: AuthPrompt }): React.ReactElement {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const answer = (creds: { username: string; password: string } | null): void => {
    fire('browser:authAnswer', p.id, creds);
    useBrowser.setState(s => ({ auths: s.auths.filter(d => d.id !== p.id) }));
  };
  return (
    <form className="bx-modal" role="dialog" aria-label="Sign in" autoComplete="off"
      onSubmit={e => { e.preventDefault(); answer({ username, password }); }}
      onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); answer(null); } }}>
      <div className="flex items-center gap-2 text-[14px] font-semibold"><Icon name="key" size={16} className="text-aico-secondary" />Sign in</div>
      <div className="mt-1 text-[13px] text-aico-secondary">
        <b className="font-medium text-aico-primary">{p.host}</b> requires a username and password{p.realm ? <> for “{p.realm}”</> : null}.
      </div>
      <label className="label mt-3 block">Username</label>
      <input className="input mt-1" value={username} onChange={e => setUsername(e.target.value)} autoFocus autoComplete="off" spellCheck={false} />
      <label className="label mt-2 block">Password</label>
      <input className="input mt-1" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="off" />
      <div className="mt-2 text-[11.5px] text-aico-muted">You type these; they go straight to the site. AICO’s agent never sees or types them.</div>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="btn-outline" onClick={() => answer(null)}>Cancel</button>
        <button type="submit" className="btn-primary" disabled={!username}>Sign in</button>
      </div>
    </form>
  );
}

function ConfirmDialog({ p }: { p: ConfirmPrompt }): React.ReactElement {
  const answer = (allow: boolean): void => {
    fire('browser:confirmAnswer', p.id, allow);
    useBrowser.setState(s => ({ confirms: s.confirms.filter(d => d.id !== p.id) }));
  };
  const risky = Boolean(p.danger) || (p.kind === 'download' && (p.files ?? [p.title]).some(f => /\.(exe|msi|bat|cmd|ps1|vbs|js|jar|scr|com|appimage|deb|rpm|sh|dmg|pkg)$/i.test(f)));
  return (
    <div className="bx-modal" role="alertdialog" aria-label={p.title} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); answer(false); } }}>
      <div className="flex items-start gap-3">
        <span className={cls('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl', risky ? 'bg-aico-warning/15 text-aico-warning' : 'bg-aico-accent-soft text-aico-accent')}>
          <Icon name={p.kind === 'commit' ? 'shield' : p.kind === 'upload' ? 'upload' : p.kind === 'tabs' ? 'layers' : risky ? 'alert' : 'download'} size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold">{p.title}</div>
          <div className="mt-0.5 text-[12.5px] text-aico-muted">{hostOf(p.origin) || p.origin}</div>
          <div className="mt-2 text-[13px] text-aico-secondary selectable">{p.detail}</div>
          {p.files && p.files.length > 0 && (
            <div className="mt-2 max-h-32 overflow-y-auto rounded-lg border border-aico-border-subtle p-2 font-mono text-[11.5px] thin-scroll selectable">
              {p.files.map(f => <div key={f} className="truncate">{f}</div>)}
            </div>
          )}
          {risky && p.kind !== 'commit' && <div className="mt-2 text-[12px] text-aico-warning">Programs and scripts can harm your computer. Allow only if you trust this site.</div>}
          {p.kind === 'commit' && <div className="mt-2 text-[12px] text-aico-warning">The agent cannot press this without you. If you did not ask for it, choose Don’t allow.</div>}
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn-outline" onClick={() => answer(false)} autoFocus>{p.cancelLabel ?? (p.kind === 'upload' ? 'Don’t send' : 'Cancel')}</button>
        <button className={risky ? 'btn-danger' : 'btn-primary'} onClick={() => answer(true)}>{p.okLabel ?? (p.kind === 'upload' ? 'Send files' : p.kind === 'commit' ? 'Allow' : 'Download')}</button>
      </div>
    </div>
  );
}
