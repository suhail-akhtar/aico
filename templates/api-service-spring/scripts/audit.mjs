// Dependency audit that works the same on Windows, macOS and Linux (no make, no shell tricks).
// Why Node: it is the one runtime every AICO machine already has, and the audit needs a
// cross-platform way to build the SBOM and run the scanner container. `make audit` does the same
// with two plain commands; keep the pinned scanner image in step with the Makefile.
//
// It builds the CycloneDX SBOM with the Maven wrapper (always: a stale SBOM would audit the wrong
// dependencies), then scans it with OSV-Scanner in a container (Docker is required).
// `--no-build` scans the SBOM already in target/, for callers that just built it (CI, the
// starter's verification script) or machines without the right JDK.
//
// Exit codes: 0 clean, 1 findings or scan failure, 2 Docker missing (the audit could not run;
// that is a "not verified", never a pass).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE =
  'ghcr.io/google/osv-scanner:v2.6.0@sha256:afd838850ac1a0fcc15ff4a041dc9ba11123c3f0d2666217a5f0fcf9222b55fa';
const SBOM = 'target/classes/META-INF/sbom/application.cdx.json';
const win = process.platform === 'win32';
const noBuild = process.argv.includes('--no-build');

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: win, ...opts });
}

const docker = spawnSync('docker', ['--version'], { stdio: 'ignore', shell: win });
if (docker.status !== 0) {
  console.error('audit: Docker is required to run the scanner and was not found. NOT verified.');
  process.exit(2);
}

if (!noBuild) {
  const mvn = win ? 'mvnw' : './mvnw';
  const build = run(mvn, ['-q', '-DskipTests', '-Dspotless.check.skip=true', 'process-resources']);
  if (build.status !== 0) {
    console.error('audit: could not build the SBOM with the Maven wrapper (is JDK 25 installed?).');
    process.exit(1);
  }
}
if (!existsSync(resolve(root, SBOM))) {
  console.error(`audit: ${SBOM} not found. Run the build first (./mvnw process-resources).`);
  process.exit(1);
}

const scan = run(
  'docker',
  ['run', '--rm', '-v', `${root}:/src:ro`, '-w', '/src', IMAGE, 'scan', 'source', '--config', 'osv-scanner.toml', '-L', SBOM],
  // shell: false so a project path with spaces (a Windows user named "First Last") reaches docker as
  // ONE argument; through cmd.exe it is split and docker reports "invalid reference format".
  { env: { ...process.env, MSYS_NO_PATHCONV: '1' }, shell: false },
);
process.exit(scan.status === 0 ? 0 : 1);
