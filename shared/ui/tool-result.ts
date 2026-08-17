/**
 * Turning a tool result into something a person can read.
 *
 * Pure, and in its own module because it is where the worst of the output
 * formatting lived: a shell result rendered as raw JSON, showing
 * `{"stdout":" Volume in drive E
 Directory of…"}` — the output you wanted,
 * wrapped in quoting with its line breaks spelled out as escape sequences.
 *
 * Command output is text. It is presented as text.
 *
 * @module shared/ui/tool-result
 */

/** A newline, named so no literal control character appears in an expression. */
const LF = String.fromCharCode(10);
/** CRLF as a global pattern, built from escapes so the source stays ASCII. */
const CRLF = new RegExp('\\r\\n', 'g');
/** Trailing blank lines, which shells add and readers do not want. */
const TRAILING_BLANK = new RegExp('[\\r\\n]+$');

/**
 * Turn a tool result into something readable.
 *
 * A shell result arrives as `{stdout, stderr, exit_code}`, and dumping that as
 * JSON showed people `{"stdout":" Volume in drive E\r\n Directory of…"}` —
 * the output they wanted, wrapped in quoting and with its line breaks spelled
 * out as escape sequences. Command output is *text*; it is presented as text,
 * with stderr labelled and a non-zero exit reported rather than buried in a
 * field name.
 */
export function formatResult(result: unknown): { text: string; isError: boolean } {
  if (typeof result === 'string') return { text: result, isError: false };
  if (result === null || result === undefined) return { text: '', isError: false };
  if (typeof result !== 'object') return { text: String(result), isError: false };

  const r = result as Record<string, unknown>;

  // A shell result: stdout, then stderr, then the exit code if it failed.
  const hasShellShape = 'stdout' in r || 'stderr' in r || 'exit_code' in r || 'exitCode' in r;
  if (hasShellShape) {
    const exit = Number(r.exit_code ?? r.exitCode ?? 0);
    // CRLF reaches us verbatim from a Windows shell and renders as a stray
    // glyph in a <pre>; normalising is the difference between readable output
    // and output with a box at the end of every line.
    const clean = (value: unknown): string =>
      typeof value === 'string' ? value.replace(CRLF, LF).replace(TRAILING_BLANK, '') : '';
    const stdout = clean(r.stdout);
    const stderr = clean(r.stderr);
    const parts: string[] = [];
    if (stdout.trim()) parts.push(stdout);
    if (stderr.trim()) parts.push('stderr:\n' + stderr);
    if (exit !== 0) parts.push('exited ' + exit);
    return { text: parts.join('\n\n') || '(no output)', isError: exit !== 0 };
  }
  if (typeof r.error === 'string') return { text: r.error, isError: true };
  if (typeof r.content === 'string') return { text: r.content, isError: false };
  if (Array.isArray(r.results)) {
    // Search results: one titled line each, rather than a JSON array.
    return {
      text: r.results.map((item: unknown) => {
        const entry = item as Record<string, unknown>;
        const title = String(entry.title ?? entry.name ?? '');
        const url = String(entry.url ?? entry.link ?? '');
        const snippet = String(entry.snippet ?? entry.description ?? '');
        return [title, url, snippet].filter(Boolean).join(LF);
      }).join(LF + LF),
      isError: false,
    };
  }
  return { text: JSON.stringify(result, null, 2), isError: false };
}

