/**
 * Turning a named agent into the three things a run needs.
 *
 * A spec is a description; a run needs a system prompt, a tool list and a
 * model. That translation existed once, inside the Task tool, which was fine
 * while delegation was the only way to reach an agent. It is not any more —
 * a person can now hold a whole conversation with one — and two copies of this
 * would drift in exactly the way that matters: an agent that behaves one way
 * when the orchestrator delegates to it and another way when you talk to it is
 * worse than one that does not exist.
 *
 * **An agent's skills are inlined, not merely named.** `AgentSpec.skills` is
 * what makes a specialist more than a system prompt with opinions, and naming
 * a skill the agent then has to go and open is a step that may not happen. The
 * procedure text is put in front of it. The rest of the catalogue is still
 * offered the usual way, so an agent can reach for something not on its list
 * when the work calls for it.
 *
 * @module agents/resolve
 */

import type { AgentSpec } from './types.js';
import { getAgentSpec } from './registry.js';
import { skillRegistry } from '../skills/index.js';
import { isDisabled } from '../registry-state.js';

export interface ResolvedAgent {
  spec: AgentSpec;
  /** False when the agent has been switched off since it was chosen. */
  enabled: boolean;
  /** The system prompt this agent runs under. */
  instructions?: string;
  /** Tools it may use, or undefined for the default set. */
  tools?: string[];
  /** A model it is pinned to, if any. */
  model?: string;
  /** Skills named by the spec that do not exist, so the caller can say so. */
  missingSkills: string[];
}

/** The skill procedures an agent should have in front of it. */
export function inlineSkills(names: string[]): { block: string; missing: string[] } {
  const parts: string[] = [];
  const missing: string[] = [];

  for (const name of names) {
    const skill = skillRegistry.lookup(name);
    // A disabled skill is left out here too. Switching one off and then having
    // an agent quote it anyway is the kind of inconsistency that makes people
    // stop trusting the switch.
    if (!skill || isDisabled('skills', skill.frontmatter.name)) { missing.push(name); continue; }
    if (skill.promptTemplate) {
      parts.push(`## Skill: ${skill.frontmatter.name}\n${skill.promptTemplate}`);
    }
  }

  return {
    block: parts.length
      ? `\n\n## Assigned Skills\nFollow these procedures when they apply:\n\n${parts.join('\n\n')}\n`
      : '',
    missing,
  };
}

/**
 * The persona a session should run under, and what to say if it cannot.
 *
 * Wraps `resolveAgent` with the two things every caller needs to handle and
 * would otherwise each handle differently: an agent that has been deleted since
 * it was chosen, and one that has been switched off since. Both fall back to
 * the orchestrator with a reason rather than stranding the session or —
 * worse — carrying on as though the switch had not happened, which is the same
 * lie a disabled skill would be if it were still quoted at an agent.
 */
export async function personaFor(
  name: string | undefined,
  cwd?: string,
): Promise<{ persona?: { name: string; instructions: string }; tools?: string[]; model?: string; notice?: string }> {
  if (!name) return {};

  const resolved = await resolveAgent(name, cwd);
  if (!resolved) {
    return { notice: `The agent "${name}" no longer exists, so this turn ran as the orchestrator.` };
  }
  if (!resolved.enabled) {
    return {
      notice: `The agent "${resolved.spec.name}" is switched off, so this turn ran as the orchestrator. `
        + 'Enable it in Settings to go back to talking to it.',
    };
  }
  if (!resolved.instructions) return {};

  return {
    persona: { name: resolved.spec.name, instructions: resolved.instructions },
    ...(resolved.tools?.length ? { tools: resolved.tools } : {}),
    ...(resolved.model ? { model: resolved.model } : {}),
  };
}

/**
 * Look up an agent and work out how to run it.
 *
 * Returns undefined when there is no such agent, so the caller can say which
 * ones there are rather than failing silently.
 */
export async function resolveAgent(name: string, cwd?: string): Promise<ResolvedAgent | undefined> {
  const spec = await getAgentSpec(name, cwd);
  if (!spec) return undefined;

  const { block, missing } = inlineSkills(spec.skills ?? []);
  const instructions = (spec.systemPromptXml || '') + block;

  return {
    spec,
    enabled: !isDisabled('agents', spec.name),
    instructions: instructions.trim() ? instructions : undefined,
    tools: spec.tools?.length ? spec.tools : undefined,
    model: spec.model,
    missingSkills: missing,
  };
}
