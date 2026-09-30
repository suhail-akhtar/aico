/**
 * `{{secret:name}}` and `{{secret:name.field}}` — how the model refers to a
 * value it is not allowed to hold.
 *
 * The model writes the reference; trusted code substitutes the value at the
 * last moment, inside the process that sends it, after policy and approval.
 * This module only parses and substitutes. It never decides whether a use is
 * allowed — that is `resolve()`'s job, and a consumer that called
 * {@link substitutePlaceholders} with a resolver that skipped it would be the
 * bug.
 *
 * An unknown name is an error that lists *similar names*, never values, so
 * the model can correct a typo without being shown anything it should not see.
 *
 * @module vault/placeholders
 */

import { SECRET_FIELDS, type CredentialKind } from './types.js';

/** Matches one reference. Names follow `NAME_RE`; a field is an identifier. */
export const PLACEHOLDER_RE = /\{\{\s*secret:([A-Za-z0-9][A-Za-z0-9_-]{0,63})(?:\.([A-Za-z][A-Za-z0-9_]{0,31}))?\s*\}\}/g;

export interface PlaceholderRef {
  /** The text as written, e.g. `{{secret:db.password}}`. */
  raw: string;
  name: string;
  field?: string;
  start: number;
  end: number;
}

/** Every reference in `text`, in order. */
export function parsePlaceholders(text: string): PlaceholderRef[] {
  const out: PlaceholderRef[] = [];
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    out.push({
      raw: m[0],
      name: m[1]!,
      ...(m[2] ? { field: m[2] } : {}),
      start: m.index!,
      end: m.index! + m[0].length,
    });
  }
  return out;
}

export function hasPlaceholders(text: string): boolean {
  PLACEHOLDER_RE.lastIndex = 0;
  const found = PLACEHOLDER_RE.test(text);
  PLACEHOLDER_RE.lastIndex = 0;
  return found;
}

/** The field a bare reference resolves to for a kind (its first secret field). */
export function defaultField(kind: CredentialKind, fields: string[]): string | undefined {
  const preferred = SECRET_FIELDS[kind].find(f => fields.includes(f));
  return preferred ?? fields[0];
}

/** The reference the model should write for a credential. */
export function referenceFor(name: string, field?: string): string {
  return `{{secret:${name}${field ? `.${field}` : ''}}}`;
}

/**
 * Replace every reference using `resolve`, which returns the value to put
 * there (for a trusted consumer: the secret; for the shell: an environment
 * variable reference). Resolution happens once per distinct reference.
 */
export async function substitutePlaceholders(
  text: string,
  resolve: (ref: PlaceholderRef) => Promise<string>,
): Promise<string> {
  const refs = parsePlaceholders(text);
  if (!refs.length) return text;
  const values = new Map<string, string>();
  for (const ref of refs) {
    const key = `${ref.name}.${ref.field ?? ''}`;
    if (!values.has(key)) values.set(key, await resolve(ref));
  }
  let out = '';
  let at = 0;
  for (const ref of refs) {
    out += text.slice(at, ref.start) + values.get(`${ref.name}.${ref.field ?? ''}`)!;
    at = ref.end;
  }
  return out + text.slice(at);
}
