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
  if (typeof result === 'string') {
    // A structured result reaches the client as the JSON string the log stored.
    // Reading it back is what turns `{"error":"Unknown tool: Write"}` into
    // "Unknown tool: Write" instead of showing the reader raw JSON.
    const parsed = tryParse(result);
    if (parsed && typeof parsed === 'object') return formatResult(parsed);
    return { text: result, isError: false };
  }
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


/** The headline fact about a finished tool call. */
export interface ToolOutcome {
  /** Short chip text — the thing worth knowing without expanding the row. */
  label: string;
  tone: 'good' | 'bad' | 'neutral';
  /** One line of supporting detail, when there is one worth the width. */
  detail?: string;
}

/**
 * The one thing worth showing about a finished call, when there is one.
 *
 * The generic fallback is a line count, which is honest and nearly useless: a
 * browser verification that found three broken controls and one that passed
 * cleanly both read as "7 lines". For tools whose result has a headline — did
 * it pass, where did the shell end up, what was left running — that headline is
 * the summary, and the line count goes back to being the fallback it was meant
 * to be.
 *
 * Returns undefined for everything else, so no tool is given a summary that
 * pretends to more meaning than its result has.
 */
export function outcomeOf(name: string, result: unknown): ToolOutcome | undefined {
  if (result === undefined || result === null) return undefined;

  // VerifyApp answers one question, and its answer is the first line.
  if (name === 'VerifyApp' && typeof result === 'string') {
    if (result.startsWith('PASSED')) return { label: 'works', tone: 'good' };
    if (result.startsWith('FAILED')) {
      const count = /has (\d+) problem/.exec(result);
      // The first problem is ordered worst-first, so it is the one to surface.
      const firstProblem = result.split(LF).find(line => line.trim().startsWith('- '));
      return {
        label: count ? `${count[1]} problem${count[1] === '1' ? '' : 's'}` : 'broken',
        tone: 'bad',
        ...(firstProblem ? { detail: firstProblem.trim().slice(2) } : {}),
      };
    }
    return undefined;
  }

  // The project's own checks, answering the same question VerifyApp answers for
  // a page: does this work.
  if (name === 'RunChecks' && typeof result === 'string') {
    if (result.startsWith('PASSED')) {
      const count = /^PASSED — (\d+) check/.exec(result);
      return { label: count ? `${count[1]}/${count[1]} green` : 'green', tone: 'good' };
    }
    if (result.startsWith('FAILED')) {
      const which = /^FAILED — (\S+) did not pass/.exec(result);
      const firstLine = result.split(LF).find(l => l.startsWith('FAIL '));
      return {
        label: which ? `${which[1]} failing` : 'failing',
        tone: 'bad',
        ...(firstLine ? { detail: firstLine.replace(/\s+/g, ' ').trim() } : {}),
      };
    }
    return undefined;
  }

  // A structured result reaches the client as the JSON string the log stored,
  // not as an object. Tests that pass an object therefore prove nothing about
  // the running UI — these branches never fired in the browser until this
  // parsed first, and the unit tests were green throughout.
  const parsed = typeof result === 'string' ? tryParse(result) : result;
  if (!parsed || typeof parsed !== 'object') return undefined;
  const r = parsed as Record<string, unknown>;

  // A backgrounded command is not finished, and saying "exit 0" about it would
  // be actively wrong.
  const background = r.background as { pid?: number } | undefined;
  if (background?.pid) return { label: `running · pid ${background.pid}`, tone: 'neutral' };

  // The whole point of a persistent shell is where it left you.
  if (name === 'Terminal' && typeof r.cwd === 'string') {
    const failed = typeof r.exit_code === 'number' && r.exit_code !== 0;
    return {
      label: shortPath(r.cwd),
      tone: failed ? 'bad' : 'neutral',
    };
  }

  return undefined;
}

/**
 * A path short enough for a chip, keeping the end — the identifying part.
 *
 * The separator class needs both slashes. Written with one backslash too few it
 * became `[\/]`, which matches only a forward slash, so no Windows path ever
 * split and every chip showed the full path. The test that should have caught
 * it used a two-segment path, which is returned whole either way.
 */
function shortPath(full: string): string {
  const parts = full.split(new RegExp('[\\\\/]')).filter(Boolean);
  if (parts.length <= 2) return full;
  return `…/${parts.slice(-2).join('/')}`;
}

/** Parse a stored result, or nothing. Never throws — a non-JSON result is normal. */
function tryParse(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try { return JSON.parse(trimmed); } catch { return undefined; }
}

/**
 * How much command output a transcript will draw.
 *
 * Two limits, because either alone lets the other through: a hundred thousand
 * short lines is as unrenderable as one enormous line. Both are generous for
 * reading and far below what freezes a renderer.
 */
const MAX_DISPLAY_LINES = 400;
const MAX_DISPLAY_CHARS = 40_000;

/**
 * Keep the tail of a result, and say how much was left off.
 *
 * The tail, not the head: the end of a command's output is where the exit
 * message, the error and the summary live. A head-truncated build log shows the
 * compiler's banner and hides the failure.
 */
export function trimForDisplay(text: string): { text: string; dropped: number } {
  if (text.length <= MAX_DISPLAY_CHARS) {
    const lines = text.split('\n');
    if (lines.length <= MAX_DISPLAY_LINES) return { text, dropped: 0 };
    return {
      text: lines.slice(-MAX_DISPLAY_LINES).join('\n'),
      dropped: lines.length - MAX_DISPLAY_LINES,
    };
  }

  // Character-bounded first, then line-bounded, so one pathological line cannot
  // survive by being a single line.
  const tail = text.slice(-MAX_DISPLAY_CHARS);
  const lines = tail.split('\n');
  const kept = lines.slice(-MAX_DISPLAY_LINES);
  return {
    text: kept.join('\n'),
    dropped: text.split('\n').length - kept.length,
  };
}
