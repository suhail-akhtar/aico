/**
 * Default composition.
 *
 * Registers the implementations AICO ships with. Everything here is a *default*,
 * not a fixture: a deployment can call {@link createRootContext} and then
 * override any capability, or build a context from scratch and register its own.
 *
 * This is the only module that knows both the capability interfaces and their
 * concrete implementations. Keeping that knowledge in one place is what lets
 * consumers depend on the interface alone.
 *
 * @module registry/boot
 */

import { detectProviderType, selectProvider } from '../providers/index.js';
import { ToolPipeline, type AdditionalContext } from '../tools/pipeline.js';
import { openSession } from '../session/index.js';
import type { Session } from '../session/index.js';
import type { AicoSettings } from '../settings.js';
import { Context, createContext } from './context.js';
import { DefaultToolRegistry, type ToolRegistryOptions } from './tool-registry.js';
import type {
  LlmCapability,
  SessionsCapability,
  ToolPolicyCapability,
} from './capabilities.js';

export interface BootOptions {
  settings?: AicoSettings;
  /** Bind the context to an already-open session. */
  session?: Session;
  /** Narrow the built-in tool set (sub-agent types, spec whitelists). */
  tools?: ToolRegistryOptions;
  label?: string;
}

/** The default LLM capability: AICO's existing provider selection. */
export function createLlmCapability(): LlmCapability {
  return {
    resolve: (model, settings) => selectProvider(model, settings),
    detect: (model, settings) => detectProviderType(model, settings),
  };
}

/** The default sessions capability. */
export function createSessionsCapability(current?: Session): SessionsCapability {
  let bound = current;
  return {
    current: () => bound,
    open: async (sessionId, cwd, name) => {
      const opened = await openSession(sessionId, cwd, name);
      bound = opened.session;
      return opened.session;
    },
  };
}

/**
 * The default tool-policy capability.
 *
 * Owns the pipeline plus the buffer that post-execute stages contribute to.
 * Buffering here rather than in the loop is what lets a stage add model-visible
 * context without the loop knowing which stage produced it.
 */
export function createToolPolicyCapability(pipeline = new ToolPipeline()): ToolPolicyCapability {
  const pending: AdditionalContext[] = [];
  return {
    pipeline,
    drainContexts: () => pending.splice(0, pending.length),
  };
}

/**
 * Compose a root context with AICO's default capabilities.
 *
 * @returns the context; dispose it to unwind every registration.
 */
export function createRootContext(options: BootOptions = {}): Context {
  const ctx = createContext(options.label ?? 'aico');

  if (options.settings) ctx.provide('settings', options.settings);
  ctx.provide('llm', createLlmCapability());
  ctx.provide('tools', new DefaultToolRegistry(options.tools ?? {}));
  ctx.provide('sessions', createSessionsCapability(options.session));
  ctx.provide('toolPolicy', createToolPolicyCapability());

  return ctx;
}
