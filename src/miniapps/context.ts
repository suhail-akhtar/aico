/**
 * What a bound session knows about its App, without being told each turn.
 *
 * ## Why this is a system-prompt block and not a message
 *
 * A conversation dedicated to one app needs the same handful of facts on every
 * turn: where it lives, what it is made of, what files exist. Sending those as a
 * message per turn would be the expensive way to do it twice over — paid on
 * every request, and worse, it would change the tail of the conversation each
 * time, which is exactly what stops a prompt cache from hitting.
 *
 * In the system prompt it sits in the stable prefix: written once when the
 * session starts and read from cache on every turn after.
 *
 * ## What is deliberately not in here
 *
 * File *contents*, with one exception. A prefix that embeds the source changes
 * every time a file is edited, which invalidates the cache on precisely the
 * turns a build session has most of — the model can read a file when it needs
 * it. The exception is the app's own `AICO.md`: a few hundred tokens the
 * template wrote to say what the agent needs to know, capped, and changing
 * only when a convention changes.
 *
 * Nor is anything that moves mid-turn: whether the process is running, its
 * URL, how far the backlog is. Those ride the volatile tail as `app_state`, so
 * a build that starts its own server does not break the cache behind it.
 *
 * ## The file list, bounded
 *
 * Two levels deep and at most forty entries, skipping `node_modules`, build
 * output and the database. The previous version walked the whole tree and
 * skipped only dotfiles — for a Next.js app that put `node_modules` into the
 * system prompt, which is the single most expensive thing this module could
 * have done.
 *
 * @module miniapps/context
 */

import { readdir, readFile } from 'fs/promises';
import path from 'path';
import { authoringContract } from './contract.js';
import { describe } from './data.js';
import { effectiveKind, hasProcess, type MiniApp } from './store.js';

/** Directories whose contents say nothing an author needs and cost a great deal. */
const SKIP = new Set(['node_modules', '.next', 'dist', 'build', 'coverage', '.git', '.turbo', 'out']);
const MAX_ENTRIES = 40;
/** The most of the app's own AICO.md that is inlined. */
const MAX_AICO_MD = 2_000;

/** One line per table: name, then columns with the constraints that matter. */
async function schemaSummary(dir: string): Promise<string> {
  let tables;
  try {
    tables = await describe(dir);
  } catch (err) {
    // A schema that will not apply is the single most useful thing to say
    // here — every request the page makes is about to fail with this.
    return `The schema does not apply: ${err instanceof Error ? err.message : String(err)}\n`
      + 'Fix schema.sql before anything else; nothing can read or write until it parses.';
  }
  if (tables.length === 0) {
    return 'No tables yet. schema.sql is empty or missing.';
  }
  return tables.map(t => {
    const cols = t.columns.map(c => {
      const marks = [
        c.primaryKey ? 'pk' : '',
        c.notNull && !c.primaryKey ? 'not null' : '',
      ].filter(Boolean).join(' ');
      return `${c.name} ${c.type || 'ANY'}${marks ? ` (${marks})` : ''}`;
    });
    return `${t.name}: ${cols.join(', ')}`;
  }).join('\n');
}

/**
 * Files the app has, relative to its directory: two levels, forty entries,
 * names only. A directory with more inside says so rather than listing it.
 */
export async function fileList(dir: string): Promise<string> {
  const found: string[] = [];
  let overflow = 0;
  const walk = async (rel: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'data.sqlite' || SKIP.has(entry.name)) continue;
      // The app's own `.aico/` is listed by name so the agent knows the backlog
      // and decisions files exist; other dot-directories are tooling.
      if (entry.name.startsWith('.') && entry.name !== '.aico' && entry.name !== '.env.example') continue;
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth >= 1) { found.push(`${next}/…`); continue; }
        await walk(next, depth + 1);
      } else if (found.length < MAX_ENTRIES) {
        found.push(next);
      } else {
        overflow += 1;
      }
    }
  };
  await walk('', 0);
  if (found.length === 0) return '(nothing yet — this app has not been built)';
  return found.join('\n') + (overflow ? `\n(+${overflow} more files; use Glob to list them)` : '');
}

/** The app's own AICO.md, capped, or nothing. */
async function ownMemory(dir: string): Promise<string> {
  try {
    const text = (await readFile(path.join(dir, 'AICO.md'), 'utf8')).trim();
    if (!text) return '';
    return text.length > MAX_AICO_MD
      ? `${text.slice(0, MAX_AICO_MD)}\n… (AICO.md continues; read the file for the rest)`
      : text;
  } catch {
    return '';
  }
}

/**
 * The block appended to a bound session's system prompt.
 *
 * Assembled per turn but almost always identical, which is the point: an
 * unchanged prefix is a cached prefix. The parts that do change — the file list
 * after a write, the schema after a migration — are the parts where a stale
 * answer would be actively wrong, so they are worth the occasional miss.
 */
export async function miniAppContext(
  app: MiniApp,
  dir: string,
  url: string,
  /**
   * Whether the shared host is actually listening (page and static apps).
   *
   * Stated rather than implied, because an agent told to open a URL that
   * answers nothing does not conclude "the plugin is off" — it goes looking
   * for the server. The reader's setting is not a bug to investigate.
   */
  served = true,
): Promise<string> {
  const kind = effectiveKind(app);
  const [files, memory] = await Promise.all([fileList(dir), ownMemory(dir)]);
  const schema = kind === 'page' ? await schemaSummary(dir) : '';

  const facts = [
    `  App        ${app.title}${app.description ? ` — ${app.description}` : ''}`,
    `  Slug       ${app.slug}`,
    `  Kind       ${kind}${app.template ? ` · from template ${app.template.id}@${app.template.version}` : ''}`,
    `  Directory  ${dir}`,
    ...(hasProcess(app) ? [] : [`  URL        ${url}`]),
  ].join('\n');

  const howToWork = hasProcess(app) || kind === 'cli'
    ? `Read before you change: the file list says what exists, not what is in it.
If this is your first turn on an app, Skill app-platform is the whole platform in one page.
The person sees this app beside the chat — a live preview, the backlog, decisions, files, logs —
so keep .aico/backlog.md and .aico/decisions.md current; they are read there.
Start with AICO.md (below) and docs/EXTENDING.md — the worked feature there is
the pattern to copy. New feature work: use the app-plan skill first, then keep
.aico/backlog.md ticked as you go. After changing source, RunChecks runs this
app's own checks. ${kind === 'cli'
      ? 'A CLI has nothing to open; a passing check run is the verification.'
      : 'Then AppManage start (this app), and VerifyApp the URL it reports — a page that renders is the check, not the source you wrote.'}
Do not create another app in this conversation and do not delete this one.`
    : `Read before you change: the file list says what exists, not what is in it.
Use AppManage tables after any schema change to confirm what SQLite accepted.
${served
      ? `When you have changed anything the reader will look at, open ${url} with VerifyApp and check it.`
      : `The Apps host is NOT running, so ${url} answers nothing. That is a setting, not a fault — do not go looking for the server; write the app, say it could not be checked in a browser, and stop.`}
Do not create another app in this conversation and do not delete this one.`;

  return `# You are working on one App

This whole conversation is about **${app.title}** and nothing else. Every
request — a change, a fix, an enhancement, a bug — is about this app.

${facts}
${schema ? `\n## Its tables, as they actually applied\n\n${schema}\n` : ''}
## Its files

${files}
${memory ? `\n## AICO.md — what this app's author left for you\n\n${memory}\n` : ''}
## How to work on it

${howToWork}
${kind === 'page' && !app.template ? `\n${authoringContract(app.slug, dir, url)}` : ''}`;
}

/**
 * What changes while a build runs, for the volatile tail.
 *
 * Kept out of the cached block above on purpose: a server starting, a URL
 * appearing, a story being ticked — these move mid-turn, and a prefix that
 * moved with them would be re-billed on exactly the turns a build has most of.
 */
export function appStateLine(input: {
  app: Pick<MiniApp, 'slug' | 'kind'>;
  process?: { state: string; url?: string; error?: string } | undefined;
  backlog?: { done: number; total: number };
  hostUp?: boolean;
}): string {
  const parts: string[] = [];
  if (hasProcess(input.app)) {
    const p = input.process;
    parts.push(p
      ? `process ${p.state}${p.url ? ` at ${p.url}` : ''}${p.error ? ` (${p.error})` : ''}`
      : 'process not running — AppManage start to run it');
  } else if (input.hostUp !== undefined) {
    parts.push(input.hostUp ? 'host serving' : 'host off');
  }
  if (input.backlog && input.backlog.total > 0) {
    parts.push(`backlog ${input.backlog.done}/${input.backlog.total} done`);
  }
  return parts.length ? `App ${input.app.slug}: ${parts.join(' · ')}` : '';
}
