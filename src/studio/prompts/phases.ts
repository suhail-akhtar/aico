/**
 * Per-phase orchestration prompt builder.
 * Produces the full task prompt sent to each phase sub-agent via runTask().
 */

import type { StudioState, Task } from '../state.js';
import type { PhaseDefinition } from '../phases.js';
import { SYSTEM_PROMPTS } from './system.js';

// ── Main builder ──────────────────────────────────────────────────────────────

export async function buildPhasePrompt(
  phase: PhaseDefinition,
  state: StudioState,
  taskBatch: Task[],
  context: {
    feedback?: string;
    priorContext?: string;
    iteration: number;
  },
): Promise<string> {
  const agentType = phase.agentType as keyof typeof SYSTEM_PROMPTS;
  const systemPrompt = SYSTEM_PROMPTS[agentType] ?? '';

  const parts: string[] = [
    systemPrompt,
    '',
    '---',
    '',
    `## Studio Pipeline — Phase ${state.currentPhase}/${state.totalPhases}: ${phase.name}`,
    '',
    `**Project directory:** ${state.projectDir}`,
    `**Tier:** ${state.tier}`,
    `**Stack:** ${state.stack}`,
    `**Iteration:** ${context.iteration}`,
    '',
  ];

  // Read and include any attached docs/policies for this phase (T1).
  // These are policy/guidance files the pipeline author specified — the agent
  // receives their full content and must follow them strictly.
  if (phase.docs?.length) {
    const { readFile } = await import('fs/promises');
    const { join } = await import('path');
    parts.push('## Phase Policies & Guidance (MUST follow strictly)', '');
    for (const docPath of phase.docs) {
      try {
        const absPath = docPath.startsWith('.') || docPath.startsWith('/')
          ? join(state.projectDir, docPath)
          : join(state.projectDir, docPath);
        const content = await readFile(absPath, 'utf8');
        parts.push(`### ${docPath}`, '```', content.slice(0, 5000), '```', '');
      } catch {
        parts.push(`### ${docPath}`, '*(file not found — skipped)*', '');
      }
    }
  }

  // Requirements summary
  parts.push('## Requirements Summary', '');
  parts.push(state.requirements.slice(0, 1000));
  if (state.requirements.length > 1000) parts.push('... (truncated — read .studio/PRD.md for full requirements)');
  parts.push('');

  // Feedback from previous iteration (healer context)
  if (context.feedback && context.feedback.trim()) {
    parts.push('## ⚠ Errors to Fix First (from previous iteration)', '');
    parts.push('Read `.studio/FEEDBACK.md` for the full error log. Summary:');
    parts.push('```');
    parts.push(context.feedback.slice(0, 800));
    if (context.feedback.length > 800) parts.push('... (see FEEDBACK.md for full details)');
    parts.push('```');
    parts.push('Fix these errors BEFORE implementing new tasks.');
    parts.push('');
  }

  // Task batch
  if (phase.kind === 'implementation' && taskBatch.length > 0) {
    parts.push('## Your Tasks for This Iteration', '');
    parts.push('Implement the following tasks (in order, respecting DependsOn):');
    parts.push('');
    for (const task of taskBatch) {
      const deps = task.dependsOn.length > 0 ? ` (after: ${task.dependsOn.join(', ')})` : '';
      parts.push(`- **[${task.id}]** ${task.title}${deps}`);
      if (task.errorDetail) parts.push(`  > Previous error: ${task.errorDetail}`);
    }
    parts.push('');
    parts.push('Update `.studio/TASKS.md` checkboxes as you complete each task:');
    parts.push('  - `[x]` = done successfully');
    parts.push('  - `[!]` = failed (add error detail in parentheses)');
    parts.push('');
  }

  // Phase-kind specific instructions
  parts.push(...getKindInstructions(phase, state));

  // Standard closing instructions
  parts.push('## After Completing Your Work', '');
  parts.push(`1. Update \`.studio/TASKS.md\` with final checkbox states`);
  parts.push(`2. Append a brief summary to \`.studio/CONTEXT.md\`: what you built/fixed`);
  if (context.feedback) {
    parts.push(`3. If all errors are resolved, clear \`.studio/FEEDBACK.md\` (write empty content)`);
  }
  parts.push('');

  return parts.join('\n');
}

// ── Kind-specific instructions ────────────────────────────────────────────────

function getKindInstructions(phase: PhaseDefinition, state: StudioState): string[] {
  const dir = state.projectDir;

  switch (phase.kind) {
    case 'design':
      return [
        '## Design Phase Instructions', '',
        `Read the requirements carefully. Produce the following files in \`${dir}/.studio/\`:`,
        ...phase.outputs.map(o => `- \`${dir}/.studio/${o}\``),
        '',
        'For TASKS.md — use this exact format for every task:',
        '```markdown',
        '## Phase 2: Backend',
        '',
        '- [ ] Set up Express project with TypeScript <!-- id:T001 -->',
        '- [ ] Create User model (email, passwordHash, createdAt) <!-- id:T002 DependsOn:T001 -->',
        '- [ ] Implement POST /auth/register endpoint <!-- id:T003 DependsOn:T002 -->',
        '```',
        '',
        '**Critical:** Every task must have an `id:TXXX` annotation. DependsOn must reference real IDs.',
        'Tasks should be 1-2 hours of work each. Break large tasks into smaller ones.',
        '',
      ];

    case 'implementation':
      return [
        '## Implementation Phase Instructions', '',
        `Work in: \`${dir}\``,
        '',
        'Read these files before writing code:',
        `- \`${dir}/.studio/ARCHITECTURE.md\` — architecture decisions and patterns to follow`,
        `- \`${dir}/.studio/PRD.md\` — requirements and acceptance criteria`,
        `- \`${dir}/.studio/TASKS.md\` — full task list with dependencies`,
        `- \`${dir}/.studio/CONTEXT.md\` — what has been built in previous iterations`,
        '',
        'After each task:',
        '- Update the checkbox in TASKS.md',
        '- Run `npx tsc --noEmit` — fix any type errors immediately',
        '- Do NOT move to the next task if the current one has a compile error',
        '',
        'On completion of all tasks in your batch:',
        '- Run the full build: check if `npm run build` passes',
        '- Run tests: `npm test`',
        '- Write any test failures to `.studio/FEEDBACK.md`',
        '',
      ];

    case 'testing':
      return [
        '## Testing Phase Instructions', '',
        `Project directory: \`${dir}\``,
        '',
        'Your testing mandate:',
        '1. Run `npm test` — record which tests fail',
        '2. For each failure: read the test, read the implementation, fix the implementation',
        '3. Run `npx tsc --noEmit` — fix all TypeScript errors',
        '4. Run `npm run build` — ensure production build succeeds',
        '5. Write final test results to `.studio/FEEDBACK.md` (clear it if all pass)',
        '',
        'If tests are missing, write them:',
        '- Unit tests: co-locate with source (*.test.ts)',
        '- Target 80%+ code coverage on business logic',
        '- Every API endpoint needs at least one integration test',
        '',
      ];

    case 'validation':
      if (phase.name.includes('Browser') || phase.name.includes('QA')) {
        return [
          '## Browser QA Phase Instructions', '',
          `Project directory: \`${dir}\``,
          '',
          'Browser QA process:',
          '1. Start dev server in background: `cd ' + dir + ' && npm run dev &`',
          '2. Wait for it to be ready (check the port it listens on)',
          '3. Navigate every route in the application',
          '4. For each route: check for console errors, check for broken UI, test interactions',
          '5. Test all forms: submit with valid data, submit with invalid data',
          '6. Test authentication flows if applicable',
          '7. Stop dev server when done',
          '',
          'Use Playwright MCP tools if available. Otherwise use Bash with curl to test API endpoints.',
          '',
          'Record all issues in `.studio/FEEDBACK.md`. Clear it if all checks pass.',
          '',
        ];
      }
      if (phase.name.includes('Performance')) {
        return [
          '## Performance Testing Phase Instructions', '',
          `Project directory: \`${dir}\``,
          '',
          'Run performance tests:',
          '1. Start the production build: `npm run build && npm start`',
          '2. If autocannon is available: `npx autocannon -c 50 -d 10 http://localhost:PORT/api/health`',
          '3. If k6 is available: write a simple k6 script and run it',
          '4. Measure: p95 response time (target: <200ms), requests/sec, error rate',
          '5. Write results to `.studio/performance-report.md`',
          '',
          'If load testing tools are unavailable, run the API with curl in a loop and measure response times.',
          '',
        ];
      }
      if (phase.name.includes('Security')) {
        return [
          '## Security Testing Phase Instructions', '',
          `Project directory: \`${dir}\``,
          '',
          '1. Run `npm audit` — document all vulnerabilities',
          '2. Run `npm audit fix` to auto-fix safe upgrades',
          '3. Check for hardcoded secrets: `grep -r "password\\|secret\\|apikey\\|token" src/ --include="*.ts" -l`',
          '4. Check for SQL injection patterns: `grep -r "\\`SELECT\\|query(" src/ --include="*.ts"`',
          '5. Verify all routes have auth middleware where required',
          '6. Check CORS config — no wildcard (*) in production',
          '7. Verify JWT algorithm is not "none", bcrypt rounds >= 10',
          '',
          'Write findings to `.studio/security-report.md`',
          'Fix all CRITICAL and HIGH severity issues.',
          '',
        ];
      }
      return [];

    case 'gate':
      return [
        '## Quality Gate Instructions', '',
        `Project directory: \`${dir}\``,
        '',
        'Validate the following:',
        `1. Read \`${dir}/.studio/PRD.md\` — list every P0 acceptance criterion`,
        '2. Read the source code (not just CONTEXT.md) to verify each criterion',
        '3. Run `npm test` — tests must pass',
        '4. Check `.studio/FEEDBACK.md` — must be empty or contain only INFO-level notes',
        '',
        `Write your verdict to \`${dir}/.studio/${phase.outputs[0] ?? 'gate-review.md'}\`:`,
        '',
        '```markdown',
        '# Product Owner Gate Review',
        '',
        '## Verdict: APPROVED / REJECTED',
        '',
        '## Acceptance Criteria Results',
        '- [x] User can register with email/password — VERIFIED',
        '- [!] Dashboard shows analytics chart — MISSING (not implemented)',
        '',
        '## Issues (if REJECTED)',
        '- Issue 1: ...',
        '```',
        '',
        'Only return APPROVED if all P0 criteria are met and tests pass.',
        '',
      ];

    case 'documentation':
      return [
        '## Documentation Phase Instructions', '',
        `Project directory: \`${dir}\``,
        '',
        'Read the actual source code before documenting. Do not invent features.',
        '',
        'Produce:',
        ...phase.outputs.map(o => `- \`${dir}/${o}\``),
        '',
        'README.md must include:',
        '- Project overview (2-3 sentences)',
        '- Prerequisites (Node version, required tools)',
        '- Installation: exact commands to clone, install, configure',
        '- Environment: copy .env.example, explain each variable',
        '- Running locally: start command, expected output, default port',
        '- Running tests: test command, what to expect',
        '- API overview: table of endpoints (method, path, auth required, description)',
        '- Project structure: key directories explained',
        '',
      ];

    default:
      return [];
  }
}

// ── Orchestrator prompt ───────────────────────────────────────────────────────

export function buildOrchestratorPrompt(opts: {
  requirements: string;
  tier: string;
  stack: string;
  projectDir: string;
  phases: Array<{ index: number; name: string; agentType: string; kind: string }>;
  totalPhases: number;
}): string {
  const { requirements, tier, stack, projectDir, phases, totalPhases } = opts;

  return `${SYSTEM_PROMPTS['studio-orchestrator']}

---

## USER'S REQUIREMENTS (this is what you are building)

\`\`\`
${requirements}
\`\`\`

**IMPORTANT:** You MUST include the FULL requirements above in every sub-agent Task prompt you spawn. The sub-agents have NO context from this conversation — they only see what you pass them.

---

## Project Configuration

**Project directory:** \`${projectDir}\`
**Tier:** ${tier} | **Stack:** ${stack}
**Total phases:** ${totalPhases}
**State files:** \`${projectDir}/.studio/\`

## Phases

${phases.map(p => `${p.index}. **${p.name}** — subagent_type: \`${p.agentType}\` (${p.kind})`).join('\n')}

## How to Spawn Each Phase

For EACH phase, spawn a Task tool call like this:

\`\`\`
Task({
  description: "Phase N: <phase name>",
  prompt: "<FULL instructions — see below>",
  subagent_type: "<from the phase list above>",
  timeout: 600  // 10 minutes — do NOT use the default 2 min timeout
})
\`\`\`

### What to include in EVERY sub-agent prompt:

1. **The role instruction** — Tell the agent what it is (e.g., "You are an architect designing the system")
2. **The user's requirements** — Copy the FULL requirements block above into the prompt
3. **Project directory** — \`${projectDir}\`
4. **Stack** — ${stack}
5. **What files to read first** — \`.studio/PRD.md\`, \`.studio/ARCHITECTURE.md\`, \`.studio/TASKS.md\`, \`.studio/CONTEXT.md\`
6. **What files to produce/update** — specific to the phase
7. **Quality rules** — run \`npx tsc --noEmit\` after code changes, update TASKS.md checkboxes

### Phase-specific instructions:

**Design phases (architect, product-owner):**
- Produce: PRD.md, ARCHITECTURE.md, TASKS.md with \`<!-- id:T001 DependsOn:T002 -->\` annotations
- TASKS.md must have tasks organized by phase (## Phase 2: Backend, ## Phase 3: Frontend, etc.)
- Each task must be specific and implementable in <2 hours
- All files go in \`${projectDir}/.studio/\` except scaffold/boilerplate which goes in \`${projectDir}/\`

**Implementation phases (backend, frontend):**
- Read ARCHITECTURE.md and TASKS.md before writing any code
- All code goes in \`${projectDir}/\` (NOT in .studio/)
- After each file: run \`npx tsc --noEmit\` and fix errors immediately
- Update TASKS.md checkboxes: \`[x]\` done, \`[!]\` failed
- Append summary to \`.studio/CONTEXT.md\`
- If build/test fails, write errors to \`.studio/FEEDBACK.md\`

**Testing phases (qa):**
- Run \`npm test\`, fix failures
- Target 80%+ coverage on business logic
- Write test results to \`.studio/FEEDBACK.md\` (clear if all pass)

**Documentation phases (tech-writer):**
- Read actual source code before documenting
- Produce README.md with exact setup commands

## Execution Flow

1. Read \`${projectDir}/.studio/STUDIO.json\` — check which phases are done/pending
2. Execute phases sequentially (start from first pending phase)
3. After EACH phase completes:
   - Read \`.studio/FEEDBACK.md\` — if non-empty, spawn a \`healer\` Task to fix errors
   - Update STUDIO.json: set phase status to "done" or "failed"
4. After implementation phases: run \`npx tsc --noEmit\` in \`${projectDir}\` to verify
5. After all phases: output a delivery summary

## Critical Rules

- **Timeout:** Always set \`timeout: 600\` on Task calls (10 minutes). Default 2 min is too short.
- **Requirements:** Always include the user's requirements in sub-agent prompts. Sub-agents are blank slates.
- **Project directory:** All code goes in \`${projectDir}/\`, all state in \`${projectDir}/.studio/\`.
- **Do NOT stop early.** Complete all ${totalPhases} phases.
- **Do NOT use haiku for implementation.** Use the default model (your own model) for backend/frontend/qa phases. Haiku is only suitable for simple design/doc tasks.
`.trim();
}

// ── Healer prompt ─────────────────────────────────────────────────────────────

export function buildHealerPrompt(opts: {
  strategy: 'retry' | 'simplify' | 'replan';
  attempt: number;
  phaseName: string;
  projectDir: string;
  errors: string;
  errorType: string;
}): string {
  const { strategy, attempt, phaseName, projectDir, errors, errorType } = opts;

  const strategyInstructions = {
    retry: `Fix the errors listed below. Apply targeted fixes only — do not refactor unrelated code.
After fixing, run \`npx tsc --noEmit\` and \`npm test\` to verify.
If all errors resolved, clear \`${projectDir}/.studio/FEEDBACK.md\`.`,

    simplify: `Previous fix attempt failed. Simplify the failing implementation:
- Replace complex async logic with synchronous stubs returning valid placeholder data
- Remove optional/nice-to-have features that are causing cascade errors
- Use simpler data structures (plain objects instead of complex classes)
- Goal: a compilable, runnable baseline — completeness can be restored after.
Run \`npx tsc --noEmit\` to verify after each change.`,

    replan: `Two fix attempts failed. Update the task plan instead:
- Read \`${projectDir}/.studio/TASKS.md\`
- Find the task(s) causing cascading failures
- Break each failing task into 3-5 smaller, independently implementable subtasks
- Add proper DependsOn annotations to the new subtasks
- Mark the original failing task as blocked: \`[-]\`
- The pipeline will restart the implementation loop with the new smaller tasks.`,
  };

  return `${SYSTEM_PROMPTS['healer']}

---

## Heal Attempt ${attempt}/3 — Strategy: ${strategy.toUpperCase()}
**Phase:** ${phaseName}
**Error type:** ${errorType}
**Project directory:** ${projectDir}

## Errors to Fix

\`\`\`
${errors.slice(0, 2000)}${errors.length > 2000 ? '\n... (see .studio/FEEDBACK.md for full details)' : ''}
\`\`\`

## Your Task

${strategyInstructions[strategy]}
`.trim();
}
