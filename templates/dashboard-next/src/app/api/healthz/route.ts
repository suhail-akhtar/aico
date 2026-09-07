import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export function GET(): Response {
  try {
    db().prepare('SELECT 1').get();
    return Response.json({ ok: true, db: 'ok' });
  } catch (err) {
    return Response.json({ ok: false, db: err instanceof Error ? err.message : String(err) }, { status: 503 });
  }
}
