/**
 * Moonshot AI's Kimi platform (`api.moonshot.ai`).
 *
 * Everything here was read from the platform's own documentation at
 * platform.kimi.ai/docs on 2026-09-03 — the API overview, the chat reference,
 * the model parameter reference, the thinking-model and reasoning-effort
 * guides, the context-caching guide, the pricing pages and the error table.
 * Where the code takes a position the docs do not, it says so.
 *
 * Kimi is OpenAI-compatible on the wire and could have gone through the generic
 * {@link OpenAICompatibleProvider}. Three things justify a provider of its own,
 * the same three that justified DeepSeek's:
 *
 * ## 1. Reasoning is a second channel, and it must be sent back
 *
 * Every current Kimi model reasons. The chain of thought arrives as
 * `reasoning_content`, a sibling of `content` (and of `delta.reasoning_content`
 * while streaming), which the generic shim does not know about and would throw
 * away. The docs are also explicit that "the complete assistant message —
 * including `reasoning_content` and `tool_calls` — must be passed back to
 * `messages` as-is" in multi-turn and tool-calling conversations. DeepSeek
 * scopes that to tool-calling turns; Kimi's guide says every historical
 * assistant message, so that is what is replayed here — only ever a trace this
 * provider produced, never another vendor's.
 *
 * ## 2. Reasoning is controlled two different ways, by model
 *
 *   - `kimi-k3` takes a top-level `reasoning_effort` of `low`, `high` or `max`
 *     (default `max`) and rejects a `thinking` object.
 *   - `kimi-k2.6` takes `thinking: {type: 'enabled' | 'disabled'}` and has no
 *     `reasoning_effort`.
 *   - `kimi-k2.7-code` thinks always; the only accepted value is
 *     `{type: 'enabled', keep: 'all'}`, so the field is best left unsent.
 *
 * One provider therefore chooses the shape per model id, and the ladder in
 * `shared/reasoning` only offers each model the rungs it has.
 *
 * ## 3. Cache hits are reported at the top of `usage`
 *
 * Caching is automatic — "just call the API as usual" — with no write premium,
 * and a hit is priced at a tenth to a sixth of a miss depending on the model
 * (K3: $0.30 against $3.00). The hit count arrives as `usage.cached_tokens`,
 * a top-level field rather than OpenAI's `prompt_tokens_details.cached_tokens`;
 * both are read, the documented one first.
 *
 * ## What is never sent
 *
 * `temperature`, `top_p` and `n` are fixed on every current model, and the
 * parameter reference says outright "do not pass temperature explicitly". AICO
 * never did, so this provider simply never introduces them. The output ceiling
 * is `max_completion_tokens`, which is the name the chat reference documents,
 * and the thinking guide's advice — "set max_tokens >= 16000 for complex
 * reasoning tasks", because reasoning and answer draw from the same budget — is
 * why the default is 32K rather than the generic shim's 8K.
 *
 * @module providers/kimi
 */

import OpenAI, { APIError } from 'openai';
import { normalizeUsage } from './usage.js';
import type { EffortLevel } from '../../shared/reasoning.js';
import { resolvedEffort } from '../run-context.js';
import { KIMI_DIALECT } from '../prompt/dialects.js';
import type {
  AicoMessage,
  ChatEvent,
  FinishReason,
  ProviderAPI,
  ProviderChatOptions,
  ToolDef,
} from './types.js';

/** The levels Kimi K3 accepts for `reasoning_effort`. */
export type KimiReasoningEffort = 'low' | 'high' | 'max';

/**
 * A configured reasoning depth. `off` disables thinking where a model allows
 * it (K2.6); on models that cannot stop thinking it is ignored rather than
 * sent, because sending it is a 400.
 */
export type KimiThinking = KimiReasoningEffort | 'off';

export interface KimiConfig {
  apiKey: string;
  /** Override for a proxy or the regional platform. */
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
  /**
   * Reasoning depth when the run does not choose one. Undefined means "send
   * nothing" and take the platform default (K3: `max`; K2.x: thinking on) —
   * deliberately, because quietly lowering the effort of a reasoning model is
   * the same mistake as forcing `reasoning_effort: 'none'` on one.
   */
  thinking?: KimiThinking;
  /** Output ceiling. Reasoning tokens draw from this same budget. */
  maxOutputTokens?: number;
}

/** The OpenAI-compatible root, per the API overview. */
export const KIMI_BASE_URL = 'https://api.moonshot.ai/v1';

/**
 * Default output ceiling.
 *
 * The thinking guide recommends at least 16,000 for complex reasoning because
 * "the sum of tokens in reasoning_content and content must be less than or
 * equal to max_tokens". Doubled, so a long chain of thought still leaves room
 * for the file it was thinking about writing.
 */
export const KIMI_DEFAULT_MAX_OUTPUT_TOKENS = 32_000;

/** Models the platform serves, per the model list (2026-09-03). */
export const KIMI_MODELS = [
  'kimi-k3',
  'kimi-k2.7-code',
  'kimi-k2.7-code-highspeed',
  'kimi-k2.6',
] as const;

// The id predicate lives with the other vendors' in model-vendor, where both
// selection and instance resolution can reach it without a cycle.
export { isKimiModel } from './model-vendor.js';

/** Map a Kimi `finish_reason` onto the normalized vocabulary. */
function normalizeFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop':       return 'stop';
    case 'tool_calls': return 'tool_calls';
    case 'length':     return 'length';
    default:           return 'other';
  }
}

/**
 * How reasoning is asked for, by model.
 *
 * Read from the model parameter reference: K3 has `reasoning_effort` and no
 * `thinking`; K2.6 has `thinking` with an on/off switch; K2.7 Code thinks
 * unconditionally and accepts only the one value, which sending adds nothing
 * to and getting wrong costs a request.
 */
export function reasoningShapeFor(model: string): 'effort' | 'switch' | 'fixed' {
  const id = model.toLowerCase();
  if (/^kimi-k3/.test(id)) return 'effort';
  if (/^kimi-k2\.7/.test(id)) return 'fixed';
  return 'switch';
}

/**
 * The reasoning fields for one request, or nothing.
 *
 * Exported for the tests, which assert the wire shape per model rather than
 * trusting this comment.
 */
export function reasoningFieldsFor(
  model: string,
  level: EffortLevel | KimiThinking | undefined,
): Record<string, unknown> {
  if (level === undefined) return {};
  switch (reasoningShapeFor(model)) {
    case 'effort': {
      // K3 has no off switch. `off` and the low rungs step to `low`; the
      // ladder's upper rungs map onto K3's three.
      const effort: KimiReasoningEffort =
        level === 'max' ? 'max'
          : level === 'high' || level === 'xhigh' ? 'high'
            : 'low';
      return { reasoning_effort: effort };
    }
    case 'switch':
      return { thinking: { type: level === 'off' ? 'disabled' : 'enabled' } };
    case 'fixed':
      return {};
  }
}

export class KimiProvider implements ProviderAPI {
  readonly id = 'kimi';
  readonly displayName = 'Moonshot Kimi';
  readonly promptDialect = KIMI_DIALECT;
  private readonly client: OpenAI;
  private readonly thinking: KimiThinking | undefined;
  private readonly maxOutputTokens: number;
  // Once a 400 proves this deployment rejects stream_options, stop sending it
  // for the life of the provider rather than repeating the failure per call.
  private streamUsageDisabled = false;

  constructor(config: KimiConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL ?? KIMI_BASE_URL,
      ...(config.defaultHeaders ? { defaultHeaders: config.defaultHeaders } : {}),
    });
    this.thinking = config.thinking;
    this.maxOutputTokens = config.maxOutputTokens ?? KIMI_DEFAULT_MAX_OUTPUT_TOKENS;
  }

  async *chat(opts: ProviderChatOptions): AsyncGenerator<ChatEvent> {
    const messages = toKimiMessages(opts.messages, opts.systemPrompt, opts.volatileContext);
    const tools = toKimiTools(opts.tools);
    const tcBuilders = new Map<number, { id: string; name: string; args: string }>();

    const buildBody = (includeStreamUsage: boolean) => ({
      model: opts.model,
      messages,
      ...(tools.length > 0 ? { tools } : {}),
      stream: true as const,
      ...(includeStreamUsage ? { stream_options: { include_usage: true } } : {}),
      max_completion_tokens: opts.maxTokens ?? this.maxOutputTokens,
      // The run's choice first, then the configured one, then nothing — which
      // takes the platform default. `resolvedEffort` has already stepped the
      // choice onto a rung this model has (see the table in shared/reasoning).
      ...reasoningFieldsFor(opts.model, resolvedEffort(opts.model) ?? this.thinking),
    });

    const wantStreamUsage = !this.streamUsageDisabled;
    let stream: AsyncIterable<KimiChunk>;
    try {
      stream = (await this.client.chat.completions.create(
        buildBody(wantStreamUsage) as never,
        { signal: opts.signal },
      )) as unknown as AsyncIterable<KimiChunk>;
    } catch (err) {
      if (wantStreamUsage && isStreamOptionsError(err)) {
        this.streamUsageDisabled = true;
        try {
          stream = (await this.client.chat.completions.create(
            buildBody(false) as never,
            { signal: opts.signal },
          )) as unknown as AsyncIterable<KimiChunk>;
        } catch (err2) {
          throw normalizeKimiError(err2);
        }
      } else {
        throw normalizeKimiError(err);
      }
    }

    let finalUsage: ReturnType<typeof normalizeUsage> | undefined;
    for await (const chunk of stream) {
      // Held rather than emitted — reported once, after the loop, however
      // many chunks carry it (see providers/openai.ts for the reason).
      if (chunk.usage) {
        // `cached_tokens` is a top-level field in Kimi's usage object per the
        // chat reference; the OpenAI-shaped nested one is read as a fallback
        // in case the platform moves it. Both are subsets of prompt_tokens,
        // so this is the `inclusive` convention. No write premium exists.
        finalUsage = normalizeUsage({
          reportedInput: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
          cacheReadTokens: chunk.usage.cached_tokens
            ?? chunk.usage.prompt_tokens_details?.cached_tokens,
          convention: 'inclusive',
        });
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;

      // Reasoning rides its own delta field, ahead of content.
      const reasoning = choice.delta?.reasoning_content;
      if (reasoning) yield { type: 'reasoning', delta: reasoning };

      const text = choice.delta?.content;
      if (text) yield { type: 'text', content: text };

      for (const tc of choice.delta?.tool_calls ?? []) {
        if (!tcBuilders.has(tc.index)) {
          tcBuilders.set(tc.index, { id: '', name: '', args: '' });
        }
        const b = tcBuilders.get(tc.index)!;
        if (tc.id)                  b.id    = tc.id;
        if (tc.function?.name)      b.name += tc.function.name;
        if (tc.function?.arguments) b.args += tc.function.arguments;
      }

      if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
        for (const [, b] of tcBuilders) {
          if (!b.name) continue;
          const parsed = tryParseToolArgs(b.args);
          yield {
            type: 'tool_call',
            id: b.id || `call_${b.name}`,
            name: b.name,
            input: parsed.input,
            ...(parsed.parseError ? { parseError: parsed.parseError } : {}),
          };
        }
        tcBuilders.clear();
      }

      if (choice.finish_reason) {
        yield { type: 'finish', reason: normalizeFinishReason(choice.finish_reason) };
      }
    }

    if (finalUsage) {
      yield {
        type: 'usage',
        inputTokens: finalUsage.inputTokens,
        outputTokens: finalUsage.outputTokens,
        ...(finalUsage.cacheReadTokens ? { cacheReadTokens: finalUsage.cacheReadTokens } : {}),
      };
    }
  }
}

// ── Message conversion ───────────────────────────────────────────────

/** An assistant message on the wire, carrying its reasoning back. */
interface KimiAssistantMessage {
  role: 'assistant';
  content: string | null;
  reasoning_content?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

/** A user turn's content: a string until an image joins it. */
type OpenAiStyleContent =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;

type KimiMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: OpenAiStyleContent }
  | KimiAssistantMessage
  | { role: 'tool'; tool_call_id: string; content: string };

/**
 * Project provider-agnostic messages onto Kimi's wire format.
 *
 * `reasoning_content` is replayed on **every** assistant turn whose trace this
 * provider produced. That follows the thinking guide's instruction to "append
 * the complete assistant message — including reasoning_content — back to
 * messages as-is", and the chat reference's "always preserve the
 * reasoning_content of each historical assistant message". K2.6 with the
 * default `keep: null` ignores historical reasoning, so on that model the
 * replay costs input tokens for no behavioural gain; the docs still ask for
 * it, the cache bills a repeated prefix at a fraction of the miss rate, and
 * the alternative — a per-model rule about what the platform will silently
 * drop — is exactly the kind of undocumented leniency that changes without
 * notice.
 *
 * A trace from another provider is never forwarded: a session that switched
 * models mid-way degrades to "no trace" rather than handing Kimi a payload it
 * would try to parse.
 */
export function toKimiMessages(
  messages: AicoMessage[],
  systemPrompt: string,
  volatileContext?: string,
): KimiMessage[] {
  const result: KimiMessage[] = [{ role: 'system', content: systemPrompt }];

  for (const msg of messages) {
    if (msg.role === 'user') {
      // Kimi's vision guide uses the OpenAI content-part shape, with base64
      // data URLs accepted directly.
      result.push(msg.images?.length
        ? {
          role: 'user',
          content: [
            ...msg.content ? [{ type: 'text' as const, text: msg.content }] : [],
            ...msg.images.map(image => ({
              type: 'image_url' as const,
              image_url: { url: `data:${image.mediaType};base64,${image.data}` },
            })),
          ],
        }
        : { role: 'user', content: msg.content });
      continue;
    }

    if (msg.role === 'tool') {
      result.push({ role: 'tool', tool_call_id: msg.toolCallId, content: msg.content });
      continue;
    }

    const toolCalls = msg.toolCalls ?? [];
    const assistant: KimiAssistantMessage = {
      role: 'assistant',
      content: msg.content || null,
    };
    if (toolCalls.length > 0) {
      assistant.tool_calls = toolCalls.map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.input) },
      }));
    }
    if (msg.reasoning?.provider === 'kimi' && msg.reasoning.content) {
      assistant.reasoning_content = msg.reasoning.content;
    }
    result.push(assistant);
  }

  // Tail position: the platform's cache is an automatic prefix match, and the
  // caching guide asks for stable system prompts and tool definitions up
  // front. Turn-volatile text placed any earlier would miss on every turn.
  if (volatileContext?.trim()) {
    result.push({ role: 'user', content: volatileContext });
  }

  return result;
}

export function toKimiTools(defs: ToolDef[]): Array<{
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return defs.map(d => ({
    type: 'function' as const,
    function: {
      name: d.name,
      description: d.description,
      parameters: d.inputSchema,
    },
  }));
}

// ── Loose typing for Kimi stream chunks ──────────────────────────────
// The OpenAI SDK's types know neither `reasoning_content` nor the top-level
// `cached_tokens`, so the stream is read through a permissive shape.
interface KimiChunk {
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** Documented top-level cache-hit count. */
    cached_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
}

function isStreamOptionsError(err: unknown): boolean {
  if (!(err instanceof APIError) || err.status !== 400) return false;
  const msg = (typeof err.error === 'object' && err.error !== null
    ? JSON.stringify(err.error)
    : err.message
  ).toLowerCase();
  return msg.includes('stream_options') || msg.includes('stream options');
}

/**
 * Normalize SDK errors into stable aico strings carrying the HTTP status, so
 * the agent's retry classifier can tell a rate limit from a 4xx. Kimi's own
 * error types are kept in the body: `rate_limit_reached_error`,
 * `exceeded_current_quota_error` and `engine_overloaded_error` all arrive as
 * 429 and mean three different things to the person reading them.
 */
function normalizeKimiError(err: unknown): Error {
  if (err instanceof APIError) {
    const body = typeof err.error === 'object' && err.error !== null
      ? JSON.stringify(err.error)
      : err.message;
    return new Error(`[Moonshot Kimi] API error ${err.status}: ${body}`);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new Error(`[Moonshot Kimi] API error: ${msg}`);
}

/**
 * Parse accumulated tool-call arguments, reporting malformed JSON rather than
 * dispatching empty args and letting the model guess why the tool misbehaved.
 */
function tryParseToolArgs(raw: string): {
  input: Record<string, unknown>;
  parseError?: string;
} {
  if (!raw) return { input: {} };
  try {
    return { input: JSON.parse(raw) as Record<string, unknown> };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const snippet = raw.length > 120 ? raw.slice(0, 120) + '…' : raw;
    return {
      input: {},
      parseError: `Tool arguments were not valid JSON (${reason}). Raw: ${snippet}`,
    };
  }
}
