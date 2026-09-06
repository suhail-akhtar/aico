import type { Metadata } from 'next';
import Link from 'next/link';
import { currentUser } from '@/lib/auth';
import { logout } from '@/app/actions/auth';
import './globals.css';

export const metadata: Metadata = {
  title: '__APP_TITLE__',
  description: '__APP_DESCRIPTION__',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  return (
    <html lang="en">
      <body className="min-h-screen flex flex-col">
        <header className="border-b border-line">
          <div className="mx-auto max-w-4xl flex items-center gap-4 px-4 py-3">
            <Link href="/" className="font-bold">__APP_TITLE__</Link>
            <nav className="ml-auto flex items-center gap-3 text-sm">
              {user ? (
                <>
                  <Link href="/items" className="hover:text-brand">Items</Link>
                  <span className="text-ink-muted hidden sm:inline">{user.email}</span>
                  <form action={logout}>
                    <button className="btn btn-ghost btn-sm" type="submit">Sign out</button>
                  </form>
                </>
              ) : (
                <>
                  <Link href="/login" className="hover:text-brand">Sign in</Link>
                  <Link href="/register" className="btn btn-sm">Create account</Link>
                </>
              )}
            </nav>
          </div>
        </header>
        <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8">{children}</main>
        <footer className="border-t border-line text-ink-muted text-xs">
          <div className="mx-auto max-w-4xl px-4 py-4">__APP_TITLE__</div>
        </footer>
      </body>
    </html>
  );
}
