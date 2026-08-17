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

export function buildTeamPrompt(input: {
  requirements: string;
  agents: AgentSpec[];
  availableSkills: Skill[];
}): string {
  const productOwner = input.agents.find((a) => a.name === 'product-owner') ?? input.agents[0];
  return [
    '<aico_agent_team>',
    '  <mission>',
    input.requirements,
    '  </mission>',
    '  <quality_bar>',
    '    <target>Production-grade implementation that satisfies P0 requirements and avoids known regressions.</target>',
    '    <target>At least 80-90% requirement accuracy before final delivery; never claim completion when material gaps remain.</target>',
    '    <target>Basic security measures: validation, auth/authz where relevant, secret hygiene, safe defaults, and dependency awareness.</target>',
    '    <target>Tests/build/typecheck/QA evidence must be collected where the project supports it.</target>',
    '  </quality_bar>',
    '  <team_lead>',
    `    <agent>${productOwner?.name ?? 'product-owner'}</agent>`,
    '    <responsibility>Own acceptance criteria, inspect final work, reject incomplete delivery, and order follow-up fixes.</responsibility>',
    '  </team_lead>',
    '  <agents>',
    ...input.agents.map((a) => [
      `    <agent name="${a.name}" source="${a.source}">`,
      `      <role>${a.role}</role>`,
      `      <skills>${a.skills.join(', ') || '(none declared)'}</skills>`,
      `      <can_delegate>${a.canDelegate}</can_delegate>`,
      '    </agent>',
    ].join('\n')),
    '  </agents>',
    formatSkills(input.availableSkills),
    '  <operating_protocol>',
    '    <step index="1">Product Owner extracts P0/P1/P2 requirements and writes acceptance criteria.</step>',
    '    <step index="2">Architect creates a concise implementation plan and assigns work to specialist agents.</step>',
    '    <step index="3">Spawn specialist agents with Task for independent work. Every Task prompt must include the mission, relevant acceptance criteria, files/dirs, expected outputs, and report format.</step>',
    '    <step index="4">Implementation agents modify code and run focused verification.</step>',
    '    <step index="5">QA agent runs tests/browser checks where available and writes defects with repro steps.</step>',
    '    <step index="6">Security agent checks obvious security weaknesses and dependency/config risks.</step>',
    '    <step index="7">Product Owner reviews actual code/results against acceptance criteria. If rejected, spawn healer/implementation agents for remaining gaps and repeat up to three repair loops.</step>',
    '    <step index="8">Write a final team report with WorkspaceWrite and summarize evidence to the user.</step>',
    '  </operating_protocol>',
    '  <communication_rules>',
    '    <rule>Agents communicate through complete Task prompts, WorkspaceWrite reports, and concise parent summaries.</rule>',
    '    <rule>Do not assume a sub-agent has conversation context; pass all required details.</rule>',
    '    <rule>Use parallel Task calls only for independent work with disjoint ownership.</rule>',
    '    <rule>When requirements are unclear, ask the user one concise clarification before implementation.</rule>',
    '  </communication_rules>',
    '</aico_agent_team>',
  ].join('\n');
}
