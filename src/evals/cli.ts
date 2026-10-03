/**
 * `aico agent certify <name>` and `aico agent status [name]` — the terminal's
 * door to agent certification (design §6.4, Phase 4).
 *
 * `certify` spends the user's money, so it prints the plan, the estimate and
 * the hard cap before the first call, and stops at the cap rather than near
 * it. `--dry-run` prints the plan and spends nothing. The exit code is 0 only
 * when the agent was certified, so a script can gate on it.
 *
 * @module evals/cli
 */

import type { Command } from 'commander';
import { loadSettings, type AicoSettings } from '../settings.js';
import { listAgentSpecs, getAgentSpec } from '../agents/registry.js';
import { certifyAgent, describeCertificate, describePlan } from './certify.js';
import { STATUS_LABEL, statusOfSpec } from './certificate.js';

export interface AgentCommandDeps {
  /** The CLI's own model resolution, so `--model` means what it means everywhere else. */
  pickModel: (requested?: string, settings?: AicoSettings) => string;
}

export function registerAgentCommands(program: Command, deps: AgentCommandDeps): void {
  const agent = program.command('agent').description('certify agents and show their certification status');

  agent
    .command('certify <name>')
    .description('run the safety pack and the agent\'s golden tasks k times; certify it when they pass (paid, capped)')
    .option('--runs <n>', 'trials per task (k)', '3')
    .option('--budget <usd>', 'hard cap in dollars (default and maximum 2)')
    .option('-m, --model <model>', 'model to certify on, when the agent does not pin one (default: the configured model)')
    .option('--judge-model <model>', 'model for LLM-judged checks (default: the judge model role, deepseek-v4-pro unless set)')
    .option('--dry-run', 'print the plan and the estimate; spend nothing')
    .action(async (name: string, cmd: { runs: string; budget?: string; model?: string; judgeModel?: string; dryRun?: boolean }) => {
      const settings = await loadSettings();
      const model = deps.pickModel(cmd.model, settings);
      const ac = new AbortController();
      process.once('SIGINT', () => ac.abort());
      const r = await certifyAgent(name, {
        model, settings, cwd: process.cwd(), signal: ac.signal,
        runs: Number.parseInt(cmd.runs, 10) || 3,
        ...(cmd.budget ? { budgetUsd: Number(cmd.budget) } : {}),
        ...(cmd.judgeModel ? { judgeModel: deps.pickModel(cmd.judgeModel, settings) } : {}),
        ...(cmd.dryRun ? { dryRun: true } : {}),
        onProgress: line => console.log(line),
      });
      if ('error' in r) {
        if (!r.plan) console.error(r.error);
        else console.log('\nDry run: nothing was spent.');
        process.exit(r.plan ? 0 : 1);
      }
      console.log(`\n${describeCertificate(r.certificate)}\nCertificate: ${r.file}`);
      process.exit(r.certificate.passed ? 0 : 1);
    });

  agent
    .command('status [name]')
    .description('certified / changed since certification / failed / uncertified, for one agent or all')
    .option('-m, --model <model>', 'the model to check against (default: the agent\'s own, else the configured one)')
    .action(async (name: string | undefined, cmd: { model?: string }) => {
      const settings = await loadSettings();
      const cwd = process.cwd();
      const specs = name ? [await getAgentSpec(name, cwd)].filter(Boolean) : await listAgentSpecs(cwd);
      if (name && !specs.length) { console.error(`There is no agent called "${name}".`); process.exit(1); }
      for (const spec of specs) {
        const model = spec!.model || deps.pickModel(cmd.model, settings);
        const s = await statusOfSpec(spec!, { cwd, model });
        console.log(`${spec!.name.padEnd(24)} ${STATUS_LABEL[s.status].padEnd(28)} ${s.text}`);
      }
      process.exit(0);
    });
}
