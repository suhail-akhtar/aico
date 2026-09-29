/**
 * Links the agent writes in the main chat: a normal click keeps doing what it
 * always did (the system browser); Ctrl+click (⌘+click) opens the link in
 * AICO's own browser, in a new tab, and shows it.
 *
 * @module desktop/renderer/browser/links
 */

import { go } from '@/state/desk';
import { openUrl } from './store';

export function installBrowserLinks(): () => void {
  const onClick = (e: MouseEvent): void => {
    if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    const a = target?.closest?.('a');
    const href = a?.getAttribute('href');
    if (!a || !href || !/^https?:\/\//i.test(href)) return;
    // The copilot already opens its links in the browser; this is for the chat and other readers.
    if (a.closest('.cp-panel')) return;
    if (!a.closest('.transcript, .markdown-body, [data-links-browser]')) return;
    e.preventDefault();
    e.stopPropagation();
    go('browser');
    openUrl(href, true);
  };
  document.addEventListener('click', onClick, true);
  return () => document.removeEventListener('click', onClick, true);
}
