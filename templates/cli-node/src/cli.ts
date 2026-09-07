/**
 * The command line: parse, dispatch, exit code.
 *
 * `run(argv)` is pure enough to test — it returns the exit code and writes to
 * the streams it is given — so the whole tool is exercised without spawning a
 * process. `src/index.ts` is the two-line entry that calls it with the real
 * ones.
 */
import { parseArgs } from 'node:util';
import { count } from './commands/count.js';

export const NAME = '__APP_SLUG__';
export const VERSION = '0.1.0';

export interface Io {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
}

const HELP = `${NAME} — __APP_DESCRIPTION__

Usage:
  ${NAME} count <file…> [--words] [--json]
  ${NAME} --help | --version

Commands:
  count     Count lines (or words) in files and print a table or JSON.

Options:
  --words   Count words instead of lines.
  --json    Print JSON instead of a table.
  -h, --help
  -v, --version
`;

/** Every command: name → runner returning an exit code. Add one here and in docs/EXTENDING.md. */
const COMMANDS: Record<string, (args: string[], io: Io) => Promise<number>> = {
  count,
};

export async function run(argv: string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
      allowPositionals: true,
      strict: false,
    });
  } catch (err) {
    io.stderr.write(`${NAME}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  if (parsed.values.version) { io.stdout.write(`${NAME} ${VERSION}\n`); return 0; }
  const [command, ...rest] = parsed.positionals;
  if (parsed.values.help || !command) { io.stdout.write(HELP); return command ? 0 : 2; }
  const runner = COMMANDS[command];
  if (!runner) {
    io.stderr.write(`${NAME}: unknown command "${command}". Try --help.\n`);
    return 2;
  }
  // Hand the command everything after its name, flags included, so each
  // command parses its own options with its own schema.
  const own = argv.slice(argv.indexOf(command) + 1);
  try {
    return await runner(own.length ? own : rest, io);
  } catch (err) {
    io.stderr.write(`${NAME} ${command}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
