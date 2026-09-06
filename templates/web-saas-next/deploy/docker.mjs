#!/usr/bin/env node
// Build the production image. Idempotent; prints the run command.
import { execFileSync, spawnSync } from 'node:child_process';

const tag = process.argv[2] || '__APP_SLUG__';
const has = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
if (has.status !== 0) {
  console.error('docker is not available: install Docker Desktop or Docker Engine and make sure the daemon is running.');
  process.exit(2);
}
console.log(`Building ${tag} (docker ${has.stdout.trim()})…`);
execFileSync('docker', ['build', '-t', tag, '.'], { stdio: 'inherit' });
console.log(`\nBuilt. Run it with:\n  docker run --rm -p 3000:3000 -e SESSION_SECRET=<long random string> -v ${tag}-data:/app/data ${tag}\nthen open http://localhost:3000 (health: /api/healthz).`);
