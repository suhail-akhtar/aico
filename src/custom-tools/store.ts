/**
 * Where custom tools live, which of them may be called, and the record of a
 * person's "enable".
 *
 * Two places, two gates, each bound to the exact content a person saw:
 *
 *  - **`~/.aico/tools/<pack>/<name>.tool.json`** (the user's store). A file
 *    there is a *draft* until a person enables it; enabling records the
 *    file's sha256, so an edit afterwards — by hand, by `ToolManage update`,
 *    or by the agent's own Write — sends it back to "changed" and out of the
 *    run until someone enables it again. Same draft → register shape as
 *    skills (design §5.1), and for the same reason: a tool the model can
 *    write and call in one breath is a tool nobody reviewed.
 *  - **`<project>/.aico/tools/<pack>/<name>.tool.json`**. Covered by project
 *    trust (workspace-trust.ts, design §4.4): the files' hash is part of what
 *    a person approves for that project, with each tool's command shown. A
 *    trusted project's tools are callable unless switched off here.
 *
 * The pack folder is the deferred group (`tools:<pack>`): a pack's schemas
 * are offered only after `LoadTools` names it, so installing packs costs one
 * line each in the always-sent request, not their schemas.
 *
 * Honest limit (as for skills in Phase 1): the enable record is a file in the
 * user's store, so a process running as the user could rewrite it. The gate
 * makes review the default path and the API token insufficient; it is not a
 * sandbox.
 *
 * @module custom-tools/store
 */

import fs from 'node:fs';
import path from 'node:path';
import { aicoHome } from '../home.js';
import { projectTrustStatus } from '../workspace-trust.js';
import { validateDefinition, type CustomToolDef } from './format.js';
import { TOOL_FILE_SUFFIX, projectToolsDir, toolFilesIn } from './files.js';
import { contentHash } from './runner.js';

export { TOOL_FILE_SUFFIX, toolFilesIn } from './files.js';

export type ToolScopeKind = 'user' | 'project';
export type ToolStatus = 'enabled' | 'draft' | 'changed' | 'disabled' | 'invalid' | 'untrusted';

export interface LoadedTool {
  name: string;
  pack: string;
  scope: ToolScopeKind;
  file: string;
  sha256: string;
  def?: CustomToolDef;
  errors: string[];
  warnings: string[];
  status: ToolStatus;
  /** Why it is not callable, in words a person can act on. */
  reason?: string;
}

export function userToolsDir(): string {
  return path.join(aicoHome(), 'tools');
}

// ── the enable record ────────────────────────────────────────────────

interface StateFile {
  /** User tools a person enabled, by file key → the sha256 they enabled. */
  enabled: Record<string, string>;
  /** Project tools a person switched off, by file key. */
  disabled: string[];
}

function statePath(): string {
  return path.join(aicoHome(), 'custom-tools.json');
}

function key(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function readState(): StateFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), 'utf8')) as Partial<StateFile>;
    return { enabled: parsed.enabled && typeof parsed.enabled === 'object' ? parsed.enabled : {}, disabled: Array.isArray(parsed.disabled) ? parsed.disabled : [] };
  } catch { return { enabled: {}, disabled: [] }; /* no record: nothing enabled, the safe reading */ }
}

function writeState(state: StateFile): void {
  fs.mkdirSync(path.dirname(statePath()), { recursive: true });
  const tmp = `${statePath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, statePath());
}

/**
 * Record a person's decision. Callers must have proved a person for `true`
 * (decision gate, TTY): this is the write that makes a draft callable.
 */
export function setToolEnabled(tool: LoadedTool, enabled: boolean): void {
  const state = readState();
  const k = key(tool.file);
  if (tool.scope === 'user') {
    if (enabled) state.enabled[k] = tool.sha256;
    else delete state.enabled[k];
  } else {
    state.disabled = state.disabled.filter(d => d !== k);
    if (!enabled) state.disabled.push(k);
  }
  writeState(state);
}

/** Forget a deleted file's record. */
export function forgetTool(file: string): void {
  const state = readState();
  const k = key(file);
  delete state.enabled[k];
  state.disabled = state.disabled.filter(d => d !== k);
  writeState(state);
}

// ── loading ──────────────────────────────────────────────────────────

/** Names a custom tool may not take: every built-in, and the loop's own. */
async function reservedNames(): Promise<Set<string>> {
  const { toolDefinitions } = await import('../tools/index.js');
  return new Set([...toolDefinitions.map(d => d.name), 'Task', 'Investigate', 'LoadTools', 'ToolManage']);
}

function loadOne(file: string, pack: string, scope: ToolScopeKind, reserved: ReadonlySet<string>): LoadedTool {
  const base = path.basename(file, TOOL_FILE_SUFFIX);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
    return { name: base, pack, scope, file, sha256: '', errors: [`unreadable: ${(err as Error).message}`], warnings: [], status: 'invalid' };
  }
  const sha256 = contentHash(text);
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (err) {
    return { name: base, pack, scope, file, sha256, errors: [`not valid JSON: ${(err as Error).message}`], warnings: [], status: 'invalid' };
  }
  const report = validateDefinition(raw, { reserved });
  const name = report.def?.name ?? (typeof (raw as { name?: unknown })?.name === 'string' ? String((raw as { name: string }).name) : base);
  const errors = [...report.errors];
  if (report.def && report.def.name !== base) errors.push(`the file is ${base}${TOOL_FILE_SUFFIX} but the tool is named "${report.def.name}" — make them match.`);
  return {
    name, pack, scope, file, sha256, errors, warnings: report.warnings,
    ...(errors.length === 0 && report.def ? { def: report.def } : {}),
    status: errors.length ? 'invalid' : 'draft',
  };
}

/**
 * Every custom tool visible from `cwd`, with whether it may be called and
 * why not. User tools first, then the project's; the first of a name wins
 * and a later one is reported as a duplicate rather than silently shadowing.
 */
export async function loadCustomTools(cwd: string = process.cwd()): Promise<LoadedTool[]> {
  const reserved = await reservedNames();
  const state = readState();
  const out: LoadedTool[] = [];
  const taken = new Map<string, LoadedTool>();

  const admit = (tool: LoadedTool): void => {
    const first = taken.get(tool.name);
    if (first) {
      tool.errors.push(`"${tool.name}" is already defined by ${first.scope === 'user' ? 'your tools' : 'this project'} (${first.file}).`);
      tool.status = 'invalid';
      delete tool.def;
    } else if (tool.status !== 'invalid') taken.set(tool.name, tool);
    out.push(tool);
  };

  for (const { pack, file } of toolFilesIn(userToolsDir())) {
    const tool = loadOne(file, pack, 'user', reserved);
    if (tool.status !== 'invalid') {
      const recorded = state.enabled[key(file)];
      if (recorded === tool.sha256) tool.status = 'enabled';
      else if (recorded) { tool.status = 'changed'; tool.reason = 'changed since it was enabled — a person re-enables it after reviewing the change'; }
      else { tool.status = 'draft'; tool.reason = 'a draft — a person enables it in Settings → Tools or with `aico tool enable`'; }
    }
    admit(tool);
  }

  const projectFiles = toolFilesIn(projectToolsDir(cwd));
  if (projectFiles.length) {
    const trust = await projectTrustStatus(cwd);
    for (const { pack, file } of projectFiles) {
      const tool = loadOne(file, pack, 'project', reserved);
      if (tool.status !== 'invalid') {
        if (trust.state !== 'trusted') { tool.status = 'untrusted'; tool.reason = 'this project\'s .aico configuration is not trusted yet — approve it once (AICO asks when you start a chat there)'; }
        else if (state.disabled.includes(key(file))) { tool.status = 'disabled'; tool.reason = 'switched off'; }
        else tool.status = 'enabled';
      }
      admit(tool);
    }
  }

  // A preview must be a read tool that can run: checked across the set.
  for (const tool of out) {
    const preview = tool.def?.preview?.tool;
    if (!preview) continue;
    const target = taken.get(preview);
    if (!target?.def || target.def.effect !== 'read') {
      tool.errors.push(`preview names "${preview}", which is not a valid read-class custom tool.`);
      tool.status = 'invalid';
      delete tool.def;
    }
  }
  return out;
}

/** The ones a run may call, by name. */
export function usableTools(all: readonly LoadedTool[]): Map<string, LoadedTool & { def: CustomToolDef }> {
  const map = new Map<string, LoadedTool & { def: CustomToolDef }>();
  for (const t of all) if (t.status === 'enabled' && t.def) map.set(t.name, t as LoadedTool & { def: CustomToolDef });
  return map;
}

/** The deferred group a custom tool belongs to. */
export function groupIdOf(tool: Pick<LoadedTool, 'pack'>): string {
  return `tools:${tool.pack}`;
}
