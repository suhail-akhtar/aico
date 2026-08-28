/**
 * Mini Apps, from the agent's side.
 *
 * The fifth registry, same shape as the other four: one tool, an `action`, and
 * a text answer. What differs is that creating the entry is not the work — the
 * work is a page and a schema, written afterwards with the ordinary file tools.
 *
 * So `create` does two things: it claims a directory, and it hands back the
 * authoring contract. The second is the important one. Everything a Mini App
 * gets for free — the data client, the CRUD component, the design system, the
 * CSP that will silently kill a CDN link — is invisible unless something says
 * so at the moment it matters, and a capability nobody mentions is one the
 * model routes around badly.
 *
 * Returning it here rather than putting it in the system prompt keeps it off
 * every unrelated turn. It is roughly two thousand tokens; a user who never
 * builds a Mini App should never pay for it.
 *
 * @module tools/manage-miniapps
 */

import path from 'path';
import { currentCwd, currentRunContext } from '../run-context.js';
import { loadSettings } from '../settings.js';
import { authoringContract } from '../miniapps/contract.js';
import {
  createMiniApp, deleteMiniApp, getMiniApp, listMiniApps, miniAppDir, slugify, touchMiniApp,
} from '../miniapps/store.js';
import { describe as describeTables } from '../miniapps/data.js';

export interface MiniAppManageInput {
  action: 'list' | 'create' | 'describe' | 'tables' | 'delete';
  /** For create: what to call it. For everything else: which one. */
  name?: string;
  description?: string;
}

/**
 * Where an app is reachable.
 *
 * The host runs on `miniApps.port`, or one above the portal's when that is
 * unset. The portal's own port is not visible from inside a tool, so the
 * default case is stated as a relationship rather than a number — better than
 * printing a specific port that might be wrong.
 */
async function appUrl(slug: string): Promise<string> {
  const settings = await loadSettings();
  const port = settings.miniApps?.port;
  const host = settings.miniApps?.host ?? '127.0.0.1';
  return port ? `http://${host}:${port}/${slug}/` : `http://${host}:<aico port + 1>/${slug}/`;
}

/** Say it once, wherever the user might be about to build something inert. */
async function disabledNotice(): Promise<string | null> {
  const settings = await loadSettings();
  if (settings.miniApps?.enabled) return null;
  return 'Note: Mini Apps are switched off, so nothing is being served right now. '
    + 'Turn on Settings → Mini Apps (or set miniApps.enabled to true) and restart aico. '
    + 'Building one now is fine — it will be there when the plugin is on.';
}

export async function executeMiniAppManage(input: MiniAppManageInput): Promise<string> {
  const cwd = currentCwd();
  const sessionId = currentRunContext()?.sessionId;
  const settings = await loadSettings();
  const notice = await disabledNotice();
  const withNotice = (body: string) => (notice ? `${body}\n\n${notice}` : body);

  switch (input.action) {
    case 'list': {
      const apps = await listMiniApps(settings, cwd);
      if (apps.length === 0) {
        return withNotice('No Mini Apps yet. Create one with action "create".');
      }
      const lines = await Promise.all(apps.map(async (app) => {
        const state = app.built ? await appUrl(app.slug) : 'not built yet';
        return `- ${app.slug} — ${app.title}${app.description ? `: ${app.description}` : ''} (${state})`;
      }));
      return withNotice([`${apps.length} Mini App${apps.length === 1 ? '' : 's'}:`, ...lines].join('\n'));
    }

    case 'create': {
      if (!input.name) return 'A name is required.';
      const app = await createMiniApp({
        title: input.name,
        ...(input.description ? { description: input.description } : {}),
        ...(sessionId ? { sessionId } : {}),
      }, settings, cwd);
      const dir = miniAppDir(app.slug, settings, cwd);
      return withNotice(authoringContract(app.slug, dir, await appUrl(app.slug)));
    }

    case 'describe': {
      if (!input.name) return 'Which app? Use action "list" to see them.';
      const slug = slugify(input.name);
      const app = await getMiniApp(slug, settings, cwd);
      if (!app) return `No Mini App called "${slug}".`;
      // Touched, so working on an app moves it up the list even when the change
      // was to a file this tool never saw.
      await touchMiniApp(slug, {}, settings, cwd);
      const dir = miniAppDir(slug, settings, cwd);
      const state = app.built
        ? 'Built.'
        : `Not built yet — there is no ${path.join('public', 'index.html')}.`;
      return withNotice(`${state}\n\n${authoringContract(slug, dir, await appUrl(slug))}`);
    }

    case 'tables': {
      if (!input.name) return 'Which app? Use action "list" to see them.';
      const slug = slugify(input.name);
      const app = await getMiniApp(slug, settings, cwd);
      if (!app) return `No Mini App called "${slug}".`;
      const dir = miniAppDir(slug, settings, cwd);
      let tables;
      try {
        tables = await describeTables(dir);
      } catch (err) {
        // Almost always a syntax error in schema.sql, and the message from
        // SQLite is more useful than anything this could say instead.
        return `The schema would not apply: ${err instanceof Error ? err.message : String(err)}`;
      }
      if (tables.length === 0) {
        return `"${slug}" has no tables yet. Write ${path.join(dir, 'schema.sql')}.`;
      }
      return tables.map(t => [
        `${t.name}`,
        ...t.columns.map(c => `  ${c.name} ${c.type || 'ANY'}`
          + `${c.primaryKey ? ' PRIMARY KEY' : ''}${c.notNull && !c.primaryKey ? ' NOT NULL' : ''}`),
      ].join('\n')).join('\n\n');
    }

    case 'delete': {
      if (!input.name) return 'Which app?';
      const slug = slugify(input.name);
      const app = await getMiniApp(slug, settings, cwd);
      if (!app) return `No Mini App called "${slug}".`;
      const gone = await deleteMiniApp(slug, settings, cwd);
      return gone
        ? `Deleted "${slug}", including its database. That data is not recoverable.`
        : `Could not delete "${slug}".`;
    }

    default:
      return `Unknown action "${String(input.action)}".`;
  }
}

export const miniAppManageToolDefinition = {
  name: 'MiniAppManage',
  description: [
    'Build and manage Mini Apps: self-contained single-page applications with their own SQLite',
    'database, served on their own local URL. Use this when someone asks for a small app, tool or',
    'tracker — invoices, inventory, a CRM, a habit log, anything with forms and stored records.',
    'Start with action "create": it makes the app and returns the full authoring guide — the data',
    'client, the ready-made CRUD component, the design system classes and the constraints. Read that',
    'guide before writing any files; it is the difference between an app that works and one that',
    'silently does not. Then write schema.sql and public/index.html with the normal Write tool.',
  ].join(' '),
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'create', 'describe', 'tables', 'delete'],
        description:
          'create: make a new app and get the authoring guide. list: every app and its URL. '
          + 'describe: the guide again, for an app that already exists. '
          + 'tables: the schema as it actually applied, for checking your schema.sql worked. '
          + 'delete: remove an app and its database for good.',
      },
      name: {
        type: 'string',
        description: 'What to call it when creating ("Invoices"), or which app for every other action.',
      },
      description: {
        type: 'string',
        description: 'One line saying what the app is for. Shown in the Mini Apps list.',
      },
    },
    required: ['action'],
  },
};
