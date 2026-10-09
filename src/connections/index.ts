/**
 * Connections (ADR 0039): the one place the server and the tests turn the feature on.
 *
 * `installConnections` registers the adapters that ship, installs PR-mode landing into Delivery
 * and starts the poller. It is called once by the server at start-up; nothing here runs at import
 * time, so importing a type from this folder never starts a timer or touches the network.
 *
 * @module connections
 */

import { githubAdapter } from './github/index.js';
import { installLanding } from './landing.js';
import { startConnectionPoller } from './poller.js';
import { registerAdapter } from './registry.js';

/** Register the adapters that ship. Idempotent. */
export function registerBuiltinAdapters(): void {
  registerAdapter(githubAdapter);
}

export interface InstallOptions {
  /** Is a board for this project open, or its dispatcher running? (the poller only runs then) */
  isActive: (project: string) => boolean;
  /** Tests start no timer. */
  poll?: boolean;
}

export function installConnections(opts: InstallOptions): void {
  registerBuiltinAdapters();
  installLanding();
  if (opts.poll !== false) startConnectionPoller({ isActive: opts.isActive });
}

export * as ConnectionsService from './service.js';
export { syncProject, syncStatusOf } from './sync.js';
export { kickProject, stopConnectionPoller } from './poller.js';
