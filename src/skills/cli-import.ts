/**
 * `aico skill import`, `aico skill review` and `aico skill export` — the
 * terminal's front door to the same review → install flow as Settings → Skills.
 *
 * WHY A TTY PROMPT. Enabling an imported skill is a person's decision (design
 * §5.1). In the terminal the person is at the keys, so the review is printed
 * and the question asked; the answer is read from an interactive stdin only.
 * A `--yes` flag would let the agent's own Bash enable whatever it liked (its
 * shell has no TTY), so there is none: without a terminal the skills install
 * unreviewed and the command says how to review them.
 *
 * @module skills/cli-import
 */

import path from 'path';
import readline from 'readline';
import type { Command } from 'commander';
import chalk from 'chalk';
import { skillRegistry } from './registry.js';
import { stageImport, installStaged, exportSkill, reviewInstalled } from './import.js';
import { describeReview, describeReviewed } from './manage.js';
import { markReviewed } from './provenance.js';
import { setEnabled } from '../registry-state.js';

async function askYes(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>(resolve => rl.question(question, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export function registerSkillImportCommands(skill: Command): void {
  skill
    .command('import <source>')
    .description('review a .skill/.zip, a folder, a pack or a Claude plugin, then install it (asks before enabling)')
    .option('--overwrite', 'replace skills of the same name')
    .action(async (source: string, cmd: { overwrite?: boolean }) => {
      const review = await stageImport({ path: path.resolve(source) });
      if ('error' in review) { console.error(chalk.red(review.error)); process.exit(1); }
      console.log(`\n${describeReview(review)}\n`);
      const installable = review.skills.filter(s => !s.errors.length);
      if (!installable.length) { console.error(chalk.red('Nothing here passes validation; nothing installed.')); process.exit(1); }
      const yes = await askYes(`Install and enable ${installable.map(s => s.name).join(', ')}? [y/N] `);
      const out = installStaged(review.id, { trust: yes ? 'reviewed' : 'unreviewed', overwrite: cmd.overwrite ?? false });
      if (yes) for (const s of out.installed) setEnabled('skills', s.name, true);
      for (const s of out.installed) console.log(`  ${chalk.green('✓')} ${s.name} → ${s.installedAt} (${s.trust})`);
      for (const s of out.skipped) console.log(`  ${chalk.yellow('–')} ${s.name}: ${s.reason}`);
      if (!yes && out.installed.length) {
        console.log(chalk.dim(`\n  Installed unreviewed: not usable until enabled. Run \`aico skill review <name>\` in a terminal, or use Settings → Skills.\n`));
      }
      process.exit(out.installed.length ? 0 : 1);
    });

  skill
    .command('review <name>')
    .description('show an installed skill\'s files, scripts and scan findings, and enable it if you approve')
    .action(async (name: string) => {
      await skillRegistry.load();
      const found = skillRegistry.lookupAny(name);
      if (!found?.dir) { console.error(chalk.red(`No installed directory skill called "${name}".`)); process.exit(1); }
      const r = reviewInstalled(found.dir);
      console.log(`\n${found.frontmatter.name} — trust: ${found.trust ?? 'authored'}${found.trustReason ? ` (${found.trustReason})` : ''}`);
      if (r.provenance) console.log(`source: ${r.provenance.source}`);
      console.log(describeReviewed(r).join('\n') + '\n');
      if (found.trust !== 'unreviewed') process.exit(0);
      if (await askYes(`Enable "${found.frontmatter.name}"? [y/N] `)) {
        markReviewed(found.dir);
        setEnabled('skills', found.frontmatter.name, true);
        console.log(chalk.green(`  Reviewed and enabled.`));
      } else {
        console.log(chalk.dim('  Left unreviewed.'));
      }
      process.exit(0);
    });

  skill
    .command('export <name> [dest]')
    .description('pack a skill into Claude\'s .skill format')
    .option('--include-evals', 'keep the evals/ folder')
    .action(async (name: string, dest: string | undefined, cmd: { includeEvals?: boolean }) => {
      await skillRegistry.load();
      const found = skillRegistry.lookupAny(name);
      if (!found?.dir) { console.error(chalk.red(`No directory skill called "${name}".`)); process.exit(1); }
      const out = await exportSkill(found.dir, path.resolve(dest ?? '.'), { includeEvals: cmd.includeEvals ?? false });
      if (!out.ok) { console.error(chalk.red(out.error)); process.exit(1); }
      console.log(`${chalk.green('✓')} ${out.path} (${out.files} file(s))`);
      for (const w of out.warnings ?? []) console.log(chalk.yellow(`  warning: ${w}`));
      process.exit(0);
    });
}
