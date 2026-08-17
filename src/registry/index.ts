/**
 * Capability registry — named services resolved from a context rather than
 * imported as singletons.
 *
 * A singleton import is a hard edge: the agent loop that reaches for one can
 * only ever be given that one. Resolving `llm` and `tools` through a context
 * instead lets a composition hand one agent a different provider or a narrowed
 * tool set without touching the loop — which is also what makes the loop
 * testable without a live backend.
 *
 * @module registry
 */

export type { Capabilities, CapabilityKey, Disposer } from './context.js';
export { Context, createContext } from './context.js';

export type {
  LlmCapability,
  RegisteredTool,
  SessionsCapability,
  ToolExecutor,
  ToolPolicyCapability,
  ToolRegistryCapability,
} from './capabilities.js';
// Side-effect import: registers the capability keys on `Capabilities` via
// declaration merging. Without it, `ctx.provide('llm', …)` would not typecheck
// for a consumer that imported only the Context class.
import './capabilities.js';

export type { ToolRegistryOptions } from './tool-registry.js';
export { DefaultToolRegistry } from './tool-registry.js';

export type { BootOptions } from './boot.js';
export {
  createLlmCapability,
  createRootContext,
  createSessionsCapability,
  createToolPolicyCapability,
} from './boot.js';
