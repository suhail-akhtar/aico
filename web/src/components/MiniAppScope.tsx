/**
 * The bar that says which Mini App this conversation is about.
 *
 * A scoped session looks exactly like an unscoped one until something says
 * otherwise, and that ambiguity is expensive in both directions: the reader
 * types "make the totals bold" into what they think is a general chat, or
 * types a general question into a conversation whose every answer will be
 * bent toward one app.
 *
 * So the scope is stated, with the app's address next to it — because the
 * commonest thing to want, while asking for a change, is to look at the thing
 * being changed.
 *
 * @module components/MiniAppScope
 */

import React, { useEffect, useState } from 'react';
import { useStore } from '../store';
import { api, type MiniAppSummary } from '../api';
import { Icon } from './Icon';

export function MiniAppScope(): React.ReactElement | null {
  const slug = useStore(s => s.miniApp);
  const busy = useStore(s => s.busy);
  const [app, setApp] = useState<MiniAppSummary | null>(null);
  const [host, setHost] = useState<string | null>(null);

  // Re-read when a turn ends: the agent may have just built the page, and a
  // bar still saying "not built yet" beside a working app is worse than none.
  useEffect(() => {
    if (!slug) { setApp(null); return; }
    let live = true;
    void api.miniApps().then(view => {
      if (!live) return;
      setApp(view.apps.find(a => a.slug === slug) ?? null);
      setHost(view.host);
    }).catch(() => { /* the bar is not worth an error banner */ });
    return () => { live = false; };
  }, [slug, busy]);

  if (!slug) return null;

  const url = host && app?.built ? `${host}/${slug}/` : null;

  return (
    <div className="mx-auto flex w-full max-w-column items-center gap-2 px-5 pb-2 pt-3">
      <span className="shrink-0 text-aico-accent"><Icon name="bolt" size={14} /></span>
      <span className="shrink-0 text-[13px] font-medium text-aico-primary">
        {app?.title ?? slug}
      </span>
      <span className="min-w-0 truncate text-[12px] text-aico-muted">
        {app?.built
          ? 'Mini App — ask for changes, fixes or new features'
          : 'Mini App — not built yet'}
      </span>
      <div className="flex-1" />
      {/*
        A link, and only when there is something to open. A button that opens a
        404 is worse than an absent one: it makes the reader doubt the app
        rather than the button.
      */}
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noreferrer noopener"
          className="shrink-0 rounded-lg px-2 py-1 text-[12px] font-medium text-aico-accent
                     transition-colors hover:bg-aico-accent/10"
        >
          Open app
        </a>
      )}
    </div>
  );
}
