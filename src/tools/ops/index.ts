/**
 * The ops tools, as the registry sees them: SSH (exec, copy, tunnel), HTTP
 * APIs, WinRM and SNMP — the tools that let the agent operate the owner's
 * machines with credentials it can use but never read.
 *
 * Kept together behind one dispatcher so the tool registry (`tools/index.ts`)
 * gains one import and one `case` group rather than six, and so the list of
 * vault consumers (`OPS_TOOL_NAMES`) cannot drift from what is dispatched:
 * `tools/credentials.ts` classifies every name here as a `consumer`, and the
 * registry invariant test fails for a registered tool that is not classified.
 *
 * Contracts, security model and limits: docs/security/ops-tools.md.
 * Database clients (`DbQuery`) are deliberately not here yet — see that doc.
 *
 * @module tools/ops
 */

import type { ApprovalPrompter } from '../../vault/index.js';
import type { ToolPipeline } from '../pipeline.js';
import { OpsError, runWithOpsPrompter } from './common.js';
import { httpRequest, httpRequestDefinition, type HttpRequestInput } from './http.js';
import { snmpQuery, snmpQueryDefinition, type SnmpQueryInput } from './snmp.js';
import {
  sshCopy, sshCopyDefinition, sshExec, sshExecDefinition, sshTunnel, sshTunnelDefinition,
  type SshCopyInput, type SshExecInput, type SshTunnelInput,
} from './ssh.js';
import { winRmExec, winRmExecDefinition, type WinRmExecInput } from './winrm.js';

export { setOpsProgressSink } from './common.js';

/** Every ops tool name. Each is a vault consumer. */
export const OPS_TOOL_NAMES = ['SshExec', 'SshCopy', 'SshTunnel', 'HttpRequest', 'WinRmExec', 'SnmpQuery'] as const;
export type OpsToolName = (typeof OPS_TOOL_NAMES)[number];

/** Ops tools whose live output is worth streaming to a client while they run. */
export const STREAMING_OPS_TOOLS: ReadonlySet<string> = new Set(['SshExec', 'WinRmExec']);

export function isOpsTool(name: string): name is OpsToolName {
  return (OPS_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * Registry entries. Concurrency: SSH and WinRM are exclusive — one remote
 * command at a time keeps approvals and live output unambiguous, and long
 * work goes to `background`. HTTP and SNMP requests are independent and may
 * overlap.
 */
export const opsToolDefinitions = [
  { ...sshExecDefinition, isConcurrencySafe: false, maxResultSizeChars: 50_000 },
  { ...sshCopyDefinition, isConcurrencySafe: false, maxResultSizeChars: 5_000 },
  { ...sshTunnelDefinition, isConcurrencySafe: false, maxResultSizeChars: 3_000 },
  { ...httpRequestDefinition, isConcurrencySafe: true, maxResultSizeChars: 60_000 },
  { ...winRmExecDefinition, isConcurrencySafe: false, maxResultSizeChars: 50_000 },
  { ...snmpQueryDefinition, isConcurrencySafe: true, maxResultSizeChars: 60_000 },
];

/** Dispatch one ops tool call. Throws OpsError with a message the model can act on. */
export async function executeOpsTool(name: OpsToolName, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  switch (name) {
    case 'SshExec': return sshExec(args as unknown as SshExecInput, signal);
    case 'SshCopy': return sshCopy(args as unknown as SshCopyInput, signal);
    case 'SshTunnel': return sshTunnel(args as unknown as SshTunnelInput, signal);
    case 'HttpRequest': return httpRequest(args as unknown as HttpRequestInput, signal);
    case 'WinRmExec': return winRmExec(args as unknown as WinRmExecInput, signal);
    case 'SnmpQuery': return snmpQuery(args as unknown as SnmpQueryInput, signal);
    default: throw new OpsError(`Unknown ops tool ${String(name)}.`);
  }
}

/**
 * Install the `ops:prompter` stage: carries the run's own approval dialog
 * (the terminal UI's permission callback) into the ops tools, for the case
 * where no process-wide prompter is set. A server or AICO Desktop sets one,
 * and then this is never consulted. Idempotent by stage name.
 */
export function installOpsStages(pipeline: ToolPipeline, options: { fallbackPrompter?: ApprovalPrompter }): void {
  if (pipeline.describe().around.includes('ops:prompter')) return;
  pipeline.onAroundExecute('ops:prompter', (ctx, next) => (
    isOpsTool(ctx.name) ? runWithOpsPrompter(options.fallbackPrompter, next) : next()
  ));
}
