/**
 * Learning a project's commands from the ones that worked.
 *
 * The agent runs `npm install`, then `npm run dev`, reads "Local: http://
 * localhost:5173" off the output, runs `prisma migrate dev` — and next turn
 * knows none of it, because the only record is a transcript that will be
 * compacted. This stage watches Bash results go past and turns the ones that
 * succeeded into profile facts at `observed` rank: never a denial, never a
 * rewrite, never a model call.
 *
 * `observeCommand` is pure — command in, stdout in, exit code in, patch out —
 * so the harness tests it without a shell. `installProfileObserver` is the
 * thin pipeline stage that feeds it.
 *
 * @module project/observe
 */

import type { ToolPipeline } from '../tools/pipeline.js';
import { updateProfile, type ProfilePatch } from './profile.js';

const PM = '(?:npm|pnpm|yarn|bun)';
const OBSERVER_STAGE = 'project-profile-observer';

/** A dev-server line: the first localhost URL with a port. */
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})\b/i;

/**
 * What one finished command says about the project, or nothing.
 *
 * Only success teaches: a failed install says the wrong package manager was
 * tried, not which one is right. A command with `&&` or `;` is left alone —
 * recording "cd api && npm test" as the test command would run it from the
 * wrong directory next time.
 */
export function observeCommand(command: string, stdout: string, exitCode: number): ProfilePatch | undefined {
  const cmd = command.trim();
  if (exitCode !== 0 || !cmd || /&&|\|\||;|\|/.test(cmd)) return undefined;

  // Install.
  const install = new RegExp(`^(${PM})\\s+(?:install|ci|i|add)\\b(?!.*\\s(?:-g|--global)\\b)`).exec(cmd);
  if (install) {
    const pm = install[1]!;
    // A named package is being added, not the project set up — that still
    // says which package manager the project uses, and nothing more.
    const bare = !/\s(?:install|ci|i|add)\s+[^-\s]/.test(cmd);
    return {
      packageManager: { value: pm, source: 'observed' },
      ...(bare ? { commands: { setup: { command: cmd, source: 'observed' } } } : {}),
    };
  }

  // Dev server: a run script called dev/start/serve, or the tool itself, that
  // printed where it listens.
  const port = LOCAL_URL.exec(stdout)?.[1];
  const devScript = new RegExp(`^(?:${PM}\\s+(?:run\\s+)?(?:dev|start|serve|preview)\\b|npx\\s+(?:next|vite|astro|nuxt|remix|expo)\\s+(?:dev|start)\\b|(?:next|vite|astro|nuxt)\\s+dev\\b|python\\s+-m\\s+(?:http\\.server|flask|uvicorn)\\b|uvicorn\\b|flask\\s+run\\b|cargo\\s+run\\b|go\\s+run\\b|rails\\s+(?:s|server)\\b)`);
  if (devScript.test(cmd) && port) {
    return { commands: { dev: { command: cmd, source: 'observed', port: Number(port) } } };
  }

  // Migrations.
  if (/^(?:npx\s+)?(?:prisma\s+(?:migrate|db\s+push)|drizzle-kit\s+(?:push|migrate|generate)|knex\s+migrate|sequelize(?:-cli)?\s+db:migrate|typeorm\s+migration:run|alembic\s+upgrade|python\s+manage\.py\s+migrate|(?:bundle\s+exec\s+)?rails\s+db:migrate|dotnet\s+ef\s+database\s+update|goose\s+up|migrate\s+up|dbmate\s+up|flyway\s+migrate)\b/.test(cmd)
    || new RegExp(`^${PM}\\s+run\\s+(?:migrate|db:migrate|db:push)\\b`).test(cmd)) {
    return { commands: { migrate: { command: cmd, source: 'observed' } } };
  }

  return undefined;
}

/** The shape a Bash result takes, as far as the observer needs. */
interface BashLike { stdout?: string; exit_code?: number }

/**
 * Register the observer on a pipeline.
 *
 * Post-execute, and it always calls `next()` first and returns its decision
 * unchanged: this stage records, it never rules. `rootOf` is asked per call so
 * a command run inside a bound app's directory teaches that app's profile, not
 * the repository's.
 */
export function installProfileObserver(
  pipeline: ToolPipeline,
  rootOf: () => string,
): () => void {
  // One per pipeline: a pipeline shared across sessions would otherwise gain a
  // stage per run and record every observation several times over.
  if (pipeline.describe().post.includes(OBSERVER_STAGE)) return () => undefined;
  return pipeline.onPostExecute(OBSERVER_STAGE, async (ctx, next) => {
    const decision = await next();
    if (ctx.name !== 'Bash' || decision.outcome.isError) return decision;
    const result = decision.outcome.result as BashLike | undefined;
    const command = String(ctx.arguments.command ?? '');
    const patch = observeCommand(command, result?.stdout ?? '', result?.exit_code ?? 1);
    if (patch) {
      // Never awaited into the tool's latency, never allowed to fail the call.
      void updateProfile(rootOf(), patch).catch(() => undefined);
    }
    return decision;
  });
}
