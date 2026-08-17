/**
 * Expert system prompt templates for each studio sub-agent role.
 *
 * Now imports from the unified prompts-registry (single source of truth) so the
 * studio pipeline, the Task tool, and the /agents chat path all use identical
 * prompts. Previously this file held strong ~300-word prompts while task.ts held
 * weak ~100-word versions and the registry held generic XML — three paths, three
 * quality levels. All three now resolve to the same registry.
 */

import { AGENT_PROMPTS } from '../../agents/prompts-registry.js';

export const SYSTEM_PROMPTS = {
  architect: AGENT_PROMPTS.architect,
  backend: AGENT_PROMPTS.backend,
  frontend: AGENT_PROMPTS.frontend,
  qa: AGENT_PROMPTS.qa,
  healer: AGENT_PROMPTS.healer,
  'product-owner': AGENT_PROMPTS['product-owner'],
  'tech-writer': AGENT_PROMPTS['tech-writer'],
  'studio-orchestrator': AGENT_PROMPTS['studio-orchestrator'],
} as const;

export type SystemPromptRole = keyof typeof SYSTEM_PROMPTS;
