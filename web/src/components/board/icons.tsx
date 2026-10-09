/**
 * The design board's glyphs, on the same 24-unit grid and 1.75 stroke as the
 * Code map's (components/codegraph/icons), kept beside the view so it needs
 * nothing client-specific and renders the same in the desktop and the browser.
 *
 * @module web/components/board/icons
 */

import React from 'react';

const PATHS = {
  play: <path d="M8 5.5v13l10.5-6.5L8 5.5Z" />,
  pointer: <path d="m5 3.5 13.5 7.2-6 1.4 3.4 6.4-2.5 1.3-3.4-6.4L6 17.6 5 3.5Z" />,
  hand: <><path d="M8 13V6.5a1.5 1.5 0 0 1 3 0V12" /><path d="M11 11V4.8a1.5 1.5 0 0 1 3 0V11" /><path d="M14 11V6.3a1.5 1.5 0 0 1 3 0v7.2a7 7 0 0 1-7 7h-.6a6 6 0 0 1-4.6-2.2L2.7 15.6a1.5 1.5 0 0 1 2.2-2L8 16" /></>,
  note: <><path d="M5 4h14a1 1 0 0 1 1 1v9.5L14.5 20H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" /><path d="M14 20v-5a1 1 0 0 1 1-1h5" /></>,
  present: <><rect x="3" y="4" width="18" height="12" rx="1.5" /><path d="M12 16v4M8 20h8" /><path d="m10.5 8 4 2-4 2V8Z" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  fit: <path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" />,
  download: <><path d="M12 4v11" /><path d="m7 10 5 5 5-5" /><path d="M5 20h14" /></>,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  back: <path d="M15 6l-6 6 6 6" />,
  next: <path d="m9 6 6 6-6 6" />,
  alert: <><path d="M12 4 2.8 19.5h18.4L12 4Z" /><path d="M12 10v4.5M12 17.2v.1" /></>,
  trash: <><path d="M4.5 7h15M10 11v6M14 11v6" /><path d="M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4.5h6V7" /></>,
  expand: <><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" /></>,
  refresh: <><path d="M20 11a8 8 0 0 0-14.3-4.9L4 8" /><path d="M4 3v5h5" /><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16" /><path d="M20 21v-5h-5" /></>,
} as const;

export type BoardGlyph = keyof typeof PATHS;

export function BoardIcon({ name, size = 16, className }: { name: BoardGlyph; size?: number; className?: string }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      {PATHS[name]}
    </svg>
  );
}
