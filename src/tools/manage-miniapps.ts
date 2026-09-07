/**
 * Apps, from the agent's side.
 *
 * One tool, an `action`, a text answer — the same shape as the other
 * registries. What differs is that creating the entry is not the work: the work
 * is the files written afterwards with the ordinary tools, or copied from a
 * template in zero model tokens.
 *
 * ## Templates first
 *
 * `create` without a template does not make anything. It returns the catalogue
 * — one line per template, the ones a brief suggests first — and stops. An app
 * started from a template arrives with a working feature, tests, a Dockerfile
 * and its own notes to the agent, and the whole skeleton costs no generation;
 * an app started from nothing costs a few thousand tokens of contract on every
 * create and arrives empty. The catalogue is the cheaper path and the better
 * one, so it is the path the tool leads to.
 *
 * The exception is the `page` kind by explicit request (`kind: 'page'`), which
 * keeps the authoring contract that has worked since Mini Apps began: for a
 * one-screen tool over SQLite the runtime is the template.
 *
 * ## What comes back after create
 *
 * A pointer, not a brief: the directory, the kind, and the three files to read
 * (`AICO.md`, `docs/EXTENDING.md`, `.aico/backlog.md`). Roughly 150 tokens.
 * The template's own `AICO.md` is inlined into the bound session's system
 * prompt, so an agent working on the app reads the notes once and has them
 * on every turn from cache.
 *
 * @module tools/manage-miniapps
 */

import path from 'path';
import { currentCwd, currentRunContext } from '../run-context.js';
import { loadSettings } from '../settings.js';
import { authoringContract } from '../miniapps/contract.js';
import { nextAuthoringContract } from '../miniapps/contract-nextjs.js';
import {
  backlogProgress, createMiniApp, deleteMiniApp, effectiveKind, getMiniApp, hasProcess, listMiniApps,
  miniAppDir, runProfileFor, slugify, touchMiniApp,
  type MiniApp, type MiniAppKind,
} from '../miniapps/store.js';
import { closeDatabase, describe as describeTables } from '../miniapps/data.js';
import { appState, startApp, stopApp, type RunningApp } from '../miniapps/process.js';
import { getTemplate, instantiateTemplate, nodeSatisfies, renderCatalogue } from '../apps/templates.js';
import { deployApp, deployState } from '../apps/deploy.js';

export interface AppManageInput {
  action: 'list' | 'create' | 'describe' | 'tables' | 'delete' | 'templates' | 'start' | 'stop' | 'status' | 'deploy';
  /** For deploy: which target from app.json (defaults to the first). */
  target?: string;
  /** For create: what to call it. For everything else: which one. */
  name?: string;
  description?: string;
  /** For create: the template id (see action "templates"). */
  template?: string;
  /** For templates and create-without-template: what the app is for, to rank suggestions. */
  brief?: string;
  /** For create without a template: only "page" is honoured; everything else goes through a template. */
  kind?: MiniAppKind;
}

/** The old name, kept one release so a transcript that says it still works. */
export type MiniAppManageInput = AppManageInput;

/** How long `start` waits for a process to report ready before handing back the log. */
const START_TIMEOUT_MS = 120_000;

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
  return 'Note: Apps are switched off, so the shared host is not serving page and static apps right now. '
    + 'Turn on Settings → Apps (or set miniApps.enabled to true) and restart aico. '
    + 'Building one now is fine — it will be there when the host is on.';
}

/** The ~150-token pointer handed back for a templated app. */
function pointer(app: MiniApp, dir: string, created: boolean): string {
  const kind = effectiveKind(app);
  const process = hasProcess(app);
  return [
    `${created ? 'Created' : 'App'} "${app.slug}" — ${app.title} (${kind}${app.template ? `, from template ${app.template.id}` : ''})`,
    `  Directory  ${dir}`,
    '',
    'Read these first, in order:',
    `  ${path.join(dir, 'AICO.md')}            what this app is and how to work on it`,
    `  ${path.join(dir, 'docs', 'EXTENDING.md')}   how to add the next feature — copy the worked one`,
    `  ${path.join(dir, '.aico', 'backlog.md')}   the stories; tick them as they land`,
    '',
    process
      ? 'Then: use Skill app-plan for the brief, build by copying the worked feature, RunChecks, '
        + `and AppManage start (name "${app.slug}") to run it — the first start installs dependencies, `
        + 'which takes a while. VerifyApp the URL it reports.'
      : `Then: build by copying the worked pattern and VerifyApp ${kind === 'cli' ? 'is not needed — a passing RunChecks is the check' : 'the served URL after every change'}.`,
    'Do not create another app in this conversation.',
  ].join('\n');
}

function describeProcess(rec: RunningApp | undefined, slug: string): string {
  if (!rec) return `"${slug}" is not running. AppManage start to run it.`;
  const tail = rec.output.slice(-20);
  const head = `"${slug}": ${rec.state}${rec.url ? ` at ${rec.url}` : ''}${rec.error ? ` — ${rec.error}` : ''}`;
  return tail.length ? `${head}\n\nLast output:\n${tail.join('\n')}` : head;
}

/** Wait for a started process to settle: running, failed, or the timeout. */
async function awaitReady(slug: string): Promise<RunningApp | undefined> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const rec = appState(slug);
    if (!rec || rec.state === 'running' || rec.state === 'failed' || rec.state === 'stopped' || rec.state === 'done') return rec;
    await new Promise(r => setTimeout(r, 500));
  }
  return appState(slug);
}

export async function executeAppManage(input: AppManageInput): Promise<string> {
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
  const find = async (name: string | undefined): Promise<{ slug: string; app: MiniApp } | string> => {
    if (!name) return 'Which app? Use action "list" to see them.';
    const slug = slugify(name);
    const app = await getMiniApp(slug, settings, cwd);
    return app ? { slug, app } : `No app called "${slug}".`;
  };

  switch (input.action) {
    case 'templates': {
      return `Templates (★ = suggested by the brief):\n${renderCatalogue(input.brief ?? input.description ?? '', cwd)}\n\n`
        + 'Create from one with action "create", name, and template. Templates copy in zero model tokens '
        + 'and arrive with a worked feature, tests, notes to you (AICO.md) and a Dockerfile.';
    }

    case 'list': {
      const apps = await listMiniApps(settings, cwd);
      if (apps.length === 0) {
        return withNotice('No apps yet. See action "templates", then "create".');
      }
      const lines = await Promise.all(apps.map(async (app) => {
        const kind = effectiveKind(app);
        let state: string;
        if (hasProcess(app)) {
          const rec = appState(app.slug);
          state = rec ? `${rec.state}${rec.url ? ` at ${rec.url}` : ''}` : (app.built ? 'not running' : 'not built yet');
        } else {
          state = app.built ? await appUrl(app.slug) : 'not built yet';
        }
        const progress = await backlogProgress(miniAppDir(app.slug, settings, cwd));
        const backlog = progress.total ? `, backlog ${progress.done}/${progress.total}` : '';
        return `- ${app.slug} — ${app.title}${app.description ? `: ${app.description}` : ''} (${kind}, ${state}${backlog})`;
      }));
      return withNotice([`${apps.length} app${apps.length === 1 ? '' : 's'}:`, ...lines].join('\n'));
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

      if (input.template) {
        const template = getTemplate(input.template, cwd);
        if (!template) {
          return `No template called "${input.template}".\n\n${renderCatalogue(input.brief ?? input.description ?? '', cwd)}`;
        }
        if (!nodeSatisfies(template.requires?.node)) {
          return `Template "${template.id}" needs Node ${template.requires?.node}; this machine runs ${process.versions.node}. `
            + 'Pick another template or upgrade Node.';
        }
        const app = await instantiateTemplate({
          template,
          title: input.name,
          ...(input.description ? { description: input.description } : {}),
          ...(sessionId ? { sessionId } : {}),
        }, settings, cwd);
        return withNotice(pointer(app, miniAppDir(app.slug, settings, cwd), true));
      }

      // The page kind by explicit request keeps its authoring contract: for a
      // one-screen tool over SQLite, the runtime is the template.
      if (input.kind === 'page') {
        const app = await createMiniApp({
          title: input.name,
          kind: 'page',
          ...(input.description ? { description: input.description } : {}),
          ...(sessionId ? { sessionId } : {}),
        }, settings, cwd);
        const dir = miniAppDir(app.slug, settings, cwd);
        return withNotice(authoringContract(app.slug, dir, await appUrl(app.slug)));
      }

      // No template named: nothing is made. The catalogue is the answer, and
      // the next call names one.
      return `Nothing created yet — pick a template first.\n\n`
        + `Templates (★ = suggested for "${input.name}"):\n`
        + `${renderCatalogue([input.name, input.description, input.brief].filter(Boolean).join(' '), cwd)}\n\n`
        + `Call create again with template set (for example template: "page-records"). `
        + 'For a bare single-page app without a template, pass kind: "page".';
    }

    case 'describe': {
      const found = await find(input.name);
      if (typeof found === 'string') return found;
      const { slug, app } = found;
      // Touched, so working on an app moves it up the list even when the change
      // was to a file this tool never saw.
      await touchMiniApp(slug, {}, settings, cwd);
      const dir = miniAppDir(slug, settings, cwd);
      if (app.template) return withNotice(pointer(app, dir, false));
      if (app.kind === 'nextjs') {
        return withNotice(`${app.built ? 'Built.' : 'Not built yet — there is no package.json.'}\n\n${nextAuthoringContract(slug, dir)}`);
      }
      if (effectiveKind(app) === 'page') {
        const state = app.built ? 'Built.' : `Not built yet — there is no ${path.join('public', 'index.html')}.`;
        return withNotice(`${state}\n\n${authoringContract(slug, dir, await appUrl(slug))}`);
      }
      return withNotice(pointer(app, dir, false));
    }

    case 'tables': {
      const found = await find(input.name);
      if (typeof found === 'string') return found;
      const { slug, app } = found;
      if (effectiveKind(app) !== 'page') {
        return `"${slug}" is a ${effectiveKind(app)} app; its database is its own. Read its data layer `
          + '(see AICO.md) rather than asking the shared host.';
      }
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

    case 'start': {
      const found = await find(input.name);
      if (typeof found === 'string') return found;
      const { slug, app } = found;
      if (!hasProcess(app)) {
        return effectiveKind(app) === 'cli'
          ? `"${slug}" is a CLI: nothing to start. Run its checks with RunChecks, or run it with Bash in ${miniAppDir(slug, settings, cwd)}.`
          : withNotice(`"${slug}" is served by the shared host and needs no start: ${await appUrl(slug)}`);
      }
      const dir = miniAppDir(slug, settings, cwd);
      const profile = runProfileFor(app);
      if (!profile?.dev) return `"${slug}" declares no dev command in app.json; add run.dev and try again.`;
      const current = appState(slug);
      if (current?.state === 'running') return describeProcess(current, slug);
      await startApp(slug, dir, app);
      const rec = await awaitReady(slug);
      if (rec?.state === 'running') return `"${slug}" is running at ${rec.url}. VerifyApp it.`;
      if (rec && rec.state !== 'failed' && rec.state !== 'stopped') {
        return `"${slug}" is still ${rec.state} after ${START_TIMEOUT_MS / 1000}s (a first install can take longer). `
          + `Check again with AppManage status.\n\n${describeProcess(rec, slug)}`;
      }
      return describeProcess(rec, slug);
    }

    case 'stop': {
      const found = await find(input.name);
      if (typeof found === 'string') return found;
      const stopped = await stopApp(found.slug);
      return stopped ? `Stopped "${found.slug}".` : `"${found.slug}" was not running.`;
    }

    case 'status': {
      const found = await find(input.name);
      if (typeof found === 'string') return found;
      const { slug, app } = found;
      const dir = miniAppDir(slug, settings, cwd);
      const progress = await backlogProgress(dir);
      const backlog = progress.total ? `Backlog ${progress.done}/${progress.total} done.` : 'No backlog file.';
      if (!hasProcess(app)) {
        const where = effectiveKind(app) === 'cli' ? 'a CLI; nothing is served' : `served at ${await appUrl(slug)}`;
        return withNotice(`"${slug}" is ${where}. ${backlog}`);
      }
      return `${describeProcess(appState(slug), slug)}\n${backlog}`;
    }

    case 'deploy': {
      const found = await find(input.name);
      if (typeof found === 'string') return found;
      const { slug, app } = found;
      const dir = miniAppDir(slug, settings, cwd);
      const started = await deployApp(app, dir, input.target);
      if (!started.ok) return started.message;
      // Wait for it to settle, within reason: a docker build is minutes, and a
      // model that returns "started" and moves on never learns it failed.
      const deadline = Date.now() + START_TIMEOUT_MS * 2;
      let rec = deployState(slug);
      while (rec && rec.state === 'working' && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 1000));
        rec = deployState(slug);
      }
      const targets = (app.deploy ?? []).map(t => t.id).join(', ');
      if (!rec) return `Deploy of "${slug}" produced no record.`;
      const tail = rec.output.slice(-25).join('\n');
      if (rec.state === 'done') return `Deployed "${slug}" (${input.target ?? app.deploy?.[0]?.id}). Last output:\n${tail}`;
      if (rec.state === 'working') return `Deploy of "${slug}" is still running after ${(START_TIMEOUT_MS * 2) / 1000}s. Check again with AppManage status. Output so far:\n${tail}`;
      return `Deploy of "${slug}" failed${rec.error ? ` — ${rec.error}` : ''}. Targets: ${targets}. Output:\n${tail}`;
    }

    case 'delete': {
      if (!input.name) return 'Which app?';
      const slug = slugify(input.name);
      const app = await getMiniApp(slug, settings, cwd);
      if (!app) return `No app called "${slug}".`;

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
          + 'If the reader genuinely wants it gone, they can delete it from the Apps screen.';
      }
      await stopApp(slug).catch(() => undefined);
      closeDatabase(miniAppDir(slug, settings, cwd));
      const gone = await deleteMiniApp(slug, settings, cwd);
      return gone
        ? `Deleted "${slug}", including its database. That data is not recoverable.`
        : `Could not delete "${slug}".`;
    }

    default:
      return `Unknown action "${String(input.action)}".`;
  }
}

/** The old name, kept one release. */
export const executeMiniAppManage = executeAppManage;

export const appManageToolDefinition = {
  name: 'AppManage',
  description: [
    'Create and run Apps: real applications kept in the workspace, started from templates.',
    'Use this when someone asks for an app, a tool, a site, a service or an API — a tracker, a',
    'landing page, a SaaS with accounts, a JSON API. Start with action "templates" (or "create" with',
    'a name and no template) to see the catalogue: each template copies in without generating a line,',
    'and arrives with a worked feature, tests, a Dockerfile, and notes to you in AICO.md.',
    'Then "create" with the template id. Kinds: page (one HTML file over the shared SQLite host, no',
    'install), static (files), process (its own server — Next.js, Hono — installed and started by',
    '"start"), cli. After creating, read the app\'s AICO.md and docs/EXTENDING.md before writing',
    'anything; build by copying the worked feature; RunChecks; then "start" and VerifyApp.',
  ].join(' '),
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['templates', 'list', 'create', 'describe', 'tables', 'start', 'stop', 'status', 'deploy', 'delete'],
        description:
          'templates: the catalogue, best matches for `brief` first. create: make an app from `template` '
          + '(without one, returns the catalogue and makes nothing). list: every app, its kind and state. '
          + 'describe: the pointer or authoring guide for an existing app. tables: a page app\'s schema as it '
          + 'applied. start/stop/status: the process of a process app (start installs on first run and waits '
          + 'for the URL). deploy: run the app\'s own deploy script (`target` from app.json; docker by default) '
          + 'and report the outcome — refuses plainly when a required tool is missing. delete: remove an app '
          + 'and its data for good.',
      },
      target: {
        type: 'string',
        description: 'For deploy: the target id from the app\'s app.json (e.g. "docker"). Defaults to the first.',
      },
      name: {
        type: 'string',
        description: 'What to call it when creating ("Invoices"), or which app for every other action.',
      },
      template: {
        type: 'string',
        description: 'For create: the template id from action "templates", e.g. "web-saas-next", "api-service-hono", "page-records", "landing-static".',
      },
      brief: {
        type: 'string',
        description: 'What the app is for, in the user\'s words. Ranks the catalogue.',
      },
      kind: {
        type: 'string',
        enum: ['page'],
        description: 'For create without a template: "page" makes a bare single-page app and returns its authoring guide. Prefer a template.',
      },
      description: {
        type: 'string',
        description: 'One line saying what the app is for. Shown on its card and substituted into the template.',
      },
    },
    required: ['action'],
  },
};

/** The old name, kept one release. */
export const miniAppManageToolDefinition = appManageToolDefinition;
