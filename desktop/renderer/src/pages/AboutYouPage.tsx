/**
 * About you — what AICO has learned about the person, in the desktop (ADR 0018).
 *
 * The facts, their evidence and controls are the web client's shared
 * `AboutYouPane` (so web Settings and this page cannot disagree about what
 * the agent is told). This page adds what only the desktop has: the
 * browser's own switch, "Let About you use my browsing", which decides
 * whether main writes the browsing digest at all
 * (electron/browser-profile-digest.ts) — turning it off empties the file at
 * once, before the engine could read it again. Wiping asks through the
 * native dialog. Confirm/edit/add/run reach the engine as a person through
 * main's grant (protocol.ts HUMAN_ROUTES).
 *
 * @module desktop/renderer/pages/AboutYouPage
 */

import React, { useEffect, useState } from 'react';
import { AboutYouPane } from '@web/components/settings/AboutYouPane';
import type { ProfileDigestStatus } from '@desk/profile-digest-types';
import { call } from '@/browser/ipc';
import { desktop } from '@/desktop';
import { toast } from '@/state/desk';

function BrowserSwitch(): React.ReactElement | null {
  const [s, setS] = useState<ProfileDigestStatus | null>(null);
  useEffect(() => { void call<ProfileDigestStatus>('browser:profile:status').then(v => setS(v ?? null)).catch(() => setS(null)); }, []);
  if (!s) return null;
  const set = (on: boolean): void => {
    void call<ProfileDigestStatus>('browser:profile:set', { useBrowsing: on }).then(v => setS(v ?? null)).catch((e: Error) => toast.error('Could not change', e.message));
  };
  return (
    <label className="flex items-center gap-1.5" title="Whether the built-in browser writes its summary for About you. Off empties it at once." data-use-browsing>
      <input type="checkbox" checked={s.useBrowsing} onChange={e => set(e.target.checked)} />
      Let About you use my browsing
      <span className="text-aico-muted">
        {s.learningPaused ? '(browser learning is paused)' : s.writtenAt ? `(${s.domains} sites summarised)` : ''}
      </span>
    </label>
  );
}

export function AboutYouPage(): React.ReactElement {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-8 pb-16 pt-10">
        <h1 className="text-[28px] font-semibold tracking-tight">About you</h1>
        <p className="mt-2 mb-6 text-[14px] text-aico-secondary">
          What AICO has picked up about how you work and what you are into, so it can fit its help to you. Every fact shows
          why it was learned. Confirm what is right, fix what is not, and forget anything you would rather it did not know.
        </p>
        <AboutYouPane
          confirm={message => desktop.dialog.confirm({ title: 'Erase About you', message, ok: 'Erase', danger: true })}
          extraSources={<BrowserSwitch />}
        />
      </div>
    </div>
  );
}
