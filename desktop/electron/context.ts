/**
 * What every main-process module is handed: the window, the prefs, the engine,
 * and a way to tell the interface something happened.
 *
 * One object instead of module-level singletons, so each feature module is a
 * plain `register(ctx)` that can be read — and switched off — on its own.
 *
 * @module desktop/electron/context
 */

import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import type { EngineHost } from './engine-host';
import type { PrefsStore } from './prefs';

export interface DesktopPaths {
  /** `~/.aico` (or `AICO_HOME`). */
  aicoHome: string;
  /** `~/.aico/desktop` — prefs, plugins, browser downloads. */
  desktopDir: string;
  pluginsDir: string;
  /** Where built files live: `dist/`. */
  distDir: string;
}

/** Services one module offers others (the MCP tools use these). Filled in by register(). */
export interface DesktopServices {
  terminal?: {
    list(): Array<{ id: string; title: string; cwd: string; exited: boolean }>;
    tail(id: string): string;
    run(command: string, cwd?: string): { id: string };
    write(id: string, data: string): void;
  };
  browser?: import('./browser').BrowserService;
  renderer?: {
    /** Ask the interface something and wait for the answer (see renderer-bridge.ts). */
    call<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  };
}

export interface DesktopContext {
  services: DesktopServices;
  window(): BrowserWindow | null;
  prefs: PrefsStore;
  engine: EngineHost;
  paths: DesktopPaths;
  /** Send an event to the interface. */
  emit(channel: string, payload?: unknown): void;
  /** Register an invoke handler; the channel must be on the preload allowlist. */
  handle<A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>): void;
  /** Focus and show the main window. */
  reveal(): void;
}

export function makeHandle(): DesktopContext['handle'] {
  return (channel, fn) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (_e: IpcMainInvokeEvent, ...args: unknown[]) => fn(...(args as never)));
  };
}
