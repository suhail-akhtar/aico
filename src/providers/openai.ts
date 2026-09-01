/**
 * OpenAI-compatible provider — handles:
 *   • OpenAI       (api.openai.com)
 *   • OpenRouter   (openrouter.ai/api/v1)
 *   • Ollama       (localhost:11434/v1)
 *   • Google Gemini (generativelanguage.googleapis.com/v1beta/openai)
 *
 * All four use the same OpenAI Chat Completions wire format.
 */

import OpenAI, { APIError } from 'openai';
import type { ProviderAPI, ProviderChatOptions, ChatEvent, AicoMessage, FinishReason } from './types.js';
import { normalizeUsage } from './usage.js';
import { resolvedEffort } from '../run-context.js';
import { supportsReasoning } from '../../shared/reasoning.js';
import { DEFAULT_DIALECT } from '../prompt/dialects.js';
import type { PromptDialect } from '../prompt/types.js';

/**
 * Whether a model rejects `max_tokens` and requires `max_completion_tokens`.
 *
 * Covers the reasoning-capable families OpenAI has moved to the newer
 * parameter: gpt-5 and above, and the o-series. This is a fast path only — the
 * provider also self-heals on the 400, so a model missing from this test costs
 * one wasted request instead of failing outright.
 */
export function usesMaxCompletionTokens(model: string): boolean {
  return /^gpt-5/i.test(model) || /^o[1-9]/i.test(model);
}

/**
 * Whether a model accepts `reasoning_effort` on Chat Completions.
 *
 * Sending it to a model without reasoning is not ignored — gpt-4o-mini returns
 * 400 "Unrecognized request argument supplied: reasoning_effort" — so a
 * globally configured effort must not be forwarded blindly. Currently the same
 * families as {@link usesMaxCompletionTokens}, but kept separate because the
 * two answer different questions and will drift apart.
 */
export function supportsReasoningEffort(model: string): boolean {
  return /^gpt-5/i.test(model) || /^o[1-9]/i.test(model);
}

/** Detect a 400 blaming `reasoning_effort`, for the self-heal. */
function isReasoningEffortError(err: unknown): boolean {
  if (!(err instanceof APIError) || err.status !== 400) return false;
  const msg = (typeof err.error === 'object' && err.error !== null
    ? JSON.stringify(err.error)
    : err.message
  ).toLowerCase();
  return msg.includes('reasoning_effort');
}

/**
 * Map an OpenAI-family `finish_reason` onto the normalized vocabulary.
 * `length` is the one that matters most: it means the reply was cut off at the
 * output-token ceiling, which the agent must not report as a completed turn.
 */
function normalizeFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop':          return 'stop';
    case 'tool_calls':
    case 'function_call': return 'tool_calls';
    case 'length':        return 'length';
    default:              return 'other';
  }
}

export interface OpenAICompatibleConfig {
  id: string;
  displayName: string;
  apiKey?: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
  /**
   * Whether to send stream_options: { include_usage: true }.
   * Live testing confirmed OpenRouter accepts this for both DeepSeek and
   * Anthropic models (returns cached_tokens, cache_write_tokens, cost).
   * Previously disabled for OpenRouter on a false assumption — now on by default.
   * The chat() method also retries without it on a 400, so it self-heals.
   * Defaults to true.
   */
  supportsStreamUsage?: boolean;
  /**
   * Inject a top-level cache_control breakpoint into the request body.
   * OpenRouter honors this for Anthropic models (Claude), giving ~90% input-token
   * cost reduction on repeat turns. No effect on DeepSeek (caching is implicit
   * there) or OpenAI (automatic server-side). Verified via live API testing.
   */
  cacheControl?: boolean;
  /**
   * OpenRouter session id for provider sticky routing. Maximizes prompt-cache
   * warmth by routing repeat requests to the same backend. No effect on non-OR
   * providers (the field is simply ignored).
   */
  sessionId?: string;
  /**
   * OpenAI's `prompt_cache_key`. Requests sharing a key are routed to the same
   * machine, which is what turns a matching prefix into an actual cache hit.
   * The docs recommend a session or user id, and roughly 15 requests/minute per
   * key to keep it warm. Ignored by vendors that do not implement it.
   */
  promptCacheKey?: string;
  /**
   * Reasoning effort for reasoning-capable models on Chat Completions. Omitted
   * entirely when unset, so models that reject the parameter never see it.
   */
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /**
   * How this endpoint spells a reasoning level.
   *
   * Set explicitly per provider rather than sniffed from the model id, because
   * a gateway fronts many vendors and the *endpoint* decides the shape, not the
   * model. Each was read from that vendor's own documentation:
   *
   * - `openai`     — `reasoning_effort: '<level>'`
   * - `openrouter` — `reasoning: { effort: '<level>' }`
   * - `zai`        — `thinking: { type: 'enabled' | 'disabled' }`, a switch
   * - `none`       — send nothing. The honest default for an endpoint nobody
   *                  has checked: a guessed parameter 400s every request.
   */
  reasoningShape?: 'openai' | 'openrouter' | 'zai' | 'none';
  /**
   * Prompt dialect for whichever vendor this instance is pointed at.
   *
   * This class serves five of them, and they do not agree — OpenAI documents
   * Markdown, Gemini accepts either but demands consistency, and an
   * OpenRouter-routed Claude model wants XML. So the dialect is supplied per
   * instance rather than fixed on the class.
   */
  promptDialect?: PromptDialect;
  /**
   * Output ceiling per request, when the caller names none.
   *
   * Per instance rather than one constant, because "OpenAI-compatible" spans
   * an order of magnitude: the shared 8192 is a safe floor for an unknown
   * endpoint and badly wrong for GLM, which documents a 128K output limit. A
   * ceiling below what the model can write does not merely shorten a reply —
   * it truncates tool calls, and a half-emitted call performs no action at
   * all, so the step costs money and writes nothing.
   */
  maxOutputTokens?: number;
}

/**
 * Default output ceiling. (The previous value was 8096 — a typo for 8192 that
 * quietly shaved 96 tokens off every request's budget.)
 */
export const DEFAULT_MAX_TOKENS = 8192;

export class OpenAICompatibleProvider implements ProviderAPI {
  readonly id: string;
  readonly displayName: string;
  private readonly client: OpenAI;
  private readonly supportsStreamUsage: boolean;
  private readonly cacheControl: boolean;
  private readonly sessionId?: string;
  private readonly promptCacheKey?: string;
  private readonly reasoningEffort?: OpenAICompatibleConfig['reasoningEffort'];
  private readonly reasoningShape: NonNullable<OpenAICompatibleConfig['reasoningShape']>;
  private readonly maxOutputTokens: number;
  readonly promptDialect: PromptDialect;
  // Once a 400 from stream_options is seen, disable it for the life of this provider
  // so subsequent requests don't repeat the failure.
  private streamUsageDisabled = false;
  // Latched once a 400 proves this model wants `max_completion_tokens`, so the
  // discovery costs one request per provider instance rather than one per call.
  private maxCompletionTokensRequired = false;
  // Latched when a 400 proves this deployment rejects reasoning_effort, so a
  // model outside the prefix test costs one wasted request rather than every
  // call failing.
  private reasoningEffortUnsupported = false;

  constructor(config: OpenAICompatibleConfig) {
    this.id = config.id;
    this.displayName = config.displayName;
    this.supportsStreamUsage = config.supportsStreamUsage ?? true;
    this.cacheControl = config.cacheControl ?? false;
    this.maxOutputTokens = config.maxOutputTokens ?? DEFAULT_MAX_TOKENS;
    this.sessionId = config.sessionId;
    this.promptCacheKey = config.promptCacheKey;
    // 'none' means "do not send the parameter" rather than sending the literal
    // string, so a model with no reasoning support is never handed the field.
    this.reasoningEffort = config.reasoningEffort === 'none' ? undefined : config.reasoningEffort;
    this.reasoningShape = config.reasoningShape ?? 'none';
    this.promptDialect = config.promptDialect ?? DEFAULT_DIALECT;
    this.client = new OpenAI({
      apiKey: config.apiKey ?? 'no-key',
      baseURL: config.baseURL,
      defaultHeaders: config.defaultHeaders,
    });
  }

  /**
   * The reasoning fields for one request, in this endpoint's own shape.
   *
   * The run's choice outranks the configured one, and both are withheld from a
   * model the table does not know reasons — verified the hard way once already:
   * gpt-4o-mini answers a `reasoning_effort` request with
   * 400 "Unrecognized request argument supplied: reasoning_effort", so
   * forwarding a globally configured effort to every model breaks every
   * non-reasoning one.
   *
   * `none` sends nothing at all. That is the default, and it is deliberate: an
   * endpoint whose documentation nobody has read gets no reasoning parameter
   * rather than a guessed one, because a guess 400s every request rather than
   * degrading.
   */
  private reasoningFields(model: string): Record<string, unknown> {
    if (this.reasoningShape === 'none') return {};
    if (this.reasoningEffortUnsupported) return {};

    const level = resolvedEffort(model) ?? this.reasoningEffort;
    if (!level || level === 'none') return {};
    /*
      Asked of the shared table, not of an OpenAI prefix test.

      `supportsReasoningEffort` answers "is this an OpenAI reasoning model",
      which is the right question for one vendor and silently false for every
      other — it gated GLM out entirely, so `thinking` was never sent and the
      whole Z.AI path did nothing. One source of truth for what reasons.
    */
    if (!supportsReasoning(model)) return {};

    switch (this.reasoningShape) {
      case 'openai':
        return { reasoning_effort: level };
      case 'openrouter':
        // `reasoning: { effort }`, and the accepted ladder is exactly ours —
        // none, minimal, low, medium, high, xhigh, max — which is why the
        // shared vocabulary needed no translation here.
        return { reasoning: { effort: level } };
      case 'zai':
        // A switch, not a ladder: `thinking: {type}` takes enabled or disabled
        // and nothing else, so every level above `off` means enabled.
        return { thinking: { type: level === 'off' ? 'disabled' : 'enabled' } };
      default:
        return {};
    }
  }

  async *chat(opts: ProviderChatOptions): AsyncGenerator<ChatEvent> {
    const messages = toOpenAIMessages(opts.messages, opts.systemPrompt, opts.volatileContext);
    const tools = toOpenAITools(opts.tools);

    // Tool call accumulator indexed by tool_call position (delta.index)
    const tcBuilders = new Map<number, { id: string; name: string; args: string }>();

    // Build the request body. cache_control is injected at the top level for
    // OpenRouter+Anthropic (verified: ~90% input-cost reduction on repeat turns).
    // session_id enables sticky routing so repeat requests hit the warm cache.
    // The body reads the self-heal latches directly rather than taking them as
    // arguments, so a retry is just "call it again" — the previous shape needed
    // one boolean per healable parameter at every call site, which does not
    // survive a third one being added.
    const buildBody = () => ({
      model: opts.model,
      messages,
      ...(tools.length > 0 ? { tools } : {}),
      stream: true as const,
      ...(this.supportsStreamUsage && !this.streamUsageDisabled
        ? { stream_options: { include_usage: true } }
        : {}),
      // Newer OpenAI models reject `max_tokens` outright and require
      // `max_completion_tokens`. The prefix test covers the known families; the
      // 400 self-heal below covers the ones that ship after this code was
      // written, because a hardcoded list always goes stale.
      ...(this.maxCompletionTokensRequired || usesMaxCompletionTokens(opts.model)
        ? { max_completion_tokens: opts.maxTokens ?? this.maxOutputTokens }
        : { max_tokens: opts.maxTokens ?? this.maxOutputTokens }),
      ...(this.cacheControl ? { cache_control: { type: 'ephemeral' as const } } : {}),
      ...(this.sessionId ? { session_id: this.sessionId } : {}),
      // OpenAI routes requests to a cache-warm machine by prompt_cache_key,
      // with the prefix hash only as a secondary key. Without it, successive
      // requests in one session can land on different machines and miss a cache
      // whose prefix matched perfectly. The OpenRouter/Z.AI `session_id` above
      // is the same idea under a different vendor's name.
      ...(this.promptCacheKey ? { prompt_cache_key: this.promptCacheKey } : {}),
      // Only sent to models that actually reason. Verified the hard way:
      // gpt-4o-mini answers a `reasoning_effort` request with
      // 400 "Unrecognized request argument supplied: reasoning_effort", so
      // forwarding a globally configured effort to every model would break
      // every non-reasoning one. Prefix test plus 400 self-heal, same pattern
      // as max_completion_tokens above.
      ...this.reasoningFields(opts.model),
    });

    // Typed explicitly rather than inferred from create(): the body is cast to
    // `never` because the installed SDK's types lag the API (its ReasoningEffort
    // enum has no 'xhigh'/'minimal'/'max'), and that cast also erases the
    // `stream: true` discriminant the return type would otherwise key on.
    const send = async (): Promise<AsyncIterable<OpenAI.Chat.ChatCompletionChunk>> =>
      (await this.client.chat.completions.create(
        buildBody() as never, { signal: opts.signal },
      )) as unknown as AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;

    // Each healable parameter gets one chance to be blamed and dropped, and the
    // disable latches on the provider so the discovery costs one wasted request
    // per instance rather than one per call. A loop rather than nested
    // try/catch because two of them can be wrong at once — an unknown
    // deployment can reject both stream_options and reasoning_effort, which the
    // previous else-if chain could never recover from.
    let stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;
    for (let attempt = 0; ; attempt++) {
      try {
        stream = await send();
        break;
      } catch (err) {
        const canHeal = attempt < 3 && (
          (!this.maxCompletionTokensRequired && this.isMaxTokensParamError(err)
            && (this.maxCompletionTokensRequired = true))
          || (!this.streamUsageDisabled && this.isStreamOptionsError(err)
            && (this.streamUsageDisabled = true))
          || (!this.reasoningEffortUnsupported && isReasoningEffortError(err)
            && (this.reasoningEffortUnsupported = true))
        );
        if (!canHeal) throw this.normalizeError(err);
      }
    }

    for await (const chunk of stream) {
      // Usage (arrives on the final chunk when include_usage: true)
      if (chunk.usage) {
        // OpenAI/OpenRouter/Gemini/Z.AI report automatic prompt-cache hits in
        // prompt_tokens_details. OpenRouter additionally reports cache_write_tokens
        // there, which is real money on its Anthropic-backed models (writes bill
        // at 1.25x) and was previously discarded.
        const details = (chunk.usage as any).prompt_tokens_details ?? {};
        // `inclusive`: prompt_tokens already contains the cached tokens, so
        // normalizeUsage keeps it as the total instead of double-counting.
        const usage = normalizeUsage({
          reportedInput: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
          cacheReadTokens: details.cached_tokens,
          cacheWriteTokens: details.cache_write_tokens,
          convention: 'inclusive',
        });
        yield {
          type: 'usage',
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          ...(usage.cacheReadTokens ? { cacheReadTokens: usage.cacheReadTokens } : {}),
          ...(usage.cacheWriteTokens ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
        };
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;

      // Text delta
      const text = choice.delta?.content;
      if (text) yield { type: 'text', content: text };

      // Tool call deltas — accumulate arguments across chunks
      for (const tc of choice.delta?.tool_calls ?? []) {
        if (!tcBuilders.has(tc.index)) {
          tcBuilders.set(tc.index, { id: '', name: '', args: '' });
        }
        const b = tcBuilders.get(tc.index)!;
        if (tc.id)                 b.id   = tc.id;
        if (tc.function?.name)     b.name += tc.function.name;
        if (tc.function?.arguments) b.args += tc.function.arguments;
      }

      // When the model stops, emit all accumulated tool calls
      if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
        for (const [, b] of tcBuilders) {
          if (!b.name) continue;
          const parsed = tryParseToolArgs(b.args);
          yield {
            type: 'tool_call',
            id: b.id || `call_${Date.now()}`,
            name: b.name,
            input: parsed.input,
            ...(parsed.parseError ? { parseError: parsed.parseError } : {}),
          };
        }
        tcBuilders.clear();
      }

      // Report the stop reason independently of the content it accompanies, so
      // a reply truncated at the token ceiling is never mistaken for a complete
      // one. Emitted after tool calls so the agent has the full step first.
      if (choice.finish_reason) {
        yield { type: 'finish', reason: normalizeFinishReason(choice.finish_reason) };
      }
    }
  }

  /**
   * Detect a 400 error caused by stream_options being unsupported. Some
   * OpenRouter-backed models reject it; we self-heal by retrying without it.
   */
  /**
   * Detect a 400 saying this model requires `max_completion_tokens`.
   * Matched on the parameter name rather than the full sentence so a reworded
   * error message does not silently disable the self-heal.
   */
  private isMaxTokensParamError(err: unknown): boolean {
    if (!(err instanceof APIError) || err.status !== 400) return false;
    const msg = (typeof err.error === 'object' && err.error !== null
      ? JSON.stringify(err.error)
      : err.message
    ).toLowerCase();
    return msg.includes('max_completion_tokens');
  }

  private isStreamOptionsError(err: unknown): boolean {
    if (!(err instanceof APIError) || err.status !== 400) return false;
    const msg = (typeof err.error === 'object' && err.error !== null
      ? JSON.stringify(err.error)
      : err.message
    ).toLowerCase();
    return msg.includes('stream_options') || msg.includes('stream options');
  }

  /**
   * Normalize SDK errors into stable aico error strings with HTTP status, so
   * the retry classifier can pattern-match (rate limits vs 4xx vs transient).
   */
  private normalizeError(err: unknown): Error {
    if (err instanceof APIError) {
      const body = typeof err.error === 'object' && err.error !== null
        ? JSON.stringify(err.error)
        : err.message;
      throw new Error(`[${this.displayName}] API error ${err.status}: ${body}`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[${this.displayName}] API error: ${msg}`);
  }
}

// ── Message conversion ──────────────────────────────────────────────

function toOpenAIMessages(
  messages: AicoMessage[],
  systemPrompt: string,
  volatileContext?: string,
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const result: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
  ];

  for (const msg of messages) {
    if (msg.role === 'user') {
      // A `data:` URL rather than a hosted one: the bytes are already here,
      // and uploading them somewhere first to hand back a link would add a
      // failure mode and a retention question for no gain.
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
    } else if (msg.role === 'assistant') {
      if (msg.toolCalls?.length) {
        result.push({
          role: 'assistant',
          content: msg.content || null,
          tool_calls: msg.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.input) },
          })),
        });
      } else {
        result.push({ role: 'assistant', content: msg.content });
      }
    } else if (msg.role === 'tool') {
      result.push({
        role: 'tool',
        tool_call_id: msg.toolCallId,
        content: msg.content,
      });
    }
  }

  // Tail position, deliberately. OpenAI's cache is an automatic prefix match,
  // so putting turn-volatile content anywhere earlier — including at the end of
  // the system message — would change the prefix of every message behind it and
  // cost the whole transcript its cache.
  if (volatileContext?.trim()) {
    result.push({ role: 'user', content: volatileContext });
  }

  return result;
}

function toOpenAITools(defs: ProviderChatOptions['tools']): OpenAI.Chat.ChatCompletionTool[] {
  return defs.map(d => ({
    type: 'function' as const,
    function: {
      name: d.name,
      description: d.description,
      parameters: d.inputSchema,
    },
  }));
}

/**
 * Parse accumulated tool-call argument JSON. Returns the parsed input plus a
 * parseError diagnostic when the JSON was malformed, so the agent can surface
 * the real cause to the model instead of silently dispatching empty args.
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
