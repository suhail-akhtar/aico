/**
 * Delivery's few glyphs, on the same 24-unit grid and stroke as the rest of the
 * interface (components/Icon, codegraph/icons).
 *
 * WHY local: the web Icon set has no branch, check-shield or inbox glyph, and
 * the desktop has its own icon module; this file keeps the shared Delivery
 * components dependency-free so they render the same in both clients.
 *
 * @module web/components/delivery/icons
 */

import React from 'react';

const PATHS = {
  delivery: <><circle cx="6" cy="6" r="2.2" /><circle cx="6" cy="18" r="2.2" /><circle cx="18" cy="12" r="2.2" /><path d="M6 8.2v7.6M8 6h4a4 4 0 0 1 4 4v0M8 18h4a4 4 0 0 0 4-4v0" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  play: <path d="M8 5.5v13l10-6.5-10-6.5Z" />,
  pause: <path d="M9 5.5v13M15 5.5v13" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  chevron: <path d="m9 6 6 6-6 6" />,
  down: <path d="m6 9 6 6 6-6" />,
  branch: <><circle cx="7" cy="6" r="2" /><circle cx="7" cy="18" r="2" /><circle cx="17" cy="8" r="2" /><path d="M7 8v8M17 10c0 4-10 2-10 6" /></>,
  clock: <><circle cx="12" cy="12" r="8" /><path d="M12 7.5V12l3 2" /></>,
  sparkles: <><path d="M12 3.5 13.6 8 18 9.5l-4.4 1.6L12 15.5l-1.6-4.4L6 9.5 10.4 8 12 3.5Z" /><path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8Z" /></>,
  map: <><path d="M9 4 3 6.5v13.5L9 17.5l6 2.5 6-2.5V4l-6 2.5L9 4Z" /><path d="M9 4v13.5M15 6.5V20" /></>,
  chat: <path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-7l-4 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z" />,
  file: <><path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7l-4-4Z" /><path d="M14 3v4h4" /></>,
  more: <><circle cx="6" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="18" cy="12" r="1" /></>,
  alert: <><path d="M12 4 2.8 19.5h18.4L12 4Z" /><path d="M12 10v4.5M12 17.2v.1" /></>,
  inbox: <><path d="M4 13.5 6.5 5h11L20 13.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-5.5Z" /><path d="M4 13.5h4.5a3.5 3.5 0 0 0 7 0H20" /></>,
  refresh: <><path d="M20 11a8 8 0 0 0-14.3-4.9L4 8" /><path d="M4 3v5h5" /><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16" /><path d="M20 21v-5h-5" /></>,
  grip: <><circle cx="9" cy="7" r="1" /><circle cx="15" cy="7" r="1" /><circle cx="9" cy="12" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="9" cy="17" r="1" /><circle cx="15" cy="17" r="1" /></>,
  help: <><circle cx="12" cy="12" r="8.5" /><path d="M9.6 9.6a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1.1.9-1.1 1.7M12 16.8v.1" /></>,
  tag: <><path d="M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7l8.3 8.3a1 1 0 0 1 0 1.4l-7.1 7.1a1 1 0 0 1-1.4 0L3.5 12.2Z" /><circle cx="8" cy="8" r="1.2" /></>,
  rocket: <><path d="M14 4c3.6 0 6 2.4 6 6-1.5 4-5 7.5-9 9l-4-4c1.5-4 5-7.5 7-11Z" /><circle cx="14.5" cy="9.5" r="1.4" /><path d="M7.5 14.5c-1.8.4-2.8 1.6-3 3.5 1.9-.2 3.1-1.2 3.5-3M5 19l1.5-1.5" /></>,
  undo: <><path d="M9 5 4 10l5 5" /><path d="M4 10h9a6 6 0 0 1 0 10h-3" /></>,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  checkCircle: <><circle cx="12" cy="12" r="8.5" /><path d="m8.2 12.4 2.6 2.6 5-5.4" /></>,
  xCircle: <><circle cx="12" cy="12" r="8.5" /><path d="m9.2 9.2 5.6 5.6M14.8 9.2l-5.6 5.6" /></>,
  list: <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />,
} as const;

export type DvGlyph = keyof typeof PATHS;

export function DvIcon({ name, size = 16, className }: { name: DvGlyph; size?: number; className?: string }): React.ReactElement {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}
    >
      {PATHS[name]}
    </svg>
  );
}
