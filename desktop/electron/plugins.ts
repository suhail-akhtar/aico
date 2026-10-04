/**
 * User plugins on disk: `~/.aico/desktop/plugins/<id>/aico-plugin.json`.
 *
 * Main reads, writes and watches them; the renderer turns them into the
 * interface. Writes come from two places — the Plugins page and the agent's
 * `ide_plugin_*` tools — and both go through `savePlugin`, so a plugin the
 * orchestrator creates is validated exactly like one a person writes.
 *
 * @module desktop/electron/plugins
 */

import fs from 'node:fs';
import path from 'node:path';
import type { DesktopContext } from './context';
import { manifestHasScript, validateManifest, type InstalledPlugin, type PluginManifest } from '../shared/plugin-types';
import { pluginContentHash, reconcilePluginTrust } from './security-core';

const MANIFEST = 'aico-plugin.json';

export function pluginDirFor(ctx: DesktopContext, id: string): string {
  if (!/^[a-z0-9][a-z0-9.-]{1,62}$/.test(id)) throw new Error(`Invalid plugin id "${id}".`);
  return path.join(ctx.paths.pluginsDir, id);
}

/** Every file of a plugin folder (bounded), for its content hash. Null when it cannot be read. */
function pluginHash(dir: string): string | undefined {
  const files: Array<{ rel: string; data: Buffer }> = [];
  let total = 0;
  const walkDir = (abs: string, rel: string): void => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const a = path.join(abs, e.name); const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walkDir(a, r);
      else if (e.isFile()) {
        const data = fs.readFileSync(a);
        total += data.length;
        if (files.length > 2000 || total > 64 * 1024 * 1024) throw new Error('plugin too large to hash');
        files.push({ rel: r, data });
      }
    }
  };
  try { walkDir(dir, ''); } catch { return undefined; }
  return pluginContentHash(files);
}

/**
 * Trust follows the files: a trusted plugin whose content hash changed since
 * the person trusted it (the agent saved it, someone edited it) is no longer
 * trusted, and its scripts wait for the person again. A trust record without
 * a hash (given before trust followed the files, or just now in the interface) takes the
 * current one.
 */
export function reconcileTrust(ctx: DesktopContext): void {
  const p = ctx.prefs.get().plugins;
  if (!p?.trusted?.length) return;
  const current: Record<string, string | undefined> = {};
  for (const id of p.trusted) {
    try { const dir = pluginDirFor(ctx, id); if (fs.existsSync(path.join(dir, MANIFEST))) current[id] = pluginHash(dir) ?? ''; } catch { /* not a user plugin id */ }
  }
  const next = reconcilePluginTrust({ trusted: p.trusted, hashes: p.trustedHashes }, current);
  const same = next.trusted.length === p.trusted.length && JSON.stringify(next.hashes) === JSON.stringify(p.trustedHashes ?? {});
  if (!same) ctx.prefs.set({ plugins: { ...p, trusted: next.trusted, trustedHashes: next.hashes } });
}

/** Saving a plugin's files takes its trust away: the person trusts what is there now, not what was. */
function revokeTrust(ctx: DesktopContext, id: string): void {
  const p = ctx.prefs.get().plugins;
  if (!p.trusted.includes(id) && !p.trustedHashes?.[id]) return;
  const hashes = { ...(p.trustedHashes ?? {}) };
  delete hashes[id];
  ctx.prefs.set({ plugins: { ...p, trusted: p.trusted.filter(x => x !== id), trustedHashes: hashes } });
}

export function listUserPlugins(ctx: DesktopContext): InstalledPlugin[] {
  reconcileTrust(ctx);
  const prefs = ctx.prefs.get().plugins;
  const out: InstalledPlugin[] = [];
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(ctx.paths.pluginsDir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(ctx.paths.pluginsDir, e.name);
    const file = path.join(dir, MANIFEST);
    if (!fs.existsSync(file)) continue;
    try {
      const manifest = validateManifest(JSON.parse(fs.readFileSync(file, 'utf8')));
      const hasScript = manifestHasScript(manifest);
      out.push({
        manifest, source: 'user', dir,
        enabled: !prefs.disabled.includes(manifest.id),
        hasScript,
        trusted: !hasScript || prefs.trusted.includes(manifest.id),
      });
    } catch (err) {
      out.push({
        manifest: { id: e.name, name: e.name, version: '0.0.0', contributes: {} },
        source: 'user', dir, enabled: false, hasScript: false, trusted: false,
        error: (err as Error).message,
      });
    }
  }
  return out.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

/**
 * Create or replace a plugin. `files` are extra files beside the manifest
 * (a frame view's HTML, a README) — relative names only, no directories out.
 */
export function savePlugin(ctx: DesktopContext, manifestInput: unknown, files: Record<string, string> = {}): PluginManifest {
  const manifest = validateManifest(manifestInput);
  const dir = pluginDirFor(ctx, manifest.id);
  // Before a byte changes: whatever the person trusted, this is not it.
  revokeTrust(ctx, manifest.id);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const target = path.resolve(dir, name);
    if (!target.startsWith(path.resolve(dir) + path.sep)) throw new Error(`File "${name}" would be written outside the plugin.`);
    if (path.basename(target) === MANIFEST) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
  // Every file a contribution names must exist, or the plugin would load broken.
  for (const v of manifest.contributes.views ?? []) {
    if (v.kind === 'frame' && !fs.existsSync(path.join(dir, v.entry))) throw new Error(`View "${v.id}" names "${v.entry}", which is not in the plugin.`);
  }
  for (const w of manifest.contributes.widgets ?? []) {
    if (!fs.existsSync(path.join(dir, w.entry))) throw new Error(`Widget "${w.language}" names "${w.entry}", which is not in the plugin.`);
  }
  fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify({ ...manifest, builtin: undefined }, null, 2));
  ctx.emit('plugins:changed');
  return manifest;
}

export function readPluginFile(ctx: DesktopContext, id: string, name: string): string {
  const dir = pluginDirFor(ctx, id);
  const target = path.resolve(dir, name);
  if (!target.startsWith(path.resolve(dir) + path.sep)) throw new Error('Outside the plugin.');
  return fs.readFileSync(target, 'utf8');
}

export async function removePlugin(ctx: DesktopContext, id: string): Promise<void> {
  const dir = pluginDirFor(ctx, id);
  // To the system trash: a plugin someone (or the agent) removed can be recovered.
  const { shell } = await import('electron');
  try { await shell.trashItem(dir); } catch { fs.rmSync(dir, { recursive: true, force: true }); }
  const p = ctx.prefs.get().plugins;
  const hashes = { ...(p.trustedHashes ?? {}) };
  delete hashes[id];
  ctx.prefs.set({ plugins: { disabled: p.disabled.filter(x => x !== id), trusted: p.trusted.filter(x => x !== id), trustedHashes: hashes } });
  ctx.emit('plugins:changed');
}

export function setPluginEnabled(ctx: DesktopContext, id: string, enabled: boolean): void {
  const p = ctx.prefs.get().plugins;
  const disabled = new Set(p.disabled);
  if (enabled) disabled.delete(id); else disabled.add(id);
  ctx.prefs.set({ plugins: { ...p, disabled: [...disabled] } });
  ctx.emit('plugins:changed');
}

export function setPluginTrusted(ctx: DesktopContext, id: string, trusted: boolean): void {
  const p = ctx.prefs.get().plugins;
  const set = new Set(p.trusted);
  if (trusted) set.add(id); else set.delete(id);
  const hashes = { ...(p.trustedHashes ?? {}) };
  delete hashes[id];
  if (trusted) { const h = pluginHash(pluginDirFor(ctx, id)); if (h) hashes[id] = h; }
  ctx.prefs.set({ plugins: { ...p, trusted: [...set], trustedHashes: hashes } });
  ctx.emit('plugins:changed');
}

export function registerPlugins(ctx: DesktopContext): void {
  ctx.handle('plugins:list', () => listUserPlugins(ctx));
  ctx.handle('plugins:save', (manifest: unknown, files?: Record<string, string>) => savePlugin(ctx, manifest, files ?? {}));
  ctx.handle('plugins:remove', (id: string) => removePlugin(ctx, id));
  ctx.handle('plugins:setEnabled', (id: string, enabled: boolean) => setPluginEnabled(ctx, id, enabled));
  ctx.handle('plugins:setTrusted', (id: string, trusted: boolean) => setPluginTrusted(ctx, id, trusted));
  ctx.handle('plugins:readFile', (id: string, name: string) => readPluginFile(ctx, id, name));
  ctx.handle('plugins:openFolder', async () => {
    const { shell } = await import('electron');
    return shell.openPath(ctx.paths.pluginsDir);
  });

  // A trust given in the interface (prefs:set) records the hash of the files as they are now.
  ctx.prefs.on('change', () => {
    const p = ctx.prefs.get().plugins;
    if (p.trusted.some(id => !p.trustedHashes?.[id])) reconcileTrust(ctx);
  });
  reconcileTrust(ctx);

  // Hand-edited plugins reload without a restart (and lose their trust if their files changed).
  let timer: NodeJS.Timeout | null = null;
  try {
    fs.watch(ctx.paths.pluginsDir, { recursive: true }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { reconcileTrust(ctx); ctx.emit('plugins:changed'); }, 300);
    });
  } catch { /* recursive watch unsupported: the Reload button still works */ }
}
