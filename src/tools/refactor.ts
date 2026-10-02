/**
 * The `refactor` tool group: structural search and rewrite, and language-
 * service refactors, for changes too wide to make one `Edit` at a time.
 *
 * ## Why
 *
 * AICO was weak exactly where an engineer reaches for an IDE: rename an
 * exported API used in two hundred files, add a parameter at every call site,
 * move a module and fix its importers. Done with `Grep` and `Edit` that is
 * hundreds of calls, each a chance to miss a site or catch a lookalike
 * (`formatPriceRange`, a string, a comment), and no moment where the whole
 * change is seen and checked. The editor-backed `VSCodeRename` covers one
 * client only. These three tools cover every client:
 *
 * - `CodeSearch` (read): ast-grep pattern search — syntax, not text.
 * - `CodeRewrite` (write): ast-grep pattern → rewrite, as a plan first.
 * - `Refactor` (write): TypeScript/JavaScript rename, find references,
 *   organize imports, move file (imports updated), and rollback.
 *
 * ## Shape
 *
 * Every writing call is a **dry run unless `dryRun: false`**, and an apply is
 * only honoured for a plan this run has already shown (`refactor/plan`, which
 * also owns the checkpoint → write → RunChecks → rollback sequence). They are
 * a deferred group (`tools/deferred`), so their schemas cost nothing until a
 * turn loads them; the `LoadTools` line says when to.
 *
 * @module tools/refactor
 */

import path from 'path';
import { currentCwd } from '../run-context.js';
import { resolveForReading } from './path.js';
import { runChecks } from './run-checks.js';
import { checkpointDir } from './checkpoint.js';
import { codeSearch, rewriteChanges } from '../refactor/ast-grep.js';
import {
  applyPlan, makePlan, planKey, rememberPlan, renderPlan, rollbackLastApply, shownPlan,
  type RefactorPlan,
} from '../refactor/plan.js';
import {
  ProjectService, findReferences, moveFileChanges, organizeImportsChanges, renameChanges,
} from '../refactor/ts-service.js';

export interface CodeSearchInput {
  pattern: string;
  lang: string;
  paths?: string[];
}

export interface CodeRewriteInput extends CodeSearchInput {
  rewrite: string;
  dryRun?: boolean;
  runChecks?: boolean;
  onFail?: 'report' | 'rollback';
}

export interface RefactorInput {
  action: 'rename' | 'findReferences' | 'organizeImports' | 'moveFile' | 'rollback';
  path?: string;
  symbol?: string;
  line?: number;
  occurrence?: number;
  newName?: string;
  to?: string;
  dryRun?: boolean;
  runChecks?: boolean;
  onFail?: 'report' | 'rollback';
}

/** Search paths, each checked to be inside the project, relative to it. */
function searchPaths(paths: unknown, root: string): string[] {
  if (paths === undefined) return [];
  const list = Array.isArray(paths) ? paths : [paths];
  return list.map(p => {
    const abs = resolveForReading(String(p), 'paths');
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`paths must be inside the project: ${String(p)}`);
    return rel || '.';
  });
}

function need(value: unknown, name: string, tool: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${tool}: needs ${name}.`);
  return value;
}

/**
 * Show, or apply what was shown.
 *
 * The plan is always recomputed: an apply lands only if the fresh plan is the
 * one already shown, byte for byte (digest), so a file edited in between can
 * never be overwritten with a stale rewrite.
 */
async function showOrApply(tool: string, args: Record<string, unknown>, compute: () => Promise<RefactorPlan>): Promise<string> {
  const key = planKey(tool, args);
  const plan = await compute();
  if (args.dryRun !== false) {
    rememberPlan(key, plan);
    if (plan.changes.length === 0) return renderPlan(plan);
    return `DRY RUN — nothing written.\n${renderPlan(plan)}\n\nTo apply exactly this, call ${tool} again with the same arguments and dryRun: false. `
      + 'It is checkpointed, then the project\'s checks run; Refactor {"action":"rollback"} undoes it.';
  }
  const shown = shownPlan(key);
  if (!shown || shown.digest !== plan.digest) {
    rememberPlan(key, plan);
    const why = !shown ? 'its plan has not been shown in this run yet' : 'the files changed since its plan was shown';
    return `NOT APPLIED — ${why}. This is the plan that would land; review it, then repeat the call with dryRun: false.\n\n${renderPlan(plan)}`;
  }
  const result = await applyPlan(plan, {
    runChecks: args.runChecks !== false,
    onFail: args.onFail === 'rollback' ? 'rollback' : 'report',
    checks: () => runChecks({}),
    ...(await checkpointDir().then(d => (d ? { checkpointDir: d } : {}))),
  });
  // Applied (or rolled back): the next call with these arguments plans afresh.
  rememberPlan(key, makePlan(tool, plan.title, []));
  return result;
}

export async function executeCodeSearch(input: CodeSearchInput, signal?: AbortSignal): Promise<string> {
  const root = currentCwd();
  return codeSearch({
    pattern: need(input.pattern, 'pattern', 'CodeSearch'),
    lang: need(input.lang, 'lang', 'CodeSearch'),
    paths: searchPaths(input.paths, root),
    root,
    ...(signal ? { signal } : {}),
  });
}

export async function executeCodeRewrite(input: CodeRewriteInput, signal?: AbortSignal): Promise<string> {
  const root = currentCwd();
  const pattern = need(input.pattern, 'pattern', 'CodeRewrite');
  const lang = need(input.lang, 'lang', 'CodeRewrite');
  if (typeof input.rewrite !== 'string') throw new Error('CodeRewrite: needs rewrite (it may be empty to delete the match).');
  const paths = searchPaths(input.paths, root);
  return showOrApply('CodeRewrite', input as unknown as Record<string, unknown>, async () => {
    const { changes, notes } = await rewriteChanges({ pattern, lang, rewrite: input.rewrite, paths, root, ...(signal ? { signal } : {}) });
    return makePlan('CodeRewrite', `Rewrite \`${pattern}\` → \`${input.rewrite}\``, changes, notes);
  });
}

export async function executeRefactor(input: RefactorInput): Promise<string> {
  const root = currentCwd();
  const action = input.action;
  if (action === 'rollback') return rollbackLastApply();
  if (!['rename', 'findReferences', 'organizeImports', 'moveFile'].includes(action)) {
    throw new Error('Refactor: action must be rename, findReferences, organizeImports, moveFile or rollback.');
  }
  const file = resolveForReading(need(input.path, 'path (the file containing the symbol, or the file to act on)', 'Refactor'), 'path');
  const line = input.line === undefined ? undefined : Number(input.line);
  if (line !== undefined && (!Number.isInteger(line) || line < 1)) throw new Error('Refactor: line is 1-indexed, as Read numbers lines.');

  if (action === 'findReferences') {
    const svc = new ProjectService(root);
    return findReferences(svc, { file, line: line ?? 0, symbol: need(input.symbol, 'symbol', 'Refactor'), ...(input.occurrence ? { occurrence: input.occurrence } : {}) });
  }

  return showOrApply('Refactor', input as unknown as Record<string, unknown>, async () => {
    const svc = new ProjectService(root);
    const rel = svc.relative(file);
    if (action === 'rename') {
      const symbol = need(input.symbol, 'symbol', 'Refactor rename');
      const newName = need(input.newName, 'newName', 'Refactor rename');
      const { changes, notes } = renameChanges(svc, { file, line: line ?? 0, symbol, ...(input.occurrence ? { occurrence: input.occurrence } : {}) }, newName);
      return makePlan('Refactor', `Rename ${symbol} → ${newName} (from ${rel})`, changes, notes);
    }
    if (action === 'organizeImports') {
      return makePlan('Refactor', `Organize imports in ${rel}`, organizeImportsChanges(svc, file));
    }
    const to = path.resolve(root, need(input.to, 'to (the new path)', 'Refactor moveFile'));
    const toRel = path.relative(root, to);
    if (toRel.startsWith('..') || path.isAbsolute(toRel)) throw new Error('Refactor moveFile: "to" must be inside the project.');
    return makePlan('Refactor', `Move ${rel} → ${toRel.split(path.sep).join('/')}`, moveFileChanges(svc, file, to));
  });
}

const APPLY_PROPS = {
  dryRun: {
    type: 'boolean',
    description: 'Default true: return the plan (files, counts, first hunks) and write nothing. Set false to apply '
      + 'the plan already shown for these exact arguments — it is refused, and the plan shown, otherwise.',
  },
  runChecks: { type: 'boolean', description: 'Run the project\'s checks after applying (default true).' },
  onFail: {
    type: 'string', enum: ['report', 'rollback'],
    description: 'If the checks fail after applying: report (default — right for one step of a multi-step change) '
      + 'or roll the change back automatically.',
  },
};

export const codeSearchDefinition = {
  name: 'CodeSearch',
  description:
    'Structural code search with ast-grep: match syntax, not text. A pattern is code with metavariables — '
    + '$A one node, $$$ any number — e.g. `formatPrice($A)`, `new Client($$$)`, `import { $$$ } from "./money"`. '
    + 'Unlike Grep it skips comments, strings and lookalike names (formatPriceRange), and matches across line breaks. '
    + 'Use it to find every site before a wide change.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'ast-grep pattern, written as code in the target language.' },
      lang: { type: 'string', description: 'Language: ts, tsx, js, jsx, python, go, rust, java, kotlin, csharp, c, cpp, ruby, php, swift, …' },
      paths: { type: 'array', items: { type: 'string' }, description: 'Files or folders inside the project. Default: all (gitignored files skipped).' },
    },
    required: ['pattern', 'lang'],
  },
};

export const codeRewriteDefinition = {
  name: 'CodeRewrite',
  description:
    'Rewrite every match of an ast-grep pattern across the project in one step — use it instead of many Edits for '
    + 'a mechanical change at many sites (a call shape, an argument added, an API swapped). Metavariables carry over: '
    + 'pattern `fetchUser($ID)` + rewrite `fetchUser($ID, { cache: true })`. Dry run by default: returns the plan; '
    + 'apply with dryRun:false and the same arguments. Every apply is checkpointed and followed by the project\'s '
    + 'checks. For renaming a TS/JS symbol prefer Refactor rename, which follows imports and re-exports.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: codeSearchDefinition.inputSchema.properties.pattern,
      rewrite: { type: 'string', description: 'Replacement, as code, using the pattern\'s metavariables. Empty deletes the match.' },
      lang: codeSearchDefinition.inputSchema.properties.lang,
      paths: codeSearchDefinition.inputSchema.properties.paths,
      ...APPLY_PROPS,
    },
    required: ['pattern', 'rewrite', 'lang'],
  },
};

export const refactorDefinition = {
  name: 'Refactor',
  description:
    'TypeScript/JavaScript refactors through the TypeScript language service (no editor needed), exact where '
    + 'Grep+Edit guesses: rename (every import, re-export and `ns.name` use; strings, comments and lookalike names '
    + 'untouched), findReferences, organizeImports, moveFile (importers and its own imports updated), rollback '
    + '(undo the last apply). Use rename instead of editing each file for an API rename. Writing actions are a dry '
    + 'run by default; apply with dryRun:false and the same arguments — checkpointed, then the project\'s checks run.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['rename', 'findReferences', 'organizeImports', 'moveFile', 'rollback'] },
      path: { type: 'string', description: 'The file containing the symbol (rename, findReferences), or the file to act on.' },
      symbol: { type: 'string', description: 'The identifier\'s exact text.' },
      line: { type: 'number', description: '1-indexed line of the symbol, as Read reports it. Omit to use its declaration in that file.' },
      occurrence: { type: 'number', description: 'Which occurrence on the line, when it appears more than once.' },
      newName: { type: 'string', description: 'rename: the new identifier.' },
      to: { type: 'string', description: 'moveFile: the new path, relative to the project.' },
      ...APPLY_PROPS,
    },
    required: ['action'],
  },
};
