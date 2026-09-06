import Link from 'next/link';
import { currentUser } from '@/lib/auth';

export default async function Home() {
  const user = await currentUser();
  return (
    <section className="py-12 text-center">
      <p className="text-brand text-xs font-semibold uppercase tracking-widest">Placeholder eyebrow</p>
      <h1 className="mt-2 text-4xl font-bold tracking-tight">__APP_TITLE__</h1>
      <p className="mx-auto mt-4 max-w-xl text-lg text-ink-muted">__APP_DESCRIPTION__</p>
      <div className="mt-8 flex justify-center gap-3">
        {user ? (
          <Link href="/items" className="btn">Go to your items</Link>
        ) : (
          <>
            <Link href="/register" className="btn">Create an account</Link>
            <Link href="/login" className="btn btn-ghost">Sign in</Link>
          </>
        )}
      </div>
    </section>
  );
}
