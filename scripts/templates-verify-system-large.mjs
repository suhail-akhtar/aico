/**
 * Proof for the `system-large` bundle: the manifest validates, the clean copy is free of
 * generated state, the deployment definitions agree with the medium tier's application, and
 * every static check the bundle ships (`scripts/check.sh`) passes in pinned containers.
 *
 * Why this exists: the large tier is Helm, kustomize, Terraform, GitOps and observability
 * files with no process to start, so "it works" can only mean "every linter, schema and
 * policy tool accepts it". `scripts/templates-live.mjs` knows nothing about those tools, and
 * the check script inside the bundle is the one definition of "passed" that CI, a laptop and
 * this proof share; this script runs it from a clean copy (the way `instantiateTemplate`
 * makes one) and adds the checks that only AICO's repository can make (manifest, pinned
 * actions, consistency with the medium tier's image names, ports and probe paths).
 *
 * What it deliberately does not do: apply anything to a cluster or cloud account (nothing
 * here has been), touch `~/.aico` (it imports the isolated test home first), call a model, or
 * install anything on the host: every tool is a container, and the two cache volumes the
 * checks create are removed at the end (`--keep-cache` leaves them for a faster rerun).
 * A step that cannot run (no Docker, offline) is reported as skipped, never as passed.
 *
 * Run: node scripts/templates-verify-system-large.mjs [--offline] [--keep] [--keep-cache]
 *   --offline     skips the groups that download (terraform providers, tflint plugin, CRD
 *                 schemas, trivy database, yamllint) and the action-pin lookups
 *   --keep        leave the scratch copy in place and print its path
 * Exit code 1 when any step fails.
 */

import './lib/test-home.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkActionPins, copyTemplate, createReporter, dockerAvailable, run, scratchDir, tail } from './lib/verify-kit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const source = path.join(root, 'templates', 'system-large');
const flags = new Set(process.argv.slice(2));
const offline = flags.has('--offline');

const r = createReporter();
const { check, skip, section } = r;
let scratch;

const read = (rel) => fs.readFileSync(path.join(source, rel), 'utf8');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)).map((f) => path.join(e.name, f)) : [e.name]));

try {
  section('manifest and layout');
  const validator = run(process.execPath, [path.join(here, 'validate-template.mjs'), source], { cwd: root, timeout: 120_000 });
  check(validator.ok, 'validate-template.mjs accepts the manifest and the completeness bar', tail(validator.out));
  const manifest = JSON.parse(read('template.json'));
  check(manifest.id === 'system-large' && manifest.kind === 'bundle' && manifest.services.length >= 2, 'manifest is a bundle named system-large');
  check(read('AICO.md').length <= 2000, 'AICO.md is within the 2,000 character cap');
  const files = walk(source);
  const junk = files.filter((f) => /(^|[\\/])(\.terraform|charts|__snapshot__|node_modules)([\\/]|$)|chart-rendered\.yaml$|\.tfstate|\.tfvars$/.test(f));
  check(junk.length === 0, 'no generated state (.terraform, charts, rendered manifests, state, tfvars) in the source tree', junk.join('\n'));
  const crlf = files.filter((f) => /\.(ya?ml|tf|sh|md|json|hcl|tpl|txt)$/.test(f) && fs.readFileSync(path.join(source, f), 'utf8').includes('\r'));
  check(crlf.length === 0, 'every text file uses LF line endings', crlf.join('\n'));
  for (const f of ['LICENSE', 'SECURITY.md', 'CHANGELOG.md', 'CODEOWNERS', 'CONTRIBUTING.md', 'docs/ARCHITECTURE.md', 'docs/EXTENDING.md', '.github/workflows/ci.yml', 'scripts/check.sh']) {
    check(fs.existsSync(path.join(source, f)), `${f} is shipped`);
  }
  check(/^MIT License/.test(read('LICENSE')), 'LICENSE is MIT');
  check(read('docs/ARCHITECTURE.md').includes('```mermaid') && /small[\s\S]*medium[\s\S]*large/.test(read('docs/ARCHITECTURE.md')), 'ARCHITECTURE.md has a Mermaid diagram of the small, medium, large growth');
  const licenceTraps = files.filter((f) => /\.(ya?ml|tf|json|sh)$/.test(f) && /\bminio\b|redis:8|redis\/redis-stack/i.test(fs.readFileSync(path.join(source, f), 'utf8')));
  check(licenceTraps.length === 0, 'no MinIO or Redis 8 image anywhere (licence traps)', licenceTraps.join('\n'));
  const stale = files.filter((f) => /\.(ya?ml|tf|json|tpl|txt)$/.test(f) && /\b(billing|nats)\b|system-(core|search|notifications)|^\s*(core|search|notifications):/im.test(fs.readFileSync(path.join(source, f), 'utf8')));
  check(stale.length === 0, 'no leftovers of the five-service split (billing, notifications, search, core, nats)', stale.join('\n'));

  section('consistency with the medium tier (image names, ports, probe paths)');
  const values = read('deploy/helm/system/values.yaml');
  check(/system-web/.test(values) && /system-api/.test(values), 'the chart deploys system-web and system-api');
  check(/PORT: "8080"/.test(values) && /service: \{type: ClusterIP, port: 8080\}/.test(values), 'port 8080 everywhere');
  check(/path: \/healthz/.test(values) && /path: \/readyz/.test(values), 'liveness /healthz and readiness /readyz');
  const medium = path.join(root, 'templates', 'system-medium');
  if (fs.existsSync(path.join(medium, 'compose.yaml'))) {
    const compose = fs.readFileSync(path.join(medium, 'compose.yaml'), 'utf8');
    check(/image: system-api:/.test(compose) && /image: system-web:/.test(compose), 'templates/system-medium builds the same two image names');
    check(/\/readyz/.test(compose) && /APP_JOBS_ENABLED/.test(compose), 'templates/system-medium uses /readyz and the same jobs switch');
  } else {
    skip('compare with templates/system-medium', 'templates/system-medium is not in the tree yet');
  }

  section('workflow pins');
  const pins = checkActionPins(source, { offline });
  check(pins.problems.length === 0, 'every GitHub Action is pinned to a full commit SHA with a version comment', pins.problems.join('\n'));
  if (pins.skipped) skip('action SHAs match their tags', offline ? '--offline' : 'gh is not available');
  else check(pins.verified.length > 0, `action SHAs match their tags (${pins.verified.join(', ')})`);

  section('clean copy (as instantiateTemplate would make it)');
  const docker = dockerAvailable();
  if (!docker) {
    skip('static checks', 'the docker daemon is not reachable');
  } else {
    r.note(`docker ${docker}`);
    scratch = scratchDir('aico-system-large-');
    const app = path.join(scratch, 'app');
    copyTemplate(source, app);
    check(!fs.existsSync(path.join(app, 'template.json')), 'template.json did not come along');
    r.note(app);

    section('scripts/check.sh (every static check, pinned containers)');
    const shell = process.platform === 'win32' ? 'bash' : 'sh';
    const groups = offline ? ['helm', 'kustomize', 'otel', 'rules', 'drift'] : [];
    if (offline) skip('terraform, yaml and scan groups', '--offline');
    const out = run(shell, ['scripts/check.sh', ...groups], { cwd: app, timeout: 40 * 60_000 });
    const lines = out.out.split('\n');
    const results = lines.filter((l) => /^(ok|FAIL)\s/.test(l));
    for (const l of results) {
      const name = l.replace(/^(ok|FAIL)\s+/, '');
      const detail = l.startsWith('FAIL') ? tail(lines.slice(lines.indexOf(l) + 1, lines.indexOf(l) + 30).join('\n'), 25) : undefined;
      check(l.startsWith('ok'), name, detail);
    }
    const unit = /Tests:\s+(\d+) passed, (\d+) total/.exec(out.out);
    check(results.length > 0 && !/^FAIL/m.test(out.out), `check.sh reported ${results.filter((l) => l.startsWith('ok')).length} passing checks and no failure`, tail(out.out));
    if (!offline) {
      const expected = ['helm lint (prod)', 'helm template + kubeconform (prod)', 'helm-unittest', 'prod refuses a tag-only image', 'kustomize build + kubeconform (prod)', 'terraform validate (envs/prod)', 'tflint (terraform + aws ruleset)', 'otel collector config (kubernetes relay)', 'promtool test rules (SLO burn alerts)', 'yamllint', 'trivy config (HIGH, CRITICAL)'];
      for (const name of expected) check(results.includes(`ok   ${name}`), `ran and passed: ${name}`);
    }
    void unit;
    const chartTests = run('docker', ['run', '--rm', '-v', `${path.join(app, 'deploy', 'helm', 'system')}:/src:ro`, '--entrypoint', 'sh', 'helmunittest/helm-unittest:4.2.4-1.2.1', '-c', 'cp -r /src /tmp/apps && cd /tmp/apps && helm unittest .'], { timeout: 5 * 60_000 });
    const m = /Tests:\s+(\d+) passed, (\d+) total/.exec(chartTests.out);
    check(Boolean(m) && m[1] === m[2] && Number(m[1]) >= 49, `helm-unittest: ${m ? `${m[1]} of ${m[2]} tests passed` : 'no summary'} (expected at least 49)`, tail(chartTests.out));
  }
} catch (e) {
  check(false, `unexpected error: ${e.message}`, e.stack);
} finally {
  if (scratch && !flags.has('--keep')) fs.rmSync(scratch, { recursive: true, force: true });
  else if (scratch) r.note(`kept ${scratch}`);
  if (!flags.has('--keep-cache') && dockerAvailable()) {
    for (const v of ['aico-tf-plugin-cache', 'aico-trivy-cache']) run('docker', ['volume', 'rm', '-f', v], { timeout: 60_000 });
  }
}

process.exit(r.finish('Static verification only: nothing was applied to a cluster or a cloud account.'));
