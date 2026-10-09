/**
 * What a task's run, and the planner, are told (prompt text is data, ADR-style: kept
 * out of the logic that decides when to run).
 *
 * The run prompt carries only what the engine itself stored: the task's own text and
 * review comments. It is not a rule: the loop enforces the rules that matter (the run
 * starts on its own branch in its own worktree, cannot push or merge through the git
 * tool, can submit only its own task, and the landing is a person's), and this text
 * only tells the agent how to do the job well inside them.
 *
 * The phrase "delivery task" and the word "backlog" are deliberate: they are what
 * loads the deferred `Delivery` tool group from the first message (tools/deferred).
 *
 * @module delivery/prompts
 */

import type { Task } from './types.js';

export function runPrompt(task: Task, trunk: string, opts: { rework?: boolean } = {}): string {
  const comments = (task.review?.comments ?? []).slice(-6);
  const out: string[] = [
    `You are delivering ONE delivery task from this project's board (delivery task ${task.id}).`,
    `Work only in this directory${task.worktree ? ` (${task.worktree})` : ''}: it is a git worktree on branch ${task.branch ?? `aico/task-${task.id}`}, made from ${trunk}. Other agents deliver other tasks in parallel in their own worktrees; never touch anything outside this directory, never switch branches, never merge, never push.`,
    '',
    `Task: ${task.title}`,
    task.body ? `\n${task.body}` : '',
  ];
  if (task.acceptance.length > 0) out.push('', 'Acceptance criteria (each must be true when you finish):', ...task.acceptance.map(a => `- ${a}`));
  if (comments.length > 0) {
    out.push('', opts.rework ? 'This task came back. Address these first:' : 'Comments on this task:',
      ...comments.map(c => `- [${c.by}] ${c.text}`));
  }
  out.push(
    '',
    'Do exactly this:',
    '1. Implement the task; keep the change focused on what it asks. If the branch already has commits, build on them.',
    '2. Add or update tests for what you changed (never weaken or delete an existing test to make a check pass), run the project\'s checks (RunChecks) and fix what fails.',
    '3. Commit locally on this branch with Conventional Commits messages (feat:, fix:, test:, docs:, refactor:, chore:).',
    '4. Call the Delivery tool with action "submit" and a short summary (load it with LoadTools {"groups":["delivery"]} if it is not offered). A person reviews and lands it; you do not.',
    'If you cannot finish, say exactly what is missing in your final answer instead of submitting broken work.',
  );
  return out.filter(l => l !== undefined).join('\n');
}

export function planPrompt(brief: string): string {
  return [
    'Break the brief below into independent tasks on the delivery board, using the Delivery tool (action "create"): they land in the backlog; a person promotes them.',
    '',
    'Rules for good tasks:',
    '- Each task is deliverable on its own by one agent in its own git worktree, and reviewable on its own. Prefer 3-10 tasks over many tiny ones.',
    '- Tasks must not need to edit the same files at the same time. If they must, make one depend on the other (dependsOn) instead.',
    '- Give each: a short imperative title, a body saying what and why, 2-5 acceptance criteria that can be checked, a priority (1 = most urgent .. 4), and labels naming the folders or files it will touch (e.g. "src/auth").',
    '- Read the code first (Read, Grep, CodeGraph) so the tasks name real places. Do not implement anything and do not edit files: only create tasks.',
    '- Finish with a one-line-per-task summary.',
    '',
    'Brief:',
    brief.trim(),
  ].join('\n');
}
