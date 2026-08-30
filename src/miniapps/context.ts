/**
 * What a Mini App session knows about its app, without being told each turn.
 *
 * ## Why this is a system-prompt block and not a message
 *
 * A conversation dedicated to one app needs the same handful of facts on every
 * turn: where it lives, what tables it has, what files exist, and the contract
 * every Mini App is built to. Sending those as a message per turn would be the
 * expensive way to do it twice over — paid on every request, and worse, it
 * would change the tail of the conversation each time, which is exactly what
 * stops a prompt cache from hitting.
 *
 * In the system prompt it sits in the stable prefix. It is written once when
 * the session starts and read from cache on every turn after, at roughly a
 * fifth to a tenth of the price depending on the provider. The same reasoning
 * the rest of aico uses for tool definitions and the system prompt.
 *
 * That is also why the schema is rendered compactly rather than as the raw
 * `schema.sql`: the file is the authority, the summary is what the model needs
 * in front of it, and the difference is a few hundred tokens per turn for the
 * life of the session.
 *
 * ## What is deliberately not in here
 *
 * File *contents*. A prefix that embeds `index.html` changes every time the
 * page is edited, which invalidates the cache on precisely the turns a build
 * session has most of — and the model can read the file when it needs to. Only
 * the list is here, because knowing what exists is what stops it recreating
 * something it already has.
 *
 * @module miniapps/context
 */

import { readdir } from 'fs/promises';
import path from 'path';
import { authoringContract } from './contract.js';
import { describe } from './data.js';
import type { MiniApp } from './store.js';

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

/** Files the app has, relative to its directory. Names only — see the module note. */
async function fileList(dir: string): Promise<string> {
  const found: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // The database is a binary blob and node_modules cannot exist here, but
      // a generated app can and does create directories of its own.
      if (entry.name === 'data.sqlite' || entry.name.startsWith('.')) continue;
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(next);
      else found.push(next);
    }
  };
  await walk('');
  return found.length ? found.sort().join('\n') : '(nothing yet — this app has not been built)';
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
   * Whether the host is actually listening.
   *
   * Stated rather than implied, because the contract tells the agent to open
   * the page and check it — and an agent told to open a URL that answers
   * nothing does not conclude "the plugin is off". It concludes something is
   * broken and goes looking for it: in one run, a filesystem-wide search of the
   * home directory, forty-five steps, for a server that was never started. The
   * reader's setting is not a bug to investigate.
   */
  served = true,
): Promise<string> {
  const [schema, files] = await Promise.all([schemaSummary(dir), fileList(dir)]);

  return `# You are working on one Mini App

This whole conversation is about **${app.title}** and nothing else. Every
request — a change, a fix, an enhancement, a bug — is about this app. Do not
create another one, and do not touch anything outside its directory.

  App        ${app.title}${app.description ? ` — ${app.description}` : ''}
  Slug       ${app.slug}
  Directory  ${dir}
  URL        ${url}

## Its tables, as they actually applied

${schema}

## Its files

${files}

## How to work on it

You already have everything MiniAppManage describe would tell you — it is
above. Do not call it for this app; the answer would be this same text again,
paid for a second time. MiniAppManage is still the way to check the schema
after you change it (tables) and to list other apps (list).

Read before you change. The file list above says what exists; it does not say
what is in it. An edit written from memory of a file you have not opened this
session is how a working page gets broken.

Use MiniAppManage tables after any schema change to confirm what SQLite
actually accepted — a CREATE TABLE that silently did not apply looks exactly
like one that did until the first request fails.

${served
  ? `When you have changed anything the reader will look at, open ${url} with
VerifyApp and check it. A Mini App is a page; reading the source you just wrote
is not verification.`
  : `The Mini Apps host is NOT running, so ${url} answers nothing. That is a
setting, not a fault — do not go looking for the server, do not search the
filesystem for it, and do not try to start one. Write the app, say that it
could not be checked in a browser because the host is off, and stop.`}

${authoringContract(app.slug, dir, url)}`;
}
