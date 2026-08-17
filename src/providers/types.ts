/**
 * Provider abstraction types for aico.
 *
 * All AI providers (OpenAI, OpenRouter, Anthropic, Gemini, Ollama) implement
 * ProviderAPI. The agent never talks to the SDK directly — it streams events
 * from the provider and manages the tool-calling loop itself.
 */

import type { PromptDialect } from '../prompt/types.js';

// ── Tool definition (provider-agnostic) ───────────────────────────
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ── Tool call from the model ───────────────────────────────────────
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /**
   * Set when the model's tool-call arguments could not be parsed as JSON.
   * Surfaced to the model so it can correct itself rather than receiving a
   * confusing missing-argument error.
   */
  parseError?: string;
}

/**
 * A model's own reasoning trace, carried back to the provider that produced it.
 *
 * Some reasoning models want their chain of thought replayed on later requests
 * rather than treated as display-only output. Anthropic's thinking blocks carry
 * a cryptographic `signature` and are documented as needing to return unchanged
 * when a conversation continues on the same model; DeepSeek documents the same
 * for tool-calling turns. Live testing found both vendors tolerate the trace
 * being dropped, so replay is adherence to the documented contract rather than
 * a workaround for an observed failure — and it hands the model back its own
 * prior reasoning, which is the point on multi-step work.
 *
 * Either way the trace has to survive in the session log like any other
 * model-visible input, not in provider-local memory, or it is lost on resume.
 *
 * `content` is deliberately opaque — plain text for DeepSeek, but a provider is
 * free to store an encrypted blob or serialized items. `provider` gates replay
 * so a trace is never echoed to a vendor that cannot parse it (and so switching
 * models mid-session degrades to "no trace" rather than a 400).
 */
export interface ReasoningTrace {
  /** Provider id that produced this trace. */
  provider: string;
  /** Opaque payload; its shape is that provider's business. */
  content: string;
}

// ── Internal multi-turn message format ───────────────────────────
// Used within a single agentic turn (supports tool calls + results).
export type AicoMessage =
  | { role: 'user';      content: string }
  | {
      role: 'assistant';
      content: string;
      toolCalls?: ToolCall[];
      /** Reasoning trace to replay to its originating provider. */
      reasoning?: ReasoningTrace;
    }
  | { role: 'tool';      toolCallId: string; toolName: string; content: string };

// ── Streaming events from provider ───────────────────────────────
export type ChatEvent =
  | { type: 'text';      content: string }
  | {
      /**
       * A delta of the model's reasoning trace, separate from `text` because it
       * is not part of the answer: it renders differently, and for providers
       * that demand it back (see {@link ReasoningTrace}) the agent accumulates
       * these into the trace stored on the assistant message.
       */
      type: 'reasoning';
      delta: string;
      /**
       * Opaque payload to store as the step's {@link ReasoningTrace} instead of
       * the concatenated deltas.
       *
       * Needed when the replayable form is not the readable form. Anthropic's
       * thinking blocks carry a cryptographic `signature` and must be echoed
       * back byte-identical, so the display text alone cannot reconstruct them;
       * DeepSeek's `reasoning_content` is plain text and needs no such payload.
       * When several arrive in one step the last wins.
       */
      replay?: string;
    }
  | {
      type: 'tool_call';
      id: string;
      name: string;
      input: Record<string, unknown>;
      /**
       * Set when the model's tool-call arguments could not be parsed as JSON.
       * The agent surfaces this diagnostic to the model so it can correct
       * itself, rather than silently dispatching with empty args.
       */
      parseError?: string;
    }
  | {
      type: 'usage';
      /**
       * TOTAL prompt tokens for this request, inclusive of both cache counts
       * below.
       *
       * Vendors disagree here — OpenAI's `prompt_tokens` already contains the
       * cached tokens, Anthropic's `input_tokens` counts only the uncached
       * remainder after the last cache breakpoint. Each provider normalizes to
       * this one convention at its own boundary (see providers/usage.ts), so
       * downstream cost accounting is never vendor-dependent.
       */
      inputTokens: number;
      outputTokens: number;
      /**
       * Subset of `inputTokens` served from a warm prompt cache, billed at
       * roughly 0.1x the input rate. 0 when caching is unsupported or cold.
       */
      cacheReadTokens?: number;
      /**
       * Subset of `inputTokens` written to the prompt cache by this request.
       * Anthropic bills these at 1.25x the input rate; OpenAI charges no write
       * premium and reports none, leaving this 0.
       */
      cacheWriteTokens?: number;
    }
  | {
      /**
       * Why the model stopped generating.
       *
       * `length` means the reply was truncated at the output-token ceiling.
       * Without this signal a truncated answer is indistinguishable from a
       * complete one, so the agent would report success on a cut-short turn —
       * exactly the "report orthogonal outcomes independently" failure.
       */
      type: 'finish';
      reason: FinishReason;
    };

/**
 * Normalized stop reason across providers.
 *
 * `blocked` is distinct from `other` on purpose: a safety classifier declining
 * a request arrives as a successful HTTP 200 with empty or partial content, so
 * without its own value it is indistinguishable from a clean short answer.
 */
export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'blocked' | 'other';

// ── Provider API ─────────────────────────────────────────────────
export interface ProviderChatOptions {
  model: string;
  /**
   * The frozen part of the system prompt. Must be byte-identical across
   * requests in a session — everything downstream of it, including the entire
   * message history, is cached against it as a prefix.
   */
  systemPrompt: string;
  messages: AicoMessage[];
  /**
   * Context that changes between turns — working-tree state, live agent and
   * cron rosters, per-task mode notes.
   *
   * It cannot live in `systemPrompt`. Providers render `tools → system →
   * messages`, so a single byte of churn in the system block changes the prefix
   * of *every* message behind it and invalidates the conversation cache as
   * well. A coding agent edits files constantly, so that is not an edge case:
   * it is every turn.
   *
   * Providers therefore append this at the very tail of the request, after the
   * last cache breakpoint, where it invalidates nothing before it. It is paid
   * for in full on every request — a few hundred tokens — instead of costing
   * the whole transcript a cache miss.
   */
  volatileContext?: string;
  tools: ToolDef[];
  maxTokens?: number;
  /**
   * Abort signal. When aborted, the provider should cancel the in-flight
   * HTTP stream rather than letting the socket linger. Both the OpenAI and
   * Anthropic SDKs forward `signal` into their request layer.
   */
  signal?: AbortSignal;
}

export interface ProviderAPI {
  readonly id: string;
  readonly displayName: string;
  /**
   * How this vendor documents its prompts should be shaped.
   *
   * Declared by the provider so the prompt layer never switches on provider id
   * to decide formatting — adding a vendor is a dialect on its class, not an
   * edit to every prompt. See `src/prompt/dialects.ts` for what each is based
   * on.
   */
  readonly promptDialect: PromptDialect;
  chat(opts: ProviderChatOptions): AsyncGenerator<ChatEvent>;
}
