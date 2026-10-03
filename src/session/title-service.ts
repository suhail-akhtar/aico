/**
 * Writing session titles into the log at the right moments.
 *
 * Separated from `title.ts` — which is pure text handling and has no idea what
 * a provider is — because naming a session involves a network call, and the
 * rules about *when* to make it are the interesting part:
 *
 *   - The fallback is written **before** the turn starts, so the sidebar has a
 *     name during the minutes the turn takes rather than after it.
 *   - The model title is requested **after** the turn ends, off the critical
 *     path. It is a nicety; a turn must never wait on it, and a failure to
 *     produce one must never surface as a failed turn.
 *   - Neither ever overwrites a user's rename.
 *
 * The naming call is deliberately cheap: one short request, no tools, a low
 * token ceiling, and the smallest model the configured provider offers. A
 * feature that costs a noticeable fraction of the work it labels is a feature
 * people turn off.
 *
 * @module session/title-service
 */

import type { Session } from './session.js';
import type { AicoSettings } from '../settings.js';
import {
  acceptsAutomaticTitle, buildTitleRequest, currentTitle,
  fallbackSessionTitle, normalizeSessionTitle, parseModelTitle,
} from './title.js';
import type { SessionTitle } from './title.js';
// The cheapest model per family lives in `shared/models` (CHEAP_MODELS) and is
// chosen by `cheapModelFor` in models/roles, so naming, the sub-agent
// recommendation and the background role never disagree about a vendor's
// small model. Matching is on the *brand* ("claude-opus-5" names no
// "anthropic"), which is what `familyOfModel` does.
import { backgroundModel, recordRoleSpend } from '../models/roles.js';

/** How long the naming call may take before it is abandoned. */
const NAMING_TIMEOUT_MS = 20_000;
/**
 * Output budget for the naming call.
 *
 * Generous for six words on purpose. Reasoning tokens are drawn from the same
 * budget as visible output, so a tight cap on a thinking model is spent
 * entirely on thinking and returns an empty string — which is precisely what
 * happened at 64: the model reasoned about the title, ran out, and said
 * nothing. Thinking is disabled below as the real fix; this is the backstop for
 * a model that reasons anyway.
 */
const NAMING_MAX_TOKENS = 512;

/**
 * Give a session its immediate, deterministic name.
 *
 * Called on the first submit. Returns the title written, or undefined when the
 * session already has one that outranks a fallback.
 */
export function writeFallbackTitle(session: Session, firstMessage: string): SessionTitle | undefined {
  if (!acceptsAutomaticTitle(session, 'fallback')) return undefined;
  if (currentTitle(session)) return undefined;

  const title = fallbackSessionTitle(firstMessage);
  if (!title) return undefined;

  const record: SessionTitle = { title, source: 'fallback' };
  session.append('session/title', record);
  return record;
}

/** Record an explicit rename. This pins the name — automatic naming stops. */
export function writeUserTitle(session: Session, title: string): SessionTitle | undefined {
  const clean = normalizeSessionTitle(title);
  if (!clean) return undefined;
  const record: SessionTitle = { title: clean, source: 'user' };
  session.append('session/title', record);
  return record;
}

export interface NamingOptions {
  settings: AicoSettings;
  /** The model the turn ran on, used to pick a same-family naming model. */
  workModel: string;
  signal?: AbortSignal;
}

/**
 * Ask a model to name the session, and log the result.
 *
 * Every failure path returns undefined rather than throwing. This runs after a
 * turn the user already considers finished, so there is no one to report an
 * error to and nothing useful they could do about it — the session keeps the
 * fallback name, which was always good enough.
 */
export async function generateModelTitle(
  session: Session,
  firstMessage: string,
  firstReply: string,
  opts: NamingOptions,
): Promise<SessionTitle | undefined> {
  if (!acceptsAutomaticTitle(session, 'model')) return skip('the current title outranks a model one');
  if (opts.settings.sessionTitles?.enabled === false) return skip('naming is disabled in settings');

  const timeout = AbortSignal.timeout(NAMING_TIMEOUT_MS);
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, timeout])
    : timeout;

  try {
    // Imported here rather than at module scope: the provider registry pulls in
    // every adapter, and a title is not a reason for the CLI to load all of
    // them before it has been asked to name anything.
    const { selectProvider } = await import('../providers/index.js');
    const namingModel = pickNamingModel(opts.settings, opts.workModel);
    if (!namingModel) return skip('no background model may be used (Settings → Models says why)');
    const provider = selectProvider(namingModel, withoutReasoning(opts.settings));

    let text = '';
    for await (const event of provider.chat({
      model: namingModel,
      // The naming request carries no AICO system prompt on purpose: it shares
      // no cache prefix with the session's own requests, and prepending several
      // thousand tokens of agent instructions to name one conversation would
      // cost more than the naming is worth.
      systemPrompt: 'You write short, concrete titles. You reply with the title and nothing else.',
      messages: [{ role: 'user', content: buildTitleRequest(firstMessage, firstReply) }],
      tools: [],
      maxTokens: NAMING_MAX_TOKENS,
      signal,
    })) {
      if (event.type === 'text') text += event.content;
      else if (event.type === 'usage') {
        const { costFor } = await import('../tokens.js');
        recordRoleSpend('background', costFor(namingModel, { inputTokens: event.inputTokens, outputTokens: event.outputTokens, cachedTokens: event.cacheReadTokens ?? 0 }, opts.settings));
      }
    }

    const title = parseModelTitle(text);
    // An empty or unusable answer leaves the fallback in place, which is a
    // perfectly good outcome — but a silent one is indistinguishable from the
    // feature not being wired up at all.
    if (!title) return skip(`the model returned nothing usable (${JSON.stringify(text.slice(0, 60))})`);
    // Re-checked after the await: the user may have renamed the session while
    // the request was in flight, and their name wins.
    if (!acceptsAutomaticTitle(session, 'model')) return skip('renamed while the request was in flight');

    const record: SessionTitle = {
      title,
      source: 'model',
      provider: provider.id,
      model: namingModel,
    };
    session.append('session/title', record);
    return record;
  } catch (err) {
    // Swallowed as an outcome — the fallback name stands and there is nobody to
    // report to — but never silently. A naming call that quietly fails forever
    // looks identical to one that was never wired up, which cost real time to
    // diagnose exactly once.
    const reason = err instanceof Error ? err.message : String(err);
    if (process.env.AICO_DEBUG) console.warn(`  ⚠ session naming failed: ${reason}`);
    return undefined;
  }
}

/**
 * The same settings, with every family's reasoning turned off.
 *
 * Naming a conversation requires no deliberation, and paying a reasoning model
 * to think about a six-word label is the opposite of what this feature is for.
 * Worse, reasoning tokens come out of the same output budget as the answer, so
 * a thinking model can spend the entire allowance reasoning and return an empty
 * string — a silent failure that looks exactly like the feature being broken.
 */
export function withoutReasoning(settings: AicoSettings): AicoSettings {
  const providers = (settings.providers ?? {}) as Record<string, Record<string, unknown>>;
  return {
    ...settings,
    providers: {
      ...providers,
      anthropic: { ...providers.anthropic, thinking: 'off' },
      deepseek: { ...providers.deepseek, thinking: 'off' },
      kimi: { ...providers.kimi, thinking: 'off' },
      openai: { ...providers.openai, reasoningEffort: 'none' },
    } as AicoSettings['providers'],
  };
}

/** Record why no title was written. Visible under AICO_DEBUG, silent otherwise. */
function skip(reason: string): undefined {
  if (process.env.AICO_DEBUG) console.warn(`  · session naming skipped: ${reason}`);
  return undefined;
}

/**
 * Which model does the naming: the `background` role (ADR 0017).
 *
 * `models.roles.background`, then `sessionTitles.model`, then the preset —
 * by default the cheapest model in the same family as the work model, so the
 * key is already configured and the request adds no new dependency. Empty
 * when the role may not be used (kept on this machine with no local model):
 * the session keeps its fallback name rather than going to another provider.
 */
export function pickNamingModel(settings: AicoSettings, workModel: string): string {
  return backgroundModel(settings, workModel, 'titles') ?? '';
}
