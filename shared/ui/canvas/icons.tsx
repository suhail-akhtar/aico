/**
 * The canvas's own small icon set, drawn the way the rich blocks' are
 * (16-unit grid, 1.4 stroke, currentColor).
 *
 * @module shared/ui/canvas/icons
 */

import React from 'react';

export type CanvasIconName =
  | 'doc' | 'code' | 'sparkle' | 'history' | 'copy' | 'check' | 'download' | 'close' | 'open' | 'undo' | 'redo'
  | 'bold' | 'italic' | 'strike' | 'inline-code' | 'link' | 'bullet' | 'number' | 'task' | 'quote' | 'codeblock'
  | 'table' | 'rule' | 'split' | 'write' | 'eye' | 'send' | 'restore' | 'expand' | 'warn'
  | 'comment' | 'image' | 'plus' | 'fullscreen' | 'shrink' | 'share' | 'chevron' | 'follow' | 'callout' | 'math'
  | 'chart' | 'diagram' | 'heading' | 'trash' | 'pencil' | 'page' | 'markdown';

const PATHS: Record<CanvasIconName, React.ReactNode> = {
  doc: <><path d="M4 1.8h5.5L13 5.3V13a1.2 1.2 0 0 1-1.2 1.2H4A1.2 1.2 0 0 1 2.8 13V3A1.2 1.2 0 0 1 4 1.8z" /><path d="M9.3 1.9v3.6H13M5.3 8.3h5.4M5.3 10.8h3.6" /></>,
  code: <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5M9 3 7 13" />,
  sparkle: <><path d="M7 2.5 8.2 6 11.7 7.2 8.2 8.4 7 11.9 5.8 8.4 2.3 7.2 5.8 6z" /><path d="M12.3 10.3l.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.5z" /></>,
  history: <><path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9" /><path d="M2.3 2.6v2.6h2.6" /><path d="M8 5v3.2l2.2 1.3" /></>,
  copy: <><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 3.5H4A1.5 1.5 0 0 0 2.5 5v6.5" /></>,
  check: <path d="m3.5 8.5 3 3 6-7" />,
  download: <><path d="M8 2.5v8" /><path d="m4.5 7.5 3.5 3 3.5-3" /><path d="M2.5 13h11" /></>,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  open: <><path d="M9 2.5h4.5V7" /><path d="M13.5 2.5 7.5 8.5" /><path d="M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" /></>,
  undo: <><path d="M5 3.5 2.5 6 5 8.5" /><path d="M2.8 6h6.7a3.5 3.5 0 0 1 0 7H6" /></>,
  redo: <><path d="M11 3.5 13.5 6 11 8.5" /><path d="M13.2 6H6.5a3.5 3.5 0 0 0 0 7H10" /></>,
  bold: <path d="M4.5 2.8h4.3a2.5 2.5 0 0 1 0 5H4.5zM4.5 7.8h5a2.7 2.7 0 0 1 0 5.4h-5z" strokeWidth={1.7} />,
  italic: <path d="M6.5 2.8h5M4.5 13.2h5M9.8 2.8 6.2 13.2" />,
  strike: <><path d="M2.5 8h11" /><path d="M11 4.3C10.5 3.3 9.4 2.8 8 2.8c-1.8 0-3 .9-3 2.3 0 .8.4 1.4 1.2 1.9M5 11.3c.5 1.2 1.6 1.9 3.1 1.9 1.9 0 3.1-1 3.1-2.5 0-.6-.2-1.1-.6-1.5" /></>,
  'inline-code': <path d="M6 4.5 2.5 8 6 11.5M10 4.5 13.5 8 10 11.5" />,
  link: <><path d="M6.8 9.2a2.8 2.8 0 0 0 4 0l2-2a2.8 2.8 0 0 0-4-4l-.8.8" /><path d="M9.2 6.8a2.8 2.8 0 0 0-4 0l-2 2a2.8 2.8 0 0 0 4 4l.8-.8" /></>,
  bullet: <><circle cx="3" cy="4.5" r=".9" fill="currentColor" /><circle cx="3" cy="8" r=".9" fill="currentColor" /><circle cx="3" cy="11.5" r=".9" fill="currentColor" /><path d="M6 4.5h7.5M6 8h7.5M6 11.5h7.5" /></>,
  number: <><path d="M2.3 3.2h1v3M2.2 6.2h2M2.2 9.3c.2-.6.7-.9 1.2-.9.6 0 1 .4 1 .9 0 .9-2.2 1.4-2.2 2.4h2.3" /><path d="M6.5 4.5h7M6.5 8h7M6.5 11.5h7" /></>,
  task: <><rect x="2" y="3" width="4" height="4" rx="1" /><path d="m2.8 11.2 1.1 1.1 2-2.3" /><path d="M8.5 5h5M8.5 11h5" /></>,
  quote: <><path d="M3 4.5h10M6 8h7M6 11.5h7" /><path d="M3 7.5v4.5" strokeWidth={2} /></>,
  codeblock: <><rect x="2" y="2.5" width="12" height="11" rx="1.6" /><path d="M6.3 6.3 4.8 8l1.5 1.7M9.7 6.3 11.2 8l-1.5 1.7" /></>,
  table: <><rect x="2" y="2.5" width="12" height="11" rx="1.4" /><path d="M2 6.2h12M2 9.8h12M6.5 6.2v7.3" /></>,
  rule: <><path d="M2 8h12" /><path d="M4 4.5h8M4 11.5h8" opacity={0.35} /></>,
  split: <><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M8 2.5v11" /></>,
  write: <><path d="M10.5 2.5l3 3-8 8H2.5v-3z" /><path d="M9 4l3 3" /></>,
  eye: <><path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8z" /><circle cx="8" cy="8" r="2" /></>,
  send: <path d="M2.5 8 13.5 2.5 10.5 13.5 8 9zM8 9l5.5-6.5" />,
  restore: <><path d="M3 8a5 5 0 1 0 1.5-3.6" /><path d="M2.8 2.8v2.4h2.4" /></>,
  expand: <><path d="M9.5 2.5h4v4" /><path d="M6.5 13.5h-4v-4" /><path d="M13.5 2.5 9 7" /><path d="M2.5 13.5 7 9" /></>,
  warn: <><path d="M8 2.2 14.3 13H1.7z" /><path d="M8 6.5v3M8 11.3v.2" /></>,
  comment: <path d="M2.5 3.8A1.3 1.3 0 0 1 3.8 2.5h8.4a1.3 1.3 0 0 1 1.3 1.3v6.1a1.3 1.3 0 0 1-1.3 1.3H7l-3 2.3v-2.3h-.2a1.3 1.3 0 0 1-1.3-1.3z" />,
  image: <><rect x="2" y="2.8" width="12" height="10.4" rx="1.5" /><circle cx="5.6" cy="6.2" r="1.2" /><path d="m2.5 12 3.8-3.6 2.6 2.4 1.8-1.6 3 2.8" /></>,
  plus: <path d="M8 3v10M3 8h10" />,
  fullscreen: <><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" /></>,
  shrink: <><path d="M6 2.5V6H2.5M13.5 6H10V2.5M10 13.5V10h3.5M2.5 10H6v3.5" /></>,
  share: <><path d="M8 10V2.5" /><path d="M5 5.3 8 2.5l3 2.8" /><path d="M4.5 7.5h-1a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-4a1 1 0 0 0-1-1h-1" /></>,
  chevron: <path d="m4.5 6.3 3.5 3.4 3.5-3.4" />,
  follow: <><circle cx="8" cy="8" r="2.2" /><path d="M8 1.8v2.4M8 11.8v2.4M1.8 8h2.4M11.8 8h2.4" /></>,
  callout: <><rect x="2" y="3" width="12" height="10" rx="1.6" /><path d="M5 6.3h6M5 9.3h4" /><path d="M2 3v10" strokeWidth={2.4} /></>,
  math: <path d="M3 4.5h5.5M11.5 3v3M10 4.5h3M3.5 9.5l3 3M6.5 9.5l-3 3M10 10h3M10 12h3" />,
  chart: <><path d="M2.5 13.5h11" /><path d="M4.5 11V8M7.5 11V4.5M10.5 11V6.5" strokeWidth={1.8} /></>,
  diagram: <><rect x="1.8" y="2.3" width="4.4" height="3.4" rx=".8" /><rect x="9.8" y="10.3" width="4.4" height="3.4" rx=".8" /><path d="M4 5.7v2.8h8v1.8" /></>,
  heading: <path d="M3.5 3v10M9.5 3v10M3.5 8h6M11.5 6.5 13 5.5V13" />,
  trash: <><path d="M3 4.5h10M6.5 4.5V3h3v1.5" /><path d="M4.3 4.5 5 13.5h6l.7-9" /></>,
  pencil: <><path d="M10.5 2.5l3 3-8 8H2.5v-3z" /></>,
  page: <><rect x="3" y="1.8" width="10" height="12.4" rx="1.3" /><path d="M5.5 5h5M5.5 7.5h5M5.5 10h3" /></>,
  markdown: <><rect x="1.5" y="3.5" width="13" height="9" rx="1.5" /><path d="M4 10.5v-5l2 2.5 2-2.5v5M11 5.5v5M9.5 9l1.5 1.5L12.5 9" /></>,
};

export function CvIcon({ name, size = 14, className }: { name: CanvasIconName; size?: number; className?: string }): React.ReactElement {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.4}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      {PATHS[name]}
    </svg>
  );
}
