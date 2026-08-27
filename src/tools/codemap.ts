/**
 * The codebase map, as the agent reaches it.
 *
 * Sits beside Glob and Grep rather than replacing them, and the description
 * says which to reach for. Grep answers questions about *text*; this answers
 * questions about *shape and intent* — where something lives, what a directory
 * is for, which file is about caching. The failure this exists to stop is the
 * dozen-call opening sequence: Glob the tree, Grep a few guesses, Read four
 * files, and only then begin. Each of those is a paid round trip, repeated at
 * the start of every session on a project that did not change in between.
 *
 * @module tools/codemap
 */

import { currentCwd } from '../run-context.js';
import {
  findSymbol, getCodeMap, listDirectory, overview, searchPurpose,
} from '../codemap/index.js';

export interface CodeMapInput {
  action?: 'overview' | 'list' | 'symbol' | 'search';
  /** Directory for `list`, symbol name for `symbol`, term for `search`. */
  query?: string;
  /** Rebuild before answering, for when the map is known to be behind. */
  refresh?: boolean;
}

export async function codeMap(input: CodeMapInput): Promise<string> {
  const root = currentCwd();
  const map = await getCodeMap(root, input.refresh === true);
  const action = input.action ?? 'overview';
  const query = (input.query ?? '').trim();

  switch (action) {
    case 'list':
      return listDirectory(map, query || '.');
    case 'symbol':
      if (!query) return 'symbol requires a name in `query`.';
      return findSymbol(map, query);
    case 'search':
      if (!query) return 'search requires a term in `query`.';
      return searchPurpose(map, query);
    case 'overview':
    default:
      return overview(map);
  }
}

export const codeMapDefinition = {
  name: 'CodebaseMap',
  description: [
    'Understand a codebase without reading it. Answers from a cached index of every',
    'source file — its purpose line and its exported symbols — built by walking the',
    'project, which costs no tokens.',
    '',
    'Use this BEFORE Glob/Grep/Read when orienting in an unfamiliar project, or when',
    'looking for where something lives. One call replaces the usual opening sequence of',
    'several Globs, Greps and Reads.',
    '',
    'actions:',
    '  overview  — directories, file counts and sizes. Start here in a new project.',
    '  list      — files in one directory, each with what it is for. query = the directory.',
    '  symbol    — which file declares a name. query = the symbol.',
    '  search    — files whose stated purpose mentions a term. query = the term.',
    '',
    'Limits, so you know when to fall back: only exported/top-level declarations are',
    'indexed, so Grep is still the way to find local symbols and any occurrence in a',
    'file body. Purpose lines come from leading doc comments; files without one are',
    'listed without a summary. Pass refresh:true if you have just created files and',
    'they are missing.',
  ].join('\n'),
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['overview', 'list', 'symbol', 'search'],
        description: 'What to ask. Defaults to overview.',
      },
      query: {
        type: 'string',
        description: 'Directory for list, symbol name for symbol, term for search.',
      },
      refresh: {
        type: 'boolean',
        description: 'Rebuild the index first. Only needed if files were just created.',
      },
    },
    required: [] as string[],
  },
};
