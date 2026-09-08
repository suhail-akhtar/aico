'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * The navigation list, with the current section marked.
 *
 * A client component only because the current path is a browser fact; it
 * renders the same links the server knows about, so there is no flash.
 */
export function SideNav({ links, onNavigate }: { links: ReadonlyArray<{ href: string; label: string }>; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5 text-sm">
      {links.map(l => {
        const current = pathname === l.href || pathname.startsWith(`${l.href}/`);
        return (
          <Link
            key={l.href}
            href={l.href}
            onClick={onNavigate}
            aria-current={current ? 'page' : undefined}
            className={`rounded-lg px-3 py-2 ${current ? 'bg-surface font-medium text-ink shadow-sm' : 'text-ink-muted hover:bg-surface hover:text-ink'}`}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
