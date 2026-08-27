/**
 * What one source file says about itself, read without parsing it properly.
 *
 * Regex over declaration forms rather than a real parser, and the trade is
 * deliberate. A parser per language would be several megabytes of dependency
 * and a build step, to gain exactness in a place that does not need it: this
 * index exists to point an agent at the right file, and a symbol list that is
 * ninety-five percent right does that just as well as one that is perfect. The
 * agent opens the file afterwards either way.
 *
 * What it must never do is *mislead*. So the rules only match unambiguous
 * declaration syntax at the start of a line — anything clever, generated, or
 * inside a string is simply missed rather than guessed at. A missing symbol
 * costs one extra Grep; an invented one sends the agent somewhere that does
 * not exist.
 *
 * @module codemap/extract
 */

/** Languages whose declaration syntax is understood well enough to be useful. */
const EXTRACTORS: Record<string, RegExp[]> = {
  // TypeScript and JavaScript. `export` is the signal — a module's private
  // helpers are not what someone searching the index is looking for.
  ts: [
    /^export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
    /^export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
    /^export\s+(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,
    /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
  ],
  py: [
    /^def\s+([A-Za-z_]\w*)/gm,
    /^class\s+([A-Za-z_]\w*)/gm,
  ],
  go: [
    // Exported identifiers in Go are the capitalised ones, which the language
    // makes unambiguous — nicer than every other case here.
    /^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/gm,
    /^type\s+([A-Z]\w*)/gm,
  ],
  rs: [
    /^pub\s+(?:async\s+)?fn\s+([a-z_]\w*)/gm,
    /^pub\s+(?:struct|enum|trait|type)\s+([A-Za-z_]\w*)/gm,
  ],
};

const EXTENSION_LANGUAGE: Record<string, keyof typeof EXTRACTORS> = {
  '.ts': 'ts', '.tsx': 'ts', '.mts': 'ts', '.cts': 'ts',
  '.js': 'ts', '.jsx': 'ts', '.mjs': 'ts', '.cjs': 'ts',
  '.py': 'py',
  '.go': 'go',
  '.rs': 'rs',
};

/** Whether this file's declarations can be read at all. */
export function languageFor(extension: string): string | undefined {
  return EXTENSION_LANGUAGE[extension.toLowerCase()];
}

/**
 * Exported symbol names, in declaration order.
 *
 * Deduplicated, because an overloaded function or a re-exported name would
 * otherwise appear several times and crowd out the rest of the file's surface.
 * Capped, because a barrel file re-exporting four hundred names tells a reader
 * nothing that "it is a barrel file" does not.
 */
export function extractSymbols(source: string, language: string, limit = 40): string[] {
  const patterns = EXTRACTORS[language];
  if (!patterns) return [];
  const found: string[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    // Each regex is module-level and stateful with /g; resetting makes repeated
    // calls give the same answer, which is otherwise a genuinely baffling bug.
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const name = match[1];
      if (!name || seen.has(name)) continue;
      seen.add(name);
      found.push(name);
      if (found.length >= limit) return found;
    }
  }
  return found;
}

/**
 * The first sentence of the file's leading doc comment.
 *
 * Only a comment at the very top counts. A licence header is skipped, and so
 * is anything after the first declaration — a comment in the middle of a file
 * describes that part of it, not the file, and presenting it as the file's
 * purpose is worse than saying nothing.
 */
export function extractPurpose(source: string, language: string): string | undefined {
  const head = beforeFirstDeclaration(source.slice(0, 4_000));

  if (language === 'py') {
    const docstring = /^\s*(?:"""|''')\s*([\s\S]*?)(?:"""|''')/.exec(head);
    return firstSentence(docstring?.[1]);
  }

  // A `/** ... */` block, skipping anything that reads as a licence.
  for (const block of head.matchAll(/\/\*\*([\s\S]*?)\*\//g)) {
    const text = (block[1] ?? '')
      .split('\n')
      .map(line => line.replace(/^\s*\*\s?/, ''))
      .join('\n');
    if (/copyright|licen[cs]e|SPDX/i.test(text.slice(0, 200))) continue;
    const sentence = firstSentence(text);
    if (sentence) return sentence;
  }

  // A run of `//` lines at the very top, which is the other common style.
  const slashes = /^(?:\/\/[^\n]*\n)+/.exec(head);
  if (slashes) {
    return firstSentence(slashes[0].replace(/^\/\/\s?/gm, ''));
  }
  return undefined;
}

/**
 * Syntax that means the file's real content has started.
 *
 * The trailing word boundary matters and is easy to lose: without it,
 * `constant` and `typeof` read as declarations and truncate the header
 * early. It was lost once already — a shell heredoc turned the escape into
 * a raw backspace byte, which is invisible in every editor and made the
 * pattern match nothing at all.
 */
const DECLARATION_START = /^(?:export|function|class|const|let|var|def|pub|func|type|interface|enum)\b/m;

/**
 * Everything up to the file's first real declaration.
 *
 * Imports may precede it — plenty of codebases put the file's doc comment
 * after them — but once actual code has started, any comment belongs to the
 * thing it sits above rather than to the file. Reporting "Helper for the loop
 * below" as a module's purpose is worse than reporting nothing, because it
 * reads as authoritative.
 */
function beforeFirstDeclaration(head: string): string {
  const declaration = DECLARATION_START.exec(head);
  return declaration ? head.slice(0, declaration.index) : head;
}

/**
 * The first meaningful sentence of a doc comment.
 *
 * Tag lines are dropped — `@module`, `@param` and friends describe the
 * documentation, not the code — and so is the leading blank line every block
 * comment starts with.
 */
function firstSentence(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const line = text
    .split('\n')
    .map(l => l.trim())
    .find(l => l.length > 0 && !l.startsWith('@'));
  if (!line) return undefined;
  // Cut at the first sentence end, so a paragraph does not become the summary.
  const stop = /^(.*?[.!?])(\s|$)/.exec(line);
  const sentence = (stop?.[1] ?? line).trim();
  return sentence.length > 200 ? `${sentence.slice(0, 197)}…` : sentence;
}
