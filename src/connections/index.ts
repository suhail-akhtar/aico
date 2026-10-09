/**
 * Connections (ADR 0039): the one place the server and the tests turn the feature on.
 *
 * `installConnections` registers the adapters that ship, installs PR-mode landing into Delivery
 * and starts the poller. It is called once by the server at start-up; nothing here runs at import
 * time, so importing a type from this folder never starts a timer or touches the network.
 *
 * @module connections
 */

import { azureDevopsAdapter } from './azure-devops/index.js';
import { bitbucketCloudAdapter } from './bitbucket/cloud.js';
import { customAdapter } from './packs/adapter.js';
import { bitbucketDcAdapter } from './bitbucket/dc.js';
import { githubAdapter } from './github/index.js';
import { gitbucketAdapter } from './gitbucket/index.js';
import { forgejoAdapter, giteaAdapter } from './gitea/index.js';
import { gitlabAdapter } from './gitlab/index.js';
import { installLanding } from './landing.js';
import { startConnectionPoller } from './poller.js';
import { registerAdapter } from './registry.js';

/** Register the adapters that ship. Idempotent. */
export function registerBuiltinAdapters(): void {
  registerAdapter(githubAdapter);
  registerAdapter(gitlabAdapter);
  registerAdapter(giteaAdapter);
  registerAdapter(forgejoAdapter);
  registerAdapter(gitbucketAdapter);
  registerAdapter(azureDevopsAdapter);
  registerAdapter(bitbucketCloudAdapter);
  registerAdapter(bitbucketDcAdapter);
  registerAdapter(customAdapter);
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
