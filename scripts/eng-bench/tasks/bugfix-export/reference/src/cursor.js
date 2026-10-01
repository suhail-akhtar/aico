// Reference fix (grader self-test only): the cursor carries the tie-breaker.

export function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ t: row.createdAt, id: row.id }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
  } catch {
    throw new TypeError('invalid cursor');
  }
  if (!parsed || !Number.isFinite(parsed.t)) throw new TypeError('invalid cursor');
  return { createdAt: parsed.t, id: typeof parsed.id === 'string' ? parsed.id : null };
}
