#!/usr/bin/env node
// Build the production image. Idempotent; prints the run command.
import { execFileSync, spawnSync } from 'node:child_process';

// Docker refuses uppercase or unusual characters in a repository name, so the tag is normalised.
const tag = (process.argv[2] || '__APP_SLUG__').toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
const has = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
  encoding: 'utf8',
});
if (has.status !== 0) {
  console.error(
    'docker is not available: install Docker Desktop or Docker Engine and make sure the daemon is running.',
  );
  process.exit(2);
}
console.log(`Building ${tag} (docker ${has.stdout.trim()})…`);
execFileSync('docker', ['build', '-t', tag, '.'], { stdio: 'inherit' });
console.log(
  `\nBuilt. Run it (it serves the static app; /api needs a gateway in front, see docs/BFF.md):\n` +
    `  docker run --rm -p 8080:8080 --read-only --tmpfs /tmp --cap-drop ALL \\n` +
    `    --security-opt no-new-privileges ${tag}\nthen: curl localhost:8080/healthz`,
);
