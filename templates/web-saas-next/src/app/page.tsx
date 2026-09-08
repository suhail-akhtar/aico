import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { NAV } from '@/components/shell/nav';

/**
 * The front door. Someone signed in goes straight to the first section — a
 * marketing page is not where their work is. Everyone else gets one promise,
 * one action, and three things that are true of this app today.
 */
export default async function Home() {
  if (await currentUser()) redirect(NAV[0]?.href ?? '/items');
  return (
    <div className="space-y-16">
      <section className="py-8 text-center">
        <h1 className="mx-auto max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl">__APP_TITLE__</h1>
        <p className="mx-auto mt-4 max-w-xl text-lg text-ink-muted">__APP_DESCRIPTION__</p>
        <div className="mt-8 flex justify-center gap-3">
          <Link href="/register" className="btn">Create an account</Link>
          <Link href="/login" className="btn btn-ghost">Sign in</Link>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        <div className="card">
          <h2 className="font-semibold">Your own space</h2>
          <p className="mt-1 text-sm text-ink-muted">Sign in and everything you keep here is yours alone — nothing is shared unless you build sharing.</p>
        </div>
        <div className="card">
          <h2 className="font-semibold">Fast to use</h2>
          <p className="mt-1 text-sm text-ink-muted">Pages render on the server and forms work without JavaScript; nothing waits on a spinner.</p>
        </div>
        <div className="card">
          <h2 className="font-semibold">Runs anywhere</h2>
          <p className="mt-1 text-sm text-ink-muted">One process and one file of data, shipped as a container image you can run on any host.</p>
        </div>
      </section>
    </div>
  );
}
