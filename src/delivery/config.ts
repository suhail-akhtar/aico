/**
 * The two commands Delivery may run besides the project's checks, and where they may
 * come from (ADR 0038): `delivery.worktreeSetup` (runs in a task's new worktree before
 * its agent starts) and `delivery.deployCommand` (runs when a person deploys a release).
 *
 * WHY NOT `loadSettings`. That function reads the project layer of `process.cwd()`;
 * Delivery serves many registered projects from one server, so it reads each project's
 * own `.aico/settings.json` / `settings.local.json` itself — and applies the same
 * rules `loadSettings` does, because these are commands:
 *
 *  - the person's own settings (`aicoHome()/settings.json`) apply at once;
 *  - a project's files apply only when workspace trust says that exact file was
 *    approved by a person (`workspace-trust`; the `delivery` section is trust-gated
 *    like `hooks`). Until then they are ignored and the reason is returned, so the
 *    board can say "approve this project's settings first" instead of silently doing
 *    nothing — and a cloned repository cannot make the board run its commands;
 *  - later layers win (user, then project, then local), as in `loadSettings`.
 *
 * What it does not do: run anything. `exec.ts` does, behind `shellDenial`.
 *
 * @module delivery/config
 */

import fs from 'node:fs';
import path from 'node:path';
import { aicoHome } from '../home.js';
import { evaluateProjectLayers, untrustedNotice } from '../workspace-trust.js';

export interface DeliveryConfig {
  deployCommand?: string;
  worktreeSetup?: string;
  /** Which layer each command came from. */
  from: { deployCommand?: 'user' | 'project'; worktreeSetup?: 'user' | 'project' };
  /** Set when the project's own settings define commands that a person has not approved yet. */
  untrusted?: string;
}

type Layer = Record<string, unknown>;

function readLayer(file: string): Layer {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Layer : {};
  } catch { return {}; }
}

function commandOf(layer: Layer, key: 'deployCommand' | 'worktreeSetup'): string | undefined {
  const d = layer.delivery;
  const v = d && typeof d === 'object' ? (d as Layer)[key] : undefined;
  return typeof v === 'string' && v.trim() && v.length <= 4000 ? v.trim() : undefined;
}

export function deliveryConfig(project: string): DeliveryConfig {
  const root = path.resolve(project);
  const user = readLayer(path.join(aicoHome(), 'settings.json'));
  const proj = readLayer(path.join(root, '.aico', 'settings.json'));
  const local = readLayer(path.join(root, '.aico', 'settings.local.json'));
  const trust = evaluateProjectLayers(root, proj, local);
  const projectLayers = trust.state === 'untrusted' ? [] : [proj, local];
  const out: DeliveryConfig = { from: {} };
  for (const key of ['deployCommand', 'worktreeSetup'] as const) {
    const fromUser = commandOf(user, key);
    if (fromUser) { out[key] = fromUser; out.from[key] = 'user'; }
    for (const layer of projectLayers) {
      const v = commandOf(layer, key);
      if (v) { out[key] = v; out.from[key] = 'project'; }
    }
  }
  if (trust.state === 'untrusted' && [proj, local].some(l => commandOf(l, 'deployCommand') || commandOf(l, 'worktreeSetup'))) {
    out.untrusted = untrustedNotice(trust);
  }
  return out;
}
