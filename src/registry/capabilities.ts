/**
 * Capability definitions — the interface half of each seam.
 *
 * These are deliberately *interfaces*, not the concrete classes that implement
 * them today. A consumer that resolves `ctx.require('llm')` depends only on
 * what is declared here, so replacing the implementation is a configuration
 * change rather than an edit to every call site.
 *
 * Each capability declares its key on {@link Capabilities} via declaration
 * merging, which keeps `registry/context.ts` free of dependencies on the things
 * it registers.
 *
 * @module registry/capabilities
 */

import type { AicoSettings } from '../settings.js';
import type { ProviderAPI, ToolDef } from '../providers/types.js';
import type { ToolDefinition } from '../tools/index.js';
import type { AdditionalContext, ToolPipeline } from '../tools/pipeline.js';
import type { Session } from '../session/index.js';

// ── LLM ──────────────────────────────────────────────────────────────

/**
 * Model access.
 *
 * The seam that makes "swap one provider and the whole product changes" true:
 * the agent loop asks for a provider by model name and never learns which
 * concrete class answered.
 */
export interface LlmCapability {
  /**
   * Resolve a provider for a model.
   * @throws when nothing can serve the model, with guidance on configuration.
   */
  resolve(model: string, settings?: AicoSettings): ProviderAPI;
  /** Provider id that would serve this model, for display and diagnostics. */
  detect(model: string, settings?: AicoSettings): string | null;
}

// ── Tools ────────────────────────────────────────────────────────────

/** Executes one tool call. Returns the tool's raw result. */
export type ToolExecutor = (args: Record<string, unknown>) => Promise<unknown>;

/** One registered tool: its schema plus how to run it. */
export interface RegisteredTool {
  definition: ToolDefinition;
  execute: ToolExecutor;
}

/**
 * The tool registry.
 *
 * Registration is the point. Before this, adding a tool meant editing the
 * `switch` in `executeTool()` *and* the `toolDefinitions` array — two edits to
 * core for every extension. A plugin can now contribute a tool with no core
 * change, and unregister it cleanly.
 */
export interface ToolRegistryCapability {
  /**
   * Contribute a tool. Returns a disposer that unregisters it.
   * Re-registering a name replaces the previous entry, which is what makes
   * overriding a built-in possible.
   */
  register(definition: ToolDefinition, execute: ToolExecutor): () => void;
  /** Every registered tool definition, in registration order. */
  list(): ToolDefinition[];
  /** Look one up by model-facing name. */
  get(name: string): RegisteredTool | undefined;
  /** Whether a tool is registered. */
  has(name: string): boolean;
  /** Run a tool by name, applying its result caps. */
  execute(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** Provider-facing schemas for the current tool set. */
  schemas(): ToolDef[];
}

// ── Sessions ─────────────────────────────────────────────────────────

/** Access to durable conversation logs. */
export interface SessionsCapability {
  /** The session this context is bound to, if any. */
  current(): Session | undefined;
  /** Open (or resume) a session by id. */
  open(sessionId: string, cwd: string, name?: string): Promise<Session>;
}

// ── Tool policy ──────────────────────────────────────────────────────

/**
 * The guarded execution pipeline.
 *
 * Exposed as a capability so a deployment can add a stage — a timeout, a
 * metrics wrapper, an approval policy — without the agent loop knowing it
 * exists.
 */
export interface ToolPolicyCapability {
  pipeline: ToolPipeline;
  /** Context contributed by stages, drained by the loop at the step boundary. */
  drainContexts(): AdditionalContext[];
}

// ── Key declarations ─────────────────────────────────────────────────

declare module './context.js' {
  interface Capabilities {
    /** Model access. See {@link LlmCapability}. */
    llm: LlmCapability;
    /** Tool registration and execution. See {@link ToolRegistryCapability}. */
    tools: ToolRegistryCapability;
    /** Durable conversation logs. See {@link SessionsCapability}. */
    sessions: SessionsCapability;
    /** Guarded tool-execution policy. See {@link ToolPolicyCapability}. */
    toolPolicy: ToolPolicyCapability;
    /** Settings resolved for this scope. */
    settings: AicoSettings;
  }
}
