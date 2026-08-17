/**
 * OpenAI Responses API provider (`/v1/responses`).
 *
 * Some OpenAI models cannot be driven agentically through Chat Completions at
 * all. The gpt-5.6 family is the current example, and it fails in two separate
 * ways there:
 *
 *   1. `max_tokens` is rejected outright — they require `max_completion_tokens`.
 *   2. Function tools are refused whenever any reasoning effort is set:
 *      "Function tools with reasoning_effort are not supported … in
 *      /v1/chat/completions. To use function tools, use /v1/responses or set
 *      reasoning_effort to 'none'."
 *
 * Forcing `reasoning_effort: 'none'` would make Chat Completions work, but it
 * turns a reasoning model into a non-reasoning one — the capability you are
 * paying for is exactly the one being disabled. The Responses API supports
 * tools and reasoning together, so an agent harness that wants both has to
 * speak it.
 *
 * ## Wire differences from Chat Completions
 *
 * | Concern        | Chat Completions              | Responses                      |
 * |----------------|-------------------------------|--------------------------------|
 * | System prompt  | a `system` message            | top-level `instructions`       |
 * | History        | `messages[]`                  | `input[]` of typed items       |
 * | Tool schema    | nested under `function`       | flat on the tool object        |
 * | Tool call      | `message.tool_calls[]`        | a `function_call` output item  |
 * | Tool result    | a `tool` role message         | a `function_call_output` item  |
 * | Output cap     | `max_tokens`                  | `max_output_tokens`            |
 * | Reasoning      | `reasoning_effort`            | `reasoning: { effort }`        |
 *
 * ## Known limitation: reasoning continuity
 *
 * The API can carry a model's `reasoning` items between steps when they are
 * echoed back in `input`. AICO's provider-agnostic message type has nowhere to
 * put them, so they are not echoed: each step reasons afresh from the
 * conversation. Verified to work correctly — the model still calls tools and
 * answers from their results — but it does forgo cross-step reasoning reuse.
 * Carrying them would mean either a provider-specific field on `AicoMessage` or
 * server-side `store: true` + `previous_response_id`, and the latter breaks the
 * "session log is the source of truth" invariant. Documented rather than
 * silently accepted.
 *
 * @module providers/openai-responses
 */

import OpenAI, { APIError } from 'openai';
import { normalizeUsage } from './usage.js';
import { OPENAI_DIALECT } from '../prompt/dialects.js';
import type {
  AicoMessage,
  ChatEvent,
  FinishReason,
  ProviderAPI,
  ProviderChatOptions,
  ToolDef,
} from './types.js';

/** Reasoning effort accepted by the Responses API for these models. */
export type ReasoningEffort =
  | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface OpenAIResponsesConfig {
  id: string;
  displayName: string;
  apiKey: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
  /**
   * Reasoning effort. Omitted entirely when `none`, so a model that rejects the
   * field is not sent it.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Output-token ceiling. Higher than the Chat Completions default because
   * reasoning tokens are drawn from the SAME budget as visible output — an
   * 8K cap that was generous for a non-reasoning model can leave a reasoning
   * model no room to answer at all.
   */
  maxOutputTokens?: number;
}

/** Default output ceiling; see {@link OpenAIResponsesConfig.maxOutputTokens}. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;

export class OpenAIResponsesProvider implements ProviderAPI {
  readonly id: string;
  readonly displayName: string;
  readonly promptDialect = OPENAI_DIALECT;
  private readonly client: OpenAI;
  private readonly reasoningEffort: ReasoningEffort;
  private readonly maxOutputTokens: number;

  constructor(config: OpenAIResponsesConfig) {
    this.id = config.id;
    this.displayName = config.displayName;
    this.reasoningEffort = config.reasoningEffort ?? 'low';
    this.maxOutputTokens = config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      ...(config.defaultHeaders ? { defaultHeaders: config.defaultHeaders } : {}),
    });
  }

  async *chat(opts: ProviderChatOptions): AsyncGenerator<ChatEvent> {
    const input = toResponsesInput(opts.messages, opts.volatileContext);
    const tools = toResponsesTools(opts.tools);

    const body: Record<string, unknown> = {
      model: opts.model,
      input,
      stream: true,
      max_output_tokens: opts.maxTokens ?? this.maxOutputTokens,
      ...(opts.systemPrompt ? { instructions: opts.systemPrompt } : {}),
      ...(tools.length > 0 ? { tools } : {}),
      // Omit the field entirely for 'none' rather than sending it: a model that
      // does not accept the parameter should not receive it at all.
      ...(this.reasoningEffort === 'none' ? {} : { reasoning: { effort: this.reasoningEffort } }),
      // Never persist server-side. The session log is the source of truth, and
      // a stored response would create a second one that can drift from it.
      store: false,
    };

    let stream: AsyncIterable<ResponseStreamEvent>;
    try {
      stream = (await this.client.responses.create(
        body as never,
        { signal: opts.signal },
      )) as unknown as AsyncIterable<ResponseStreamEvent>;
    } catch (err) {
      throw normalizeResponsesError(err, this.displayName);
    }

    // Function calls arrive as a separate output item whose arguments stream in
    // deltas. Keyed by item id: `output_index` is not stable enough when text
    // and calls interleave.
    const pending = new Map<string, { callId: string; name: string; args: string }>();
    let finish: FinishReason | undefined;

    for await (const event of stream) {
      switch (event.type) {
        case 'response.output_text.delta':
          if (event.delta) yield { type: 'text', content: event.delta };
          break;

        case 'response.output_item.added':
          if (event.item?.type === 'function_call' && event.item.id) {
            pending.set(event.item.id, {
              callId: event.item.call_id ?? event.item.id,
              name: event.item.name ?? '',
              args: '',
            });
          }
          break;

        case 'response.function_call_arguments.delta': {
          const entry = event.item_id ? pending.get(event.item_id) : undefined;
          if (entry && event.delta) entry.args += event.delta;
          break;
        }

        case 'response.function_call_arguments.done': {
          const entry = event.item_id ? pending.get(event.item_id) : undefined;
          // The `done` event carries the complete argument string; prefer it
          // over the accumulated deltas so a dropped delta cannot corrupt args.
          if (entry && typeof event.arguments === 'string') entry.args = event.arguments;
          break;
        }

        case 'response.output_item.done': {
          const item = event.item;
          if (item?.type !== 'function_call') break;
          const entry = (item.id ? pending.get(item.id) : undefined) ?? {
            callId: item.call_id ?? item.id ?? '',
            name: item.name ?? '',
            args: typeof item.arguments === 'string' ? item.arguments : '',
          };
          if (typeof item.arguments === 'string' && item.arguments) entry.args = item.arguments;
          if (!entry.name) break;
          const parsed = tryParseToolArgs(entry.args);
          yield {
            type: 'tool_call',
            id: entry.callId,
            name: entry.name,
            input: parsed.input,
            ...(parsed.parseError ? { parseError: parsed.parseError } : {}),
          };
          finish = 'tool_calls';
          if (item.id) pending.delete(item.id);
          break;
        }

        case 'response.completed':
        case 'response.incomplete':
        case 'response.failed': {
          const response = event.response;
          const usage = response?.usage;
          if (usage) {
            // `inclusive`: the Responses API's input_tokens is the full prompt
            // size and input_tokens_details.cached_tokens is a subset of it.
            const normalized = normalizeUsage({
              reportedInput: usage.input_tokens ?? 0,
              outputTokens: usage.output_tokens ?? 0,
              cacheReadTokens: usage.input_tokens_details?.cached_tokens,
              // OpenAI's caching is automatic and carries no write premium, so
              // there is no write count to report.
              convention: 'inclusive',
            });
            yield {
              type: 'usage',
              inputTokens: normalized.inputTokens,
              outputTokens: normalized.outputTokens,
              ...(normalized.cacheReadTokens
                ? { cacheReadTokens: normalized.cacheReadTokens }
                : {}),
            };
          }
          if (event.type === 'response.incomplete') {
            // Report truncation independently: reasoning tokens share the output
            // budget, so hitting the cap is a realistic outcome here and must
            // never read as a clean finish.
            finish = response?.incomplete_details?.reason === 'max_output_tokens'
              ? 'length'
              : 'other';
          } else if (event.type === 'response.failed') {
            const message = response?.error?.message ?? 'response failed';
            throw new Error(`[${this.displayName}] API error: ${message}`);
          } else if (finish === undefined) {
            finish = 'stop';
          }
          break;
        }

        case 'error':
          throw new Error(
            `[${this.displayName}] API error: ${event.message ?? 'stream error'}`,
          );

        default:
          break;
      }
    }

    if (finish !== undefined) yield { type: 'finish', reason: finish };
  }
}

// ── Message conversion ───────────────────────────────────────────────

/** One item in a Responses `input` array. */
type ResponsesInputItem =
  | { role: 'user' | 'assistant'; content: string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

/**
 * Project provider-agnostic messages onto Responses input items.
 *
 * An assistant turn that both spoke and called tools becomes two items: a
 * message and one `function_call` per call. A tool result becomes a
 * `function_call_output` keyed by the same `call_id`, which is what preserves
 * the call/result pairing the session log maintains.
 */
export function toResponsesInput(
  messages: AicoMessage[],
  volatileContext?: string,
): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      items.push({ role: 'user', content: message.content });
      continue;
    }
    if (message.role === 'assistant') {
      if (message.content) items.push({ role: 'assistant', content: message.content });
      for (const call of message.toolCalls ?? []) {
        items.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.input),
        });
      }
      continue;
    }
    // Tool result.
    items.push({
      type: 'function_call_output',
      call_id: message.toolCallId,
      output: message.content,
    });
  }

  // Tail position, behind everything cacheable — see ProviderChatOptions.
  if (volatileContext?.trim()) {
    items.push({ role: 'user', content: volatileContext });
  }

  return items;
}

/** Responses tool schemas are flat, unlike the nested Chat Completions form. */
export function toResponsesTools(defs: ToolDef[]): Array<Record<string, unknown>> {
  return defs.map(def => ({
    type: 'function',
    name: def.name,
    description: def.description,
    parameters: def.inputSchema,
    // Strict mode requires every property to be required and additionalProperties
    // false; AICO's schemas use optional fields throughout, so it is off.
    strict: false,
  }));
}

// ── Stream event typing ──────────────────────────────────────────────

/**
 * Permissive shape for Responses stream events.
 *
 * Deliberately not the SDK's generated union: these event types are still
 * gaining fields, and a strict binding turns an additive server change into a
 * compile error in a consumer that would otherwise have ignored it.
 */
interface ResponseStreamEvent {
  type: string;
  delta?: string;
  item_id?: string;
  arguments?: string;
  message?: string;
  item?: {
    id?: string;
    type?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  };
  response?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      input_tokens_details?: { cached_tokens?: number };
    };
    incomplete_details?: { reason?: string };
    error?: { message?: string };
  };
}

// ── Errors ───────────────────────────────────────────────────────────

/**
 * Normalize SDK errors into the stable `API error <status>: <body>` string the
 * agent's retry classifier pattern-matches on, so a 429 from this provider is
 * treated as a rate limit rather than an unknown transient failure.
 */
function normalizeResponsesError(err: unknown, displayName: string): Error {
  if (err instanceof APIError) {
    const body = typeof err.error === 'object' && err.error !== null
      ? JSON.stringify(err.error)
      : err.message;
    return new Error(`[${displayName}] API error ${err.status}: ${body}`);
  }
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`[${displayName}] API error: ${message}`);
}

/**
 * Parse tool-call argument JSON, preserving a diagnostic when it is malformed
 * so the model sees the real cause instead of a missing-argument error.
 */
function tryParseToolArgs(raw: string): { input: Record<string, unknown>; parseError?: string } {
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
