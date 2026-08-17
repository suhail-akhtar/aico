/**
 * Taking a session somewhere else.
 *
 * A transcript is often the deliverable — pasted into a ticket, attached to a
 * PR, sent to someone who was not watching it run. Both operations are here
 * because they are the same intent with different destinations: copy puts it on
 * the clipboard, download writes a file.
 *
 * Markdown is offered first because it survives being pasted into almost
 * anything and stays readable when nothing renders it. Plain text is for the
 * places where Markdown's punctuation is noise.
 *
 * @module components/SessionMenu
 */

import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';

export function SessionMenu(): React.ReactElement {
  const sessionId = useStore(s => s.sessionId);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<'md' | 'txt' | null>(null);
  const menu = useRef<HTMLDivElement>(null);

  // Close on an outside click or Escape — a menu that can only be dismissed by
  // choosing something is a trap.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      if (!menu.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const copy = async (format: 'md' | 'txt'): Promise<void> => {
    try {
      await navigator.clipboard.writeText(await api.exportText(sessionId, format));
      setCopied(format);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // Clipboard access can be refused by the browser. Downloading still
      // works, and it is right there in the same menu.
    }
  };

  const download = (format: 'md' | 'txt'): void => {
    // A plain anchor click rather than fetch+blob: the server already sets
    // Content-Disposition with a sensible filename, and letting the browser do
    // the download means it lands in the downloads list like anything else.
    const link = document.createElement('a');
    link.href = api.exportUrl(sessionId, format);
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setOpen(false);
  };

  return (
    <div ref={menu} className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        className="rounded-lg px-2 py-1 text-[13px] text-aico-muted transition-colors
                   hover:bg-aico-hover hover:text-aico-primary"
        title="Copy or download this transcript"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        Export
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-40 mt-1 w-52 overflow-hidden rounded-xl
                     border border-aico-border bg-aico-bg py-1 shadow-lg"
        >
          <MenuItem onClick={() => void copy('md')}>
            {copied === 'md' ? 'Copied' : 'Copy as Markdown'}
          </MenuItem>
          <MenuItem onClick={() => void copy('txt')}>
            {copied === 'txt' ? 'Copied' : 'Copy as plain text'}
          </MenuItem>
          <div className="my-1 border-t border-aico-border-subtle" />
          <MenuItem onClick={() => download('md')}>Download .md</MenuItem>
          <MenuItem onClick={() => download('txt')}>Download .txt</MenuItem>
        </div>
      )}
    </div>
  );
}

function MenuItem(
  { onClick, children }: { onClick: () => void; children: React.ReactNode },
): React.ReactElement {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className="block w-full px-3 py-1.5 text-left text-[13px] text-aico-secondary
                 transition-colors hover:bg-aico-hover hover:text-aico-primary"
    >
      {children}
    </button>
  );
}
