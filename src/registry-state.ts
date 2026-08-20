/**
 * Which skills, servers and agents are switched off.
 *
 * Turning something off is not the same as deleting it, and until now the only
 * way to stop a skill being offered was to delete the file. That is a bad
 * trade: the procedure took work to write, the reason for silencing it is
 * usually temporary ("not on this project"), and deletion is the one action
 * that cannot be undone.
 *
 * **Its own file rather than settings.json.** Settings merge — a global file
 * and a project file, with precedence rules — and "disabled" does not survive
 * that cleanly: disabling something globally and re-enabling it for one project
 * is a list subtraction, which merging cannot express. This is runtime state
 * about registry entries, not configuration of behaviour, and keeping the two
 * apart means neither has to grow rules for the other.
 *
 * **Disabled entries stay on disk and stay listable.** A disabled skill is
 * still shown by `list`, marked off, because a switch you cannot find is
 * indistinguishable from a bug. What changes is that it leaves the catalogue,
 * so the model is never offered it.
 *
 * @module registry-state
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

/** The registries that can have entries switched off. */
export type RegistryKind = 'skills' | 'mcp' | 'agents';

interface RegistryState {
  skills?: { disabled?: string[] };
  mcp?: { disabled?: string[] };
  agents?: { disabled?: string[] };
}

export function registryStatePath(): string {
  return path.join(os.homedir(), '.aico', 'registry-state.json');
}

function read(): RegistryState {
  try {
    return JSON.parse(fs.readFileSync(registryStatePath(), 'utf8')) as RegistryState;
  } catch {
    // Missing or corrupt means nothing is disabled, which is the safe reading:
    // a broken state file should not silently remove someone's skills.
    return {};
  }
}

function write(state: RegistryState): void {
  const file = registryStatePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
}

/** Names switched off in a registry, lowercased for comparison. */
export function disabledIn(kind: RegistryKind): Set<string> {
  return new Set((read()[kind]?.disabled ?? []).map(n => n.toLowerCase()));
}

export function isDisabled(kind: RegistryKind, name: string): boolean {
  return disabledIn(kind).has(name.trim().toLowerCase());
}

/**
 * Switch an entry on or off.
 *
 * Returns whether this actually changed anything, so a caller can say "already
 * disabled" instead of reporting a no-op as an action taken.
 */
export function setEnabled(kind: RegistryKind, name: string, enabled: boolean): boolean {
  const key = name.trim().toLowerCase();
  if (!key) return false;

  const state = read();
  const current = state[kind]?.disabled ?? [];
  const has = current.some(n => n.toLowerCase() === key);
  if (enabled === !has) return false;  // already in the requested state

  const next = enabled
    ? current.filter(n => n.toLowerCase() !== key)
    : [...current, key];

  write({ ...state, [kind]: { ...(state[kind] ?? {}), disabled: next } });
  return true;
}

/** Forget an entry's state entirely — used when it is deleted for real. */
export function forget(kind: RegistryKind, name: string): void {
  setEnabled(kind, name, true);
}
