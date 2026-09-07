import { run } from './cli.js';

run(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr })
  .then(code => { process.exitCode = code; })
  .catch(err => { process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`); process.exitCode = 1; });
