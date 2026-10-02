/**
 * `aico tool list | test | enable | disable` — the terminal's front door to
 * the same executor as Settings → Tools and the agent's `ToolManage`.
 *
 * WHY A TTY CHECK. Enabling a tool and executing one from `test` are a
 * person's acts (design §5.2). In a terminal the person is at the keys; the
 * agent's own Bash has no TTY. So `enable` prints the definition and asks,
 * and `test` executes only with an interactive terminal — without one it is
 * the same dry run the model gets. There is no `--yes`, for the reason
 * skills' import has none: it would hand the switch to whatever can run a
 * command.
 *
 * @module custom-tools/cli
 */

import fs from 'node:fs';
import readline from 'node:readline';
import type { Command } from 'commander';
import { executeToolManage } from './manage.js';
import { loadCustomTools } from './store.js';

const interactive = (): boolean => Boolean(process.stdin.isTTY && process.stdout.isTTY);

async function askYes(question: string): Promise<boolean> {
  if (!interactive()) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await new Promise<string>(resolve => rl.question(question, resolve))).trim());
  } finally {
    rl.close();
  }
}

export function registerToolCommands(program: Command): void {
  const tool = program.command('tool').description('custom tools: typed wrappers around one command or HTTP call (~/.aico/tools, .aico/tools)');

  tool.command('list').description('every custom tool visible from here, with its status').action(async () => {
    console.log(await executeToolManage({ action: 'list' }, { cwd: process.cwd() }));
  });

  tool
    .command('test <name>')
    .description('validate, show the exact argv, run the probe and (read tools only) the call itself')
    .option('--args <json>', 'arguments as JSON, e.g. \'{"path":"src"}\'', '{}')
    .action(async (name: string, cmd: { args: string }) => {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(cmd.args) as Record<string, unknown>;
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('not an object');
      } catch (err) {
        console.error(`--args must be a JSON object (${(err as Error).message}).`);
        process.exitCode = 2;
        return;
      }
      const out = await executeToolManage({ action: 'test', name, args }, { human: interactive(), cwd: process.cwd() });
      console.log(out);
      if (/^(Not |No |Arguments refused)|FAILED|"error"/m.test(out)) process.exitCode = 1;
    });

  tool.command('enable <name>').description('enable a tool after reading its definition (asks; needs a terminal)').action(async (name: string) => {
    const t = (await loadCustomTools(process.cwd())).find(x => x.name === name);
    if (!t) { console.error(`No custom tool called "${name}".`); process.exitCode = 1; return; }
    let text = '';
    try { text = fs.readFileSync(t.file, 'utf8'); } catch { /* shown as unreadable */ }
    console.log(`${t.file}\n${text || '(unreadable)'}`);
    if (!(await askYes(`Enable "${name}" (${t.def?.effect ?? 'invalid'})? [y/N] `))) {
      console.log(interactive() ? 'Not enabled.' : 'Not enabled: enabling asks a person, and this is not an interactive terminal.');
      process.exitCode = 1;
      return;
    }
    console.log(await executeToolManage({ action: 'enable', name }, { human: true, cwd: process.cwd() }));
  });

  tool.command('disable <name>').description('switch a tool off').action(async (name: string) => {
    console.log(await executeToolManage({ action: 'disable', name }, { cwd: process.cwd() }));
  });
}
