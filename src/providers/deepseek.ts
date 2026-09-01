/**
 * DeepSeek Platform provider (`api.deepseek.com`).
 *
 * DeepSeek advertises an OpenAI-compatible wire format, and AICO could have
 * pointed the generic {@link OpenAICompatibleProvider} at it. Three differences
 * justify a dedicated provider instead.
 *
 * Everything below was verified against the live API on 2026-08-16 with
 * `deepseek-v4-flash` and `deepseek-v4-pro`. Two claims the documentation
 * supports did **not** reproduce; they are called out rather than quietly
 * dropped, because the code is shaped by them.
 *
 * ## 1. Reasoning is a second channel the shim discards
 *
 * Thinking mode is enabled by default at `high` effort, and the chain of
 * thought arrives as `reasoning_content` — a sibling of `content`, and of
 * `delta.reasoning_content` while streaming (confirmed live: the stream's delta
 * keys are `role`, `content`, `reasoning_content`). The generic shim knows
 * nothing about that field, so routing DeepSeek through it throws the model's
 * reasoning away entirely. This is the strongest reason for a dedicated
 * provider.
 *
 * **Correction.** The thinking-mode guide states that once an assistant turn
 * contains tool calls its `reasoning_content` "must participate in the context
 * concatenation ... in all subsequent user interaction turns", and that
 * omitting it "triggers a 400 error". That does **not** reproduce. Stripping
 * the trace was accepted with HTTP 200 in every configuration tested: a
 * single-round tool call, a two-round chain, a resolved chain followed by a new
 * user turn, and on `deepseek-v4-pro` as well as `-flash`.
 *
 * The replay is kept anyway, on the narrow ground that the vendor documents it
 * as required and undocumented leniency is not a contract. It is deliberately
 * cheap: scoped to tool-calling turns only, and DeepSeek's automatic caching
 * bills the repeated prefix at ~1/50th of the miss rate. What changed is the
 * justification, not the behaviour — this is prudence, not a fix for a 400 that
 * anyone has observed.
 *
 * ## 2. Cache accounting is reported twice, and priced differently
 *
 * Caching is automatic and on by default. Hits appear as
 * `usage.prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`, which partition
 * the input exactly — measured live at 5888 + 124 = 6012 = `prompt_tokens`,
 * making this the `inclusive` convention for {@link normalizeUsage}.
 *
 * **Correction.** DeepSeek *also* populates the standard
 * `prompt_tokens_details.cached_tokens`, with the identical value (5888), so
 * the generic shim would in fact have seen the hit — contrary to what an
 * earlier revision of this comment claimed. Both fields are read below, the
 * DeepSeek-specific one first, since only it is documented.
 *
 * What the shim would still have got wrong is the price: a hit costs ~1/50th of
 * a miss here, against the ~1/10th that {@link CACHE_READ_RATE_MULTIPLIER}
 * assumes, so cost estimates would overstate a well-cached session ~5x.
 *
 * ## 3. Thinking mode forbids the usual sampling knobs
 *
 * `temperature`, `top_p`, `presence_penalty` and `frequency_penalty` are
 * unsupported under thinking mode (the penalties are retired platform-wide).
 * AICO never sent them, so this provider simply never introduces them.
 *
 * @module providers/deepseek
 */

import OpenAI, { APIError } from 'openai';
import { normalizeUsage } from './usage.js';
import type { EffortLevel } from '../../shared/reasoning.js';
import { resolvedEffort } from '../run-context.js';
import { DEEPSEEK_DIALECT } from '../prompt/dialects.js';
import type {
  AicoMessage,
  ChatEvent,
  FinishReason,
  ProviderAPI,
  ProviderChatOptions,
  ToolDef,
} from './types.js';

/** Effort levels DeepSeek accepts. `medium` and `xhigh` are folded into `high`. */
export type DeepSeekReasoningEffort = 'low' | 'high' | 'max';

/** Thinking is on by default at `high`; `off` sends `{type:'disabled'}`. */
export type DeepSeekThinking = DeepSeekReasoningEffort | 'off';

export interface DeepSeekConfig {
  apiKey: string;
  /** Override for a proxy or the beta endpoint. */
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
  /**
   * Reasoning depth. Defaults to `high`, matching the platform default —
   * deliberately not lowered, because thinking is the capability being paid
   * for and quietly downgrading it is the same mistake as forcing
   * `reasoning_effort: 'none'` on a reasoning model.
   */
  thinking?: DeepSeekThinking;
  /** Output ceiling. Reasoning tokens draw from this same budget. */
  maxOutputTokens?: number;
}

/** Default endpoint. DeepSeek serves the OpenAI-format API at the bare host. */
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

/**
 * Default output ceiling.
 *
 * The platform allows up to 384K, but reasoning tokens are drawn from the same
 * budget as visible output, so this is sized for "a reasoning model needs room
 * to think AND answer" rather than for the maximum the API permits.
 */
export const DEEPSEEK_DEFAULT_MAX_OUTPUT_TOKENS = 32_000;

/** Models served by the platform. Both route to the latest snapshot. */
export const DEEPSEEK_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro'] as const;

/** Map a DeepSeek `finish_reason` onto the normalized vocabulary. */
function normalizeFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop':                 return 'stop';
    case 'tool_calls':           return 'tool_calls';
    case 'length':               return 'length';
    // `insufficient_system_resource` is DeepSeek-specific: the request was cut
    // short server-side. It is emphatically not a clean stop.
    case 'insufficient_system_resource': return 'other';
    default:                     return 'other';
  }
}

export class DeepSeekProvider implements ProviderAPI {
  readonly id = 'deepseek';
  readonly displayName = 'DeepSeek';
  // Markdown, and specifically not XML — DeepSeek writes its own tool block into
  // the system message under a Markdown heading, and reserves tag markup for
  // protocol. See DEEPSEEK_DIALECT for the argument.
  readonly promptDialect = DEEPSEEK_DIALECT;
  private readonly client: OpenAI;
  private readonly thinking: DeepSeekThinking;
  private readonly maxOutputTokens: number;
  // Once a 400 proves this deployment rejects stream_options, stop sending it
  // for the life of the provider rather than repeating the failure per call.
  private streamUsageDisabled = false;

  constructor(config: DeepSeekConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL ?? DEEPSEEK_BASE_URL,
      ...(config.defaultHeaders ? { defaultHeaders: config.defaultHeaders } : {}),
    });
    this.thinking = config.thinking ?? 'high';
    this.maxOutputTokens = config.maxOutputTokens ?? DEEPSEEK_DEFAULT_MAX_OUTPUT_TOKENS;
  }

  async *chat(opts: ProviderChatOptions): AsyncGenerator<ChatEvent> {
    const messages = toDeepSeekMessages(opts.messages, opts.systemPrompt, opts.volatileContext);
    const tools = toDeepSeekTools(opts.tools);
    const tcBuilders = new Map<number, { id: string; name: string; args: string }>();

    const buildBody = (includeStreamUsage: boolean) => ({
      model: opts.model,
      messages,
      ...(tools.length > 0 ? { tools } : {}),
      stream: true as const,
      ...(includeStreamUsage ? { stream_options: { include_usage: true } } : {}),
      max_tokens: opts.maxTokens ?? this.maxOutputTokens,
      /*
        The run's choice first, then the configured one.

        DeepSeek's platform default is `high` and it has no adaptive setting, so
        every step of a long tool loop thought as hard as the hardest one —
        including the step that reads a line of `git status`. `resolvedEffort`
        returns undefined for `auto`, which keeps exactly that behaviour for
        anyone who has not asked for anything else.
      */
      thinking: thinkingFor(resolvedEffort(opts.model) ?? this.thinking),
    });

    const wantStreamUsage = !this.streamUsageDisabled;
    let stream: AsyncIterable<DeepSeekChunk>;
    try {
      stream = (await this.client.chat.completions.create(
        buildBody(wantStreamUsage) as never,
        { signal: opts.signal },
      )) as unknown as AsyncIterable<DeepSeekChunk>;
    } catch (err) {
      if (wantStreamUsage && isStreamOptionsError(err)) {
        this.streamUsageDisabled = true;
        try {
          stream = (await this.client.chat.completions.create(
            buildBody(false) as never,
            { signal: opts.signal },
          )) as unknown as AsyncIterable<DeepSeekChunk>;
        } catch (err2) {
          throw normalizeDeepSeekError(err2);
        }
      } else {
        throw normalizeDeepSeekError(err);
      }
    }

    for await (const chunk of stream) {
      if (chunk.usage) {
        // hit + miss partition prompt_tokens (measured: 5888 + 124 = 6012), so
        // this is `inclusive` and the hit count is the cache-read subset.
        // DeepSeek charges no write premium — a miss is simply billed at the
        // normal input rate — so there is no write count to report.
        //
        // Both field names are read. The DeepSeek-specific one wins because it
        // is the documented surface, but the platform mirrors the value into
        // the standard prompt_tokens_details.cached_tokens, and preferring
        // whichever is present survives either being dropped later.
        const usage = normalizeUsage({
          reportedInput: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
          cacheReadTokens: chunk.usage.prompt_cache_hit_tokens
            ?? chunk.usage.prompt_tokens_details?.cached_tokens,
          convention: 'inclusive',
        });
        yield {
          type: 'usage',
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          ...(usage.cacheReadTokens ? { cacheReadTokens: usage.cacheReadTokens } : {}),
        };
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;

      // Reasoning rides its own delta field, parallel to content.
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
  }
}

// ── Message conversion ───────────────────────────────────────────────

/** An assistant message on the wire, optionally carrying its reasoning back. */
interface DeepSeekAssistantMessage {
  role: 'assistant';
  content: string | null;
  reasoning_content?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

/**
 * A user turn's content, which is a plain string until an image joins it.
 *
 * DeepSeek follows OpenAI's content-part shape here, so the same two part
 * kinds cover both. Kept as its own alias rather than inlined because two
 * providers spell it identically and one place to correct it is worth more
 * than the line it saves.
 */
type OpenAiStyleContent =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;

type DeepSeekMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: OpenAiStyleContent }
  | DeepSeekAssistantMessage
  | { role: 'tool'; tool_call_id: string; content: string };

/**
 * Project provider-agnostic messages onto DeepSeek's wire format.
 *
 * The one non-obvious rule is `reasoning_content`: it is replayed **only** on
 * assistant turns that carry tool calls, and only when the trace came from this
 * provider. Both halves matter.
 *
 *   - Replaying it on tool-call turns follows the documented contract, which
 *     says the trace must participate in the context concatenation once tool
 *     calls are involved. Live testing found the API accepts requests without
 *     it (see the module comment), so this is defensive adherence to the spec
 *     rather than a workaround for an observed failure.
 *   - Replaying it anywhere else is waste. The docs are explicit that a
 *     non-tool-calling turn's trace "does not need to participate in the
 *     context concatenation", and echoing it would re-bill a long chain of
 *     thought as input on every subsequent request for no behavioural gain.
 *
 * The provider check means a session that switched models mid-way degrades to
 * sending no trace — which the API tolerates — instead of forwarding another
 * vendor's payload into a field DeepSeek will try to parse.
 */
export function toDeepSeekMessages(
  messages: AicoMessage[],
  systemPrompt: string,
  volatileContext?: string,
): DeepSeekMessage[] {
  const result: DeepSeekMessage[] = [{ role: 'system', content: systemPrompt }];

  for (const msg of messages) {
    if (msg.role === 'user') {
      // DeepSeek's chat endpoint follows the OpenAI content-part shape.
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
    const assistant: DeepSeekAssistantMessage = {
      role: 'assistant',
      content: msg.content || null,
    };
    if (toolCalls.length > 0) {
      assistant.tool_calls = toolCalls.map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.input) },
      }));
      if (msg.reasoning?.provider === 'deepseek' && msg.reasoning.content) {
        assistant.reasoning_content = msg.reasoning.content;
      }
    }
    result.push(assistant);
  }

  // Tail position: DeepSeek's context cache is an automatic prefix match, so
  // turn-volatile content placed any earlier would invalidate the transcript
  // behind it — and here a cache miss costs ~50x a hit.
  if (volatileContext?.trim()) {
    result.push({ role: 'user', content: volatileContext });
  }

  return result;
}

export function toDeepSeekTools(defs: ToolDef[]): Array<{
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

// ── Loose typing for DeepSeek stream chunks ──────────────────────────
// The OpenAI SDK's types do not know about `reasoning_content` or the
// cache-hit/miss usage fields, so the stream is read through a permissive
// shape rather than fought with casts at every access.
interface DeepSeekChunk {
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    /** DeepSeek mirrors the hit count here too — verified live. */
    prompt_tokens_details?: { cached_tokens?: number };
    /** Reasoning tokens are a subset of completion_tokens, already counted. */
    completion_tokens_details?: { reasoning_tokens?: number };
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
 * the agent's retry classifier can tell a rate limit from a 4xx.
 */
function normalizeDeepSeekError(err: unknown): Error {
  if (err instanceof APIError) {
    const body = typeof err.error === 'object' && err.error !== null
      ? JSON.stringify(err.error)
      : err.message;
    return new Error(`[DeepSeek] API error ${err.status}: ${body}`);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new Error(`[DeepSeek] API error: ${msg}`);
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

/**
 * One reasoning level, in DeepSeek's shape.
 *
 * `off` is a distinct request — `{type: 'disabled'}` — rather than the absence
 * of the field, because omitting it gets the platform default, which is `high`.
 * Anything the ladder offers that DeepSeek does not is stepped by
 * `effortToSend` before it reaches here, so this only ever sees a value the API
 * accepts.
 */
function thinkingFor(level: EffortLevel | 'low' | 'high' | 'max' | 'off'):
  { type: 'disabled' } | { type: 'enabled'; reasoning_effort: string } {
  if (level === 'off') return { type: 'disabled' };
  return { type: 'enabled', reasoning_effort: level };
}
