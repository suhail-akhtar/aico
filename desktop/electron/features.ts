/**
 * Every desktop-only service, registered in one place.
 *
 * Each module exports `register(ctx)`. Adding a service is one import and one
 * line here; nothing else in main needs to know it exists.
 *
 * @module desktop/electron/features
 */

import type { DesktopContext } from './context';
import { registerPlugins } from './plugins';
import { registerTerminal } from './terminal';
import { registerFiles } from './files';
import { registerBrowser } from './browser';
import { registerBrowserOverlay } from './browser-overlay';
import { registerBrowserWindow } from './browser-window';
import { registerGitHub } from './github';
import { registerRendererBridge } from './renderer-bridge';
import { registerUpdater } from './updater';
import { registerBackup } from './backup';
import { registerContextMenus } from './context-menu';
import { registerVaultHost } from './vault-host';
import { registerCredentialManager } from './credential-manager';
import { registerSecurePromptIpc } from './secure-prompt';

export function registerFeatures(ctx: DesktopContext): void {
  // The vault's host side first: it names the engine's key provider before the
  // engine starts, and the browser fills logins through it.
  registerSecurePromptIpc();
  ctx.services.vaultHost = registerVaultHost(ctx);
  registerCredentialManager(ctx, ctx.services.vaultHost);
  registerRendererBridge(ctx);
  registerPlugins(ctx);
  registerTerminal(ctx);
  registerFiles(ctx);
  registerBrowser(ctx);
  registerBrowserOverlay(ctx);
  registerBrowserWindow(ctx);
  registerGitHub(ctx);
  registerUpdater(ctx);
  registerBackup(ctx);
  registerContextMenus(ctx);
}
