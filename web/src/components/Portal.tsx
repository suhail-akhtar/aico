/**
 * Render outside the sidebar.
 *
 * `position: fixed` is relative to the viewport *unless* an ancestor has a
 * transform, in which case that ancestor becomes the containing block. The
 * sidebar carries `md:translate-x-0` so its drawer can slide on small screens,
 * which quietly means every fixed child of it — a dialog with `inset-0`
 * included — is laid out inside a 280-pixel column rather than over the page.
 *
 * A portal to `document.body` sidesteps the whole question: there is no
 * transformed ancestor there, so fixed means fixed.
 *
 * @module components/Portal
 */

import { createPortal } from 'react-dom';
import type React from 'react';

export function Portal({ children }: { children: React.ReactNode }): React.ReactPortal {
  return createPortal(children, document.body);
}
