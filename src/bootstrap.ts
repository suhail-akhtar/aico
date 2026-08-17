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
}

/** Test seam: forget that startup happened, so a suite can run it again. */
export function resetBootstrapForTests(): void {
  started = false;
}
