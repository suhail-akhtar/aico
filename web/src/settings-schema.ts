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

export type FieldKind = 'segmented' | 'select' | 'toggle' | 'number' | 'text' | 'list';

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
  /** Shown value = stored value ÷ scale; e.g. 1000 shows milliseconds as seconds. */
  scale?: number;
  /** `list` only: the items are numbers. */
  numeric?: boolean;
  /** `list` only: what the engine uses when unset, shown as the placeholder. */
  fallbackList?: Array<string | number>;
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
  | 'sun' | 'moon' | 'monitor' | 'lock' | 'pencil' | 'globe' | 'bolt' | 'users' | 'bookmark';

export interface Pane {
  id: string;
  label: string;
  icon: IconName;
  blurb?: string;
  groups: Group[];
  /** Panes that render their own thing rather than a list of fields. */
  custom?: 'models' | 'skills' | 'mcp' | 'agents' | 'memory' | 'tools' | 'learned' | 'about';
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
        title: 'Scratch workspace',
        hint: 'Where AICO writes artifacts, reports and scratch files that are not part of your project.',
        fields: [
          {
            path: 'workspace.path',
            label: 'Scratch workspace path',
            hint: 'Absolute, or relative to the project. Blank uses ~/.aico/workspace.',
            kind: 'text',
            placeholder: '~/.aico/workspace',
            keywords: 'folder directory artifacts scratch output',
          },
        ],
      },
      {
        title: 'Images',
        hint: 'How the agent draws pictures when you ask for one. It uses a provider you have already set up — no separate key.',
        fields: [
          {
            path: 'imageGeneration.provider',
            label: 'Image provider',
            hint: '“openai”, “gemini”, or a provider id from Models. Blank tries OpenAI first, then Gemini.',
            kind: 'text',
            placeholder: 'automatic',
            keywords: 'image generation picture draw dall-e gpt-image gemini imagen',
          },
          {
            path: 'imageGeneration.model',
            label: 'Image model',
            hint: 'Blank uses gpt-image-1 on OpenAI, gemini-2.5-flash-image on Gemini.',
            kind: 'text',
            placeholder: 'gpt-image-1',
            keywords: 'image generation picture model gpt-image-1-mini imagen',
          },
          {
            path: 'imageGeneration.quality',
            label: 'Image quality',
            hint: 'OpenAI gpt-image models only. Higher costs more per image.',
            kind: 'segmented',
            fallback: 'medium',
            keywords: 'image generation picture quality cost',
            options: [
              { value: 'low', label: 'Low' },
              { value: 'medium', label: 'Medium' },
              { value: 'high', label: 'High' },
            ],
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
    id: 'skills',
    label: 'Skills',
    icon: 'bolt',
    blurb: 'Procedures someone already worked out. Every one is offered to the agent by name and '
      + 'description on every turn, and the description is what decides whether it gets used.',
    custom: 'skills',
    groups: [
      {
        title: 'Where skills come from',
        fields: [
          {
            path: 'skills.dirs',
            label: 'Extra skill folders',
            hint: 'Folders searched for SKILL.md files, besides your own and the built-in ones. Comma-separated.',
            kind: 'list',
            placeholder: 'none',
            keywords: 'skills folder directory path',
          },
          {
            path: 'skills.disableBuiltins',
            label: 'Hide the built-in skills',
            hint: 'Only your own skills are offered to the agent.',
            kind: 'toggle',
            fallback: false,
            keywords: 'skills builtin disable',
          },
        ],
      },
    ],
  },
  {
    id: 'mcp',
    label: 'MCP',
    icon: 'globe',
    blurb: 'Model Context Protocol servers. Whatever tools they expose become the tools the agent has.',
    custom: 'mcp',
    groups: [],
  },
  {
    id: 'tools',
    label: 'Tools',
    icon: 'bolt',
    blurb: 'Custom tools: one command or one HTTP call, typed, with an effect class that decides when you are asked. '
      + 'The agent can draft one; only you can enable it.',
    custom: 'tools',
    groups: [],
  },
  {
    id: 'agents',
    label: 'Agents',
    icon: 'users',
    blurb: 'Specialists work can be handed to. What an agent is for decides when it gets the task, and '
      + 'the skills assigned to it are the procedures it reaches for first.',
    custom: 'agents',
    groups: [
      {
        title: 'Talking to a specialist',
        hint: 'A conversation can be addressed to one agent instead of the orchestrator. '
          + 'It then stays in that role for every turn and declines work outside it.',
        fields: [
          {
            path: 'agents.directChat',
            label: 'Let me talk to an agent directly',
            hint: 'Adds the agent picker beside the model, and @name in the composer. '
              + 'Off hides both and every session goes to the orchestrator.',
            kind: 'toggle',
            fallback: true,
            keywords: 'agent persona mention direct chat specialist role',
          },
        ],
      },
      {
        title: 'Background agents',
        hint: 'Sub-agents, background agents and Investigate workers a chat starts. '
          + 'Each one’s report comes back into the chat that started it.',
        fields: [
          {
            path: 'agents.maxConcurrent',
            label: 'Agents running at once, per chat',
            hint: 'More than this wait as queued and start when one finishes — never refused.',
            kind: 'number',
            fallback: 6,
            min: 1,
            max: 16,
            unit: 'agents',
            keywords: 'concurrency parallel limit queue sub-agent background investigate',
          },
          {
            path: 'agents.wakeOnResult',
            label: 'Read a report as soon as it arrives',
            hint: 'When a background agent finishes after the chat went quiet, start a short turn to read it. '
              + 'Off, it waits for your next message.',
            kind: 'toggle',
            fallback: true,
            keywords: 'background report back wake notify result',
          },
          {
            path: 'agents.resumeAfterRestart',
            label: 'Resume background agents after a restart',
            hint: 'Ones a restart interrupted carry on by themselves; nothing they had already started runs again.',
            kind: 'toggle',
            fallback: true,
            keywords: 'background restart resume interrupted crash',
          },
          {
            path: 'agents.resumeWithinHours',
            label: 'Only if they were active within',
            hint: 'Older interrupted agents stay interrupted until you resume them.',
            kind: 'number',
            fallback: 24,
            min: 1,
            max: 168,
            unit: 'hours',
            keywords: 'background restart resume window',
          },
        ],
      },
    ],
  },
  {
    id: 'memory',
    label: 'Memory',
    icon: 'bookmark',
    blurb: 'Facts the agent carries between turns. Scope decides how far each one travels — everywhere, '
      + 'this project, or just this conversation.',
    custom: 'memory',
    groups: [
      {
        title: 'Memory files',
        fields: [
          {
            path: 'memory.cacheTtl',
            label: 'Re-read memory files after',
            kind: 'number',
            fallback: 60,
            min: 0,
            unit: 's',
            keywords: 'memory cache',
          },
          {
            path: 'memory.maxSizePerType',
            label: 'Largest memory section',
            hint: 'Anything longer is cut, so one runaway file cannot fill the context.',
            kind: 'number',
            fallback: 50000,
            min: 1000,
            step: 1000,
            unit: 'chars',
            keywords: 'memory size limit',
          },
          {
            path: 'memory.watchFiles',
            label: 'Notice edits to memory files immediately',
            kind: 'toggle',
            fallback: true,
            keywords: 'memory watch',
          },
        ],
      },
    ],
  },
  {
    id: 'learned',
    label: 'What AICO learned',
    icon: 'bookmark',
    blurb: 'What AICO learned about how you work — rules distilled from your feedback, corrections and edits. '
      + 'Nothing is in force until you accept it.',
    custom: 'learned',
    groups: [
      {
        title: 'Learning',
        fields: [
          {
            path: 'learning.preferences',
            label: 'Learn how I work',
            hint: 'Off stops capturing signals, the small distilling call, and adding rules to requests.',
            kind: 'toggle',
            fallback: true,
            keywords: 'learn preferences feedback rules personalise personalize',
          },
          {
            path: 'learning.autoAcceptStyle',
            label: 'Auto-accept low-risk style rules',
            hint: 'Formatting-only rules (indentation, quotes, naming) go into force without a click. Anything about tools, commands or permissions still waits for you.',
            kind: 'toggle',
            fallback: false,
            keywords: 'learn preferences style auto accept',
          },
        ],
      },
    ],
  },
  {
    id: 'about',
    label: 'About you',
    icon: 'bookmark',
    blurb: 'What AICO has learned about you from your work and browsing — interests, stack, how you work. '
      + 'Every fact shows its evidence; confirm, edit, hide or forget it. Learned and kept on this computer.',
    custom: 'about',
    groups: [],
  },
  {
    id: 'agent',
    // Not "Agent": beside the "Agents" pane the two read as the same thing.
    label: 'Permissions',
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
        title: 'Safety reviewer (Sentinel)',
        hint: 'A second, cheap model reviews high-risk calls — commands that deploy, delete, send data out, buy or use a credential — and can only refuse them or ask you. About $0.001 per review; recent reviews and their cost are under Activity.',
        fields: [
          {
            path: 'sentinel.mode',
            label: 'When to review',
            kind: 'segmented',
            fallback: 'auto',
            keywords: 'sentinel safety reviewer monitor guardian classifier',
            options: [
              { value: 'auto', label: 'Automatic', hint: 'When tools run without asking (auto, unattended).', icon: 'shield' },
              { value: 'always', label: 'Always', hint: 'Also when you approve tools yourself.', icon: 'lock' },
              { value: 'off', label: 'Off', hint: 'Only the fixed rules apply.', icon: 'globe' },
            ],
          },
          {
            path: 'sentinel.model',
            label: 'Reviewer model',
            hint: 'Defaults to deepseek-v4-pro (thinking off) when a DeepSeek or OpenRouter key is set, else the chat\'s own model.',
            kind: 'text',
            placeholder: 'deepseek-v4-pro',
            keywords: 'sentinel reviewer model',
          },
          {
            path: 'sentinel.timeoutMs',
            label: 'Give up and ask you after',
            hint: 'A review that takes longer is handed to you (or refused when nobody is there) — never let through.',
            kind: 'number',
            fallback: 25000,
            scale: 1000,
            min: 1,
            max: 120,
            unit: 's',
            keywords: 'sentinel timeout',
          },
          {
            path: 'sentinel.onEscalate',
            label: 'When the safety reviewer is unsure',
            hint: 'Proceed lets the call continue and records it. A refusal still stops the call either way, '
              + 'and buying, sending, deleting and sign-ins still wait for you.',
            kind: 'segmented',
            fallback: 'ask',
            keywords: 'sentinel escalate full autonomy unattended ask proceed',
            options: [
              { value: 'ask', label: 'Ask me', hint: 'Stop and ask before the call runs.', icon: 'shield' },
              { value: 'proceed', label: 'Proceed (full autonomy)', hint: 'Continue without asking; the audit records it.', icon: 'bolt' },
            ],
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
          {
            path: 'repeatGuard.thresholds',
            label: 'Remind after this many repeats',
            hint: 'Each number is one stronger reminder.',
            kind: 'list',
            numeric: true,
            fallbackList: [3, 5, 8],
            keywords: 'loop repeat thresholds',
          },
          {
            path: 'repeatGuard.exclude',
            label: 'Tools never counted as repeats',
            hint: 'Names or patterns, comma-separated — for tools that are meant to be called the same way twice.',
            kind: 'list',
            placeholder: 'none',
            keywords: 'loop repeat exclude',
          },
        ],
      },
      {
        title: 'Tools and folders',
        fields: [
          {
            path: 'disabledTools',
            label: 'Tools the agent may not use',
            hint: 'Removed from every request, not just refused when called. Comma-separated names, e.g. WebFetch, Bash.',
            kind: 'list',
            placeholder: 'none',
            keywords: 'disable tools block',
          },
          {
            path: 'sandbox.additionalWritableRoots',
            label: 'Extra folders the agent may write to',
            hint: 'Beyond the project and the workspace. Comma-separated absolute paths.',
            kind: 'list',
            placeholder: 'none',
            keywords: 'sandbox writable folders paths',
          },
          {
            path: 'sandbox.warnOnPartial',
            label: 'Say when confinement is only partial',
            hint: 'On platforms where the sandbox cannot cover everything, the agent is told so.',
            kind: 'toggle',
            fallback: true,
            keywords: 'sandbox warning',
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
          {
            path: 'autoCompact.thresholdTokens',
            label: 'Or compact at a fixed size',
            hint: 'Used only when "Compact at" is empty. Most people want the percentage.',
            kind: 'number',
            min: 1000,
            step: 1000,
            unit: 'tokens',
            placeholder: 'use the percentage',
            keywords: 'compaction tokens threshold',
          },
        ],
      },
      {
        title: 'Long runs',
        hint: 'Inside a single long turn: older tool output is cleared behind a short note, and earlier '
          + 'steps are condensed if that is not enough — keeping your words, the plan, the todo list '
          + 'and the files touched. On by default; the defaults were chosen from live runs.',
        fields: [
          {
            path: 'contextManagement.enabled',
            label: 'Manage context during a turn',
            kind: 'toggle',
            fallback: true,
            keywords: 'mask clear tool output long run context focused',
          },
          {
            path: 'contextManagement.keepRecentSteps',
            label: 'Steps always kept in full',
            hint: 'Output the model saw this recently is never cleared, however much of it there is.',
            kind: 'number',
            fallback: 8,
            min: 1,
            max: 100,
            unit: 'steps',
            keywords: 'mask window recent',
          },
          {
            path: 'contextManagement.keepRecentToolResults',
            label: 'Results always kept in full',
            kind: 'number',
            fallback: 6,
            min: 1,
            max: 100,
            unit: 'results',
            keywords: 'mask window recent',
          },
          {
            path: 'contextManagement.midTurnCompaction',
            label: 'Condense inside a turn',
            hint: 'Only when clearing old output is not enough.',
            kind: 'toggle',
            fallback: true,
            keywords: 'compact mid turn handoff',
          },
          {
            path: 'contextManagement.modelSummary',
            label: 'Let the model write the handoff note',
            hint: 'Off uses a free heuristic summary instead of one short model call.',
            kind: 'toggle',
            fallback: true,
            keywords: 'summary handoff',
          },
          {
            path: 'contextManagement.reciteTodos',
            label: 'Repeat open todos each step',
            hint: 'Keeps what is left to do next to where the next action is chosen.',
            kind: 'toggle',
            fallback: true,
            keywords: 'todo recite',
          },
        ],
      },
      {
        title: 'Apps',
        hint: 'Single-page apps the agent builds, each with its own SQLite database, served from a '
          + 'second local port. The separate port is the security boundary — it is what keeps a '
          + 'generated page from reaching the API that runs shell commands. Applied as soon as it is saved.',
        fields: [
          {
            path: 'miniApps.enabled',
            label: 'Enable Apps',
            hint: 'Off by default: this is the one feature that opens a listening socket of its own.',
            kind: 'toggle',
            fallback: false,
            keywords: 'mini apps sqlite alpine crud plugin',
          },
          {
            path: 'miniApps.port',
            label: 'Port',
            hint: 'Leave empty and one is picked — the aico port plus one, or any free port if '
              + 'that is taken. Set one and it is used as given: if something else is already on '
              + 'it, the host says so rather than quietly moving somewhere your links do not point.',
            kind: 'number',
            min: 1024,
            max: 65535,
            keywords: 'mini apps port',
          },
          {
            path: 'miniApps.host',
            label: 'Listen on',
            hint: '127.0.0.1 keeps Apps on this machine. 0.0.0.0 shows them to your whole network — only on a network you trust.',
            kind: 'text',
            placeholder: '127.0.0.1',
            keywords: 'mini apps host network lan',
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
          {
            path: 'promptCaching.prefixTtl',
            label: 'Anthropic: keep the cached prefix for',
            hint: 'An hour costs 2× to write once instead of 1.25× every time a pause passes five minutes. '
              + 'The conversation itself always uses five minutes.',
            kind: 'select',
            fallback: '1h',
            options: [
              { value: '1h', label: 'One hour' },
              { value: '5m', label: 'Five minutes' },
            ],
            keywords: 'anthropic claude cache ttl hour',
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
          {
            path: 'safetyLimits.maxCostPerSubagent',
            label: 'Cost ceiling per sub-agent',
            hint: 'Stops one runaway helper without stopping the rest of the work.',
            kind: 'number',
            min: 0,
            step: 0.1,
            unit: 'USD',
            placeholder: 'no ceiling',
            keywords: 'budget sub-agent delegate task',
          },
          {
            path: 'safetyLimits.maxTokensPerSubagent',
            label: 'Token ceiling per sub-agent',
            kind: 'number',
            min: 0,
            step: 10000,
            unit: 'tokens',
            placeholder: 'no ceiling',
            keywords: 'budget sub-agent tokens',
          },
        ],
      },
      {
        title: 'Scheduled jobs',
        fields: [
          {
            path: 'cron.enabled',
            label: 'Run scheduled jobs',
            hint: 'Off pauses every schedule without deleting any.',
            kind: 'toggle',
            fallback: true,
            keywords: 'cron schedule jobs',
          },
          {
            path: 'cron.maxConcurrentJobs',
            label: 'Jobs at once',
            kind: 'number',
            fallback: 3,
            min: 1,
            max: 20,
            unit: 'jobs',
            keywords: 'cron concurrency',
          },
        ],
      },
      {
        title: 'Morning brief',
        hint: 'Approvals waiting, long jobs, background runs, your PRs, issues and CI (through gh), new advisories and stale branches — gathered without a model, then ranked by one cheap call. It only reads; every action is a click.',
        fields: [
          {
            path: 'brief.enabled',
            label: 'Prepare a daily brief',
            hint: 'Shown on Home, with a notification when it is ready. Monitors are switched on per project from the card.',
            kind: 'toggle',
            fallback: true,
            keywords: 'morning brief daily digest summary',
          },
          {
            path: 'brief.time',
            label: 'Time',
            hint: 'Local time, HH:MM. Missed while the computer was off? It is made when AICO next starts, within 12 hours.',
            kind: 'text',
            fallback: '08:00',
            placeholder: '08:00',
            keywords: 'morning brief schedule',
          },
          {
            path: 'brief.quietHours',
            label: 'Quiet hours',
            hint: 'HH:MM-HH:MM, or off. Monitor alerts wait until they end.',
            kind: 'text',
            fallback: '22:00-07:00',
            placeholder: '22:00-07:00',
            keywords: 'do not disturb quiet night notifications monitors',
          },
          {
            path: 'brief.useModel',
            label: 'Rank with a small model',
            hint: 'One call to the cheapest model of your provider, titles only, secrets redacted. Off: rule order and a counted summary, no call.',
            kind: 'toggle',
            fallback: true,
            keywords: 'brief cost privacy model',
          },
          {
            path: 'brief.github',
            label: 'Include GitHub',
            hint: 'Through the gh CLI and its own sign-in; AICO never holds a GitHub token.',
            kind: 'toggle',
            fallback: true,
            keywords: 'gh pull requests reviews issues actions ci',
          },
          {
            path: 'brief.advisories',
            label: 'Check dependency advisories',
            hint: 'At most once a day per project, with the ecosystem\'s own auditor (npm audit, pip-audit…).',
            kind: 'toggle',
            fallback: true,
            keywords: 'security vulnerabilities audit cve',
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
            // Stored in milliseconds, shown in seconds: beside a shell timeout in
            // seconds, typing 300 here set a 0.3-second turn limit.
            unit: 's',
            scale: 1000,
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
        if (field.fallbackList && JSON.stringify(value) === JSON.stringify(field.fallbackList)) continue;
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
