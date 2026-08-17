/**
 * The system prompt, as data.
 *
 * Content is authored once here as a {@link PromptDocument} and rendered per
 * provider by `src/prompt/`. Nothing in this file knows which vendor it is
 * talking to, and nothing here formats anything — no headings, no tags. That is
 * what lets one prompt serve XML and Markdown dialects without a second copy
 * drifting out of sync with the first.
 *
 * To add an instruction: add or extend a section below. To add one for a single
 * vendor: give it `only: ['anthropic']`. To have it echoed after the transcript
 * on vendors whose guidance asks for that: mark it `reprise: true`.
 *
 * @module prompts
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import path from 'path';
import { loadMemory } from './memory/index.js';
import type { MemoryEntry } from './memory/types.js';
import { PromptDocument } from './prompt/index.js';

const execAsync = promisify(exec);

async function getGitStatus(): Promise<string> {
  try {
    const { stdout } = await execAsync('git status --short', { cwd: process.cwd() });
    return stdout.trim();
  } catch {
    return '';
  }
}

/**
 * Working-tree state, for the volatile tail of the request.
 *
 * Deliberately not part of {@link buildSystemPrompt}. Providers render
 * `tools → system → messages`, so churn anywhere in the system block changes
 * the prefix of every message behind it. Git status moves the moment the agent
 * writes a file — most turns — so keeping it in the system prompt meant a
 * coding session never held a warm conversation cache. Re-sending a few hundred
 * tokens at the tail is cheaper than re-billing the whole transcript.
 */
export async function buildVolatileContext(): Promise<string> {
  const gitStatus = await getGitStatus();
  return gitStatus
    ? `Git status:\n${gitStatus}`
    : 'Git status: (clean or not a git repo)';
}

/**
 * Heading for one memory source.
 *
 * The memory loader has its own markdown-formatted variant of this used by
 * `/memory` and other text surfaces. The prompt path deliberately does not
 * reuse it: a hard-coded `## Project Memory` heading is markdown structure, and
 * dropping markdown structure into an XML prompt is exactly the inconsistency
 * Google's guidance warns about and Anthropic's XML convention exists to avoid.
 * Here the label is data, and the renderer decides how to mark it up.
 *
 * The memory *content* is left exactly as the user wrote it — if their AICO.md
 * uses markdown, it stays markdown. Rewriting someone's notes to match a
 * dialect would be a worse trade than a little mixed formatting inside a
 * clearly-delimited section.
 */
function memoryLabel(entry: MemoryEntry, cwd: string): { id: string; title: string } {
  switch (entry.type) {
    case 'user':
      return { id: 'user_memory', title: 'User memory (~/.aico/AICO.md)' };
    case 'parent':
      return {
        id: 'parent_memory',
        title: `Parent directory memory (${path.relative(os.homedir(), entry.path)})`,
      };
    case 'rules':
      return {
        id: 'project_rule',
        title: `Project rule (${path.relative(cwd, entry.path)})`,
      };
    case 'project':
      return { id: 'project_memory', title: 'Project memory (AICO.md)' };
    case 'local':
      return { id: 'local_memory', title: 'Local memory (AICO.local.md)' };
  }
}

/** Effort wording. Only the levels that change behaviour have an entry. */
const EFFORT_GUIDANCE: Record<string, string> = {
  low: 'Be concise and fast. Prefer the simplest working solution. Skip edge cases.',
  high: 'Be thorough and detailed. Explore edge cases and document your work.',
  max: 'Use maximum effort. Explore all options exhaustively. Leave nothing unchecked.',
};

/**
 * Build the system prompt document.
 *
 * Returns the document rather than a string so the caller can render it for
 * whichever provider it ends up talking to — and so callers can inject their
 * own sections before rendering.
 */
export async function buildSystemPrompt(
  model: string,
  effort?: string,
): Promise<PromptDocument> {
  const memory = await loadMemory();
  const doc = new PromptDocument();

  doc.add({
    id: 'role',
    order: 0,
    body: `You are aico, an expert AI coding assistant powered by ${model}.
You have tools to read, write, and edit files, run shell commands, search
codebases, fetch web pages, and manage todos. You also have a dedicated
per-project workspace for generated artifacts, QA reports, logs, scratch files,
and session-specific outputs.`,
  });

  doc.add({
    id: 'environment',
    order: 10,
    body: `Working directory: ${process.cwd()}
Platform: ${process.platform}
OS: ${os.version()}`,
  });

  // Marked for reprise: these are the rules that decide what the model does
  // next, which is exactly what OpenAI's and Google's long-context guidance
  // says to restate after the context rather than only before it.
  doc.add({
    id: 'behaviour',
    order: 20,
    reprise: true,
    body: `- Think step by step before acting.
- Prefer small, targeted edits over large rewrites.
- Always read a file before editing it unless you just created it.
- Confirm your understanding of the task before writing code.
- Use the Todo tools to track multi-step work. Create a todo for each distinct step of a non-trivial task, and mark one complete only AFTER verifying that step's outcome — not when you start it.
- After editing or writing code, verify it works before declaring the task done. Run the project's typecheck, lint, build, or tests (\`tsc --noEmit\`, \`npm test\`, \`npm run build\`) when they exist, and fix anything they surface before finishing.
- After a non-trivial edit, re-read the changed file to confirm the change landed as intended.
- Do not stop with a summary while open todos remain or verification is failing. If you believe the task is done, your final message should state what you verified, not just what you changed.
- If a verification step fails repeatedly and you cannot resolve it, surface the specific blocker — what failed, what you tried — rather than claiming success.
- Be concise in prose; be thorough in code.`,
  });

  doc.add({
    id: 'capabilities',
    order: 30,
    body: `- Use WorkspaceInfo, WorkspaceWrite, WorkspaceRead, and WorkspaceList for durable artifacts and reports.
- Use CapabilityReport to inspect your current tools, commands, MCP servers, and execution powers.
- Use AgentList, AgentRead, AgentCreate, AgentPrompt, and TeamPrompt for specialist agents, reusable roles, and agent teams.
- You can CREATE agents with AgentCreate — a role, goals, tools, skills, and a pinned model. Created agents are immediately spawnable via Task with agent_name.
- You can CREATE skills with SkillCreate — a prompt template that becomes a reusable /command or auto-trigger. Skills can be assigned to agents to give them specialized procedures.
- You can DEFINE pipelines by writing .aico/pipeline.json with phases, agent types, models, and conditions. Run them with /studio.
- You can ASSIGN skills to agents (via AgentCreate or by editing the agent spec); the skill's prompt is injected into the agent's instructions at spawn time.
- You can SPAWN any agent via Task: agent_spec for a fully custom inline agent, agent_name for a registered spec, or subagent_type for a predefined role.
- Pass complete context to every delegated Task — sub-agents do not inherit the conversation.`,
  });

  if (effort && EFFORT_GUIDANCE[effort]) {
    doc.add({
      id: 'effort',
      order: 40,
      reprise: true,
      body: `${effort.toUpperCase()} — ${EFFORT_GUIDANCE[effort]}`,
    });
  }

  // Anthropic only: the format of the prompt influences the format of the
  // reply, and their guidance says so outright. On an XML dialect this nudges
  // output away from reflexive bullet lists; on Markdown dialects it would be
  // asking the model to contradict the shape of its own instructions.
  doc.add({
    id: 'output_style',
    order: 50,
    only: ['anthropic'],
    body: `Write prose in plain paragraphs. Reserve markdown for code, file paths,
and genuinely tabular data. Do not reach for bullet lists when a sentence
carries the same information.`,
  });

  // One section per memory source rather than one pre-formatted blob, so each
  // is labelled in the active dialect and can be targeted or overridden by id.
  const cwd = process.cwd();
  memory.sections.forEach((entry: MemoryEntry, index: number) => {
    if (!entry.content.trim()) return;
    const { id, title } = memoryLabel(entry, cwd);
    // `append` rather than `add`: several files can share a label (multiple
    // project rules), and the later one must not silently replace the earlier.
    doc.append(id, entry.content, { title, order: 60 + index });
  });

  return doc;
}
