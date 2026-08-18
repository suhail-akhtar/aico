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
import { currentCwd } from './run-context.js';

const execAsync = promisify(exec);

async function getGitStatus(): Promise<string> {
  try {
    const { stdout } = await execAsync('git status --short', { cwd: currentCwd() });
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
  // The date belongs here rather than in the system prompt for the same reason
  // git status does — it changes — and it belongs somewhere, because a model
  // whose training ended at some point in the past will otherwise reason about
  // "the latest version" and "recently" from whenever that was. One line.
  const today = new Date().toISOString().slice(0, 10);
  return [
    `Today's date: ${today}`,
    gitStatus ? `Git status:\n${gitStatus}` : 'Git status: (clean or not a git repo)',
  ].join('\n\n');
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
  /**
   * Instructions the user attached to this project.
   *
   * Passed in rather than read here so this module keeps knowing nothing about
   * where settings live, and so a caller can supply them from anywhere.
   */
  projectInstructions?: string,
  /**
   * The session's standing objective, when it has an active one.
   *
   * Passed in for the same reason the instructions are: this module knows
   * nothing about sessions, and should not learn.
   */
  goal?: string,
  /**
   * Whether this is a planning turn.
   *
   * Plan mode was a tool restriction and nothing else: the tools were filtered
   * to read-only and the model was never told why, what the turn was for, or
   * how to end it. Whether a usable plan came out depended on a model
   * recognising the shape of the situation from a filtered tool list, which is
   * not a contract — it is a hope that happened to work.
   */
  planMode?: boolean,
): Promise<PromptDocument> {
  const memory = await loadMemory();
  const doc = new PromptDocument();

  // What the model is, and the one fact about its surroundings it cannot infer
  // from the tool schemas: that a scratch space exists which is not the user's
  // repository. Everything the tools already describe is left to them —
  // re-listing "you can read and write files" beside a Read and a Write tool
  // spends prefix tokens restating a schema the API sends anyway.
  doc.add({
    id: 'role',
    order: 0,
    body: `You are aico, a coding agent running on ${model} with direct access to
this machine: you edit files and run commands yourself rather than proposing
changes for someone else to apply.

Work that belongs to the user goes in their project. Artifacts that are yours —
reports, logs, scratch files, generated output nobody asked to keep — go in the
per-project workspace, via the Workspace tools. Do not leave working files in
someone's repository.`,
  });

  doc.add({
    id: 'environment',
    order: 10,
    // The *run's* directory, not the process's. These disagreed once the server
    // could drive several projects at once, and the disagreement was worse than
    // either answer alone: the tools worked in the folder the user had opened
    // while the prompt named the folder the server was launched in, so the
    // model confidently reported the wrong location and reasoned about paths
    // relative to a directory it was not in.
    body: `Working directory: ${currentCwd()}
Platform: ${process.platform}
OS: ${os.version()}`,
  });

  // Scope, separately from execution, and reprised.
  //
  // The failure this addresses is the most common one a coding agent has, and
  // it is not incompetence — it is enthusiasm. Asked to fix a function, a
  // capable model will also rename the variables it dislikes, extract a helper,
  // update three call sites and reformat the file. Every one of those is
  // defensible alone; together they turn a reviewable diff into a rewrite
  // nobody asked for, and they bury the fix.
  //
  // Its own section rather than four more bullets under `behaviour`, because
  // "what work to do" and "how to do it well" are different questions and a
  // fourteen-bullet block answers neither clearly. On XML dialects this also
  // gets its own tag, which is the structured-spec shape the vendors credit
  // with better instruction adherence.
  doc.add({
    id: 'scope',
    order: 20,
    reprise: true,
    body: `- Do what was asked. Not less, and not more.
- Improvements you notice but were not asked for are worth mentioning in a sentence, not worth making. The exception is when the task genuinely cannot be completed without them, and then say so.
- Do not reformat, restructure, or restyle code you were not asked to change. A diff should contain the change and nothing else.
- Match the surrounding code — its naming, its idioms, its comment density. The goal is a change that looks like the person who wrote the file wrote it.
- Actions that reach outside this machine or cannot be undone need asking first: committing, pushing, publishing, sending, or deleting anything you did not create. Being able to run the command is not the same as being asked to.
- When two readings of a request would produce materially different work, ask. When you can pick a sensible default, pick it, say which you picked, and keep going.`,
  });

  // Marked for reprise: these are the rules that decide what the model does
  // next, which is exactly what Google's long-context guidance says to restate
  // after the context rather than only before it.
  //
  // Kept to bullets on purpose, and the reason is worth stating because the
  // pull is always the other way. Every one of these rules can be expanded into
  // a doctrine — a numbered gate, a list of rationalizations to reject, a table
  // of red flags — and doing so is how a capable agent becomes a timid one. A
  // model that has read nine paragraphs about not claiming success prematurely
  // spends its budget proving it is allowed to finish. The rule "verification
  // has to be fresh" carries the whole idea; the nine paragraphs carry the same
  // idea plus a suggestion that the model is not trusted.
  //
  // Prefer sharpening a bullet to adding one. The verification rules here are
  // three sentences that each name a specific failure — stale evidence, hedged
  // wording, stacked fixes — rather than one long injunction to be careful,
  // which no model has ever acted on.
  doc.add({
    id: 'behaviour',
    order: 25,
    reprise: true,
    body: `- Prefer small, targeted edits over large rewrites.
- Always read a file before editing or overwriting it, unless you created it this turn. This is enforced, not advisory: an edit to a file you have not read will be refused, as will one to a file that has changed since you read it.
- Use the Todo tools to track multi-step work. Create a todo for each distinct step of a non-trivial task, and mark one complete only AFTER verifying that step's outcome — not when you start it.
- After editing or writing code, verify it works before declaring the task done. Run the project's typecheck, lint, build, or tests (\`tsc --noEmit\`, \`npm test\`, \`npm run build\`) when they exist, and fix anything they surface before finishing.
- Verification has to be fresh. A command you did not run is not evidence, and a result from before your last edit is evidence about code that no longer exists.
- When you build something that runs in a browser, open it with VerifyApp before calling it done, and again after every fix. Reading the source you just wrote proves only that you wrote it — a page can look correct in source and still throw on load, render blank, or have controls that do nothing.
- Write one VerifyApp check per interaction the user asked for, named after their words. If the brief lists six behaviours, six checks — a page that loads and answers a click is not evidence that the thing described was built.
- After a non-trivial edit, re-read the changed file to confirm the change landed as intended.
- Do not stop with a summary while open todos remain or verification is failing. If you believe the task is done, your final message should state what you verified, not just what you changed.
- If you find yourself writing that something *should* work, or *probably* passes, that is the tell: you are reporting an expectation. Go and get the actual result, or say plainly that you have not checked.
- When something breaks, find the cause before changing anything. Change one thing at a time and undo a fix that did not work before trying the next — stacked half-fixes make the original fault unfindable.
- If two or three attempts have not worked, stop and question the assumption underneath them rather than trying a fourth variation of the same idea.
- If a verification step fails repeatedly and you cannot resolve it, surface the specific blocker — what failed, what you tried — rather than claiming success.
- Be concise in prose; be thorough in code.`,
  });

  // How to find things out, before how to change them.
  //
  // Exploration is what a coding agent spends most of its turns doing, and it
  // had no guidance at all. The rules that matter are the ones that stop a
  // model acting on something it inferred rather than read.
  doc.add({
    id: 'navigation',
    order: 30,
    body: `- Prefer the dedicated search and file tools to shell equivalents. They are faster, they respect ignore rules, and their output is structured.
- Never edit a path you have not read, and never invent one. If you are unsure a file exists, look.
- A symbol's definition tells you what it does; its call sites tell you what it is for. Read both before changing a signature.
- When a search returns more than you can read, narrow it rather than skimming everything. Guessing from filenames is how the wrong file gets edited.
- Independent lookups can go out together. If you need four files to understand something, ask for all four at once rather than one at a time — it is one wait instead of four. Anything that writes, or that depends on what a previous call returned, has to wait for it.`,
  });

  // Only during a planning turn, and worth its tokens only then. A standing
  // paragraph about how to plan would be read on every ordinary turn, where the
  // right answer is usually to just do the work.
  if (planMode) {
    doc.add({
      id: 'plan_mode',
      order: 22,
      reprise: true,
      body: `You are planning, not building. Nothing you do this turn may change anything: the write tools are not available to you, and that is deliberate.
- Investigate first. A plan written without reading the code is a guess with numbered steps, and the reader cannot tell the difference until it fails.
- Finish by calling ProposePlan exactly once, with the whole plan. Do not describe the plan in prose as well — the reader answers the tool call, and a second copy in the message body is one that can drift from it.
- Give each step the files or areas it touches. "Update the settings" and "update the settings, in web/src/store.ts and two components" are different plans to agree to.
- State what you had to assume in open_questions, honestly and specifically. An assumption the reader would have corrected costs a sentence now and a rewrite later, and this is the only moment it is cheap.
- Then stop. Do not begin the work, and do not ask whether to begin: the reader will approve, amend, defer or decline, and you will be asked again with that answer.`,
    });
  }

  // Delegation, framed as a decision rather than a catalogue.
  //
  // This section used to be nine lines of "you can CREATE agents", "you can
  // DEFINE pipelines", "you can SPAWN any agent" — an inventory of features,
  // repeated in the cached prefix of every request. It cost tokens on every
  // turn to tell the model what the tool schemas already say, and told it
  // nothing about *when*. Worse, a model told six times that it can create
  // agents and skills and pipelines will reach for them, and spawning an agent
  // to fix a two-line bug is slower and worse than fixing the bug.
  //
  // What it needs is the trade-off: delegation buys parallelism and a clean
  // context, and costs a round trip and everything the sub-agent was not told.
  doc.add({
    id: 'delegation',
    order: 35,
    body: `- Sub-agents do not inherit this conversation. Whatever a delegated task needs to know, put it in the task — including things you consider obvious.
- Delegate when the work is wide rather than deep: a search across many files, an audit, several independent changes that do not need to see each other. That work would otherwise flood this context with material you read once and never need again.
- Do the work yourself when it is a handful of files, when the steps depend on each other, or when describing the task would take longer than doing it.
- Creating a durable agent or skill is for a procedure you expect to repeat, not for one task. For one task, spawn an inline agent and let it go.
- Delegation does not transfer responsibility. Check what comes back; a sub-agent reporting success is a claim, not a verification.`,
  });

  if (effort && EFFORT_GUIDANCE[effort]) {
    doc.add({
      id: 'effort',
      order: 40,
      reprise: true,
      body: `${effort.toUpperCase()} — ${EFFORT_GUIDANCE[effort]}`,
    });
  }

  // XML dialects only, whoever is serving them. The format of the prompt leaks
  // into the format of the reply — Anthropic says so outright, and OpenAI's
  // GPT-5 guidance independently asks for Markdown "only where semantically
  // correct" and stops formatting answers in it by default. Inside an XML
  // prompt this nudges output away from reflexive bullet lists; inside a
  // Markdown one it would ask the model to contradict the shape of its own
  // instructions.
  //
  // Keyed to the style rather than to `only: ['anthropic']`, which is what it
  // used to say. That spelling excluded OpenAI the moment its dialect became
  // XML, and had always excluded a Claude model routed through OpenRouter.
  doc.add({
    id: 'output_style',
    order: 50,
    styles: ['xml'],
    body: `Write prose in plain paragraphs. Reserve markdown for code, file paths,
and genuinely tabular data. Do not reach for bullet lists when a sentence
carries the same information.`,
  });

  // Last, and reprised.
  //
  // Position is the mechanism, not decoration: when two instructions conflict a
  // model tends to follow the later one, and these are the ones this particular
  // user chose for this particular folder. They should win over the general
  // advice above, and they can only do that by coming after it — including
  // after memory, which is why the order number is past the memory block rather
  // than merely at the end of this function.
  //
  // Marked `reprise` so vendors whose guidance asks for a tail restatement get
  // them closest to the model's next decision.
  if (projectInstructions?.trim()) {
    doc.add({
      id: 'project_instructions',
      order: 900,
      reprise: true,
      body: projectInstructions.trim(),
    });
  }

  // The standing objective, last of all and reprised.
  //
  // This existed for a while as a bar in the UI that the model could not see.
  // A goal nobody is told is a sticky note: it survived restarts, appeared in
  // the export, and changed nothing about what the agent did — which is the
  // worst kind of feature, because it looks like it is working.
  //
  // Last because it is the most specific thing in the prompt: the folder's
  // instructions apply to every session in it, and this applies to exactly
  // this conversation. Reprised for the same reason the rules are — it is
  // meant to be in view when the next decision is made, not only at the start.
  if (goal?.trim()) {
    doc.add({
      id: 'session_goal',
      order: 950,
      reprise: true,
      body: `The user has set a standing objective for this session:\n\n${goal.trim()}\n\n`
        + 'Keep it in view. When a step would not move it forward, say so rather than doing it anyway.',
    });
  }

  // One section per memory source rather than one pre-formatted blob, so each
  // is labelled in the active dialect and can be targeted or overridden by id.
  const cwd = currentCwd();
  memory.sections.forEach((entry: MemoryEntry, index: number) => {
    if (!entry.content.trim()) return;
    const { id, title } = memoryLabel(entry, cwd);
    // `append` rather than `add`: several files can share a label (multiple
    // project rules), and the later one must not silently replace the earlier.
    doc.append(id, entry.content, { title, order: 60 + index });
  });

  return doc;
}
