import { db } from '@/lib/db';
import { dashboard, parseMetric, record } from '@/lib/metrics';

export const dynamic = 'force-dynamic';

/** The aggregated view the page uses, for other clients. */
export function GET(req: Request): Response {
  const days = Math.min(Math.max(Number(new URL(req.url).searchParams.get('days') ?? 14) || 14, 1), 365);
  return Response.json(dashboard(db(), days));
}

/** Ingest: `{ "name": "signups", "value": 3 }`. Anything that can POST JSON can feed the dashboard. */
export async function POST(req: Request): Promise<Response> {
  const parsed = parseMetric(await req.json().catch(() => null));
  if ('errors' in parsed) return Response.json({ error: 'invalid', fields: parsed.errors }, { status: 400 });
  return Response.json(record(db(), parsed.value.name, parsed.value.value), { status: 201 });
}
