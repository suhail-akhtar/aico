// Cursors are opaque to callers: base64url JSON, so the format can change
// without breaking API clients that only pass them back.

export function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ t: row.createdAt }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
  } catch {
    throw new TypeError('invalid cursor');
  }
  if (!parsed || !Number.isFinite(parsed.t)) throw new TypeError('invalid cursor');
  return { createdAt: parsed.t };
}
