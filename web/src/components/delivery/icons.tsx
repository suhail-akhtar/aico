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
  external: <><path d="M14 4h6v6" /><path d="M20 4 11 13" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></>,
  link: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1" /></>,
  bug: <><path d="M9 8a3 3 0 0 1 6 0" /><rect x="7" y="8" width="10" height="11" rx="5" /><path d="M12 12v7M4 12h3M17 12h3M5 7l2.5 2M19 7l-2.5 2M5 18l2.5-2M19 18l-2.5-2" /></>,
  wrench: <path d="M14.5 6.5a4 4 0 0 0 4.9 4.9L20 12l-8 8a2.1 2.1 0 0 1-3-3l8-8-.5-.5A4 4 0 0 0 14.5 6.5Z" />,
  flask: <><path d="M9.5 3.5h5M10.5 3.5v6L5 19a1.3 1.3 0 0 0 1.1 2h11.8A1.3 1.3 0 0 0 19 19l-5.5-9.5v-6" /><path d="M7.5 15h9" /></>,
  book: <><path d="M5 5.5A1.5 1.5 0 0 1 6.5 4H19v14H6.5A1.5 1.5 0 0 0 5 19.5v-14Z" /><path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3" /></>,
  star: <path d="m12 4 2.4 5 5.4.7-4 3.8 1 5.4-4.8-2.6-4.8 2.6 1-5.4-4-3.8 5.4-.7L12 4Z" />,
  user: <><circle cx="12" cy="8.5" r="3.2" /><path d="M5.5 20a6.5 6.5 0 0 1 13 0" /></>,
  board: <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M9.3 4v16M14.7 4v16" /></>,
  table: <><rect x="4" y="5" width="16" height="14" rx="2" /><path d="M4 10h16M4 14.5h16M10 10v9" /></>,
  activity: <path d="M3 12h4l2.5-6 5 12 2.5-6H21" />,
  filter: <path d="M4 5h16l-6.2 7.5V19l-3.6-2v-4.5L4 5Z" />,
  shield: <><path d="M12 3.5 5 6v5.5c0 4.2 2.9 7.4 7 9 4.1-1.6 7-4.8 7-9V6l-7-2.5Z" /><path d="m9.2 12 2 2 3.6-4" /></>,
  gauge: <><path d="M4.5 16a8 8 0 1 1 15 0" /><path d="m12 13 3.5-4.5" /><circle cx="12" cy="13.5" r="1" /></>,
  bolt: <path d="M13 3 5 13.5h6L10 21l8-10.5h-6L13 3Z" />,
  copy: <><rect x="8.5" y="8.5" width="11" height="11" rx="2" /><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" /></>,
  archive: <><rect x="3.5" y="4.5" width="17" height="4.5" rx="1" /><path d="M5 9v9.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4" /></>,
  keyboard: <><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 10h.01M10.5 10h.01M14 10h.01M17 10h.01M7 14h10" /></>,
  up: <path d="m6 15 6-6 6 6" />,
  sort: <path d="M8 5v14m0 0-3-3m3 3 3-3M16 19V5m0 0-3 3m3-3 3 3" />,
  panel: <><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M14.5 4.5v15" /></>,
  layers: <><path d="m12 4 8.5 4.5L12 13 3.5 8.5 12 4Z" /><path d="m3.5 12.5 8.5 4.5 8.5-4.5M3.5 16.5l8.5 4.5 8.5-4.5" /></>,
  calendar: <><rect x="4" y="5.5" width="16" height="14" rx="2" /><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" /></>,
  bookmark: <path d="M7 4h10a1 1 0 0 1 1 1v15l-6-4-6 4V5a1 1 0 0 1 1-1Z" />,
  lock: <><rect x="5.5" y="10.5" width="13" height="9.5" rx="2" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" /></>,
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
