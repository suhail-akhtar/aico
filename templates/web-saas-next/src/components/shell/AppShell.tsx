import Link from 'next/link';
import { SideNav } from './SideNav';
import { NAV } from './nav';

interface Props {
  title: string;
  user: { email: string };
  signOut: () => Promise<void>;
  children: React.ReactNode;
}

/**
 * The signed-in shell: side navigation on wide screens, a top bar with a
 * menu below `md`, and a measured content column. Written once, here — a
 * page renders its header and content and nothing else.
 *
 * The narrow menu is a `<details>` element so it needs no script and closes
 * with the same tap that opened it.
 */
export function AppShell({ title, user, signOut, children }: Props) {
  return (
    <div className="min-h-screen md:grid md:grid-cols-[232px_minmax(0,1fr)]">
      <aside className="hidden md:flex md:flex-col border-r border-line bg-surface-alt px-3 py-4">
        <Link href="/" className="px-3 text-base font-semibold tracking-tight">{title}</Link>
        <div className="mt-6">
          <SideNav links={NAV} />
        </div>
        <div className="mt-auto border-t border-line pt-3 px-3">
          <div className="truncate text-xs text-ink-muted" title={user.email}>{user.email}</div>
          <form action={signOut} className="mt-2">
            <button className="btn btn-ghost btn-sm w-full" type="submit">Sign out</button>
          </form>
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="border-b border-line md:hidden">
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3">
              <span className="font-semibold">{title}</span>
              <span className="btn btn-ghost btn-sm" aria-hidden="true">Menu</span>
            </summary>
            <div className="border-t border-line bg-surface-alt px-2 py-2">
              <SideNav links={NAV} />
              <div className="mt-2 flex items-center justify-between px-3 py-1 text-xs text-ink-muted">
                <span className="truncate">{user.email}</span>
                <form action={signOut}>
                  <button className="text-brand" type="submit">Sign out</button>
                </form>
              </div>
            </div>
          </details>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
      </div>
    </div>
  );
}
