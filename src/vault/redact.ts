/**
 * Finding vault secrets in text on its way somewhere, and replacing them.
 *
 * This is the net under everything else. The broker's first line is that the
 * model never holds a value; but a tool that *uses* a password can still echo
 * it back — `mysql` printing its connection string, a config file the agent
 * wrote and then reads, `set -x` in a script. Every sink passes text through
 * here first (see `sink.ts` and the sink table in
 * docs/security/credential-broker.md), and every known secret value is
 * replaced by `[secret:<name>]`.
 *
 * **What is matched.** Each value is indexed in the encodings a leak actually
 * takes: raw; base64 (standard and url-safe, and — because a password is
 * usually encoded *inside* something, like `user:pass` in a Basic header — the
 * three byte alignments of it as a substring of a larger blob); URL-encoded;
 * JSON-escaped; hex (both cases); shell-quoted. A multi-line value (a private
 * key) is also indexed line by line, so a key printed with different line
 * endings or in part is still caught.
 *
 * **Short secrets.** Under 4 characters nothing is indexed: redacting every
 * `123` in a build log would make output unreadable while protecting nothing a
 * guess could not find. From 4 to 7 characters only the raw value is matched,
 * and only where it stands alone (not inside a longer word or number) — a
 * four-digit PIN is not redacted out of a timestamp. From 8 up, every
 * encoding. The vault warns when a short secret is stored.
 *
 * **What is not.** Arbitrary transformations: reversed, split with spaces,
 * ROT13, compressed, encrypted, line-wrapped base64, one character per line.
 * A model that has the value and wants to smuggle it out can. The broker's
 * answer is that the model never has the value; this catches the accidents
 * and the obvious attempts. Stated in the docs as a limit, not hidden.
 *
 * Matching is a single left-to-right pass keyed on four-character prefixes,
 * so cost is linear in the text and nearly independent of how many secrets
 * are stored.
 *
 * @module vault/redact
 */

/** A credential's name and every secret value it holds. */
export interface SecretEntry {
  name: string;
  values: string[];
}

interface Variant {
  text: string;
  name: string;
  /** Only match where not flanked by a letter or digit (short secrets). */
  bounded: boolean;
}

const KEY_LEN = 4;
/** Values shorter than this are not indexed at all. */
export const MIN_SECRET_LENGTH = 4;
/** Below this only the raw, word-bounded value is indexed. */
export const FULL_ENCODING_LENGTH = 8;
/** Encoded variants shorter than this are dropped as too collision-prone. */
const MIN_VARIANT = 6;
/** A line of a multi-line secret shorter than this is not indexed on its own. */
const MIN_LINE = 16;

const ARMOR_LINE = /^-----(BEGIN|END) [A-Z0-9 ]+-----$/;

/** The replacement written where a value was. */
export function placeholderFor(name: string): string {
  return `[secret:${name}]`;
}

/**
 * The encoded forms of `bytes` that appear when it is a substring of a larger
 * base64 blob, for each of the three byte alignments.
 *
 * A base64 character encodes six bits; at alignment `o` the first characters
 * mix bits of the unknown preceding bytes and the last ones mix bits of the
 * unknown following bytes. Only the characters built entirely from this
 * value's bits are kept.
 */
function base64Cores(bytes: Buffer, urlSafe: boolean): string[] {
  const out: string[] = [];
  for (let o = 0; o < 3; o++) {
    const padded = Buffer.concat([Buffer.alloc(o), bytes]);
    const enc = padded.toString(urlSafe ? 'base64url' : 'base64').replace(/=+$/, '');
    const start = Math.ceil((8 * o) / 6);
    const end = Math.floor((8 * padded.length) / 6);
    if (end > start) out.push(enc.slice(start, end));
  }
  return out;
}

/** Every form of one value worth looking for. */
export function variantsOf(value: string): Array<{ text: string; bounded: boolean }> {
  if (value.length < MIN_SECRET_LENGTH) return [];
  if (value.length < FULL_ENCODING_LENGTH) return [{ text: value, bounded: true }];

  const found = new Set<string>();
  const add = (text: string | undefined): void => {
    if (text && text.length >= MIN_VARIANT) found.add(text);
  };
  const encodeAll = (v: string): void => {
    const bytes = Buffer.from(v, 'utf8');
    add(v);
    add(JSON.stringify(v).slice(1, -1));
    add(encodeURIComponent(v));
    add(encodeURIComponent(v).replace(/%20/g, '+'));
    add(encodeURIComponent(v).replace(/%[0-9A-F]{2}/g, m => m.toLowerCase()));
    add(bytes.toString('hex'));
    add(bytes.toString('hex').toUpperCase());
    add(bytes.toString('base64'));
    add(bytes.toString('base64').replace(/=+$/, ''));
    add(bytes.toString('base64url'));
    for (const core of base64Cores(bytes, false)) add(core);
    for (const core of base64Cores(bytes, true)) add(core);
    // Shell quoting: inside '…' a quote becomes '\'' ; inside "…" these four are escaped.
    add(v.replace(/'/g, `'\\''`));
    add(v.replace(/(["\\$`])/g, '\\$1'));
  };

  encodeAll(value);
  if (/\r?\n/.test(value)) {
    encodeAll(value.replace(/\r?\n/g, '\r\n'));
    encodeAll(value.replace(/\r?\n/g, '\n'));
    for (const raw of value.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.length >= MIN_LINE && !ARMOR_LINE.test(line)) encodeAll(line);
    }
  }
  return [...found].map(text => ({ text, bounded: false }));
}

const isWordChar = (c: number): boolean =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);

interface Span { start: number; end: number; name: string }

/** An immutable index of secret values, and the operations over it. */
export class Redactor {
  private readonly byKey = new Map<string, Variant[]>();
  /** Prefixes of length 1..3, to recognise a value cut off at the end of a stream. */
  private readonly shortPrefixes = new Set<string>();
  /** Longest indexed variant; a stream holds back one less than this. */
  readonly maxLength: number;
  /** Number of distinct secret values indexed. */
  readonly size: number;

  static readonly EMPTY = new Redactor([]);

  /** The entries this was built from, so the sink can merge in its extras. */
  readonly entries: readonly SecretEntry[];

  constructor(entries: SecretEntry[]) {
    this.entries = entries;
    let max = 0;
    let count = 0;
    for (const entry of entries) {
      for (const value of entry.values) {
        const variants = variantsOf(value);
        if (variants.length) count++;
        for (const v of variants) {
          const key = v.text.slice(0, KEY_LEN);
          const list = this.byKey.get(key) ?? [];
          if (!list.some(x => x.text === v.text)) list.push({ text: v.text, name: entry.name, bounded: v.bounded });
          this.byKey.set(key, list);
          for (let n = 1; n < KEY_LEN; n++) this.shortPrefixes.add(v.text.slice(0, n));
          if (v.text.length > max) max = v.text.length;
        }
      }
    }
    // Longest first, so a full encoding wins over the substring core it contains.
    for (const list of this.byKey.values()) list.sort((a, b) => b.text.length - a.text.length);
    this.maxLength = max;
    this.size = count;
  }

  /** Nothing indexed: every operation is the identity. */
  get empty(): boolean { return this.byKey.size === 0; }

  private find(text: string, limit = text.length): Span[] {
    const spans: Span[] = [];
    if (this.empty) return spans;
    const last = Math.min(limit, text.length) - KEY_LEN;
    for (let i = 0; i <= last; i++) {
      const list = this.byKey.get(text.substr(i, KEY_LEN));
      if (!list) continue;
      for (const v of list) {
        if (!text.startsWith(v.text, i)) continue;
        const end = i + v.text.length;
        if (v.bounded && ((i > 0 && isWordChar(text.charCodeAt(i - 1))) || (end < text.length && isWordChar(text.charCodeAt(end))))) {
          continue;
        }
        spans.push({ start: i, end, name: v.name });
        i = end - 1;
        break;
      }
    }
    return spans;
  }

  private apply(text: string, spans: Span[]): string {
    if (!spans.length) return text;
    let out = '';
    let at = 0;
    for (const s of spans) {
      out += text.slice(at, s.start) + placeholderFor(s.name);
      at = s.end;
    }
    return out + text.slice(at);
  }

  /** Whether any indexed value occurs in `text`. */
  contains(text: string): boolean {
    return this.find(text).length > 0;
  }

  /** Replace every indexed value in `text`. */
  redact(text: string): string {
    if (this.empty || text.length < KEY_LEN) return text;
    return this.apply(text, this.find(text));
  }

  /**
   * Redact any JSON-shaped value: strings, arrays and plain objects, keys
   * included. Returns the same reference when nothing changed, so an
   * unaffected payload costs a walk and no copy.
   */
  redactDeep<T>(value: T): T {
    if (this.empty) return value;
    const seen = new WeakMap<object, unknown>();
    const walk = (v: unknown): unknown => {
      if (typeof v === 'string') return this.redact(v);
      if (!v || typeof v !== 'object') return v;
      if (seen.has(v)) return seen.get(v);
      if (Array.isArray(v)) {
        const copy: unknown[] = [];
        seen.set(v, copy);
        let changed = false;
        for (const item of v) {
          const next = walk(item);
          if (next !== item) changed = true;
          copy.push(next);
        }
        if (!changed) { seen.set(v, v); return v; }
        return copy;
      }
      if (v instanceof Error) {
        const message = this.redact(v.message);
        return message === v.message ? v : new Error(message);
      }
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) return v; // Buffers, Maps, class instances: left alone
      const copy: Record<string, unknown> = {};
      seen.set(v, copy);
      let changed = false;
      for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
        const key = this.redact(k);
        const next = walk(item);
        if (next !== item || key !== k) changed = true;
        copy[key] = next;
      }
      if (!changed) { seen.set(v, v); return v; }
      return copy;
    };
    return walk(value) as T;
  }

  /** Index at which a trailing fragment that could begin a secret starts, or -1. */
  private partialTail(text: string): number {
    if (this.empty) return -1;
    const from = Math.max(0, text.length - this.maxLength + 1);
    for (let j = from; j < text.length; j++) {
      const suffix = text.slice(j);
      if (suffix.length < KEY_LEN) {
        if (this.shortPrefixes.has(suffix)) return j;
        continue;
      }
      const list = this.byKey.get(suffix.slice(0, KEY_LEN));
      if (list?.some(v => v.text.length > suffix.length && v.text.startsWith(suffix))) return j;
    }
    return -1;
  }

  /**
   * Redact text that is *accumulated* and re-sent whole as it grows (the
   * `onChunk` contract). The tail is trimmed where it could be the start of a
   * value still arriving, so a prefix of a secret is never shown on its way
   * to being redacted. The complete text, once final, is redacted in full.
   */
  redactAccumulated(text: string): string {
    const redacted = this.redact(text);
    const cut = this.partialTail(redacted);
    return cut < 0 ? redacted : redacted.slice(0, cut);
  }

  /**
   * A redactor for text arriving as **deltas**. Holds back just enough of the
   * tail that a value split across two chunks is still caught whole.
   */
  stream(): StreamRedactor {
    let buffer = '';
    return {
      push: (chunk: string): string => {
        if (this.empty) return chunk;
        buffer += chunk;
        let cut = Math.max(0, buffer.length - (this.maxLength - 1));
        const spans = this.find(buffer);
        for (const s of spans) if (s.start < cut && s.end > cut) cut = s.end;
        const emit = this.apply(buffer.slice(0, cut), spans.filter(s => s.end <= cut));
        buffer = buffer.slice(cut);
        return emit;
      },
      flush: (): string => {
        const out = this.redact(buffer);
        buffer = '';
        return out;
      },
    };
  }
}

export interface StreamRedactor {
  /** Feed a delta; returns the part that is now safe to emit. */
  push(chunk: string): string;
  /** End of stream: returns whatever was held back, redacted. */
  flush(): string;
}
