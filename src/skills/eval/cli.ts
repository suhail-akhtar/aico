/**
 * `aico skill eval` and `aico skill optimize`.
 *
 * Both spend the user's money on purpose, so both print what they are about to
 * do — which model, how many tasks, what ceiling — before the first call, and
 * both stop at the ceiling rather than near it.
 *
 * `optimize` never touches the skill it was given. It writes a candidate beside
 * the drafts and prints the diff summary; adopting it is `aico skill register`
 * after a person has read it. The loop can prove a candidate is not worse on
 * the corpus; only a reader can judge the tasks the corpus does not contain.
 *
 * @module skills/eval/cli
 */

import fs from 'fs';
import path from 'path';
import type { Command } from 'commander';
import chalk from 'chalk';
import { loadSettings } from '../../settings.js';
import { skillRegistry } from '../registry.js';
import { draftsDir } from '../manage.js';
import { assignSplits, corpusFor } from './corpus.js';
import { evalSkill } from './run.js';
import { optimizeSkill } from './optimize.js';
import type { EvalReport, TaskResult } from './types.js';

export interface SkillCommandDeps {
  /** The CLI's own model resolution, so `--model` means what it means everywhere else. */
  pickModel: (requested?: string) => string;
}

function taskLine(r: TaskResult): string {
  const mark = r.score === 1 ? chalk.green('✓') : r.score === 0 ? chalk.red('✗') : chalk.yellow('◐');
  const misses = r.checks.filter(c => !c.passed).map(c => c.check.why);
  const cost = `$${r.costUsd.toFixed(3)}`;
  const head = `  ${mark} ${r.id.padEnd(40)} ${r.score.toFixed(2)}  ${String(r.toolCalls.length).padStart(2)} calls  ${cost}`;
  if (r.error) return `${head}\n      ${chalk.red(`crashed: ${r.error}`)}`;
  return misses.length ? `${head}\n${misses.map(m => `      ${chalk.dim('–')} ${m}`).join('\n')}` : head;
}

function summary(report: EvalReport): string {
  const over = report.overBudget ? chalk.yellow('  (stopped: budget)') : '';
  return `  mean ${chalk.bold(report.mean.toFixed(2))} over ${report.tasks.length} task(s) · $${report.costUsd.toFixed(3)}${over}`;
}

/** The body of a skill file, with its frontmatter kept aside for re-attachment. */
function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(raw);
  if (!m) return { frontmatter: '', body: raw };
  return { frontmatter: m[0], body: raw.slice(m[0].length) };
}

export function registerSkillCommands(program: Command, deps: SkillCommandDeps): void {
  const skill = program
    .command('skill')
    .description('measure and improve a skill against tasks with known answers');

  skill
    .command('eval <name>')
    .description('run a skill against its corpus and score it')
    .option('-m, --model <model>', 'model to run the skill with')
    .option('--budget <usd>', 'stop once this much has been spent', '1.00')
    .option('--max-iterations <n>', 'model calls per task', '20')
    .action(async (name: string, cmd: { model?: string; budget: string; maxIterations: string }) => {
      const settings = await loadSettings();
      await skillRegistry.load();
      const found = skillRegistry.lookup(name);
      if (!found) { console.error(chalk.red(`No skill named "${name}".`)); process.exit(1); }

      const tasks = corpusFor(found.frontmatter.name);
      if (tasks.length === 0) {
        console.error(chalk.yellow(`No tasks for "${name}". Add some under ~/.aico/skill-evals/${name}/*.json.`));
        process.exit(1);
      }
      const model = deps.pickModel(cmd.model);
      const budgetUsd = Number(cmd.budget);

      console.log(chalk.bold(`\nEvaluating ${found.frontmatter.name}`) + chalk.dim(`  ${tasks.length} task(s) · ${model} · ceiling $${budgetUsd.toFixed(2)}\n`));
      const report = await evalSkill(found.frontmatter.name, found.promptTemplate, tasks, {
        model, settings, budgetUsd, maxIterations: Number(cmd.maxIterations),
        onTask: r => console.log(taskLine(r)),
      });
      console.log('\n' + summary(report) + '\n');
      process.exit(report.overBudget ? 2 : 0);
    });

  skill
    .command('optimize <name>')
    .description('propose bounded edits to a skill and keep only those that score higher on held-out tasks')
    .option('-m, --model <model>', 'model that runs the skill')
    .option('--optimizer-model <model>', 'model that proposes edits (defaults to --model)')
    .option('--steps <n>', 'propose–validate rounds', '3')
    .option('--budget <usd>', 'stop once this much has been spent', '3.00')
    .option('--max-edits <n>', 'edits per step — the textual learning rate', '4')
    .option('--max-chars <n>', 'longest the skill may grow to, in characters')
    .option('--max-iterations <n>', 'model calls per task', '20')
    .action(async (name: string, cmd: {
      model?: string; optimizerModel?: string; steps: string; budget: string;
      maxEdits: string; maxChars?: string; maxIterations: string;
    }) => {
      const settings = await loadSettings();
      await skillRegistry.load();
      const found = skillRegistry.lookup(name);
      if (!found) { console.error(chalk.red(`No skill named "${name}".`)); process.exit(1); }

      const tasks = corpusFor(found.frontmatter.name);
      const sides = assignSplits(tasks);
      const train = [...sides.values()].filter(s => s === 'train').length;
      const val = tasks.length - train;
      const model = deps.pickModel(cmd.model);
      const optimizerModel = cmd.optimizerModel ? deps.pickModel(cmd.optimizerModel) : model;
      const budgetUsd = Number(cmd.budget);

      console.log(chalk.bold(`\nOptimising ${found.frontmatter.name}`));
      console.log(chalk.dim(`  ${train} train / ${val} val · runs on ${model} · edits by ${optimizerModel}`));
      console.log(chalk.dim(`  ${cmd.steps} step(s) · ≤${cmd.maxEdits} edits/step · ceiling $${budgetUsd.toFixed(2)}\n`));

      const result = await optimizeSkill(found.frontmatter.name, found.promptTemplate, tasks, {
        model, settings, budgetUsd,
        steps: Number(cmd.steps),
        optimizerModel,
        maxIterations: Number(cmd.maxIterations),
        budget: {
          maxEdits: Number(cmd.maxEdits),
          ...(cmd.maxChars ? { maxSkillChars: Number(cmd.maxChars) } : {}),
        },
        onTask: (phase, r) => console.log(chalk.dim(`  [${phase}]`) + taskLine(r).slice(1)),
        onStep: (s) => {
          const verdict = s.accepted ? chalk.green('kept') : chalk.yellow('rejected');
          console.log(`\n  step ${s.step}: train ${s.trainMean.toFixed(2)}`
            + (s.valMean !== undefined ? ` → val ${s.valMean.toFixed(2)}` : '')
            + `  ${verdict}  (${s.proposed.length} edit(s), ${s.dropped.length} dropped, $${s.costUsd.toFixed(3)})`);
          for (const e of s.proposed) console.log(`      ${chalk.dim('·')} ${e.reason}`);
          for (const d of s.dropped) console.log(`      ${chalk.dim('✗')} ${d.because}`);
          console.log('');
        },
      });

      console.log(chalk.bold('\nResult'));
      console.log(`  baseline val ${result.baseline.mean.toFixed(2)} → best val ${chalk.bold(result.bestValMean.toFixed(2))}`
        + `  ·  ${result.steps.filter(s => s.accepted).length} of ${result.steps.length} step(s) kept  ·  $${result.costUsd.toFixed(3)}`);
      if (result.stoppedBecause) console.log(chalk.dim(`  stopped: ${result.stoppedBecause}`));

      if (result.best === found.promptTemplate) {
        console.log('\n  Nothing beat the current skill on validation. It is unchanged.\n');
        process.exit(0);
      }

      /*
        A candidate, not a replacement. Written with the original frontmatter
        so it is a complete skill file, into the drafts directory the loader
        does not scan — so nothing changes until a person reads the diff and
        registers it.
      */
      const raw = fs.readFileSync(found.filePath, 'utf8');
      const { frontmatter } = splitFrontmatter(raw);
      // A draft directory, which is what `SkillManage register` consumes. The
      // frontmatter keeps the original name, so registering it is adoption: a
      // user skill of the same name takes precedence over the built-in.
      const draftName = `${found.frontmatter.name}-optimized`;
      const dir = path.join(draftsDir(), draftName);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), frontmatter + result.best, 'utf8');

      console.log(`\n  Candidate written to ${chalk.cyan(path.join(dir, 'SKILL.md'))}`);
      console.log(chalk.dim(`  ${found.promptTemplate.length} → ${result.best.length} chars. Read the diff, then adopt it from Settings → Skills,`));
      console.log(chalk.dim(`  or ask the agent: SkillManage register ${draftName}\n`));
      process.exit(0);
    });
}
