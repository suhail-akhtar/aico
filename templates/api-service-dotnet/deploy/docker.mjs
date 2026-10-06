#!/usr/bin/env node
// Build the production image. Idempotent; prints how to run and migrate it.
import { execFileSync, spawnSync } from 'node:child_process';

// Docker refuses uppercase or unusual characters in a repository name, so the tag is normalised.
const tag = (process.argv[2] || '__APP_SLUG__').toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
const has = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
if (has.status !== 0) {
  console.error('docker is not available: install Docker Desktop or Docker Engine and make sure the daemon is running.');
  process.exit(2);
}
console.log(`Building ${tag} (docker ${has.stdout.trim()})...`);
execFileSync('docker', ['build', '-t', tag, '.'], { stdio: 'inherit' });
console.log(`
Built ${tag}. Next:
  1. Apply migrations once (needs a PostgreSQL):
       docker run --rm -e ConnectionStrings__Default="<connection string>" -e Jwt__SigningKey="<32+ chars>" ${tag} --migrate
  2. Start the service:
       docker run --rm -p 8080:8080 -e ConnectionStrings__Default="<connection string>" -e Jwt__SigningKey="<32+ chars>" ${tag}
  3. curl localhost:8080/healthz
Or run the whole stack locally: cp .env.example .env && docker compose up --build`);
