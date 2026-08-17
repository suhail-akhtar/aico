/**
 * Settings, described as data.
 *
 * Every row on the settings screen is a record in this file rather than a piece
 * of hand-written JSX. That is not tidiness for its own sake — it is what makes
 * three things possible at once and for free:
 *
 *   - **Search.** A settings screen with five panes hides things. Because the
 *     rows are data, a query can be matched against every label, hint and key
 *     in the product and the matching rows shown together, with no per-pane
 *     search code and nothing to forget to wire up when a setting is added.
 *   - **Diffing.** Knowing the key, the type and the default for every field
 *     means "what have I changed?" is computable, so the screen can show a
 *     change count and offer to put it back rather than asking the user to
 *     remember what the box said when they opened it.
 *   - **One renderer.** Adding a setting is adding a record. There is no second
 *     place to update, so the screen cannot drift out of step with the engine.
 *
 * Nothing here ever touches a secret. `SECRET_ROOTS` is enforced by
 * {@link assertNoSecrets}, which runs at module load: settings arrive at the
 * client redacted, so a field bound to a key under one of those roots would
 * write the redacted form back and destroy a working API key. Provider
 * credentials have their own screen, their own write-only endpoint, and no
 * representation here at all.
 *
 * @module settings-schema
 */

/** Top-level settings keys this screen must never read back or write. */
export const SECRET_ROOTS = ['providers', 'providerInstances', 'env', 'mcpServers', 'hooks'] as const;

export type FieldKind = 'segmented' | 'select' | 'toggle' | 'number' | 'text';

export interface FieldOption {
  value: string;
  label: string;
  /** Shown under the label on segmented cards, where there is room to explain. */
  hint?: string;
  icon?: IconName;
}

export interface Field {
  /** Dotted path into the settings document, e.g. `sandbox.mode`. */
  path: string;
  label: string;
  /** One line, under the label. Says what the setting *does*, not what it is. */
  hint?: string;
  kind: FieldKind;
  options?: FieldOption[];
  min?: number;
  max?: number;
  step?: number;
  /** Rendered inside the number input's trailing slot: `s`, `%`, `USD`. */
  unit?: string;
  placeholder?: string;
  /**
   * What the engine does when this is unset. Shown as the resting state of the
   * control, so an untouched setting reads as "the default" rather than as a
   * value someone chose.
   */
  fallback?: string | number | boolean;
  /** Extra words a search should match — synonyms the label does not contain. */
  keywords?: string;
}

export interface Group {
  title: string;
  hint?: string;
  fields: Field[];
}

export type IconName =
  | 'sliders' | 'stack' | 'shield' | 'gauge' | 'wallet'
  | 'sun' | 'moon' | 'monitor' | 'lock' | 'pencil' | 'globe';

export interface Pane {
  id: string;
  label: string;
  icon: IconName;
  blurb?: string;
  groups: Group[];
  /** Panes that render their own thing rather than a list of fields. */
  custom?: 'models';
}

/* ── The schema ───────────────────────────────────────────────────── */

export const PANES: Pane[] = [
  {
    id: 'general',
    label: 'General',
    icon: 'sliders',
    groups: [
      {
        title: 'Appearance',
        fields: [
          {
            path: 'theme',
            label: 'Theme',
            hint: 'Applies to this browser and to the terminal client.',
            kind: 'segmented',
            fallback: 'auto',
            keywords: 'dark light colour color appearance',
            options: [
              { value: 'light', label: 'Light', icon: 'sun' },
              { value: 'dark', label: 'Dark', icon: 'moon' },
              { value: 'auto', label: 'System', icon: 'monitor' },
            ],
          },
        ],
      },
      {
        title: 'Session naming',
        hint: 'Names are written by a small model on the first exchange, and stop changing the moment you rename one yourself.',
        fields: [
          {
            path: 'sessionTitles.enabled',
            label: 'Name sessions automatically',
            hint: 'Off keeps the first line of your prompt as the name and makes no model call.',
            kind: 'toggle',
            fallback: true,
            keywords: 'title rename sidebar',
          },
          {
            path: 'sessionTitles.model',
            label: 'Naming model',
            hint: 'Defaults to the cheapest model in the same family as your provider.',
            kind: 'text',
            placeholder: 'same family, cheapest',
          },
        ],
      },
      {
        title: 'Workspace',
        hint: 'Where AICO writes artifacts, reports and scratch files that are not part of your project.',
        fields: [
          {
            path: 'workspace.path',
            label: 'Workspace path',
            hint: 'Absolute, or relative to the project. Blank uses ~/.aico/workspace.',
            kind: 'text',
            placeholder: '~/.aico/workspace',
            keywords: 'folder directory artifacts scratch output',
          },
        ],
      },
    ],
  },

  {
    id: 'models',
    label: 'Models',
    icon: 'stack',
    blurb: 'Providers you have configured, and which one turns run on. Any OpenAI-compatible endpoint works.',
    custom: 'models',
    groups: [],
  },

  {
    id: 'agent',
    label: 'Agent',
    icon: 'shield',
    blurb: 'What the agent is allowed to do, and how hard it tries before it stops.',
    groups: [
      {
        title: 'Permission',
        hint: 'Governs AICO’s own file tools completely, and processes it spawns not at all — a shell command can still write anywhere you can. Defence in depth, not a jail.',
        fields: [
          {
            path: 'sandbox.mode',
            label: 'File access',
            kind: 'segmented',
            fallback: 'danger-full-access',
            keywords: 'sandbox permission write read only safety',
            options: [
              {
                value: 'read-only',
                label: 'Read only',
                hint: 'Refuse every write.',
                icon: 'lock',
              },
              {
                value: 'workspace-write',
                label: 'Workspace write',
                hint: 'Writes confined to the workspace and temp.',
                icon: 'pencil',
              },
              {
                value: 'danger-full-access',
                label: 'Full access',
                hint: 'No confinement at all.',
                icon: 'globe',
              },
            ],
          },
          {
            path: 'autoApprove',
            label: 'Approve tool calls automatically',
            hint: 'Off stops the turn to ask before anything that writes or runs.',
            kind: 'toggle',
            fallback: false,
            keywords: 'confirm prompt ask permission',
          },
        ],
      },
      {
        title: 'Persistence',
        fields: [
          {
            path: 'maxIterations',
            label: 'Tool-calling ceiling',
            hint: 'Hard cap on steps in one turn. A safety net against a model that loops.',
            kind: 'number',
            fallback: 100,
            min: 1,
            max: 1000,
            unit: 'steps',
            keywords: 'iterations loop limit',
          },
          {
            path: 'maxParallelToolCalls',
            label: 'Parallel tool calls',
            hint: '1 is fully serial. Writes and shell commands always run alone regardless.',
            kind: 'number',
            fallback: 8,
            min: 1,
            max: 32,
            keywords: 'concurrency parallel',
          },
          {
            path: 'completionGate.enabled',
            label: 'Check for unfinished work before stopping',
            hint: 'Nudges the model to continue when it stops with open todos.',
            kind: 'toggle',
            fallback: true,
            keywords: 'todo done finish gate',
          },
          {
            path: 'repeatGuard.enabled',
            label: 'Warn on repeated tool calls',
            hint: 'Injects an escalating reminder when the same call is made verbatim. Never blocks.',
            kind: 'toggle',
            fallback: true,
            keywords: 'loop repeat stuck',
          },
        ],
      },
    ],
  },

  {
    id: 'context',
    label: 'Context',
    icon: 'gauge',
    blurb: 'How much conversation the model carries, and what happens when it runs out of room.',
    groups: [
      {
        title: 'Compaction',
        hint: 'Older turns are summarised before the context window fills, so a long session keeps going instead of failing on the next message.',
        fields: [
          {
            path: 'autoCompact.enabled',
            label: 'Compact automatically',
            kind: 'toggle',
            fallback: true,
            keywords: 'summarise summarize context window',
          },
          {
            path: 'autoCompact.thresholdPercent',
            label: 'Compact at',
            hint: 'Share of the model’s own context window. Adapts to each model rather than being a fixed token count.',
            kind: 'number',
            fallback: 75,
            min: 10,
            max: 95,
            unit: '%',
          },
          {
            path: 'autoCompact.keepRecentTurns',
            label: 'Turns kept verbatim',
            hint: 'The most recent exchanges survive compaction untouched.',
            kind: 'number',
            fallback: 4,
            min: 1,
            max: 40,
            unit: 'turns',
          },
        ],
      },
      {
        title: 'Caching',
        fields: [
          {
            path: 'promptCaching.enabled',
            label: 'Cache the system prompt and tool definitions',
            hint: 'The largest static part of every request. Roughly 90% off repeat input tokens where the provider supports it.',
            kind: 'toggle',
            fallback: true,
            keywords: 'prompt cache cost savings',
          },
        ],
      },
    ],
  },

  {
    id: 'limits',
    label: 'Limits',
    icon: 'wallet',
    blurb: 'Ceilings that stop a run before it costs more than you meant to spend.',
    groups: [
      {
        title: 'Spend',
        hint: 'Cumulative across the session, checked before every model call, so a breach stops the turn rather than reporting it afterwards. Both are off unless set — no default can be guessed honestly.',
        fields: [
          {
            path: 'safetyLimits.maxCostPerSession',
            label: 'Cost ceiling',
            hint: 'A reasonable starting point for interactive work is 5–10. Raise it rather than removing it.',
            kind: 'number',
            min: 0,
            step: 0.5,
            unit: 'USD',
            placeholder: 'no ceiling',
            keywords: 'budget money spend dollars',
          },
          {
            path: 'safetyLimits.maxTokensPerSession',
            label: 'Token ceiling',
            hint: 'Input and output together.',
            kind: 'number',
            min: 0,
            step: 10000,
            unit: 'tokens',
            placeholder: 'no ceiling',
            keywords: 'budget tokens',
          },
        ],
      },
      {
        title: 'Timeouts',
        fields: [
          {
            path: 'bashTimeout',
            label: 'Shell command timeout',
            hint: '0 waits forever. A command that overruns is killed along with everything it started.',
            kind: 'number',
            fallback: 120,
            min: 0,
            unit: 's',
            keywords: 'bash terminal kill hang',
          },
          {
            path: 'agentTimeout',
            label: 'Turn timeout',
            hint: '0 lets a turn finish naturally, however long it takes.',
            kind: 'number',
            fallback: 0,
            min: 0,
            unit: 'ms',
            keywords: 'deadline hang stuck',
          },
        ],
      },
    ],
  },
];

/* ── Reading and writing paths ────────────────────────────────────── */

/** Value at a dotted path, or undefined. */
export function readPath(settings: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = settings;
  for (const key of path.split('.')) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/**
 * The patch that sets one path to one value.
 *
 * Returns a *whole top-level key*, because that is the granularity the server
 * writes at: `saveUserSetting` replaces `settings[key]` outright. Sending only
 * the leaf would blank every sibling under the same root — setting a compaction
 * threshold would silently turn compaction itself off.
 *
 * `undefined` removes the leaf rather than storing a null, so "unset" and
 * "explicitly nothing" stay the same state on disk as they are on screen.
 */
export function patchFor(
  settings: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const [root, ...rest] = path.split('.');
  if (!root) throw new Error('empty settings path');
  assertWritable(root);

  if (rest.length === 0) {
    return { [root]: value };
  }

  const existing = settings[root];
  const base: Record<string, unknown> =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};

  let cursor = base;
  for (const key of rest.slice(0, -1)) {
    const inner = cursor[key];
    const next: Record<string, unknown> =
      inner && typeof inner === 'object' && !Array.isArray(inner)
        ? { ...(inner as Record<string, unknown>) }
        : {};
    cursor[key] = next;
    cursor = next;
  }

  const leaf = rest[rest.length - 1]!;
  if (value === undefined) delete cursor[leaf];
  else cursor[leaf] = value;

  return { [root]: base };
}

function assertWritable(root: string): void {
  if ((SECRET_ROOTS as readonly string[]).includes(root)) {
    throw new Error(`refusing to write "${root}" from the settings screen: it holds credentials`);
  }
}

/* ── Search ───────────────────────────────────────────────────────── */

export interface Hit {
  pane: Pane;
  group: Group;
  field: Field;
}

/**
 * Every field matching a query, across every pane.
 *
 * Matches the label, the hint, the key itself and any extra keywords, so
 * someone who knows the setting as `autoCompact` finds it, and so does someone
 * who only remembers it was about running out of room.
 */
export function searchFields(query: string, panes: Pane[] = PANES): Hit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const terms = needle.split(/\s+/);

  const hits: Hit[] = [];
  for (const pane of panes) {
    for (const group of pane.groups) {
      for (const field of group.fields) {
        const haystack = [
          field.label, field.hint ?? '', field.path, field.keywords ?? '',
          group.title, group.hint ?? '', pane.label, pane.blurb ?? '',
          ...(field.options ?? []).flatMap(o => [o.label, o.hint ?? '']),
        ].join(' ').toLowerCase();
        if (terms.every(term => haystack.includes(term))) hits.push({ pane, group, field });
      }
    }
  }
  return hits;
}

/* ── Change tracking ──────────────────────────────────────────────── */

/**
 * Paths whose stored value differs from what the engine would do unset.
 *
 * A field left alone reads as its fallback, so it is not "changed"; a field set
 * to exactly its fallback is stored, and is. That distinction is why the count
 * is computed from the document rather than from what the controls have been
 * touched — reopening the screen must produce the same answer as leaving it
 * open did.
 */
export function changedPaths(settings: Record<string, unknown>, panes: Pane[] = PANES): string[] {
  const changed: string[] = [];
  for (const pane of panes) {
    for (const group of pane.groups) {
      for (const field of group.fields) {
        const value = readPath(settings, field.path);
        if (value === undefined || value === '') continue;
        if (field.fallback !== undefined && value === field.fallback) continue;
        changed.push(field.path);
      }
    }
  }
  return changed;
}

/** Every field in the schema, flattened. Used by tests and by the guard below. */
export function allFields(panes: Pane[] = PANES): Field[] {
  return panes.flatMap(pane => pane.groups.flatMap(group => group.fields));
}

/**
 * No field may be bound under a root that holds credentials.
 *
 * Runs at module load rather than in a test, because the failure it prevents is
 * silent and destructive: settings reach the client redacted, so a field bound
 * to `providers.anthropic.apiKey` would read `undefined`, write it back, and
 * delete a working key the moment anything else on the same root was saved.
 */
export function assertNoSecrets(panes: Pane[] = PANES): void {
  for (const field of allFields(panes)) {
    const root = field.path.split('.')[0]!;
    if ((SECRET_ROOTS as readonly string[]).includes(root)) {
      throw new Error(`settings schema binds "${field.path}", which is under a credential root`);
    }
  }
}

assertNoSecrets();
