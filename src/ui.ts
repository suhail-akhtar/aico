import chalk from 'chalk';
import { createPatch } from 'diff';

const TOOL_ICONS: Record<string, string> = {
  Bash: '⚡',
  Read: '📖',
  Write: '✏️',
  Edit: '✏️',
  Glob: '🔍',
  Grep: '🔎',
  LS: '📁',
  WebFetch: '🌐',
  TodoRead: '📋',
  TodoWrite: '📋',
};

// Simple stdout-only spinner — uses \r (no cursor movement codes) so readline
// cursor tracking is never disturbed. Never touches process.stdin.
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerInterval: ReturnType<typeof setInterval> | null = null;
let spinnerFrameIdx = 0;

export function startSpinner(text: string): void {
  if (spinnerInterval) stopSpinner();
  spinnerFrameIdx = 0;
  spinnerInterval = setInterval(() => {
    const frame = chalk.cyan(SPINNER_FRAMES[spinnerFrameIdx % SPINNER_FRAMES.length]);
    process.stdout.write(`\r${frame} ${text}   `);
    spinnerFrameIdx++;
  }, 80);
}

export function stopSpinner(_finalMsg?: string): void {
  if (spinnerInterval) {
    clearInterval(spinnerInterval);
    spinnerInterval = null;
    // \r + erase to end of line — leaves cursor at column 0, no vertical movement
    process.stdout.write('\r\x1b[K');
  }
}

export function showToolCall(name: string, args: Record<string, unknown>, verbose: boolean): void {
  const icon = TOOL_ICONS[name] ?? '🔧';
  const label = chalk.cyan.bold(`${icon} ${name}`);

  if (verbose) {
    console.log(`\n${label}`);
    console.log(chalk.gray(JSON.stringify(args, null, 2)));
  } else {
    // Show a brief summary based on tool type
    let summary = '';
    if (args.command) summary = String(args.command).slice(0, 80);
    else if (args.file_path) summary = String(args.file_path);
    else if (args.pattern) summary = String(args.pattern);
    else if (args.url) summary = String(args.url);
    else if (args.path) summary = String(args.path);
    console.log(`\n${label} ${chalk.gray(summary)}`);
  }
}

export function showToolResult(name: string, result: unknown, verbose: boolean): void {
  if (!verbose) return;

  let display: string;
  if (typeof result === 'string') {
    display = result.slice(0, 500);
  } else if (result && typeof result === 'object') {
    display = JSON.stringify(result, null, 2).slice(0, 500);
  } else {
    display = String(result);
  }

  console.log(chalk.gray(`  → ${display}`));
}

export function showDiff(filepath: string, oldContent: string, newContent: string): void {
  const patch = createPatch(filepath, oldContent, newContent, '', '');
  const lines = patch.split('\n');
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      process.stdout.write(chalk.green(line) + '\n');
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      process.stdout.write(chalk.red(line) + '\n');
    } else if (line.startsWith('@@')) {
      process.stdout.write(chalk.cyan(line) + '\n');
    } else {
      process.stdout.write(chalk.gray(line) + '\n');
    }
  }
}

export function showError(msg: string): void {
  console.error(chalk.red.bold('✖ Error: ') + chalk.red(msg));
}

export function showAssistantMessage(msg: string): void {
  console.log('\n' + chalk.white(msg));
}

// ── Studio pipeline UI ────────────────────────────────────────────────────────

const PHASE_ICONS: Record<string, string> = {
  running: '▶',
  done: '✅',
  failed: '✖',
  waiting: '⏸',
};

const PHASE_COLORS: Record<string, (s: string) => string> = {
  running: (s) => chalk.cyan(s),
  done: (s) => chalk.green(s),
  failed: (s) => chalk.red(s),
  waiting: (s) => chalk.gray(s),
};

export function showPhaseProgress(
  phaseIndex: number,
  totalPhases: number,
  phaseName: string,
  status: 'running' | 'done' | 'failed' | 'waiting' | 'skipped',
  detail?: string,
): void {
  const icon = PHASE_ICONS[status] ?? '?';
  const colorFn = PHASE_COLORS[status] ?? ((s: string) => s);
  const prefix = colorFn(`[Phase ${phaseIndex}/${totalPhases}] ${icon}  ${phaseName.padEnd(28)}`);
  const suffix = detail ? chalk.dim(` ${detail}`) : '';
  process.stdout.write(`${prefix}${suffix}\n`);
}

export function showHealerStatus(
  attempt: number,
  maxAttempts: number,
  strategy: 'retry' | 'simplify' | 'replan',
  errorSummary: string,
): void {
  const header = chalk.yellow(`\n[Healer] ⚠  Attempt ${attempt}/${maxAttempts} — Strategy: ${strategy.toUpperCase()}`);
  const detail = chalk.dim(`         Error: ${errorSummary.slice(0, 120)}`);
  process.stdout.write(`${header}\n${detail}\n`);
}
