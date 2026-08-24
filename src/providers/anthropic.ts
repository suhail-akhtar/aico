/**
 * Anthropic provider — Claude models via the Anthropic API.
 *
 * Wire format differs from OpenAI:
 *  - Tool results go in `user` messages (not `tool` role messages)
 *  - Tool calls come as `tool_use` content blocks (not function_call)
 *  - Usage arrives in `message_start` (input) and `message_delta` (output)
 */

import Anthropic from '@anthropic-ai/sdk';
import type { ProviderAPI, ProviderChatOptions, ChatEvent, AicoMessage, ToolDef, FinishReason } from './types.js';
import { normalizeUsage } from './usage.js';
import { ANTHROPIC_DIALECT } from '../prompt/dialects.js';

/** Map an Anthropic `stop_reason` onto the normalized finish vocabulary. */
function normalizeStopReason(reason: string): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence': return 'stop';
    case 'tool_use':      return 'tool_calls';
    // Both of these are truncation, and both used to fall through to 'other'.
    // `max_tokens` is the requested output cap; `model_context_window_exceeded`
    // is the input window. Reporting either as anything but `length` lets the
    // agent accept a cut-short answer as a completed turn.
    case 'max_tokens':
    case 'model_context_window_exceeded': return 'length';
    // A safety classifier declined the request. It arrives as HTTP 200 with an
    // empty or partial content array, so it must not read as a clean stop.
    case 'refusal':       return 'blocked';
    default:              return 'other';
  }
}

/**
 * Whether a model takes adaptive thinking (`{type:'adaptive'}`).
 *
 * Claude 4.6 and later replaced the fixed `budget_tokens` budget with adaptive
 * thinking, and the newer models reject `budget_tokens` with a 400. Older
 * models are deliberately left alone: they would need the legacy parameter, and
 * sending nothing preserves exactly the behaviour they have today rather than
 * introducing an untested request shape on a legacy path.
 */
export function supportsAdaptiveThinking(model: string): boolean {
  return /^claude-(opus-(4-[678]|5)|sonnet-(4-6|5)|fable-5|mythos-5)/i.test(model);
}

/**
 * Default output ceiling.
 *
 * Raised again, from 32k, because a *tool call's arguments are output tokens*.
 * Asked to write an 85 KB file in one Write, Sonnet spent the whole 32,000 on
 * the argument and was cut off mid-JSON — and a truncated tool call is not a
 * partial file, it is no file. Ten minutes and a dollar for zero bytes,
 * reported only as "output limit reached".
 *
 * Raised from the original 8192 because `max_tokens` caps thinking *and*
 * response text together, and thinking is on by default server-side on the
 * newest models — so a budget sized for a non-thinking model can be consumed
 * before the answer starts. Current models accept up to 128K.
 */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 64_000;

export interface AnthropicConfig {
  apiKey: string;
  cacheControl?: boolean;
  /**
   * Adaptive thinking. `'off'` sends `{type:'disabled'}`; the default sends
   * `{type:'adaptive', display:'summarized'}` on models that support it.
   *
   * `summarized` is requested explicitly because the default is `omitted` on
   * every current model, which streams thinking blocks whose text is empty —
   * to a user that looks like a long stall before any output appears.
   */
  thinking?: 'adaptive' | 'off';
  /** Effort level, forwarded as `output_config.effort`. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTokens?: number;
}

export class AnthropicProvider implements ProviderAPI {
  readonly id = 'anthropic';
  readonly displayName = 'Anthropic';
  readonly promptDialect = ANTHROPIC_DIALECT;
  private readonly client: Anthropic;
  private readonly cacheControl: boolean;
  private readonly thinking: 'adaptive' | 'off';
  private readonly effort?: AnthropicConfig['effort'];
  private readonly maxTokens: number;

  constructor(config: AnthropicConfig) {
    this.client = new Anthropic({ apiKey: config.apiKey });
    // Prompt caching is on by default — the system prompt + tool definitions
    // are the largest static content and yield ~90% input-token savings on
    // repeat turns. Disable via settings.promptCaching.enabled = false.
    this.cacheControl = config.cacheControl ?? true;
    this.thinking = config.thinking ?? 'adaptive';
    this.effort = config.effort;
    this.maxTokens = config.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS;
  }

  async *chat(opts: ProviderChatOptions): AsyncGenerator<ChatEvent> {
    const messages = toAnthropicMessages(opts.messages);
    const tools = toAnthropicTools(opts.tools, this.cacheControl);

    // Cache the conversation tail, not just the static prefix. Without this the
    // whole transcript is re-billed at full input rate on every step of an
    // agentic run, which in a long session dwarfs the system prompt this
    // provider was already caching. Safe because the session event log is
    // append-only: the prefix under each breakpoint is byte-identical next step.
    if (this.cacheControl) {
      applyMessageCacheBreakpoints(messages, MESSAGE_CACHE_BREAKPOINTS);
    }

    // Strictly after the breakpoints: volatile context is the one part of the
    // request that must sit outside every cached prefix.
    appendVolatileContext(messages, opts.volatileContext);

    // When caching is enabled, send the system prompt as a content-block
    // array with an ephemeral cache_control breakpoint. The array form is
    // required to attach cache_control — a plain string cannot be cached.
    const system: string | Anthropic.TextBlockParam[] = this.cacheControl
      ? [{ type: 'text', text: opts.systemPrompt, cache_control: { type: 'ephemeral' } }]
      : opts.systemPrompt;

    let response: Awaited<ReturnType<typeof this.client.messages.create>>;
    try {
      const adaptive = this.thinking === 'adaptive' && supportsAdaptiveThinking(opts.model);
      response = await this.client.messages.create({
        model: opts.model,
        system,
        messages,
        ...(tools.length > 0 ? { tools } : {}),
        max_tokens: opts.maxTokens ?? this.maxTokens,
        stream: true,
        ...(adaptive
          ? { thinking: { type: 'adaptive', display: 'summarized' } }
          : {}),
        ...(this.effort ? { output_config: { effort: this.effort } } : {}),
      } as never, { signal: opts.signal });
    } catch (err) {
      throw normalizeAnthropicError(err);
    }

    // Tool input accumulator: keyed by content block index
    const toolBlocks = new Map<number, { id: string; name: string; input: string }>();
    // Thinking accumulator, keyed the same way. Insertion order is stream order,
    // which is the order they must be replayed in.
    const thinkingBlocks = new Map<number, ThinkingBlock>();
    // Input tokens and BOTH cache counts arrive in message_start. Capture them
    // here and emit together with the output count from message_delta below.
    //
    // All three are needed: Anthropic's `input_tokens` counts only the tokens
    // after the last cache breakpoint, so reads and writes have to be added
    // back to recover the real prompt size. Reading only `cache_read_*` — as
    // this provider originally did — makes every cache write look free.
    let startInputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;

    for await (const event of response as unknown as AsyncIterable<AnthropicStreamEvent>) {
      switch (event.type) {

        case 'message_start': {
          const usage = event.message?.usage;
          startInputTokens = usage?.input_tokens ?? 0;
          cacheReadTokens = usage?.cache_read_input_tokens ?? 0;
          cacheWriteTokens = usage?.cache_creation_input_tokens ?? 0;
          break;
        }

        case 'content_block_start':
          if (event.content_block?.type === 'tool_use' && event.index !== undefined) {
            toolBlocks.set(event.index, {
              id:    event.content_block.id    ?? '',
              name:  event.content_block.name  ?? '',
              input: '',
            });
          }
          // Thinking blocks must be replayed byte-identical on the next request
          // of the same turn, signature included, so they are accumulated
          // rather than merely displayed.
          if (
            (event.content_block?.type === 'thinking'
              || event.content_block?.type === 'redacted_thinking')
            && event.index !== undefined
          ) {
            thinkingBlocks.set(event.index, {
              type: event.content_block.type,
              thinking: event.content_block.thinking ?? '',
              signature: event.content_block.signature ?? '',
              data: event.content_block.data,
            });
          }
          break;

        case 'content_block_delta': {
          if (event.delta?.type === 'text_delta' && event.delta.text) {
            yield { type: 'text', content: event.delta.text };
          }
          if (event.delta?.type === 'input_json_delta' && event.delta.partial_json) {
            if (event.index === undefined) break;
            const b = toolBlocks.get(event.index);
            if (b) b.input += event.delta.partial_json;
          }
          if (event.delta?.type === 'thinking_delta' && event.index !== undefined) {
            const block = thinkingBlocks.get(event.index);
            if (block && event.delta.thinking) block.thinking += event.delta.thinking;
            if (event.delta.thinking) yield { type: 'reasoning', delta: event.delta.thinking };
          }
          // The signature arrives in its own delta at the end of the block and
          // is what makes the block replayable — dropping it invalidates it.
          if (event.delta?.type === 'signature_delta' && event.index !== undefined) {
            const block = thinkingBlocks.get(event.index);
            if (block && event.delta.signature) block.signature += event.delta.signature;
          }
          break;
        }

        case 'content_block_stop': {
          if (event.index === undefined) break;
          const b = toolBlocks.get(event.index);
          if (b?.name) {
            const parsed = tryParseToolArgs(b.input);
            yield {
              type: 'tool_call',
              id: b.id,
              name: b.name,
              input: parsed.input,
              ...(parsed.parseError ? { parseError: parsed.parseError } : {}),
            };
            toolBlocks.delete(event.index);
          }
          break;
        }

        case 'message_delta':
          if (event.usage) {
            // `exclusive`: Anthropic's input_tokens omits both cache counts,
            // so normalizeUsage adds them back to reach the true prompt size.
            const usage = normalizeUsage({
              // Anthropic reports input tokens only at message_start; reuse
              // the captured value so input accounting isn't silently 0.
              reportedInput: startInputTokens || (event.usage.input_tokens ?? 0),
              outputTokens: event.usage.output_tokens ?? 0,
              cacheReadTokens,
              cacheWriteTokens,
              convention: 'exclusive',
            });
            yield {
              type: 'usage',
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              ...(usage.cacheReadTokens ? { cacheReadTokens: usage.cacheReadTokens } : {}),
              ...(usage.cacheWriteTokens ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
            };
          }
          // `stop_reason` rides on message_delta. Report it independently of
          // usage so a `max_tokens` truncation is never read as a clean finish.
          if (event.delta?.stop_reason) {
            // Emitted before `finish` so the agent has the replay payload in
            // hand when it records the assistant message for this step.
            if (thinkingBlocks.size > 0) {
              yield {
                type: 'reasoning',
                delta: '',
                replay: serializeThinkingBlocks([...thinkingBlocks.values()]),
              };
            }
            yield { type: 'finish', reason: normalizeStopReason(event.delta.stop_reason) };
          }
          break;
      }
    }
  }
}

// ── Message conversion ───────────────────────────────────────────────

/** One thinking block, in the shape the API both emits and accepts back. */
interface ThinkingBlock {
  type: 'thinking' | 'redacted_thinking';
  thinking: string;
  signature: string;
  /** Present only on `redacted_thinking`, where content is encrypted. */
  data?: string;
}

/** Serialize thinking blocks for storage as an opaque {@link ReasoningTrace}. */
export function serializeThinkingBlocks(blocks: ThinkingBlock[]): string {
  return JSON.stringify(blocks);
}

/**
 * Recover thinking blocks from a stored trace.
 *
 * Returns an empty list on anything unparseable rather than throwing. A trace
 * written by an older build, hand-edited, or truncated should degrade to "this
 * turn had no thinking" — losing a replay costs quality, but throwing here
 * would take down a conversation the user can otherwise continue.
 */
export function parseThinkingBlocks(content: string): ThinkingBlock[] {
  try {
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (b): b is ThinkingBlock =>
        !!b && (b.type === 'thinking' || b.type === 'redacted_thinking'),
    );
  } catch {
    return [];
  }
}

export function toAnthropicMessages(messages: AicoMessage[]): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role === 'user') {
      // Images lead the block. Anthropic documents better results when the
      // picture precedes the question about it, and the reader's text is
      // almost always a question about the picture they just attached.
      if (msg.images?.length) {
        const blocks: Anthropic.ContentBlockParam[] = msg.images.map(image => ({
          type: 'image',
          source: { type: 'base64', media_type: image.mediaType, data: image.data },
        }));
        if (msg.content) blocks.push({ type: 'text', text: msg.content });
        result.push({ role: 'user', content: blocks });
      } else {
        result.push({ role: 'user', content: msg.content });
      }
      i++;
    } else if (msg.role === 'assistant') {
      const content: Anthropic.ContentBlockParam[] = [];
      // Thinking blocks lead the assistant turn — the order the API emits them
      // in, and the order it documents for replaying them unchanged when a
      // conversation continues on the same model. Verified live on
      // claude-sonnet-5: an 826-byte payload of signed blocks round-tripped and
      // was accepted. (Dropping them was also tolerated, so this is contract
      // adherence, not a fix for an observed 400.) The provider tag stops
      // another vendor's trace being reinterpreted as thinking blocks.
      if (msg.reasoning?.provider === 'anthropic') {
        for (const block of parseThinkingBlocks(msg.reasoning.content)) {
          content.push(block as unknown as Anthropic.ContentBlockParam);
        }
      }
      if (msg.content) content.push({ type: 'text', text: msg.content });
      for (const tc of msg.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
      }
      result.push({ role: 'assistant', content });
      i++;

      // Batch all consecutive tool results into ONE user message
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      while (i < messages.length && messages[i].role === 'tool') {
        const t = messages[i] as Extract<AicoMessage, { role: 'tool' }>;
        toolResults.push({ type: 'tool_result', tool_use_id: t.toolCallId, content: t.content });
        i++;
      }
      if (toolResults.length > 0) {
        result.push({ role: 'user', content: toolResults });
      }
    } else {
      // Standalone tool messages shouldn't appear outside an assistant context,
      // but guard against it by treating as a user message.
      result.push({ role: 'user', content: (msg as any).content ?? '' });
      i++;
    }
  }

  return result;
}

/**
 * Append turn-volatile context to the tail of the request.
 *
 * Called after {@link applyMessageCacheBreakpoints} so the block always lands
 * *behind* the last breakpoint. That ordering is the whole point: the block
 * changes every turn, and anything cached behind it would be invalidated by it.
 *
 * It is merged into the trailing user turn when there is one, rather than
 * pushed as its own message, so the model reads it as part of the same turn it
 * is responding to instead of as a separate instruction that arrived from
 * nowhere.
 */
export function appendVolatileContext(
  messages: Anthropic.MessageParam[],
  context?: string,
): void {
  if (!context?.trim()) return;
  const block: Anthropic.TextBlockParam = { type: 'text', text: context };
  const last = messages[messages.length - 1];

  if (last?.role === 'user') {
    if (typeof last.content === 'string') {
      last.content = [{ type: 'text', text: last.content }, block];
    } else {
      last.content.push(block);
    }
    return;
  }
  // No trailing user turn (an assistant turn is last, e.g. after steering).
  // A fresh user message is the only place it can go.
  messages.push({ role: 'user', content: [block] });
}

// ── Prompt-cache breakpoints ─────────────────────────────────────────
//
// Anthropic allows 4 `cache_control` breakpoints per request and AICO spends
// all four deliberately:
//
//   1. the last tool definition  — survives a system-prompt change, because
//      tools render before system and are invalidated only by their own edit
//   2. the last system block     — covers tools + system together
//   3. the second-to-last message
//   4. the last message
//
// Slots 3 and 4 are the ones that matter for cost. A coding agent's transcript
// grows past the system prompt within a few steps, and every step re-sends all
// of it; caching only the static header leaves the expensive half uncached.
//
// Two message breakpoints rather than one because of the 20-block lookback: a
// breakpoint searches at most 20 content-block positions backwards for an entry
// written by a previous request, and a single step can append more than that
// (one assistant text block, plus a tool_use and a tool_result for each
// parallel call — 1 + 2N blocks for N calls). Marking the last two message
// boundaries splits that into two shorter hops: the assistant turn is one hop
// from the previous request's breakpoint, and the tool-result turn is one hop
// from the assistant turn. A single trailing breakpoint would need N ≤ 9 to
// stay inside the window; two need only N ≤ 19.
export const MESSAGE_CACHE_BREAKPOINTS = 2;

/** Attach ephemeral breakpoints to the last `limit` cacheable message boundaries. */
export function applyMessageCacheBreakpoints(
  messages: Anthropic.MessageParam[],
  limit: number = MESSAGE_CACHE_BREAKPOINTS,
): void {
  let placed = 0;
  for (let i = messages.length - 1; i >= 0 && placed < limit; i--) {
    if (markCacheBreakpoint(messages[i])) placed++;
  }
}

/**
 * Mark the last cacheable content block of one message.
 *
 * Returns false when the message carries nothing that can hold a breakpoint, so
 * the caller moves to an earlier message rather than silently spending one of
 * the four slots on nothing. Anthropic rejects `cache_control` on an empty text
 * block and does not accept it on thinking blocks at all (those are cached
 * implicitly alongside the rest of their assistant turn).
 */
function markCacheBreakpoint(message: Anthropic.MessageParam): boolean {
  if (typeof message.content === 'string') {
    if (!message.content.trim()) return false;
    // A plain string cannot carry cache_control — promote it to a block array.
    message.content = [
      { type: 'text', text: message.content, cache_control: { type: 'ephemeral' } },
    ];
    return true;
  }

  const blocks = message.content;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i] as { type?: string; text?: string; cache_control?: unknown };
    if (block.type === 'thinking' || block.type === 'redacted_thinking') continue;
    if (block.type === 'text' && !block.text?.trim()) continue;
    block.cache_control = { type: 'ephemeral' };
    return true;
  }
  return false;
}

function toAnthropicTools(defs: ToolDef[], cacheControl: boolean): Anthropic.Tool[] {
  return defs.map((d, i) => {
    const tool: Anthropic.Tool = {
      name: d.name,
      description: d.description,
      input_schema: d.inputSchema as Anthropic.Tool['input_schema'],
    };
    // Attach a single cache breakpoint to the LAST tool definition. Anthropic
    // caches up to the breakpoint, so the entire static tool list (often the
    // bulk of the request) is cached on every subsequent turn.
    if (cacheControl && i === defs.length - 1) {
      (tool as any).cache_control = { type: 'ephemeral' };
    }
    return tool;
  });
}

// ── Loose typing for Anthropic stream events ─────────────────────
// The SDK ships strict types but stream event shapes vary across versions;
// using a permissive union avoids tight coupling to SDK internals.
interface AnthropicStreamEvent {
  type: string;
  index?: number;
  message?: {
    usage?: {
      input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  content_block?: {
    type?: string;
    id?: string;
    name?: string;
    thinking?: string;
    signature?: string;
    data?: string;
  };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    stop_reason?: string;
    thinking?: string;
    signature?: string;
  };
  usage?: { output_tokens?: number; input_tokens?: number };
}

/**
 * Convert an Anthropic SDK error into a stable aico error string that the
 * agent's retry classifier can pattern-match (status codes, rate-limit hints).
 * Mirrors what the OpenAI-compatible provider already does, so rate limits are
 * detected as rate limits rather than misclassified as transient errors.
 */
function normalizeAnthropicError(err: unknown): Error {
  const status = (err as any)?.status;
  const msg = err instanceof Error ? err.message : String(err);
  if (typeof status === 'number') {
    throw new Error(`[Anthropic] API error ${status}: ${msg}`);
  }
  throw new Error(`[Anthropic] API error: ${msg}`);
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
    // Keep a usable empty input; the agent will append the diagnostic so the
    // model can retry with well-formed arguments.
    return {
      input: {},
      parseError: `Tool arguments were not valid JSON (${reason}). Raw: ${snippet}`,
    };
  }
}
