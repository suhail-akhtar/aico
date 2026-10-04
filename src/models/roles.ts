/**
 * Model roles: which model does which job, from one table and one resolver.
 *
 * Before this, nine features each picked a model their own way
 * (`sessionTitles.model`, `learning.model`, `brief.model`, `sentinel.model`,
 * `agentModels[type]`, `imageGeneration.model`, the judge default, …): no
 * place showed the person which model, provider or price each job ran on,
 * and a typo in one of them fell back silently to the work model. Worse, the
 * features that read personal data (the learner, embeddings) could be pointed
 * at any provider with nothing to say so. ADR 0017 records the design.
 *
 * Rules this module enforces, so callers cannot get them wrong:
 * - **One order.** A per-call override (agent `.md` `model:`, a CLI flag),
 *   then `models.roles[role]`, then the legacy per-feature key, then the
 *   preset, then the role's default.
 * - **A broken choice falls back with a reason, never silently**: an unknown
 *   provider, a model that cannot do the job (vision without image input, an
 *   embedder that is a chat model), are reported in `fellBack`.
 * - **Personal data never falls back to a cloud provider.** When
 *   `models.localOnlyPersonal` is on, a personal role (`background`, `embed`)
 *   that does not resolve to a local endpoint comes back `ok: false` — the
 *   feature runs without a model (deterministic) or pauses. It is never
 *   quietly re-routed to the work model's vendor.
 * - **Only the person's own settings choose.** `models` is ignored in a
 *   project's `.aico/settings.json` (enforced where layers merge): a cloned
 *   repository must not re-route the learner's or the embedder's input to a
 *   provider of its choosing, or pick a weak Sentinel.
 * - **The Sentinel and judge stay independent**: a different model from the
 *   agent's where one is reachable; the same one is allowed but reported.
 *
 * Deliberately not here: choosing models per *request* by difficulty
 * ("router" models). Measured routing needs an eval per task type; a wrong
 * guess on a hard coding step costs more than the tokens saved. Presets
 * change roles, not turns.
 */

import { CHEAP_MODELS, familyOfModel } from '../../shared/models.js';
import type { AicoSettings } from '../settings.js';
import { getModelCapabilities, modelAccepts, modelProduces } from '../model-capabilities.js';
import { listInstances, isUsable, resolveInstance, type ProviderInstance } from '../providers/instances.js';
import { costFor, createTokenTracker } from '../tokens.js';

export type ModelRole =
  | 'main' | 'coding' | 'explore' | 'review' | 'background'
  | 'sentinel' | 'judge' | 'vision' | 'image' | 'embed' | 'compact' | 'edit';

export type RolePreset = 'balanced' | 'economy' | 'quality' | 'private';

export interface ModelsSettings {
  /** Starting point for every role not set below. Default `balanced` (today's behaviour). */
  preset?: RolePreset;
  /** Explicit model per role. Empty string or absent means "use the preset". */
  roles?: Partial<Record<ModelRole, string>>;
  /** Personal-data roles (`background`, `embed`) may only use a local endpoint. `private` preset turns it on. */
  localOnlyPersonal?: boolean;
}

export interface RoleInfo {
  role: ModelRole;
  label: string;
  /** One sentence the settings page shows. */
  does: string;
  /** Reads the person's own data (sessions, browsing, memories) beyond the current turn. */
  personal: boolean;
  /** What the model must be able to do. */
  needs: 'chat' | 'vision' | 'image-out' | 'embedding';
}

export const ROLES: readonly RoleInfo[] = [
  { role: 'main', label: 'Main', does: 'Your conversations and the agent\'s own work.', personal: false, needs: 'chat' },
  { role: 'coding', label: 'Coding helpers', does: 'Sub-agents that change code (implement, fix, refactor).', personal: false, needs: 'chat' },
  { role: 'explore', label: 'Research helpers', does: 'Read-only sub-agents that search, read and plan.', personal: false, needs: 'chat' },
  { role: 'review', label: 'Reviewers', does: 'Sub-agents that review, verify and audit work.', personal: false, needs: 'chat' },
  { role: 'background', label: 'Background', does: 'Titles, the morning brief, learning about you, memory upkeep.', personal: true, needs: 'chat' },
  { role: 'sentinel', label: 'Safety reviewer', does: 'Independently checks risky actions; can only stop them.', personal: false, needs: 'chat' },
  { role: 'judge', label: 'Judge', does: 'Grades agent certification and skill evals.', personal: false, needs: 'chat' },
  { role: 'vision', label: 'Vision', does: 'Describes images when the main model cannot see them.', personal: false, needs: 'vision' },
  { role: 'image', label: 'Image generation', does: 'Makes pictures (GenerateImage).', personal: false, needs: 'image-out' },
  { role: 'embed', label: 'Embeddings', does: 'Finds memories by meaning. Off means search by words only.', personal: true, needs: 'embedding' },
  { role: 'compact', label: 'Summaries', does: 'Summarises long conversations. Same as Main keeps the prompt cache.', personal: false, needs: 'chat' },
  // ADR 0024: "Ask AICO" on one part of a document. Main by default — the person reads every word it changes.
  { role: 'edit', label: 'Inline edits', does: 'Rewrites one selected part of a document in place (Ask AICO on a selection).', personal: false, needs: 'chat' },
];

export const ROLE_IDS = ROLES.map(r => r.role);
const INFO = new Map(ROLES.map(r => [r.role, r]));
export const roleInfo = (role: ModelRole): RoleInfo => INFO.get(role)!;

export type RoleSource = 'override' | 'role' | 'legacy' | 'preset' | 'default' | 'off';

export interface RoleResolution {
  role: ModelRole;
  /** The model to call; empty when `ok` is false or the role is off. */
  model: string;
  source: RoleSource;
  /** Provider instance id and family that would serve it. */
  instanceId?: string;
  providerType?: string;
  /** Usable as-is. False: the feature must run without a model (or pause), never substitute. */
  ok: boolean;
  /** Why the first choice was not used, or why the role is unusable. Shown in Settings and `/doctor`. */
  fellBack?: string;
  /** The model is reached on this machine (Ollama, or a loopback endpoint). */
  local: boolean;
  /**
   * Allowed but worth saying: the Sentinel or the judge is the same model as
   * the agent it checks (ADR 0017 §7). Shown beside `fellBack`, never blocks.
   */
  note?: string;
}

/** The background feature asking, so only its own legacy key counts (a `learning.model` must not rename sessions). */
export type BackgroundFeature = 'titles' | 'learning' | 'brief';

export interface ResolveOptions {
  settings: AicoSettings | undefined;
  /** The run's work model (already resolved). */
  mainModel: string;
  /** A per-call choice: agent `.md` `model:`, a CLI flag, `Task` `model`. */
  override?: string;
  /** For `explore`/`coding`/`review`: the sub-agent type, so `agentModels[type]` still counts. */
  agentType?: string;
  /** For `background`: which feature asks. Absent (the settings page) reads every background key, titles first. */
  feature?: BackgroundFeature;
  env?: Record<string, string | undefined>;
}

const LOOPBACK = /^https?:\/\/(?:localhost|127\.\d+\.\d+\.\d+|\[::1\])(?::\d+)?(?:\/|$)/i;

/**
 * Served on this machine. An Ollama instance counts only at its default
 * address or a loopback one: `ollama.baseUrl` pointed at another host is that
 * host, and was called "local" because of its type alone.
 */
function isLocalInstance(i: ProviderInstance | undefined): boolean {
  if (!i) return false;
  if (i.type === 'ollama') return !i.baseUrl || LOOPBACK.test(i.baseUrl);
  return Boolean(i.baseUrl && LOOPBACK.test(i.baseUrl));
}

/**
 * Ollama's cloud models (`gpt-oss:120b-cloud`, `qwen3-coder:480b-cloud`,
 * `…:cloud`) are called through the local daemon but run on Ollama's
 * servers, so the prompt leaves the machine. Never local, whatever serves them.
 */
const CLOUD_TAG = /(?:[-:]cloud)$/i;
export function isCloudModelTag(model: string): boolean {
  return CLOUD_TAG.test(model.trim());
}

/**
 * Roles that are not personal but read the conversation or the person's work
 * (the reviewer sees every risky call, the summariser the whole history, the
 * inline editor a document, vision the person's images). Under
 * `localOnlyPersonal` / the `private` preset they stay on this machine too:
 * a local model, else the main model if it is local, else none — the feature
 * then runs without it (the Sentinel hands the call to a person, vision adds
 * a note, inline edit says so). Never a cloud substitute.
 */
const KEEP_LOCAL_ROLES: ReadonlySet<ModelRole> = new Set(['sentinel', 'judge', 'edit', 'vision', 'compact']);

/** Whether the person asked for their data to stay on this machine. */
export function keepsDataLocal(settings: AicoSettings | undefined): boolean {
  const models = (settings as { models?: ModelsSettings } | undefined)?.models;
  return models?.localOnlyPersonal === true || models?.preset === 'private';
}

/**
 * Why `model` may not be used for `role` under keep-local, or undefined when
 * it may. For callers that hold a model chosen elsewhere (the Sentinel stage,
 * the judge) and must check it at the point of use.
 */
export function localOnlyRefusal(role: ModelRole, model: string, settings: AicoSettings | undefined): string | undefined {
  if (!keepsDataLocal(settings) || !(KEEP_LOCAL_ROLES.has(role) || roleInfo(role).personal)) return undefined;
  if (!model) return `no model for the ${roleInfo(role).label.toLowerCase()} is served on this machine`;
  if (isCloudModelTag(model)) return `${model} runs in the cloud, and your data is set to stay on this machine`;
  const instances = settings ? listInstances(settings).filter(isUsable) : [];
  const found = settings ? (localHome(model, instances) ?? resolveInstance(settings, { model })) : undefined;
  const stray = Boolean(found && found.type === 'ollama' && familyOfModel(model) && !found.models?.includes(model));
  return !stray && isLocalInstance(found) ? undefined : `${model} is not served on this machine, and your data is set to stay on it`;
}

/**
 * Names only a local runtime serves: an Ollama tag (`qwen3:8b`,
 * `nomic-embed-text:latest`) or a well-known local embedding family. Without
 * this, `resolveInstance` sent `nomic-embed-text:latest` to the active cloud
 * provider (OpenAI answered 404), so choosing a local embedder for privacy
 * quietly failed — found by the live Recall check.
 */
const LOCAL_ONLY_NAME = /^[\w.-]+:[\w.-]+$|^(?:nomic-embed|mxbai-embed|all-minilm|bge-|snowflake-arctic-embed)/i;

function localHome(model: string, instances: ProviderInstance[]): ProviderInstance | undefined {
  const listed = instances.find(i => i.models?.includes(model));
  if (listed) return listed;
  if (familyOfModel(model) || !LOCAL_ONLY_NAME.test(model)) return undefined;
  return instances.find(i => isLocalInstance(i));
}

/** The cheapest same-family model, routed the same way the work model is. */
export function cheapModelFor(mainModel: string, settings?: AicoSettings): string {
  const family = familyOfModel(mainModel);
  if (family && CHEAP_MODELS[family]) return CHEAP_MODELS[family]!;
  const active = settings?.activeProvider ?? settings?.provider;
  if (active && CHEAP_MODELS[active]) return CHEAP_MODELS[active]!;
  return mainModel;
}

/** The legacy per-feature key that still names a role's model, if set. */
function legacyChoice(role: ModelRole, s: AicoSettings | undefined, agentType?: string, feature?: BackgroundFeature): string | undefined {
  if (!s) return undefined;
  const pick = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  switch (role) {
    case 'background':
      // Each feature's own key only: before roles, `learning.model` never
      // named sessions, and keeping it that way is what "legacy keys keep
      // working" means.
      if (feature === 'titles') return pick(s.sessionTitles?.model);
      if (feature === 'learning') return pick(s.learning?.model);
      if (feature === 'brief') return pick(s.brief?.model);
      return pick(s.sessionTitles?.model) ?? pick(s.learning?.model) ?? pick(s.brief?.model);
    case 'sentinel': return pick(s.sentinel?.model);
    case 'image': return pick(s.imageGeneration?.model);
    case 'coding': case 'explore': case 'review':
      return (agentType ? pick(s.agentModels?.[agentType]) : undefined) ?? pick(s.agentModels?.default);
    default: return undefined;
  }
}

/** Embedding model names we know; anything else must be set explicitly with a model that says "embed". */
const EMBEDDING_NAME = /embed|bge-|e5-|gte-|minilm|nomic/i;

/** The preset's (or the role's own) default. Undefined means "off" for optional roles. */
function presetChoice(role: ModelRole, preset: RolePreset, o: ResolveOptions, hasKey: (family: string) => boolean): string | undefined {
  const main = o.mainModel;
  const cheap = cheapModelFor(main, o.settings);
  switch (role) {
    case 'main': case 'coding': return main;
    case 'compact': return main;
    case 'edit': return preset === 'economy' ? cheap : main;
    case 'explore': case 'review': return preset === 'economy' ? cheap : main;
    case 'background': return preset === 'quality' ? main : cheap;
    case 'sentinel': {
      // A different model from the agent's where one is reachable (independence).
      if (hasKey('deepseek')) return /deepseek-v4-pro$/.test(main) ? 'deepseek-v4-flash' : 'deepseek-v4-pro';
      return main;
    }
    case 'judge': return hasKey('deepseek') ? 'deepseek-v4-pro' : main;
    case 'vision': return modelAccepts(main, 'image', o.settings) ? main : undefined;
    case 'image': return undefined; // GenerateImage keeps its own backend choice (pickImageBackend).
    case 'embed': return undefined; // Off by default: words-only search, nothing sent anywhere.
  }
}

function meetsNeed(model: string, need: RoleInfo['needs'], settings: AicoSettings | undefined): string | undefined {
  switch (need) {
    case 'embedding': return EMBEDDING_NAME.test(model) ? undefined : `${model} is not an embedding model`;
    case 'vision': return modelAccepts(model, 'image', settings) ? undefined : `${model} does not accept images`;
    case 'image-out': return modelProduces(model, 'image', settings) || /image|imagen|dall-e/i.test(model) ? undefined : `${model} does not make images`;
    case 'chat': return getModelCapabilities(model, settings).chat ? undefined : `${model} cannot hold a conversation`;
  }
}

/**
 * Which model a role uses, where it is served, and whether it may be used.
 * Pure apart from reading settings and the environment it is given.
 */
export function resolveRole(role: ModelRole, o: ResolveOptions): RoleResolution {
  const info = roleInfo(role);
  const s = o.settings;
  const models = (s as { models?: ModelsSettings } | undefined)?.models;
  const preset: RolePreset = models?.preset ?? 'balanced';
  const localOnly = info.personal && (models?.localOnlyPersonal === true || preset === 'private');
  const keepLocal = !info.personal && KEEP_LOCAL_ROLES.has(role) && keepsDataLocal(s);
  const env = o.env ?? process.env;
  const instances = s ? listInstances(s).filter(isUsable) : [];
  const hasKey = (family: string): boolean =>
    instances.some(i => i.type === family || i.type === 'openrouter')
    || Boolean(family === 'deepseek' && (env.DEEPSEEK_API_KEY || env.OPENROUTER_API_KEY));

  const explicit = models?.roles?.[role]?.trim();
  const candidates: Array<{ model: string | undefined; source: RoleSource }> = [
    { model: o.override?.trim() || undefined, source: 'override' },
    { model: explicit || undefined, source: 'role' },
    { model: legacyChoice(role, s, o.agentType, o.feature), source: 'legacy' },
    { model: role === 'main' ? o.mainModel : presetChoice(role, preset, o, hasKey), source: role === 'main' ? 'default' : 'preset' },
  ];

  const reasons: string[] = [];
  for (const c of candidates) {
    if (!c.model) continue;
    const unmet = meetsNeed(c.model, info.needs, s);
    if (unmet) { reasons.push(`${c.source} choice skipped: ${unmet}`); continue; }
    const found = s ? (localHome(c.model, instances) ?? resolveInstance(s, { model: c.model })) : undefined;
    // `resolveInstance` falls back to the first usable instance, and Ollama is
    // always usable (keyless). A vendor's model (deepseek-v4-flash, claude-…)
    // is not served by a local Ollama unless it lists it: treating that
    // fallback as a match sent a cloud model name to a local endpoint and
    // called it "local". Found by CI, which has no cloud keys. Such a choice
    // is kept (it fails at call time, as before) but is never local.
    const strayLocal = Boolean(found && found.type === 'ollama' && familyOfModel(c.model) && !found.models?.includes(c.model));
    const inst = strayLocal ? undefined : found;
    if (s && !found) { reasons.push(`${c.source} choice skipped: no configured provider can serve ${c.model}`); continue; }
    const local = isLocalInstance(inst) && !isCloudModelTag(c.model);
    if (keepLocal && !local) {
      reasons.push(`${c.source} choice skipped: ${c.model} is not served on this machine (your data is set to stay on it)`);
      continue;
    }
    if (localOnly && !local) {
      // Never re-route personal data: stop here rather than try a cloud default.
      return {
        role, model: '', source: c.source, ok: false, local: false,
        ...(inst ? { instanceId: inst.id, providerType: inst.type } : {}),
        fellBack: `${info.label} reads your own data and is set to stay on this machine, but ${c.model} is served by ${inst?.name ?? 'a cloud provider'}. Choose a local (Ollama) model for it, or turn off "Keep personal data on this machine".`,
      };
    }
    const sameAsAgent = (role === 'sentinel' || role === 'judge') && c.model === o.mainModel;
    return {
      role, model: c.model, source: c.source, ok: true, local,
      ...(inst ? { instanceId: inst.id, providerType: inst.type } : {}),
      ...(reasons.length ? { fellBack: reasons.join('; ') } : {}),
      ...(sameAsAgent ? { note: `${info.label} is the same model as the agent it checks (${c.model}), so it is not independent.` } : {}),
    };
  }
  if (keepLocal) {
    // Last resort: the main model, but only where it is itself local.
    const refusal = o.mainModel ? localOnlyRefusal(role, o.mainModel, s) : 'no main model';
    if (o.mainModel && !refusal && !meetsNeed(o.mainModel, info.needs, s)) {
      return { role, model: o.mainModel, source: 'default', ok: true, local: true, ...(reasons.length ? { fellBack: reasons.join('; ') } : {}) };
    }
    return {
      role, model: '', source: 'off', ok: false, local: false,
      fellBack: `${[...reasons, `no local model for ${info.label.toLowerCase()}; it runs without one`].join('; ')}`,
    };
  }
  const optional = role === 'vision' || role === 'image' || role === 'embed';
  return {
    role, model: '', source: 'off', ok: false, local: false,
    ...(optional && !reasons.length ? {} : { fellBack: reasons.join('; ') || 'no usable model' }),
  };
}

/** Every role at once, for the settings page and `/doctor`. */
export function resolveAllRoles(o: Omit<ResolveOptions, 'override' | 'agentType' | 'feature'>): RoleResolution[] {
  return ROLE_IDS.map(role => resolveRole(role, o));
}

/**
 * Remove model choices a project's settings file may not make (ADR 0017 §6).
 *
 * A project's `.aico/settings.json` and `settings.local.json` live in the
 * repository: the agent can write them, and a cloned repository brings its
 * own. So `models` is dropped from those layers, and so are the legacy keys
 * that pick the personal (background) role's model — otherwise the old key
 * would be the way round the new rule. `sentinel.model` is already dropped by
 * `tightenOnlySentinel`. Mutates `layer`; returns the dotted keys it removed.
 */
export function dropProjectModelChoices(layer: Record<string, unknown>): string[] {
  const dropped: string[] = [];
  if ('models' in layer) { delete layer.models; dropped.push('models'); }
  for (const key of ['sessionTitles', 'learning', 'brief'] as const) {
    const section = layer[key];
    if (section && typeof section === 'object' && !Array.isArray(section) && 'model' in section) {
      const { model: _dropped, ...rest } = section as Record<string, unknown>;
      layer[key] = rest;
      dropped.push(`${key}.model`);
    }
  }
  return dropped;
}

/**
 * Which role a sub-agent type runs as. Read-only researchers are `explore`,
 * checkers are `review`, and everything that may change code is `coding`, so
 * an unknown type gets the main model rather than a cheap one.
 */
export function roleForAgentType(type: string | undefined): 'explore' | 'review' | 'coding' {
  const t = (type ?? '').trim().toLowerCase();
  if (/^(explore|plan|architect|investigate|investigator|research|researcher)$/.test(t)) return 'explore';
  if (/^(review|reviewer|verification|verifier|security-audit|devsecops|test-author)$/.test(t)) return 'review';
  return 'coding';
}

/**
 * The model a background feature should call, or `undefined` when it must run
 * without one (a personal role kept local with no local model, or nothing
 * usable at all). Never a substitute: the caller skips the model call.
 */
export function backgroundModel(settings: AicoSettings | undefined, workModel: string, feature: BackgroundFeature): string | undefined {
  const r = resolveRole('background', { settings, mainModel: workModel, feature });
  return r.ok && r.model ? r.model : undefined;
}

/*
  Spend per role, since this process started.

  In memory on purpose. The session log already records each turn's usage,
  and a persistent per-role ledger would be a new log format (an ADR of its
  own). What the settings page needs is "what did the Sentinel, the titles,
  the vision fallback cost today", which this answers until a restart.
*/
const spent = new Map<ModelRole, { usd: number; calls: number }>();

/** Record one call's cost against a role. Non-finite or negative amounts are ignored. */
export function recordRoleSpend(role: ModelRole, usd: number): void {
  if (!Number.isFinite(usd) || usd < 0) return;
  const cur = spent.get(role) ?? { usd: 0, calls: 0 };
  spent.set(role, { usd: cur.usd + usd, calls: cur.calls + 1 });
}

export function roleSpend(): Partial<Record<ModelRole, { usd: number; calls: number }>> {
  return Object.fromEntries(spent);
}

/** For the tests. */
export function resetRoleSpend(): void { spent.clear(); }

/** A role's price per million tokens, for the settings page. `known: false` means the default guess. */
export function rolePrice(model: string, settings: AicoSettings | undefined): { input: number; output: number; known: boolean } {
  return {
    input: costFor(model, { inputTokens: 1_000_000 }, settings),
    output: costFor(model, { outputTokens: 1_000_000 }, settings),
    known: !createTokenTracker().isEstimated(model, settings),
  };
}
