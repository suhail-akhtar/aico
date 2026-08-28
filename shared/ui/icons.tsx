/**
 * The small icons the widget frame is built from.
 *
 * Defined here rather than imported from the web app because these components
 * are shared: they render in the client, in a static export, and in tests, and
 * a dependency pointing back into one consumer would tie all three to it.
 *
 * One stroke weight, one 16-unit grid, `currentColor` throughout. Icons that
 * disagree about any of those read as a set of borrowed glyphs rather than a
 * toolbar, which is the specific thing that makes an interface look assembled.
 *
 * @module shared/ui/icons
 */

import React from 'react';

export type IconName =
  | 'copy' | 'check' | 'download' | 'expand' | 'shrink'
  | 'hide' | 'show' | 'code' | 'zoom-in' | 'zoom-out' | 'fit';

const PATHS: Record<IconName, React.ReactNode> = {
  copy: <><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 3.5H4A1.5 1.5 0 0 0 2.5 5v6.5" /></>,
  check: <path d="m3.5 8.5 3 3 6-7" />,
  download: <><path d="M8 2.5v8" /><path d="m4.5 7.5 3.5 3 3.5-3" /><path d="M2.5 13h11" /></>,
  expand: <><path d="M9.5 2.5h4v4" /><path d="M6.5 13.5h-4v-4" /><path d="M13.5 2.5 9 7" /><path d="M2.5 13.5 7 9" /></>,
  shrink: <><path d="M13 3 9 7m0 0V3.5M9 7h3.5" /><path d="M3 13l4-4m0 0v3.5M7 9H3.5" /></>,
  hide: <><path d="M2 8s2.3-4 6-4 6 4 6 4-2.3 4-6 4-6-4-6-4Z" /><circle cx="8" cy="8" r="1.6" /></>,
  show: <><path d="M2 8s2.3-4 6-4 6 4 6 4-2.3 4-6 4-6-4-6-4Z" /><path d="m3 3 10 10" /></>,
  code: <><path d="m5.5 5.5-3 2.5 3 2.5" /><path d="m10.5 5.5 3 2.5-3 2.5" /></>,
  'zoom-in': <><circle cx="7" cy="7" r="4.2" /><path d="M10.2 10.2 14 14" /><path d="M7 5.2v3.6M5.2 7h3.6" /></>,
  'zoom-out': <><circle cx="7" cy="7" r="4.2" /><path d="M10.2 10.2 14 14" /><path d="M5.2 7h3.6" /></>,
  fit: <><rect x="2.5" y="3.5" width="11" height="9" rx="1.5" /><path d="M5.5 7.5h5M8 5.5v4" /></>,
};

export function Icon({ name, size = 14 }: { name: IconName; size?: number }): React.ReactElement {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      // Decorative: every one of these sits on a button that already carries an
      // accessible name, and announcing the glyph as well would read the label
      // twice.
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}

/**
 * One control in a widget's toolbar.
 *
 * The label is both the tooltip and the accessible name, so an icon-only button
 * is never unlabelled to a screen reader — which is the usual cost of replacing
 * words with pictures, and is not worth paying.
 */
export function IconButton({
  icon, label, onClick, active = false,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  /** Drawn as pressed. For toggles whose state is otherwise invisible. */
  active?: boolean;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`rounded p-1 transition-colors hover:bg-aico-hover hover:text-aico-primary ${
        active ? 'bg-aico-hover text-aico-primary' : 'text-aico-muted'}`}
    >
      <Icon name={icon} />
    </button>
  );
}
