/**
 * Tools the *editor* runs, not the engine.
 *
 * Everything else aico can do, it does itself: read a file, run a command,
 * search a tree. These three cannot be done that way at all. Nothing outside VS
 * Code can read the Problems panel, because the diagnostics live in a language
 * server the editor is talking to and nobody else is. Nothing outside VS Code
 * can run a `tasks.json` task, or open a folder as a workspace.
 *
 * So they round-trip: the tool call suspends, the client is asked, and the
 * answer becomes the tool's result. That is the exact mechanism permissions and
 * native edits already use — a promise held on the server, resolved by an HTTP
 * answer — and reusing it rather than inventing a second one is the reason this
 * module is a contract and not a protocol.
 *
 * ## Why the shape is deliberately narrow
 *
 * A general "run any VS Code command" tool was the obvious design and is the
 * wrong one. `vscode.commands.executeCommand` reaches everything the editor can
 * do, including deleting files, changing settings, and installing extensions —
 * an unbounded surface that no permission prompt can describe honestly, because
 * the prompt would have to say "run `workbench.action.something`" and nobody can
 * judge that. Three named tools with named actions can each be described in a
 * sentence, and a reader can answer.
 *
 * ## What is not here, and why
 *
 * **No terminal.** Commands run on the fixed shell (`tools/shell-choice`), which
 * is visible in the transcript, cancellable, and the same on every surface. An
 * editor-hosted terminal would be a second execution path with different
 * environment and different failure modes, and the interesting bugs in this
 * project have all come from having two of something.
 *
 * @module shared/host-tools
 */

/** The tools that only exist when an editor is driving the run. */
export const HOST_TOOLS = ['VSCodeDiagnostics', 'VSCodeTasks', 'VSCodeWorkspace'] as const;

export type HostToolName = (typeof HOST_TOOLS)[number];

export function isHostTool(name: string): name is HostToolName {
  return (HOST_TOOLS as readonly string[]).includes(name);
}

/** One suspended tool call, on its way to the client. */
export interface HostCall {
  /** Correlates the answer. Generated server-side. */
  id: string;
  tool: HostToolName;
  input: Record<string, unknown>;
}

/**
 * What the client did.
 *
 * `ok: false` is a first-class outcome and becomes a failed tool call the model
 * can react to. The alternative — reporting a refusal or an unreachable editor
 * as success — is how a model comes to believe it opened a folder it did not.
 */
export interface HostAnswer {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Which capabilities a client claims.
 *
 * Sent when a turn is submitted rather than when the session is created,
 * because it is a property of *who is driving right now*: the same session can
 * be picked up in a browser tab tomorrow, where none of this is available. A
 * tool advertised on a turn the editor is not attached to would suspend on a
 * question nobody can hear.
 */
export function hostToolsFrom(raw: unknown): HostToolName[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((name): name is HostToolName => typeof name === 'string' && isHostTool(name));
}
