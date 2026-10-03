/**
 * The AICO mark, drawn small and alive: the "the agent is still going" signal.
 *
 * It replaced a blinking text caret at the end of a streaming reply. A caret
 * says "you can type here", which is the opposite of what a reply that is
 * still being written means, and its hard on/off blink pulled the eye to the
 * bottom of every long answer. The mark is the app's own logo (the tile with
 * the A, as `desktop/renderer/src/shell/Sidebar.tsx#Logo` and the app icon
 * draw it), so the same shape that means "AICO" also means "AICO is working".
 *
 * Motion is CSS (`theme.css`, `.aico-mark`): the tile breathes and the A is
 * traced, held, and traced out on a 1.8 s loop. With `prefers-reduced-motion`
 * nothing moves — the mark is drawn whole and only its opacity eases. `still`
 * draws it whole without animating, for a second indicator on screen that
 * should not compete with the one at the end of the text.
 *
 * Decorative by default (`aria-hidden`): the live status rows around it say
 * what is happening in words. Pass `label` when the mark stands alone.
 *
 * Deliberately not a spinner ring: a ring reads as "loading a page", and a
 * turn is not that — it is a colleague writing.
 *
 * @module shared/ui/AicoMark
 */

import React, { useId } from 'react';

export function AicoMark({ size = 18, still = false, label, className }: {
  size?: number;
  still?: boolean;
  label?: string;
  className?: string;
}): React.ReactElement {
  // useId's characters are not all valid in a url(#…) reference across React versions.
  const gradient = `aico-mark-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <svg
      width={size} height={size} viewBox="0 0 32 32"
      className={['aico-mark', still ? '' : 'is-live', className ?? ''].filter(Boolean).join(' ')}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      data-aico-mark={still ? 'still' : 'live'}
    >
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--aico-accent)' }} />
          <stop offset="1" style={{ stopColor: 'color-mix(in srgb, var(--aico-accent) 55%, var(--aico-text-primary))' }} />
        </linearGradient>
      </defs>
      <rect className="aico-mark-tile" x="1.5" y="1.5" width="29" height="29" rx="9" fill={`url(#${gradient})`} />
      <path className="aico-mark-a" pathLength={1} d="M10 22.5 16 8.5l6 14" fill="none"
        stroke="var(--aico-bg)" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
      <path className="aico-mark-bar" pathLength={1} d="M12.3 17.5h7.4"
        stroke="var(--aico-bg)" strokeWidth="2.8" strokeLinecap="round" />
    </svg>
  );
}
