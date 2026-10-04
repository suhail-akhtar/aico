/**
 * The folders the person has opened in AICO: what the interface's file
 * handlers (fs:read, fs:write, shell:openPath…) and the agent's browser_upload
 * may touch.
 *
 * WHY. Those handlers took any absolute path. The renderer is the person's
 * interface, but a script that got into it (or a frame that reached its
 * bridge) could then read `~/.ssh` or overwrite a startup file. The person
 * never works outside folders they opened, so the handlers are scoped to:
 *   - the engine's projects and workspaces (GET /api/projects — every folder
 *     a chat runs in is one),
 *   - AICO's own store (`AICO_HOME`: the library, plugins, settings files the
 *     interface shows),
 *   - folders and files the person picked in a native dialog this run.
 * The project list is cached for a few seconds and kept when the engine is
 * restarting, so a slow engine does not lock the editor.
 *
 * What it does not do: decide (security-core.ts insideAny does), or grant —
 * a path outside is refused with a message naming the fix.
 *
 * @module desktop/electron/opened-roots
 */

import fs from 'node:fs';
import path from 'node:path';
import type { DesktopContext } from './context';
import { insideAny } from './security-core';

export interface OpenedRoots {
  /** A folder or file the person picked in a native dialog. */
  add(p: string): void;
  /** The roots now (engine projects refreshed if stale). */
  list(): Promise<string[]>;
  /** Throws, naming the fix, unless `p` is inside a root. */
  check(p: string, what: string): Promise<string>;
}

const TTL_MS = 3000;
const made = new WeakMap<DesktopContext, OpenedRoots>();

/** The real path when it exists (a link inside a project must not lead out of it); the resolved path otherwise. */
function real(p: string): string {
  const abs = path.resolve(p);
  try { return fs.realpathSync.native(abs); } catch { /* not there yet (a new file): its folder decides */ }
  try { return path.join(fs.realpathSync.native(path.dirname(abs)), path.basename(abs)); } catch { return abs; }
}

export function openedRoots(ctx: DesktopContext): OpenedRoots {
  const had = made.get(ctx);
  if (had) return had;
  const picked = new Set<string>();
  let projects: string[] = [];
  let at = 0;
  const refresh = async (): Promise<void> => {
    if (Date.now() - at < TTL_MS) return;
    try {
      const r = await Promise.race([
        ctx.engine.request('projects') as Promise<{ projects?: Array<{ path?: unknown }>; launch?: unknown }>,
        new Promise<null>(res => setTimeout(() => res(null), 4000)),
      ]);
      if (r) {
        const list = (r.projects ?? []).map(p => p.path).filter((p): p is string => typeof p === 'string' && Boolean(p));
        if (typeof r.launch === 'string' && r.launch) list.push(r.launch);
        projects = list;
        at = Date.now();
      }
    } catch { /* engine restarting: keep the last list */ }
  };
  const self: OpenedRoots = {
    add(p) { if (p) picked.add(path.resolve(p)); },
    async list() {
      await refresh();
      return [ctx.paths.aicoHome, ...projects, ...picked];
    },
    async check(p, what) {
      if (typeof p !== 'string' || !p) throw new Error(`${what}: no path given.`);
      const roots = await self.list();
      // Both sides as real paths: a link inside a project that points out of it is outside.
      if (!insideAny(real(p), roots.map(real))) {
        throw new Error(`${what}: ${p} is outside the folders open in AICO. Open its folder as a project (or pick it with Open folder) first.`);
      }
      return path.resolve(p);
    },
  };
  made.set(ctx, self);
  return self;
}
