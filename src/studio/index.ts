/**
 * /studio command handler.
 * Arg parsing, tier/stack detection, state initialization, orchestrator prompt builder.
 */

import path from 'path';
import { detectTier, formatTierSummary } from './tier.js';
import { detectStack, getStack } from './stacks.js';
import { getPhasesForTierWithOverride } from './phases.js';
import {
  initStudioDir, makeInitialState, readState, writeState,
  studioDir, type Tier,
} from './state.js';

// ── Arg parsing ───────────────────────────────────────────────────────────────

export interface StudioArgs {
  requirements: string;
  forceTier?: Tier;
  forceStack?: string;
  projectDir: string;
  resume: boolean;
  statusOnly: boolean;
}

export function parseStudioArgs(rawArgs: string, defaultDir: string): StudioArgs {
  const args = rawArgs.trim();

  let forceTier: Tier | undefined;
  let forceStack: string | undefined;
  let projectDir = defaultDir;
  let resume = false;
  let statusOnly = false;

  // Extract flags
  let remaining = args;

  const tierMatch = remaining.match(/--tier\s+(small|medium|enterprise)/i);
  if (tierMatch) {
    forceTier = tierMatch[1].toLowerCase() as Tier;
    remaining = remaining.replace(tierMatch[0], '').trim();
  }

  const stackMatch = remaining.match(/--stack\s+(\S+)/);
  if (stackMatch) {
    forceStack = stackMatch[1];
    remaining = remaining.replace(stackMatch[0], '').trim();
  }

  const dirMatch = remaining.match(/--dir\s+"([^"]+)"|--dir\s+(\S+)/);
  if (dirMatch) {
    projectDir = path.resolve(dirMatch[1] ?? dirMatch[2]);
    remaining = remaining.replace(dirMatch[0], '').trim();
  }

  if (/--resume/i.test(remaining)) {
    resume = true;
    remaining = remaining.replace(/--resume/i, '').trim();
  }

  if (/--status/i.test(remaining)) {
    statusOnly = true;
    remaining = remaining.replace(/--status/i, '').trim();
  }

  const requirements = remaining.trim();

  return { requirements, forceTier, forceStack, projectDir, resume, statusOnly };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Derive a kebab-case project directory name from requirements text.
 * Takes the first few meaningful words, strips noise, makes a clean directory name.
 */
function deriveProjectName(requirements: string): string {
  const STOP_WORDS = new Set([
    'a', 'an', 'the', 'with', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'at', 'by',
    'is', 'it', 'that', 'this', 'can', 'has', 'have', 'be', 'my', 'i', 'we', 'our',
    'build', 'create', 'make', 'develop', 'implement', 'want', 'need', 'like', 'please',
    'simple', 'basic', 'full', 'complete',
  ]);

  const words = requirements
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w))
    .slice(0, 4);

  if (words.length === 0) return 'studio-project';

  return words.join('-').slice(0, 40) || 'studio-project';
}

// ── Status display (no agent invoked) ────────────────────────────────────────

export async function getStudioStatus(projectDir: string): Promise<string> {
  const state = await readState(projectDir);

  if (!state) {
    return 'No active studio run found in this directory.\nRun /studio <requirements> to start a new build.';
  }

  const lines: string[] = [
    `## Studio Status — ${state.tier} tier`,
    `Project: ${state.projectDir}`,
    `Stack: ${state.stack}`,
    `Started: ${new Date(state.startedAt).toLocaleString()}`,
    `Phase: ${state.currentPhase}/${state.totalPhases}`,
    `Iterations: ${state.iteration} | Heal attempts: ${state.healAttempts}`,
    '',
    '### Phases',
  ];

  for (const phase of state.phases) {
    const icons: Record<string, string> = {
      done: '✅', running: '▶', failed: '✖', pending: '⏸', skipped: '⤷',
    };
    const icon = icons[phase.status] ?? '?';
    const dur = phase.durationMs ? ` (${Math.round(phase.durationMs / 1000)}s)` : '';
    lines.push(`  ${icon} ${phase.index}. ${phase.name}${dur}`);
  }

  if (state.aborted) {
    lines.push('', '⚠  Studio was aborted. Use /studio --resume to continue.');
  } else if (state.currentPhase >= state.totalPhases && state.phases.every(p => p.status === 'done')) {
    lines.push('', '✅ Studio completed successfully.');
  } else {
    lines.push('', 'Use /studio --resume to continue from current phase.');
  }

  return lines.join('\n');
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function handleStudio(rawArgs: string, cwd: string): Promise<{
  handled: boolean;
  output?: string;
  sendAsPrompt?: string;
  runStudioPipeline?: { projectDir: string };
}> {
  const args = parseStudioArgs(rawArgs, cwd);

  // Status-only mode — no agent
  if (args.statusOnly) {
    const status = await getStudioStatus(args.projectDir);
    return { handled: true, output: status };
  }

  // Resume mode — load existing state and continue the pipeline from its
  // current phase. The pipeline reads state from disk, so just pass projectDir.
  if (args.resume) {
    const existingState = await readState(args.projectDir);
    if (!existingState) {
      return { handled: true, output: 'No studio run to resume in this directory.' };
    }

    return {
      handled: true,
      output: `Resuming studio pipeline from phase ${existingState.currentPhase}/${existingState.totalPhases}`,
      runStudioPipeline: { projectDir: args.projectDir },
    };
  }

  // New run — validate we have requirements
  if (!args.requirements) {
    return {
      handled: true,
      output: [
        'Usage: /studio <requirements> [options]',
        '',
        'Options:',
        '  --tier small|medium|enterprise   Force a specific SDLC tier',
        '  --stack <stack-id>               Force a specific tech stack',
        '  --dir <path>                     Target project directory (default: AICO workspace)',
        '  --resume                         Resume an in-progress studio run',
        '  --status                         Show current pipeline status',
        '',
        'Example:',
        '  /studio "a SaaS task manager with auth, teams, and Stripe billing"',
        '  /studio --tier small "personal expense tracker"',
        '  /studio --stack nextjs-postgresql "my custom requirements"',
      ].join('\n'),
    };
  }

  // Detect tier
  const tierResult = detectTier(args.requirements, { forceTier: args.forceTier });

  // Detect or look up stack
  let stack = detectStack(args.requirements, tierResult.tier);
  if (args.forceStack) {
    const forced = getStack(args.forceStack);
    if (forced) {
      stack = forced;
    } else {
      return {
        handled: true,
        output: `Unknown stack ID: "${args.forceStack}". Use /studio (no args) to see usage.`,
      };
    }
  }

  // Auto-generate a project subdirectory name from requirements if --dir not specified
  if (!rawArgs.includes('--dir')) {
    const projectName = deriveProjectName(args.requirements);
    args.projectDir = path.resolve(args.projectDir, projectName);
  }

  // Get phase definitions (supports custom pipeline override from .aico/pipeline.json)
  const phaseDefs = await getPhasesForTierWithOverride(tierResult.tier, args.projectDir);

  // Initialize .studio/ directory and state
  await initStudioDir(args.projectDir);

  const state = makeInitialState({
    projectDir: args.projectDir,
    requirements: args.requirements,
    tier: tierResult.tier,
    stack: stack.id,
    phases: phaseDefs.map(p => ({ name: p.name, agentType: p.agentType })),
  });

  await writeState(args.projectDir, state);

  // Run the deterministic pipeline engine instead of a single orchestrator
  // prompt. The caller (REPL) supplies the runtime adapter (runTask/askUser)
  // and appends the resulting summary. The pipeline reads state fresh from
  // disk (.studio/) each iteration, so we only need to pass the project dir.
  const tierSummary = formatTierSummary(tierResult);

  const banner = [
    `🎬 STUDIO — ${tierSummary}`,
    `   Stack: ${stack.name}`,
    `   Project: ${args.projectDir}`,
    `   Phases: ${phaseDefs.length}`,
    `   State: ${studioDir(args.projectDir)}`,
    '',
    `Starting phase 1 of ${phaseDefs.length}: ${phaseDefs[0].name}...`,
  ].join('\n');

  return {
    handled: true,
    output: banner,
    runStudioPipeline: { projectDir: args.projectDir },
  };
}
