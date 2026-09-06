import type { AgentSpec } from './types.js';
import type { Skill } from '../skills/types.js';

function formatSkills(skills: Skill[]): string {
  if (!skills.length) return '  <available_skills />';
  return [
    '  <available_skills>',
    ...skills.map((s) =>
      `    <skill name="${s.frontmatter.name}" source="${s.isBuiltin ? 'builtin' : 'user'}">${s.frontmatter.description}</skill>`,
    ),
    '  </available_skills>',
  ].join('\n');
}

export function buildAgentChatPrompt(input: {
  agent: AgentSpec;
  task: string;
  availableSkills: Skill[];
}): string {
  return [
    '<aico_agent_session>',
    input.agent.systemPromptXml,
    formatSkills(input.availableSkills),
    '  <task>',
    input.task,
    '  </task>',
    '  <execution_contract>',
    '    <step>Restate the goal and identify applicable skills.</step>',
    '    <step>Use tools directly for work that belongs to this agent.</step>',
    '    <step>If delegation is allowed, use Task only for narrow parallel subtasks with complete context.</step>',
    '    <step>Write durable notes or reports with WorkspaceWrite when useful.</step>',
    '    <step>Finish with the agent report format exactly enough for the user to act on it.</step>',
    '  </execution_contract>',
    '</aico_agent_session>',
  ].join('\n');
}
