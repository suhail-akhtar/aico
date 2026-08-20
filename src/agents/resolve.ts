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
    instructions: instructions.trim() ? instructions : undefined,
    tools: spec.tools?.length ? spec.tools : undefined,
    model: spec.model,
    missingSkills: missing,
  };
}
