/**
 * Studio disk state management.
 * All state lives in {projectDir}/.studio/ as plain Markdown + JSON.
 * Atomic writes via tmp-then-rename (same pattern as history.ts).
 */

import { readFile, writeFile, mkdir, rename, unlink, access } from 'fs/promises';
import path from 'path';

// ── Types ────────────────────────────────────────────────────────────────────

export type Tier = 'small' | 'medium' | 'enterprise';
export type PhaseStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export type TaskStatus = 'pending' | 'in_progress' | 'done' | 'failed' | 'blocked';

export interface StudioState {
  version: 1;
  projectDir: string;
  requirements: string;
  tier: Tier;
  stack: string;
  currentPhase: number;   // 1-indexed, 0 = not started
  totalPhases: number;
  iteration: number;       // global iteration count across all phases
  startedAt: number;       // epoch ms
  phases: PhaseStateEntry[];
  healAttempts: number;    // total healer invocations
  aborted: boolean;
}

export interface PhaseStateEntry {
  index: number;           // 1-indexed
  name: string;
  status: PhaseStatus;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  iterations: number;
  errorCount: number;
  agentType: string;
}

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  dependsOn: string[];     // other task IDs
  phase: number;           // phase index (1-indexed)
  errorDetail?: string;
}

// ── Paths ────────────────────────────────────────────────────────────────────

export function studioDir(projectDir: string): string {
  return path.join(projectDir, '.studio');
}

function statePath(projectDir: string): string {
  return path.join(studioDir(projectDir), 'STUDIO.json');
}
function tasksPath(projectDir: string): string {
  return path.join(studioDir(projectDir), 'TASKS.md');
}
function contextPath(projectDir: string): string {
  return path.join(studioDir(projectDir), 'CONTEXT.md');
}
function feedbackPath(projectDir: string): string {
  return path.join(studioDir(projectDir), 'FEEDBACK.md');
}
function prdPath(projectDir: string): string {
  return path.join(studioDir(projectDir), 'PRD.md');
}
function architecturePath(projectDir: string): string {
  return path.join(studioDir(projectDir), 'ARCHITECTURE.md');
}

// ── Atomic write helper ───────────────────────────────────────────────────────

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmpPath = filePath + '.tmp';
  await writeFile(tmpPath, content, 'utf8');
  // Windows requires unlinking before rename if destination exists
  if (process.platform === 'win32') {
    try { await unlink(filePath); } catch { /* ok if not exists */ }
  }
  await rename(tmpPath, filePath);
}

// ── Init ─────────────────────────────────────────────────────────────────────

export async function initStudioDir(projectDir: string): Promise<void> {
  const dir = studioDir(projectDir);
  await mkdir(dir, { recursive: true });

  // Write .gitignore for studio artifacts that shouldn't be committed
  const gitignorePath = path.join(dir, '.gitignore');
  const gitignoreContent = [
    'kanban.db',
    'kanban.db-shm',
    'kanban.db-wal',
    'qa-screenshots/',
    '*.tmp',
  ].join('\n') + '\n';

  try {
    await access(gitignorePath);
  } catch {
    await writeFile(gitignorePath, gitignoreContent, 'utf8');
  }
}

// ── State read/write ──────────────────────────────────────────────────────────

export async function readState(projectDir: string): Promise<StudioState | null> {
  try {
    const raw = await readFile(statePath(projectDir), 'utf8');
    return JSON.parse(raw) as StudioState;
  } catch {
    return null;
  }
}

export async function writeState(projectDir: string, state: StudioState): Promise<void> {
  await atomicWrite(statePath(projectDir), JSON.stringify(state, null, 2));
}

// ── TASKS.md parser ───────────────────────────────────────────────────────────

/**
 * Parse TASKS.md checkbox syntax into Task[].
 *
 * Expected format:
 *   ## Phase 2: Backend
 *   - [ ] Create user model <!-- id:T001 -->
 *   - [x] Bootstrap Express <!-- id:T000 -->
 *   - [!] JWT middleware <!-- id:T003 DependsOn:T001,T002 --> (error: ...)
 *   - [>] Auth endpoints <!-- id:T002 DependsOn:T001 -->
 */
export function parseTasksMarkdown(md: string): Task[] {
  const tasks: Task[] = [];
  let currentPhase = 1;

  for (const raw of md.split('\n')) {
    const line = raw.trim();

    // Phase header
    const phaseMatch = line.match(/^##\s+Phase\s+(\d+)/i);
    if (phaseMatch) {
      currentPhase = parseInt(phaseMatch[1], 10);
      continue;
    }

    // Task line: - [x] title <!-- id:T001 DependsOn:T002,T003 --> (error: ...)
    const taskMatch = line.match(/^-\s+\[([x!>\s-])\]\s+(.+)/i);
    if (!taskMatch) continue;

    const [, checkChar, rest] = taskMatch;

    // Extract HTML comment metadata
    const metaMatch = rest.match(/<!--(.+?)-->/);
    const meta = metaMatch ? metaMatch[1].trim() : '';

    const idMatch = meta.match(/\bid:(\S+)/);
    const depsMatch = meta.match(/\bDependsOn:([\w,]+)/i);

    const id = idMatch ? idMatch[1] : `T${tasks.length.toString().padStart(3, '0')}`;
    const dependsOn = depsMatch
      ? depsMatch[1].split(',').map(s => s.trim()).filter(Boolean)
      : [];

    // Strip metadata comment from title; capture optional error note in parens
    let title = rest.replace(/<!--.+?-->/g, '').trim();
    const errorMatch = title.match(/\(error:\s*(.+)\)\s*$/i);
    const errorDetail = errorMatch ? errorMatch[1].trim() : undefined;
    title = title.replace(/\(error:.+\)\s*$/i, '').trim();

    const statusMap: Record<string, TaskStatus> = {
      'x': 'done',
      '!': 'failed',
      '>': 'in_progress',
      '-': 'in_progress',
      ' ': 'pending',
    };
    const status: TaskStatus = statusMap[checkChar.toLowerCase()] ?? 'pending';

    tasks.push({ id, title, status, dependsOn, phase: currentPhase, errorDetail });
  }

  return tasks;
}

/**
 * Serialize Task[] back to TASKS.md, grouping by phase.
 */
export function serializeTasksMarkdown(tasks: Task[]): string {
  const byPhase = new Map<number, Task[]>();
  for (const t of tasks) {
    if (!byPhase.has(t.phase)) byPhase.set(t.phase, []);
    byPhase.get(t.phase)!.push(t);
  }

  const lines: string[] = ['# Studio Tasks\n'];

  for (const [phase, phaseTasks] of [...byPhase.entries()].sort(([a], [b]) => a - b)) {
    lines.push(`## Phase ${phase}\n`);
    for (const task of phaseTasks) {
      const checkMap: Record<TaskStatus, string> = {
        done: 'x',
        failed: '!',
        in_progress: '>',
        blocked: '-',
        pending: ' ',
      };
      const check = checkMap[task.status] ?? ' ';
      const meta: string[] = [`id:${task.id}`];
      if (task.dependsOn.length > 0) meta.push(`DependsOn:${task.dependsOn.join(',')}`);
      const errorSuffix = task.errorDetail ? ` (error: ${task.errorDetail})` : '';
      lines.push(`- [${check}] ${task.title} <!-- ${meta.join(' ')} -->${errorSuffix}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Topological sort via Kahn's algorithm.
 * Returns tasks that have no unmet dependencies (ready to execute in parallel).
 */
export function getParallelBatch(remaining: Task[]): Task[] {
  const remainingIds = new Set(remaining.map(t => t.id));
  return remaining.filter(task =>
    task.dependsOn.every(dep => !remainingIds.has(dep))
  );
}

// ── Tasks read/write ──────────────────────────────────────────────────────────

export async function readTasks(projectDir: string): Promise<Task[]> {
  try {
    const raw = await readFile(tasksPath(projectDir), 'utf8');
    return parseTasksMarkdown(raw);
  } catch {
    return [];
  }
}

export async function writeTasks(projectDir: string, tasks: Task[]): Promise<void> {
  await atomicWrite(tasksPath(projectDir), serializeTasksMarkdown(tasks));
}

export async function updateTaskStatus(
  projectDir: string,
  taskId: string,
  status: TaskStatus,
  errorDetail?: string,
): Promise<void> {
  const tasks = await readTasks(projectDir);
  const task = tasks.find(t => t.id === taskId);
  if (task) {
    task.status = status;
    if (errorDetail !== undefined) task.errorDetail = errorDetail;
    await writeTasks(projectDir, tasks);
  }
}

// ── Context append ────────────────────────────────────────────────────────────

export async function appendContext(projectDir: string, entry: string): Promise<void> {
  const filePath = contextPath(projectDir);
  const timestamp = new Date().toISOString();
  const line = `\n<!-- ${timestamp} -->\n${entry}\n`;
  try {
    const existing = await readFile(filePath, 'utf8');
    await atomicWrite(filePath, existing + line);
  } catch {
    await atomicWrite(filePath, `# Studio Context Log\n${line}`);
  }
}

export async function readContext(projectDir: string): Promise<string> {
  try {
    return await readFile(contextPath(projectDir), 'utf8');
  } catch {
    return '';
  }
}

// ── Feedback read/write ───────────────────────────────────────────────────────

export async function writeFeedback(projectDir: string, errors: string): Promise<void> {
  const timestamp = new Date().toISOString();
  const content = `# Feedback (${timestamp})\n\n${errors}\n`;
  await atomicWrite(feedbackPath(projectDir), content);
}

export async function readFeedback(projectDir: string): Promise<string> {
  try {
    return await readFile(feedbackPath(projectDir), 'utf8');
  } catch {
    return '';
  }
}

export async function clearFeedback(projectDir: string): Promise<void> {
  await atomicWrite(feedbackPath(projectDir), '');
}

// ── PRD / Architecture ────────────────────────────────────────────────────────

export async function writePRD(projectDir: string, content: string): Promise<void> {
  await atomicWrite(prdPath(projectDir), content);
}

export async function readPRD(projectDir: string): Promise<string> {
  try {
    return await readFile(prdPath(projectDir), 'utf8');
  } catch {
    return '';
  }
}

export async function writeArchitecture(projectDir: string, content: string): Promise<void> {
  await atomicWrite(architecturePath(projectDir), content);
}

export async function readArchitecture(projectDir: string): Promise<string> {
  try {
    return await readFile(architecturePath(projectDir), 'utf8');
  } catch {
    return '';
  }
}

// ── State helpers ─────────────────────────────────────────────────────────────

export function makeInitialState(opts: {
  projectDir: string;
  requirements: string;
  tier: Tier;
  stack: string;
  phases: Array<{ name: string; agentType: string }>;
}): StudioState {
  return {
    version: 1,
    projectDir: opts.projectDir,
    requirements: opts.requirements,
    tier: opts.tier,
    stack: opts.stack,
    currentPhase: 0,
    totalPhases: opts.phases.length,
    iteration: 0,
    startedAt: Date.now(),
    phases: opts.phases.map((p, i) => ({
      index: i + 1,
      name: p.name,
      status: 'pending',
      iterations: 0,
      errorCount: 0,
      agentType: p.agentType,
    })),
    healAttempts: 0,
    aborted: false,
  };
}
