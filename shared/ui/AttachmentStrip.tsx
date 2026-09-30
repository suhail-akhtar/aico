/**
 * What the person attached, shown on their own message.
 *
 * A message that was about a screenshot read, afterwards, as a question about
 * nothing: the picture went to the model but the bubble showed only the words.
 * Pictures appear as thumbnails that open full size; other files as chips with
 * their type and size. The engine serves both (`/api/attachments/file`), through
 * `mediaUrl` so the browser portal's token rides along and the desktop's proxy
 * adds its own.
 *
 * @module shared/ui/AttachmentStrip
 */

import React, { useState } from 'react';
import type { MessageAttachment } from './types';
import { mediaUrl } from './media';

function size(bytes: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function typeLabel(a: MessageAttachment): string {
  const ext = a.name.includes('.') ? a.name.split('.').pop()!.toUpperCase() : '';
  return ext || (a.mimeType.split('/')[1] ?? 'FILE').toUpperCase();
}

export function AttachmentStrip({ attachments, align = 'end' }: {
  attachments: MessageAttachment[];
  align?: 'start' | 'end';
}): React.ReactElement | null {
  const [open, setOpen] = useState<MessageAttachment | null>(null);
  if (attachments.length === 0) return null;
  return (
    <>
      <div className={`mb-1.5 flex max-w-[85%] flex-wrap gap-2 ${align === 'end' ? 'justify-end self-end' : ''}`}>
        {attachments.map(a => a.kind === 'image' && a.url ? (
          <button key={a.id} type="button" onClick={() => setOpen(a)} title={a.name}
            className="overflow-hidden rounded-xl border border-aico-border bg-aico-elevated transition-opacity hover:opacity-90">
            <img src={mediaUrl(a.url)} alt={a.name} loading="lazy" className="block max-h-40 max-w-[240px] object-cover" />
          </button>
        ) : (
          <a key={a.id} href={a.url ? mediaUrl(a.url) : undefined} download={a.name} title={a.name}
            className="flex max-w-[260px] items-center gap-2.5 rounded-xl border border-aico-border bg-aico-elevated px-3 py-2 text-left no-underline hover:border-aico-accent">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-aico-accent/10 text-[10px] font-semibold text-aico-accent">
              {typeLabel(a).slice(0, 4)}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-medium text-aico-primary">{a.name}</span>
              <span className="block text-[12px] text-aico-muted">{[typeLabel(a), size(a.bytes)].filter(Boolean).join(' · ')}</span>
            </span>
          </a>
        ))}
      </div>
      {open?.url && (
        <div role="dialog" aria-label={open.name} onClick={() => setOpen(null)}
          onKeyDown={e => { if (e.key === 'Escape') setOpen(null); }} tabIndex={-1}
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-6">
          <img src={mediaUrl(open.url)} alt={open.name} className="max-h-full max-w-full rounded-lg shadow-2xl" />
        </div>
      )}
    </>
  );
}
