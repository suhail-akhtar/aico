/**
 * The capability registry.
 *
 * ## Why this exists
 *
 * Every subsystem AICO has is reached by importing a module-level singleton:
 * `toolDefinitions`, `selectProvider`, `mcpRegistry`, `skillRegistry`,
 * `cronScheduler`. That works until you want to *vary* one. Adding a tool means
 * editing a `switch` in `executeTool()`; adding a provider means editing
 * `selectProvider()`. There is no way to give one agent a different tool set, or
 * to point the filesystem at a sandbox without forking every consumer of it.
 *
 * A capability is a named service resolved from a context rather than imported.
 * Three roles, all of which must exist for it to be a real seam:
 *
 *   • **Definition** — the interface, declared on {@link Capabilities}.
 *   • **Provider**   — an implementation, registered with {@link Context.provide}.
 *   • **Consumer**   — code that resolves it with {@link Context.require}.
 *
 * A definition with no consumer is decoration; a consumer that imports its
 * provider directly is not using a seam at all.
 *
 * ## Scoping
 *
 * {@link Context.extend} creates a child that inherits everything and may
 * override any of it. Overriding in a child never affects the parent, which is
 * what lets one sub-agent run with a restricted tool set, or a test swap the
 * model provider, without touching global state that another concurrent agent
 * is reading.
 *
 * ## Disposal
 *
 * Registrations unwind in reverse order, so a capability registered on top of
 * another is torn down first. Disposal is idempotent and contained: one
 * failing disposer must not strand the rest.
 *
 * @module registry/context
 */

/** Removes a registration. Idempotent. */
export type Disposer = () => void | Promise<void>;

/**
 * The capability map.
 *
 * Extended by declaration merging so each subsystem owns its own key without
 * this module importing it — the registry stays free of dependencies on the
 * things it registers, which is what keeps it swappable:
 *
 * ```ts
 * declare module './registry/context.js' {
 *   interface Capabilities { tools: ToolRegistry }
 * }
 * ```
 */
// oxlint-disable-next-line no-empty-interface -- intentionally empty; populated by declaration merging.
export interface Capabilities {}

/** Any registerable capability key. */
export type CapabilityKey = keyof Capabilities & string;

interface Registration {
  key: string;
  value: unknown;
  dispose?: Disposer;
}

/**
 * A scope holding capability registrations.
 *
 * Resolution walks up the parent chain, so a child sees everything its parent
 * provides unless it overrides it.
 */
export class Context {
  private readonly registrations: Registration[] = [];
  private readonly children = new Set<Context>();
  private disposed = false;

  /**
   * @param parent - scope to inherit from, or `undefined` for a root context.
   * @param label - diagnostic name, shown in errors and {@link describe}.
   */
  constructor(
    readonly parent?: Context,
    readonly label: string = parent ? 'child' : 'root',
  ) {}

  // ── Registration ───────────────────────────────────────────────────

  /**
   * Register a capability in this scope.
   *
   * Registering a key that already exists in THIS scope replaces it and
   * disposes the previous one — re-registering is how hot-reload works. A key
   * present only in a parent is shadowed, not replaced.
   *
   * @param key - capability name.
   * @param value - the implementation.
   * @param dispose - optional teardown for the implementation itself.
   * @returns a disposer that removes this registration.
   */
  provide<K extends CapabilityKey>(
    key: K,
    value: Capabilities[K],
    dispose?: Disposer,
  ): Disposer {
    this.assertLive();

    const existingIndex = this.registrations.findIndex(r => r.key === key);
    if (existingIndex >= 0) {
      const [previous] = this.registrations.splice(existingIndex, 1);
      void runDisposer(previous.dispose, key);
    }

    const registration: Registration = { key, value, ...(dispose ? { dispose } : {}) };
    this.registrations.push(registration);

    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const index = this.registrations.indexOf(registration);
      if (index >= 0) this.registrations.splice(index, 1);
      return runDisposer(registration.dispose, key);
    };
  }

  // ── Resolution ─────────────────────────────────────────────────────

  /** Resolve a capability, or `undefined` when nothing provides it. */
  get<K extends CapabilityKey>(key: K): Capabilities[K] | undefined {
    for (let scope: Context | undefined = this; scope; scope = scope.parent) {
      // Reverse order so the most recent registration in a scope wins.
      for (let i = scope.registrations.length - 1; i >= 0; i--) {
        if (scope.registrations[i].key === key) {
          return scope.registrations[i].value as Capabilities[K];
        }
      }
    }
    return undefined;
  }

  /**
   * Resolve a capability, or throw.
   *
   * The error names the missing capability and what is registered instead,
   * because "cannot read property of undefined" three frames deeper is how a
   * missing registration usually presents otherwise.
   */
  require<K extends CapabilityKey>(key: K): Capabilities[K] {
    const value = this.get(key);
    if (value === undefined) {
      const available = this.describe();
      throw new Error(
        `capability "${key}" is not provided in this context (${this.label}). ` +
        `Available: ${available.length > 0 ? available.join(', ') : '(none)'}. ` +
        `Register it with ctx.provide('${key}', …) before the consumer runs.`,
      );
    }
    return value;
  }

  /** Whether anything provides this capability. */
  has(key: CapabilityKey): boolean {
    return this.get(key) !== undefined;
  }

  /** Every capability visible from this scope, nearest scope first. */
  describe(): string[] {
    const seen = new Set<string>();
    for (let scope: Context | undefined = this; scope; scope = scope.parent) {
      for (const registration of scope.registrations) seen.add(registration.key);
    }
    return [...seen].sort();
  }

  // ── Scoping ────────────────────────────────────────────────────────

  /**
   * Create a child scope.
   *
   * The child inherits every capability and may override any of them without
   * the parent observing the change — which is what lets one sub-agent run with
   * a restricted tool set while another runs concurrently with the full one.
   * Disposing a parent disposes its children first.
   */
  extend(label?: string): Context {
    this.assertLive();
    const child = new Context(this, label ?? `${this.label}/child`);
    this.children.add(child);
    return child;
  }

  // ── Teardown ───────────────────────────────────────────────────────

  /**
   * Dispose this scope and everything below it.
   *
   * Children first, then this scope's registrations in reverse order, so a
   * capability registered on top of another is torn down before the one it
   * depends on. Idempotent; a failing disposer is logged and the rest still run.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    for (const child of [...this.children]) await child.dispose();
    this.children.clear();

    for (let i = this.registrations.length - 1; i >= 0; i--) {
      const registration = this.registrations[i];
      await runDisposer(registration.dispose, registration.key);
    }
    this.registrations.length = 0;

    this.parent?.children.delete(this);
  }

  /** Whether this scope has been disposed. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  private assertLive(): void {
    if (this.disposed) {
      throw new Error(`context "${this.label}" is disposed and cannot be used`);
    }
  }
}

/** Run a disposer, containing failures so one cannot strand the others. */
async function runDisposer(dispose: Disposer | undefined, key: string): Promise<void> {
  if (!dispose) return;
  try {
    await dispose();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`  ⚠ disposing capability "${key}" failed: ${reason}`);
  }
}

/** Create a root context. */
export function createContext(label = 'root'): Context {
  return new Context(undefined, label);
}
