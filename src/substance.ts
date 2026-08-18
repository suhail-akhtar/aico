/**
 * Whether the work is real, or just shaped like it.
 *
 * The browser check catches theater that *runs*: a canvas nobody draws to, a
 * button that changes nothing. It cannot catch the other kind. A handler whose
 * whole body is `// TODO: implement the 3D view` fires, does nothing anyone
 * asked for, and still changes the page enough to look alive. Neither can a
 * keyword scan — "3D view" appears in the file exactly as the brief spelled it,
 * which is how a shell scored twelve out of twelve.
 *
 * So this reads the source for the signatures of unfinished work, and reports
 * them with the line so they can be found. Deliberately conservative, because
 * a false accusation of laziness is worse than a missed one: it sends a model
 * to rewrite code that was already fine, and after two of those it stops
 * believing the check. Every signature here is one that essentially never
 * appears in finished work.
 *
 * Advisory by design. Placeholders are reported to the model and surfaced in
 * the verdict, but they do not by themselves block a turn the way a page that
 * throws does — a single `TODO` in a comment is a note, not a broken artifact.
 * The gate blocks on things that demonstrably do not work.
 *
 * @module substance
 */

export interface Placeholder {
  line: number;
  /** What was found, quoted, so it can be located without re-deriving it. */
  text: string;
  /** Why it counts as unfinished. */
  reason: string;
}

/**
 * Signatures of work that was described rather than done.
 *
 * Ordered by how damning each is. `stripStrings` is applied first for the ones
 * that would otherwise fire on a page whose *content* discusses to-do lists.
 */
const SIGNATURES: { re: RegExp; reason: string; codeOnly: boolean }[] = [
  {
    re: /\b(?:TODO|FIXME|XXX)\b[:\s]*(?:implement|add|build|finish|write|complete|wire)/i,
    reason: 'a comment saying the work still needs doing',
    codeOnly: true,
  },
  {
    re: /\/\/\s*(?:implementation|logic|code)\s+(?:goes\s+)?here\b/i,
    reason: 'a comment standing in for the implementation',
    codeOnly: true,
  },
  {
    re: /\b(?:alert|console\.(?:log|warn))\s*\(\s*['"`](?:not implemented|coming soon|todo|unimplemented)/i,
    reason: 'a stub that announces itself at runtime',
    codeOnly: true,
  },
  {
    re: /\b(?:function\s+\w+\s*\([^)]*\)|=>)\s*\{\s*(?:\/\/[^\n]*)?\s*\}/,
    reason: 'a function with an empty body',
    codeOnly: true,
  },
  {
    // Read against the raw line, not the stripped one. The message *is* a
    // string literal, so blanking string contents — which is what stops the
    // other rules firing on page copy — deletes the only evidence. `throw new
    // Error(` immediately before it is unambiguous enough to be safe.
    re: /\bthrow\s+new\s+Error\s*\(\s*['"`]\s*(?:not implemented|unimplemented|todo|stub)/i,
    reason: 'a function that throws instead of working',
    codeOnly: false,
  },
  {
    re: /\blorem\s+ipsum\b/i,
    reason: 'placeholder copy left in the page',
    codeOnly: false,
  },
  {
    re: /(?:>|["'])\s*(?:coming soon|placeholder|TBD|to be (?:added|done|implemented))\s*(?:<|["'])/i,
    reason: 'placeholder text shown to the user',
    codeOnly: false,
  },
];

/** Blank out string and template literals so their contents cannot match code rules. */
function stripStrings(line: string): string {
  return line
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

/**
 * Find the unfinished parts of a source file.
 *
 * Line-based rather than parsed: the input is one HTML file with inline script,
 * and a parser that has to be right about which of five languages a line is in
 * would fail on exactly the malformed files this most needs to read.
 */
export function findPlaceholders(source: string, limit = 12): Placeholder[] {
  const found: Placeholder[] = [];
  const lines = source.split('\n');

  for (let i = 0; i < lines.length && found.length < limit; i++) {
    const raw = lines[i]!;
    if (raw.length > 2000) continue; // minified or data-URI; nothing readable to find
    const stripped = stripStrings(raw);

    for (const sig of SIGNATURES) {
      const target = sig.codeOnly ? stripped : raw;
      if (!sig.re.test(target)) continue;
      found.push({
        line: i + 1,
        text: raw.trim().slice(0, 120),
        reason: sig.reason,
      });
      break; // one finding per line — the first is the one worth reporting
    }
  }

  return found;
}

/** The findings as a note for the model, or nothing when the work is substantive. */
export function describePlaceholders(found: Placeholder[]): string | undefined {
  if (found.length === 0) return undefined;
  const lines = found.map(p => `  line ${p.line}: ${p.reason} — ${p.text}`);
  return `${found.length} place(s) where the work is described rather than done:\n`
    + `${lines.join('\n')}\n`
    + `Finish these. A control that exists but does nothing is not a feature, and the `
    + `user asked for the behaviour, not the button.`;
}
