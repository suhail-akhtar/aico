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
import { nextAuthoringContract } from '../miniapps/contract-nextjs.js';
import {
  createMiniApp, deleteMiniApp, getMiniApp, listMiniApps, miniAppDir, slugify, touchMiniApp,
  type MiniAppKind,
} from '../miniapps/store.js';
import { describe as describeTables } from '../miniapps/data.js';

export interface MiniAppManageInput {
  action: 'list' | 'create' | 'describe' | 'tables' | 'delete';
  /** For create: what to call it. For everything else: which one. */
  name?: string;
  description?: string;
  /** What to build. Defaults to the single-page app. */
  kind?: MiniAppKind;
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
  const settings = currentRunContext()?.settings ?? await loadSettings();
  const port = settings.miniApps?.port;
  const host = settings.miniApps?.host ?? '127.0.0.1';
  return port ? `http://${host}:${port}/${slug}/` : `http://${host}:<aico port + 1>/${slug}/`;
}

/** Say it once, wherever the user might be about to build something inert. */
async function disabledNotice(): Promise<string | null> {
  const settings = currentRunContext()?.settings ?? await loadSettings();
  if (settings.miniApps?.enabled) return null;
  return 'Note: Mini Apps are switched off, so nothing is being served right now. '
    + 'Turn on Settings → Mini Apps (or set miniApps.enabled to true) and restart aico. '
    + 'Building one now is fine — it will be there when the plugin is on.';
}

export async function executeMiniAppManage(input: MiniAppManageInput): Promise<string> {
  const cwd = currentCwd();
  const sessionId = currentRunContext()?.sessionId;
  // Which app this conversation is about, when it is about one. Derived from
  // the session id the binding route uses, so the tool needs no new plumbing.
  const bound = sessionId?.startsWith('miniapp-') ? sessionId.slice('miniapp-'.length) : undefined;
  /*
    The run's settings, falling back to the file.

    The run already resolved these — a project's own `.aico/settings.json` can
    move `workspace.path`, and the server re-reads them every turn. Reading the
    file again here would ignore that and look for apps in a different
    workspace than the one the turn is working in: the tool would report no
    such app about an app that plainly exists.
  */
  const settings = currentRunContext()?.settings ?? await loadSettings();
  const notice = await disabledNotice();
  const withNotice = (body: string) => (notice ? `${body}\n\n${notice}` : body);

  switch (input.action) {
    case 'list': {
      const apps = await listMiniApps(settings, cwd);
      if (apps.length === 0) {
        return withNotice('No Mini Apps yet. Create one with action "create".');
      }
      const lines = await Promise.all(apps.map(async (app) => {
        // A Next.js app has no fixed address — it is given a free port when it
        // is started — so quoting the shared host's URL for one would be wrong.
        const state = app.kind === 'nextjs'
          ? (app.built ? 'Next.js app — started on demand' : 'Next.js app, not scaffolded yet')
          : (app.built ? await appUrl(app.slug) : 'not built yet');
        return `- ${app.slug} — ${app.title}${app.description ? `: ${app.description}` : ''} (${state})`;
      }));
      return withNotice([`${apps.length} Mini App${apps.length === 1 ? '' : 's'}:`, ...lines].join('\n'));
    }

    case 'create': {
      if (!input.name) return 'A name is required.';

      /*
        A bound session already has an app. It does not need another.

        Watched happening: handed a contract naming the directory, the agent
        called `create` anyway — because this tool's own description says
        "start with create" — got a suffixed slug, and built the whole app in
        `habit-tracker-2` while `habit-tracker` sat empty beside it. The
        suffixing is deliberate and right for a person naming two things the
        same; it is exactly wrong for an agent duplicating the app it was just
        given.

        So in a session about one app, `create` points back at it instead.
      */
      if (bound) {
        const already = await getMiniApp(bound, settings, cwd);
        if (already) {
          return `This conversation is already about "${already.slug}" — you do not need to `
            + `create anything. Work in ${miniAppDir(already.slug, settings, cwd)}, which is `
            + 'the directory in your instructions above.\n\n'
            + 'Calling create here would make a SECOND app with a suffixed name and leave '
            + 'this one empty. If you genuinely need a different app, say so and let the '
            + 'reader decide.';
        }
      }
      const kind: MiniAppKind = input.kind === 'nextjs' ? 'nextjs' : 'page';
      const app = await createMiniApp({
        title: input.name,
        kind,
        ...(input.description ? { description: input.description } : {}),
        ...(sessionId ? { sessionId } : {}),
      }, settings, cwd);
      const dir = miniAppDir(app.slug, settings, cwd);
      // Two kinds, two contracts. A Next.js author is responsible for the parts
      // a single-page author gets for free, so handing them the wrong brief
      // would be worse than handing them none.
      return withNotice(kind === 'nextjs'
        ? nextAuthoringContract(app.slug, dir)
        : authoringContract(app.slug, dir, await appUrl(app.slug)));
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
      const isNext = app.kind === 'nextjs';
      const state = app.built
        ? 'Built.'
        : `Not built yet — there is no ${isNext ? 'package.json' : path.join('public', 'index.html')}.`;
      // Two kinds, two contracts. A Next.js author is responsible for the parts
      // a single-page author gets for free, so handing them the wrong brief
      // would be worse than handing them none.
      return withNotice(`${state}\n\n${isNext
        ? nextAuthoringContract(slug, dir)
        : authoringContract(slug, dir, await appUrl(slug))}`);
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

      /*
        Refuse to delete the app this conversation is about.

        Not a hypothetical. Asked to add a column, an agent edited schema.sql,
        could not see the change take effect — a separate bug, since fixed —
        concluded the app was broken, deleted it, and rebuilt it from scratch
        under a new name. The reader lost their app and their data to a
        recovery step nobody asked for.

        Deleting is a reasonable thing to want and a terrible thing to reach for
        when something looks wrong. In the one place where "something looks
        wrong" is most likely, it is refused and the alternative is named.
      */
      if (bound && slugify(bound) === slug) {
        return `Refusing to delete "${slug}": this conversation is about that app, `
          + 'and deleting it would take its database with it.\n\n'
          + 'If something looks broken, fix it in place — read the files, correct them, '
          + 'and check with action "tables". Starting over is almost never the repair, '
          + 'and it is never the repair for a schema that did not seem to apply.\n\n'
          + 'If the reader genuinely wants it gone, they can delete it from the Mini Apps panel.';
      }
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
    'Two kinds. "page" is the default and the right answer for most requests: one HTML file with',
    'Alpine over a shared server that runs no code you write, so there is nothing to install and it',
    'is serving the moment you save. "nextjs" is a real Node application with its own server,',
    'routing and dependencies — choose it only when the app genuinely needs server-side logic,',
    'several routes, or a database other than SQLite, because it costs minutes of install on first',
    'run and you become responsible for the query safety the page kind provides for free.',
    'Start with action "create": it makes the app and returns the authoring guide for whichever kind',
    'you chose. Read that guide before writing any files; it is the difference between an app that',
    'works and one that silently does not. Then write the files with the normal Write tool.',
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
      kind: {
        type: 'string',
        enum: ['page', 'nextjs'],
        description:
          'What to build, for "create". "page" (the default) is one HTML file with Alpine and a '
          + 'shared server that runs no code you write — fastest to build, and enough for records, '
          + 'forms and dashboards. "nextjs" is a real Node application with its own server, routing '
          + 'and dependencies, started as its own process; choose it when the app genuinely needs '
          + 'server-side logic, multiple routes, or a database other than SQLite. It takes minutes '
          + 'longer on first run because dependencies install.',
      },
      description: {
        type: 'string',
        description: 'One line saying what the app is for. Shown in the Mini Apps list.',
      },
    },
    required: ['action'],
  },
};
