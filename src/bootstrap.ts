/**
 * Bringing the installation's long-lived features online.
 *
 * Skills, MCP servers, background agents and the cron scheduler are process
 * singletons. Something has to start them, and for a long time that something
 * was the interactive CLI's startup path — which meant `aico serve` ran with an
 * empty skill registry, no MCP tools, and no scheduler. The web client would
 * show "0 skills" and a slash command would silently not resolve, with nothing
 * anywhere reporting a problem.
 *
 * Any entry point that runs turns needs all of this, so it lives here and both
 * call it. Idempotent: calling it twice is a no-op, because a second entry
 * point coming up must not restart a scheduler that is already running.
 *
 * @module bootstrap
 */

import { skillRegistry } from './skills/index.js';
import { mcpRegistry } from './mcp/index.js';
import { cronScheduler } from './cron/scheduler.js';
import { setBackgroundAgentOpts } from './background/index.js';
import { setMemoryCacheTtl, stopMemoryWatcher } from './memory/index.js';
import { ledger } from './work/ledger.js';
import { setAdapterSettings, startLedgerMirroring, stopLedgerMirroring } from './work/adapters.js';
import { supervisor } from './work/supervisor.js';
import type { AicoSettings } from './settings.js';
import type { McpServerConfigV2 } from './mcp/index.js';

export interface BootstrapOptions {
  settings: AicoSettings;
  /** Model that background agents and scheduled jobs inherit. */
  model: string;
  autoApprove?: boolean;
  verbose?: boolean;
  /** Where warnings go. Silent entry points pass a no-op. */
  warn?: (message: string) => void;
}

let started = false;

/**
 * Start every feature singleton, tolerating individual failures.
 *
 * A broken MCP server or an unreadable skills directory must not stop the
 * process from answering questions — each failure is reported and the rest
 * still comes up.
 */
export async function initializeFeatures(opts: BootstrapOptions): Promise<void> {
  if (started) return;
  started = true;

  const { settings, model } = opts;
  const warn = opts.warn ?? ((message: string) => console.warn(message));
  const autoApprove = opts.autoApprove ?? settings.autoApprove ?? false;

  if (settings.memory?.cacheTtl) setMemoryCacheTtl(settings.memory.cacheTtl);

  /*
    The ledger comes up before anything that can register with it.

    Loading it is also the only chance to settle what the *last* process left
    behind. Anything the log says was running is either a detached process whose
    pid is still alive — a dev server that correctly outlived us — or work that
    died with the process and has been invisible until now. Reporting the second
    kind is the whole reason this is persisted: before it, a crash mid-delegation
    left no trace at all, and "it finished" and "it never came back" looked
    identical from the next session.
  */
  const { recovered, lost } = await ledger.load()
    .catch((err: unknown) => {
      warn(`  ⚠ Work ledger failed to load: ${String(err)}`);
      return { recovered: [], lost: [] };
    });
  if (recovered.length) {
    warn(`  ↻ ${recovered.length} process(es) still running from a previous session`);
  }
  if (lost.length) {
    warn(`  ⚠ ${lost.length} item(s) were interrupted by a restart and are marked lost`);
  }
  setAdapterSettings(settings);
  startLedgerMirroring();
  supervisor.start();

  await skillRegistry.load({
    disableBuiltins: settings.skills?.disableBuiltins,
    extraDirs: settings.skills?.dirs,
  }).catch((err: unknown) => { warn(`  ⚠ Skills failed to load: ${String(err)}`); });

  if (settings.mcpServers && Object.keys(settings.mcpServers).length > 0) {
    await mcpRegistry
      .loadServers(settings.mcpServers as Record<string, McpServerConfigV2>)
      .catch((err: unknown) => { warn(`  ⚠ MCP registry failed: ${String(err)}`); });
    mcpRegistry.startHealthChecks();
  }

  setBackgroundAgentOpts({
    token: process.env.GITHUB_TOKEN ?? '',
    model,
    autoApprove,
    verbose: opts.verbose ?? false,
    settings,
  });

  if (settings.cron?.enabled !== false) {
    await cronScheduler.start({
      token: process.env.GITHUB_TOKEN ?? '',
      model,
      autoApprove,
      settings,
    }).catch((err: unknown) => { warn(`  ⚠ Cron scheduler failed to start: ${String(err)}`); });
  }
}

/** Stop everything `initializeFeatures` started. Safe to call unstarted. */
export function shutdownFeatures(): void {
  if (!started) return;
  started = false;
  mcpRegistry.stopAll();
  cronScheduler.stop();
  stopMemoryWatcher();
  supervisor.stop();
  stopLedgerMirroring();
  // The ledger itself is deliberately not cleared. Its records outlive this
  // process by design — that is what makes the next boot able to say what was
  // interrupted rather than starting from an empty map.
}

/** Test seam: forget that startup happened, so a suite can run it again. */
export function resetBootstrapForTests(): void {
  started = false;
}
