import type { Metadata } from 'next';
import Link from 'next/link';
import { currentUser } from '@/lib/auth';
import { logout } from '@/app/actions/auth';
import { AppShell } from '@/components/shell/AppShell';
import './globals.css';

const TITLE = '__APP_TITLE__';

export const metadata: Metadata = {
  title: TITLE,
  description: '__APP_DESCRIPTION__',
};

/**
 * Two shells, chosen by whether someone is signed in.
 *
 * Signed out, the pages sell: a top bar, the content, a footer. Signed in, the
 * pages work: side navigation, a measured column, the account at the bottom of
 * the rail. Neither is repeated in a page.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  return (
    <html lang="en">
      <body className="min-h-screen">
        {user ? (
          <AppShell title={TITLE} user={user} signOut={logout}>{children}</AppShell>
        ) : (
          <div className="flex min-h-screen flex-col">
            <header className="border-b border-line">
              <div className="mx-auto flex max-w-5xl items-center gap-4 px-4 py-3">
                <Link href="/" className="font-semibold tracking-tight">{TITLE}</Link>
                <nav className="ml-auto flex items-center gap-3 text-sm">
                  <Link href="/login" className="hover:text-brand">Sign in</Link>
                  <Link href="/register" className="btn btn-sm">Create account</Link>
                </nav>
              </div>
            </header>
            <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10">{children}</main>
            <footer className="border-t border-line text-xs text-ink-muted">
              <div className="mx-auto max-w-5xl px-4 py-4">{TITLE}</div>
            </footer>
          </div>
        )}
      </body>
    </html>
  );
}
