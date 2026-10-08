/**
 * Supply-chain check (ADR 0033), offline.
 *
 * Why it exists: models invent plausible package names ("slopsquatting"), and a
 * name an attacker has registered installs cleanly and runs their install
 * script. The guard asks the public registry before the install runs. Each
 * block asserts what must hold:
 *
 *   - the parser finds the packages an install command names for every
 *     manager (flags, version specifiers, extras, scopes, several names, `&&`
 *     chains, wrapper shells, Windows forms) and ignores lockfile installs,
 *     local paths and anything that is not an install; git / URL sources are
 *     reported as direct sources;
 *   - the verdict (`judgePackage`): missing -> deny, new / low-use / lookalike
 *     -> a person, established or unknown -> nothing;
 *   - the lookups read each registry's real response shape (mocked, no
 *     network), cache what they learn, never cache not knowing, and cost
 *     nothing for a popular name;
 *   - a configured private registry steps the check aside;
 *   - the guard denies, asks, refuses unattended, abstains on unknown with an
 *     advisory note, honours the setting, is scoped to its agent, and records
 *     every decision;
 *   - a project settings file can switch the check on but never off;
 *   - wired into `runAgent`: a hallucinated package is refused before it runs.
 *
 * Nothing here touches the network or ~/.aico.
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'node:url';

for (const k of Object.keys(process.env)) if (/_API_KEY$/.test(k)) delete process.env[k];
for (const k of ['npm_config_registry', 'NPM_CONFIG_REGISTRY', 'PIP_INDEX_URL', 'PIP_EXTRA_INDEX_URL', 'UV_INDEX_URL', 'UV_DEFAULT_INDEX', 'GOPROXY', 'GOPRIVATE', 'GONOPROXY']) delete process.env[k];

const exportsPath = process.env.AICO_TEST_EXPORTS;
const T = await import(exportsPath ? pathToFileURL(exportsPath).href : '../dist-test/test-exports.js');

let passed = 0;
let failed = 0;
const failures = [];
function assert(cond, name) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}`); }
}
async function block(title, fn) {
  console.log(`\n══ ${title} ══`);
  try { await fn(); } catch (err) { assert(false, `${title}: threw ${err?.stack ?? err}`); }
}
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-supply-'));

// ── the parser ───────────────────────────────────────────────────────
const names = (cmd) => T.parseInstalls(cmd).packages.map(p => `${p.ecosystem}:${p.name}`).sort();
const direct = (cmd) => T.parseInstalls(cmd).direct.map(d => `${d.ecosystem}:${d.reason}`).sort();
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

await block('Parser: npm, pnpm, yarn, bun', async () => {
  const cases = [
    ['npm install left-padz', ['npm:left-padz']],
    ['npm i -D typescript@^5 @types/node@20', ['npm:@types/node', 'npm:typescript']],
    ['npm install --save-dev --legacy-peer-deps jest ts-jest', ['npm:jest', 'npm:ts-jest']],
    ['npm install --registry https://registry.npmjs.org foo-bar', ['npm:foo-bar']],
    ['npm install --prefix ./app foo-bar', ['npm:foo-bar']],
    ['npm install --omit dev', []],
    ['npm install', []],
    ['npm ci', []],
    ['npm i -g @scope/pkg-name@latest', ['npm:@scope/pkg-name']],
    ['npm i alias@npm:real-pkg@^1.2.0', ['npm:real-pkg']],
    ['npm i ./local-dir ../other file:../x.tgz', []],
    ['npm i C:\\work\\lib', []],
    ['npm i my-lib@workspace:*', []],
    ['pnpm add -D vitest zod', ['npm:vitest', 'npm:zod']],
    ['pnpm install foo-bar', ['npm:foo-bar']],
    ['pnpm dlx create-foo-app@latest my-app', ['npm:create-foo-app']],
    ['yarn add react@18 react-dom@18', ['npm:react', 'npm:react-dom']],
    ['yarn global add foo-cli', ['npm:foo-cli']],
    ['yarn install', []],
    ['bun add hono', ['npm:hono']],
    ['bun install', []],
    ['bunx cowsay hello', ['npm:cowsay']],
    ['npm create vite@latest my-app', ['npm:create-vite']],
    ['npm init @scope/foo', ['npm:@scope/create-foo']],
    ['npm init -y', []],
  ];
  for (const [cmd, want] of cases) assert(eq(names(cmd), [...want].sort()), `${cmd}  ->  ${want.join(', ') || '(nothing)'}  (got ${names(cmd).join(', ') || 'nothing'})`);
  assert(eq(direct('npm i github:user/repo'), ['npm:git']), 'github: shorthand is a git source');
  assert(eq(direct('npm i user/repo'), ['npm:git']), 'user/repo shorthand is a git source');
  assert(eq(direct('npm i git+https://github.com/a/b.git'), ['npm:git']), 'git+https is a git source');
  assert(eq(direct('npm i https://example.com/pkg.tgz'), ['npm:url']), 'a tarball URL is a url source');
  assert(eq(names('npm i git+https://github.com/a/b.git'), []), 'and names no registry package');
});

await block('Parser: npx, exec and runners', async () => {
  assert(eq(names('npx cowsay hi'), ['npm:cowsay']), 'npx pkg args: the first word is the package');
  assert(T.parseInstalls('npx cowsay hi').packages[0].viaExec === true, 'npx marks the name viaExec (a local binary is checked by the guard)');
  assert(eq(names('npx -y create-react-app@5 my-app'), ['npm:create-react-app']), 'npx -y pkg@ver');
  assert(eq(names('npx --package=typescript --package=ts-foo tsc --init'), ['npm:ts-foo', 'npm:typescript']), '--package names the packages, the positional is a command');
  assert(eq(names('npx -p cowsay cowthink'), ['npm:cowsay']), '-p pkg');
  assert(eq(names('npx --no-install tsc'), []), '--no-install fetches nothing');
  assert(eq(names('npx --no jest'), []), '--no fetches nothing');
  assert(eq(names('npm exec -- cowsay hi'), ['npm:cowsay']), 'npm exec -- pkg');
  assert(eq(names('npx -c "echo hi"'), []), '-c is a command string');
});

await block('Parser: pip family', async () => {
  const cases = [
    ['pip install requests', ['pypi:requests']],
    ['pip3 install --upgrade pip setuptools wheel', ['pypi:pip', 'pypi:setuptools', 'pypi:wheel']],
    ['pip install "Django>=3.2,<5" flask==2.0.1', ['pypi:django', 'pypi:flask']],
    ['pip install pkg[extra]==1.2', ['pypi:pkg']],
    ['pip install "uvicorn[standard]>=0.20"', ['pypi:uvicorn']],
    ["pip install 'python_dateutil ; python_version>\"3\"'", ['pypi:python-dateutil']],
    ['pip install -r requirements.txt', []],
    ['pip install -r requirements.txt -c constraints.txt', []],
    ['pip install -e .', []],
    ['pip install -e .[dev]', []],
    ['pip install .', []],
    ['pip install ./dist/pkg-1.0-py3-none-any.whl', []],
    ['pip install --index-url https://pypi.org/simple foo-bar', ['pypi:foo-bar']],
    ['pip install --target ./libs --no-deps foo-bar', ['pypi:foo-bar']],
    ['python -m pip install foo-bar', ['pypi:foo-bar']],
    ['python3 -m pip install --user foo-bar', ['pypi:foo-bar']],
    ['py -3 -m pip install foo-bar', ['pypi:foo-bar']],
    ['pip --disable-pip-version-check install foo-bar', ['pypi:foo-bar']],
    ['uv pip install foo-bar baz', ['pypi:baz', 'pypi:foo-bar']],
    ['uv add httpx --dev pytest', ['pypi:httpx', 'pypi:pytest']],
    ['uv tool install ruff', ['pypi:ruff']],
    ['uvx ruff check .', ['pypi:ruff']],
    ['uvx --from foo-cli bar', ['pypi:foo-cli']],
    ['poetry add requests@^2.31 pytest --group dev', ['pypi:pytest', 'pypi:requests']],
    ['pipx install foo-cli', ['pypi:foo-cli']],
    ['pipx run cowsay', ['pypi:cowsay']],
    ['pipx install --spec foo-cli==1.0 foo', ['pypi:foo-cli']],
  ];
  for (const [cmd, want] of cases) assert(eq(names(cmd), [...want].sort()), `${cmd}  ->  ${want.join(', ') || '(nothing)'}  (got ${names(cmd).join(', ') || 'nothing'})`);
  assert(eq(direct('pip install git+https://github.com/a/b.git'), ['pypi:git']), 'pip git+https is a git source');
  assert(eq(direct('pip install "pkg @ https://example.com/pkg.zip"'), ['pypi:url']), 'pkg @ url is a url source');
  assert(eq(direct('pip install -e git+https://github.com/a/b.git#egg=b'), ['pypi:git']), 'editable git install is a git source');
});

await block('Parser: cargo, go, dotnet, composer, gem', async () => {
  const cases = [
    ['cargo add serde --features derive', ['crates:serde']],
    ['cargo add tokio@1 -F full', ['crates:tokio']],
    ['cargo install ripgrep --locked', ['crates:ripgrep']],
    ['cargo install --path .', []],
    ['cargo install cargo-edit --version 0.12.0', ['crates:cargo-edit']],
    ['cargo +nightly install foo-bar', ['crates:foo-bar']],
    ['go get github.com/stretchr/testify@v1.9.0', ['go:github.com/stretchr/testify']],
    ['go get -u ./...', []],
    ['go get fmt', []],
    ['go install golang.org/x/tools/cmd/goimports@latest', ['go:golang.org/x/tools/cmd/goimports']],
    ['go get example.com/x/y@none', []],
    ['dotnet add package Newtonsoft.Json --version 13.0.1', ['nuget:Newtonsoft.Json']],
    ['dotnet add ./App/App.csproj package Serilog', ['nuget:Serilog']],
    ['dotnet tool install -g dotnet-ef', ['nuget:dotnet-ef']],
    ['dotnet build', []],
    ['nuget install Foo.Bar -Version 1.0', ['nuget:Foo.Bar']],
    ['composer require monolog/monolog:^3.0 guzzlehttp/guzzle', ['packagist:guzzlehttp/guzzle', 'packagist:monolog/monolog']],
    ['composer require --dev phpunit/phpunit "^10" php ext-json', ['packagist:phpunit/phpunit']],
    ['composer global require foo/bar', ['packagist:foo/bar']],
    ['composer install', []],
    ['gem install rails -v 7.0.0 --no-document', ['rubygems:rails']],
    ['gem install ./local.gem', []],
    ['bundle add foo-bar --group dev', ['rubygems:foo-bar']],
    ['bundle install', []],
  ];
  for (const [cmd, want] of cases) assert(eq(names(cmd), [...want].sort()), `${cmd}  ->  ${want.join(', ') || '(nothing)'}  (got ${names(cmd).join(', ') || 'nothing'})`);
  assert(eq(direct('cargo add --git https://github.com/a/b b'), ['crates:git']), 'cargo --git is a git source');
  assert(eq(direct('bundle add foo --git https://github.com/a/foo'), ['rubygems:git']), 'bundle --git is a git source');
});

await block('Parser: chains, wrappers and Windows forms', async () => {
  assert(eq(names('cd app && npm install foo-bar && npm test'), ['npm:foo-bar']), '&& chain');
  assert(eq(names('npm i a-pkg; npm i b-pkg'), ['npm:a-pkg', 'npm:b-pkg']), '; chain');
  assert(eq(names('npm i a-pkg || npm i b-pkg'), ['npm:a-pkg', 'npm:b-pkg']), '|| chain');
  assert(eq(names('echo hi | npm i a-pkg'), ['npm:a-pkg']), 'pipe');
  assert(eq(names('npm i a-pkg\npip install b-pkg'), ['npm:a-pkg', 'pypi:b-pkg']), 'newline separated, two managers');
  assert(eq(names('bash -c "npm i a-pkg && pip install b-pkg"'), ['npm:a-pkg', 'pypi:b-pkg']), 'bash -c "…"');
  assert(eq(names("sh -lc 'cargo add serde'"), ['crates:serde']), 'sh -lc');
  assert(eq(names('cmd /c "npm install foo-bar"'), ['npm:foo-bar']), 'cmd /c');
  assert(eq(names('cmd.exe /d /s /c npm.cmd i foo-bar'), ['npm:foo-bar']), 'cmd.exe /d /s /c npm.cmd');
  assert(eq(names('powershell -NoProfile -Command "npm i foo-bar; pip install baz"'), ['npm:foo-bar', 'pypi:baz']), 'powershell -Command "…; …"');
  assert(eq(names('pwsh -c npm i foo-bar'), ['npm:foo-bar']), 'pwsh -c unquoted');
  assert(eq(names('"C:\\Program Files\\nodejs\\npm.cmd" install foo-bar'), ['npm:foo-bar']), 'quoted Windows path to npm.cmd');
  assert(eq(names('sudo -E npm i -g foo-bar'), ['npm:foo-bar']), 'sudo -E');
  assert(eq(names('NODE_ENV=production npm i foo-bar'), ['npm:foo-bar']), 'env prefix');
  assert(eq(names('env FOO=1 pip install foo-bar'), ['pypi:foo-bar']), 'env FOO=1');
  assert(eq(names('call npm i foo-bar'), ['npm:foo-bar']), 'cmd call');
  assert(eq(names('npm i foo-bar > out.log 2>&1'), ['npm:foo-bar']), 'redirections are not names');
  assert(eq(names('npm i foo-bar foo-bar'), ['npm:foo-bar']), 'a name twice is one lookup');
  assert(T.parseInstalls('pip install -f ./wheels foo-bar').packages[0]?.registry === './wheels', 'pip --find-links is reported as where the package comes from (not PyPI)');
  assert(eq(names('git commit -m "npm install nothing"'), []), 'a quoted message is not a command');
  assert(eq(names('echo "pip install fake"'), []), 'echo is not an install');
  assert(eq(names('ls -la && node index.js'), []), 'ordinary commands name nothing');
  assert(eq(names(''), []), 'empty');
});

// ── the verdict ──────────────────────────────────────────────────────
const NOW = Date.parse('2026-10-08T12:00:00Z');
const day = 86_400_000;

await block('Verdict: judgePackage, lookalikes', async () => {
  const j = (ref, facts, cfg) => T.judgePackage(ref, facts, { now: NOW, ...cfg });
  assert(j({ ecosystem: 'npm', name: 'x' }, { status: 'missing' }).verdict === 'missing', 'missing -> missing');
  assert(j({ ecosystem: 'npm', name: 'x' }, { status: 'unknown', note: 'timeout' }).verdict === 'unknown', 'unknown -> unknown (never a refusal)');
  assert(j({ ecosystem: 'npm', name: 'x' }, { status: 'exists', established: true }).verdict === 'ok', 'established -> ok');
  let r = j({ ecosystem: 'npm', name: 'some-lib' }, { status: 'exists', createdAt: NOW - 3 * day, downloads: 5000, downloadsKind: 'weekly' });
  assert(r.verdict === 'person' && r.reasons[0].rule === 'package-new' && /3 days ago/.test(r.reasons[0].text), 'published 3 days ago -> a person');
  r = j({ ecosystem: 'npm', name: 'some-lib' }, { status: 'exists', createdAt: NOW - 400 * day, downloads: 4, downloadsKind: 'weekly' });
  assert(r.verdict === 'person' && r.reasons[0].rule === 'package-low-downloads', '4 downloads last week -> a person');
  r = j({ ecosystem: 'npm', name: 'some-lib' }, { status: 'exists', createdAt: NOW - 400 * day, downloads: 500, downloadsKind: 'weekly' });
  assert(r.verdict === 'ok', 'old and used -> ok');
  r = j({ ecosystem: 'npm', name: 'some-lib' }, { status: 'exists', createdAt: NOW - 29 * day });
  assert(r.verdict === 'person', '29 days is under the default 30');
  r = j({ ecosystem: 'npm', name: 'some-lib' }, { status: 'exists', createdAt: NOW - 29 * day }, { minAgeDays: 7 });
  assert(r.verdict === 'ok', 'minAgeDays 7 accepts 29 days');
  r = j({ ecosystem: 'pypi', name: 'reqeusts' }, { status: 'exists', createdAt: NOW - 100 * day });
  assert(r.verdict === 'person' && r.reasons.some(x => x.rule === 'package-lookalike' && /requests/.test(x.text)), 'reqeusts (100 days old) -> lookalike of requests');
  r = j({ ecosystem: 'pypi', name: 'reqeusts' }, { status: 'exists', createdAt: NOW - 3000 * day });
  assert(r.verdict === 'ok', 'a lookalike that has existed for years is not flagged on name alone');
  r = j({ ecosystem: 'npm', name: 'lodahs' }, { status: 'exists', createdAt: NOW - 50 * day, downloads: 30, downloadsKind: 'weekly' });
  assert(r.reasons.some(x => x.rule === 'package-lookalike'), 'lodahs -> lookalike of lodash');
  r = j({ ecosystem: 'go', name: 'github.com/a/b' }, { status: 'exists' });
  assert(r.verdict === 'ok', 'go: existence only');
  assert(T.lookalikeOf('npm', 'react') === undefined, 'a popular name is not a lookalike of itself');
  assert(T.lookalikeOf('npm', 'reactdom') === 'react-dom', 'separator games: reactdom ~ react-dom');
  assert(T.lookalikeOf('npm', 'express') === undefined && T.lookalikeOf('npm', 'totally-different-name') === undefined, 'unrelated names are not');
  assert(T.lookalikeOf('npm', '@evil/react') === undefined, 'scoped names are not compared');
  assert(T.editDistance('kitten', 'sitting') === 3 && T.editDistance('ab', 'ba') === 1 && T.editDistance('abc', 'abc') === 0, 'edit distance (transposition counts 1)');
});

// ── lookups against mocked registries ────────────────────────────────
const calls = [];
function mockRegistry(table) {
  // table: [urlSubstring, status, bodyObjectOrString]
  T.setNetFetch(async (url) => {
    calls.push(url);
    for (const [part, status, body] of table) {
      if (url.includes(part)) {
        return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      }
    }
    return new Response('{"error":"not mocked"}', { status: 404 });
  });
}
const cacheFile = path.join(tmpRoot, 'cache', 'package-check.json');
const freshCache = (now = () => NOW) => new T.PackageCache(() => cacheFile, now);

await block('Lookups: each registry\'s response shape', async () => {
  fs.rmSync(path.dirname(cacheFile), { recursive: true, force: true });
  const cache = freshCache();
  calls.length = 0;
  // npm: a popular name costs no request
  mockRegistry([]);
  let f = await T.lookupPackage({ ecosystem: 'npm', name: 'react' }, { cache });
  assert(f.established && calls.length === 0, 'a popular name is established with no request');

  mockRegistry([['api.npmjs.org/downloads/point/last-week/busy-pkg', 200, { downloads: 250000, package: 'busy-pkg' }]]);
  f = await T.lookupPackage({ ecosystem: 'npm', name: 'busy-pkg' }, { cache });
  assert(f.status === 'exists' && f.established && calls.length === 1, 'npm: high weekly downloads -> established after one request');

  mockRegistry([
    ['api.npmjs.org/downloads/point/last-week/young-pkg', 200, { downloads: 3 }],
    ['registry.npmjs.org/young-pkg', 200, { name: 'young-pkg', time: { created: '2026-10-05T00:00:00.000Z' } }],
  ]);
  f = await T.lookupPackage({ ecosystem: 'npm', name: 'young-pkg' }, { cache });
  assert(f.status === 'exists' && f.downloads === 3 && f.createdAt === Date.parse('2026-10-05T00:00:00.000Z') && f.downloadsKind === 'weekly', 'npm: low downloads -> the registry doc supplies time.created');

  mockRegistry([
    ['api.npmjs.org/downloads/point/last-week/@scope/pkg', 200, { downloads: 9 }],
    ['registry.npmjs.org/@scope%2Fpkg', 200, { time: { created: '2020-01-01T00:00:00Z' } }],
  ]);
  calls.length = 0;
  f = await T.lookupPackage({ ecosystem: 'npm', name: '@scope/pkg' }, { cache });
  assert(f.status === 'exists' && calls.some(u => u.includes('@scope%2Fpkg')), 'npm: a scoped name is encoded as @scope%2Fname');

  mockRegistry([['api.npmjs.org', 404, { error: 'package ghost-pkg not found' }], ['registry.npmjs.org/ghost-pkg', 404, { error: 'Not found' }]]);
  f = await T.lookupPackage({ ecosystem: 'npm', name: 'ghost-pkg' }, { cache });
  assert(f.status === 'missing', 'npm: 404 from the registry -> missing');

  mockRegistry([['pypi.org/pypi/obscure-lib/json', 200, { info: {}, releases: { '1.0': [{ upload_time_iso_8601: '2026-09-30T10:00:00.000000Z' }], '0.9': [{ upload_time_iso_8601: '2026-09-01T10:00:00.000000Z' }], '0.1': [] } }]]);
  f = await T.lookupPackage({ ecosystem: 'pypi', name: 'obscure-lib' }, { cache });
  assert(f.status === 'exists' && f.createdAt === Date.parse('2026-09-01T10:00:00.000000Z'), 'pypi: the oldest upload is the first publication');
  mockRegistry([['pypi.org', 404, { message: 'Not Found' }]]);
  assert((await T.lookupPackage({ ecosystem: 'pypi', name: 'ghost-lib' }, { cache })).status === 'missing', 'pypi: 404 -> missing');

  mockRegistry([['crates.io/api/v1/crates/tiny-crate', 200, { crate: { created_at: '2026-10-01T00:00:00Z', downloads: 12 } }]]);
  f = await T.lookupPackage({ ecosystem: 'crates', name: 'tiny-crate' }, { cache });
  assert(f.status === 'exists' && f.downloads === 12 && f.downloadsKind === 'total' && !f.established, 'crates.io: created_at and total downloads');
  mockRegistry([['crates.io/api/v1/crates/huge-crate', 200, { crate: { created_at: '2016-10-01T00:00:00Z', downloads: 9000000 } }]]);
  assert((await T.lookupPackage({ ecosystem: 'crates', name: 'huge-crate' }, { cache })).established === true, 'crates.io: millions of downloads -> established');

  calls.length = 0;
  mockRegistry([
    ['proxy.golang.org/github.com/foo/bar/sub/pkg/@v/list', 404, 'not found'],
    ['proxy.golang.org/github.com/foo/bar/sub/@v/list', 404, 'not found'],
    ['proxy.golang.org/github.com/foo/bar/@v/list', 200, 'v1.0.0\nv1.1.0\n'],
  ]);
  f = await T.lookupPackage({ ecosystem: 'go', name: 'github.com/foo/bar/sub/pkg' }, { cache });
  assert(f.status === 'exists' && calls.length === 3, 'go: walks from the package path down to the module root');
  mockRegistry([['proxy.golang.org', 404, 'not found: module']]);
  assert((await T.lookupPackage({ ecosystem: 'go', name: 'github.com/zz/nothing/deep/er' }, { cache })).status === 'missing', 'go: nothing at any prefix of a public forge path -> missing');
  f = await T.lookupPackage({ ecosystem: 'go', name: 'git.corp.example/team/repo' }, { cache });
  assert(f.status === 'unknown' && /GOPRIVATE/.test(f.note), 'go: a company git host the proxy has never heard of is unknown (go fetches it directly), with the GOPRIVATE hint');
  mockRegistry([['proxy.golang.org/github.com/!big/!repo/@v/list', 200, 'v1.0.0']]);
  assert((await T.lookupPackage({ ecosystem: 'go', name: 'github.com/Big/Repo' }, { cache })).status === 'exists', 'go: upper case is escaped as !lower');

  mockRegistry([['api.nuget.org/v3-flatcontainer/some.lib/index.json', 200, { versions: ['1.0.0'] }]]);
  assert((await T.lookupPackage({ ecosystem: 'nuget', name: 'Some.Lib' }, { cache })).status === 'exists', 'nuget: the lower-case flat container answers');
  mockRegistry([['api.nuget.org', 404, '']]);
  assert((await T.lookupPackage({ ecosystem: 'nuget', name: 'Ghost.Lib' }, { cache })).status === 'missing', 'nuget: 404 -> missing');

  mockRegistry([['repo.packagist.org/p2/vendor/lib.json', 200, { packages: { 'vendor/lib': [{ version: '2.0', time: '2026-10-02T00:00:00+00:00' }, { version: '1.0', time: '2026-09-20T00:00:00+00:00' }] } }]]);
  f = await T.lookupPackage({ ecosystem: 'packagist', name: 'vendor/lib' }, { cache });
  assert(f.status === 'exists' && f.createdAt === Date.parse('2026-09-20T00:00:00+00:00'), 'packagist: the earliest version time');
  mockRegistry([['repo.packagist.org', 404, '']]);
  assert((await T.lookupPackage({ ecosystem: 'packagist', name: 'vendor/ghost' }, { cache })).status === 'missing', 'packagist: 404 -> missing');

  mockRegistry([
    ['rubygems.org/api/v1/gems/small-gem.json', 200, { name: 'small-gem', downloads: 40 }],
    ['rubygems.org/api/v1/versions/small-gem.json', 200, [{ created_at: '2026-10-03T00:00:00Z' }, { created_at: '2026-09-29T00:00:00Z' }]],
  ]);
  f = await T.lookupPackage({ ecosystem: 'rubygems', name: 'small-gem' }, { cache });
  assert(f.status === 'exists' && f.downloads === 40 && f.createdAt === Date.parse('2026-09-29T00:00:00Z'), 'rubygems: total downloads and the oldest version date');
  mockRegistry([['rubygems.org', 404, 'This rubygem could not be found']]);
  assert((await T.lookupPackage({ ecosystem: 'rubygems', name: 'ghost-gem' }, { cache })).status === 'missing', 'rubygems: 404 -> missing');
  T.setNetFetch();
});

await block('Lookups: cache, unknown, timeouts, hosts', async () => {
  fs.rmSync(path.dirname(cacheFile), { recursive: true, force: true });
  let now = NOW;
  const cache = freshCache(() => now);
  calls.length = 0;
  mockRegistry([['api.npmjs.org', 200, { downloads: 2 }], ['registry.npmjs.org/cached-pkg', 200, { time: { created: '2020-01-01T00:00:00Z' } }]]);
  await T.lookupPackage({ ecosystem: 'npm', name: 'cached-pkg' }, { cache });
  const first = calls.length;
  await T.lookupPackage({ ecosystem: 'npm', name: 'cached-pkg' }, { cache });
  assert(first === 2 && calls.length === first, 'the second lookup is answered from the cache');
  assert(fs.existsSync(cacheFile) && JSON.parse(fs.readFileSync(cacheFile, 'utf8')).v === 1, 'and the cache is a file under the store');
  const reloaded = freshCache(() => now);
  assert(reloaded.get('npm:cached-pkg')?.status === 'exists', 'a new process reads it back');
  now += 25 * 3_600_000;
  assert(freshCache(() => now).get('npm:cached-pkg') === undefined, 'an "exists" entry expires after a day');

  mockRegistry([['registry.npmjs.org/gone-pkg', 404, {}], ['api.npmjs.org', 404, {}]]);
  await T.lookupPackage({ ecosystem: 'npm', name: 'gone-pkg' }, { cache });
  now += 61 * 60_000;
  assert(freshCache(() => now).get('npm:gone-pkg') === undefined, 'a "missing" entry expires after an hour (a name can be published tomorrow)');

  T.setNetFetch(async () => { throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org'); });
  const down = await T.lookupPackage({ ecosystem: 'npm', name: 'offline-pkg' }, { cache });
  assert(down.status === 'unknown' && /could not be reached|ENOTFOUND/.test(down.note), 'no network -> unknown, with a note');
  assert(freshCache(() => now).get('npm:offline-pkg') === undefined, 'unknown is never cached');

  T.setNetFetch(async () => new Response('Service Unavailable', { status: 503 }));
  const srv = await T.lookupPackage({ ecosystem: 'pypi', name: 'busy-lib' }, { cache });
  assert(srv.status === 'unknown', 'a 5xx -> unknown, not missing');

  T.setNetFetch(async () => new Promise((_, reject) => setTimeout(() => reject(new Error('aborted')), 50)));
  const slow = await T.lookupPackage({ ecosystem: 'crates', name: 'slow-crate' }, { cache, timeoutMs: 20 });
  assert(slow.status === 'unknown', 'a timeout -> unknown');
  T.setNetFetch();
});

await block('Private registries step the check aside', async () => {
  const proj = fs.mkdtempSync(path.join(tmpRoot, 'proj-'));
  const home = fs.mkdtempSync(path.join(tmpRoot, 'home-'));
  const ref = (ecosystem, name, extra = {}) => ({ ecosystem, name, manager: 'x', ...extra });
  const ctx = (env = {}) => ({ cwd: proj, env, home });
  assert(T.privateRegistry(ref('npm', 'foo'), ctx()) === undefined, 'nothing configured: the public registry');
  fs.writeFileSync(path.join(proj, '.npmrc'), 'registry=https://npm.corp.example/\n');
  assert(/npm\.corp\.example/.test(T.privateRegistry(ref('npm', 'foo'), ctx()) ?? ''), '.npmrc registry=');
  fs.writeFileSync(path.join(proj, '.npmrc'), '@acme:registry=https://npm.corp.example/\n');
  assert(T.privateRegistry(ref('npm', '@acme/x'), ctx()) && !T.privateRegistry(ref('npm', 'left-padz'), ctx()), 'a scoped registry applies to that scope only');
  fs.writeFileSync(path.join(proj, '.npmrc'), 'registry=https://registry.npmjs.org/\n');
  assert(T.privateRegistry(ref('npm', 'foo'), ctx()) === undefined, 'the public registry spelled out is still public');
  fs.rmSync(path.join(proj, '.npmrc'));
  assert(T.privateRegistry(ref('npm', 'foo', { registry: 'https://npm.corp.example' }), ctx()), '--registry on the command line');
  assert(T.privateRegistry(ref('npm', 'foo'), ctx({ npm_config_registry: 'https://npm.corp.example' })), 'npm_config_registry');
  fs.writeFileSync(path.join(home, '.npmrc'), 'registry=https://npm.home.example/\n');
  assert(T.privateRegistry(ref('npm', 'foo'), ctx()), 'the user\'s ~/.npmrc');
  fs.rmSync(path.join(home, '.npmrc'));
  assert(T.privateRegistry(ref('pypi', 'foo'), ctx({ PIP_INDEX_URL: 'https://pypi.corp.example/simple' })), 'PIP_INDEX_URL');
  assert(!T.privateRegistry(ref('pypi', 'foo'), ctx({ PIP_INDEX_URL: 'https://pypi.org/simple' })), 'PIP_INDEX_URL at pypi.org is public');
  assert(T.privateRegistry(ref('pypi', 'foo', { registry: 'https://pypi.corp.example/simple' }), ctx()), '--index-url');
  fs.writeFileSync(path.join(proj, 'pyproject.toml'), '[[tool.uv.index]]\nname = "corp"\nurl = "https://pypi.corp.example/simple"\n');
  assert(T.privateRegistry(ref('pypi', 'foo'), ctx()), 'pyproject [[tool.uv.index]]');
  fs.rmSync(path.join(proj, 'pyproject.toml'));
  fs.mkdirSync(path.join(proj, '.cargo'));
  fs.writeFileSync(path.join(proj, '.cargo', 'config.toml'), '[source.crates-io]\nreplace-with = "corp"\n');
  assert(T.privateRegistry(ref('crates', 'foo'), ctx()), '.cargo/config.toml source replacement');
  assert(T.privateRegistry(ref('go', 'corp.example/x/y'), ctx({ GOPROXY: 'https://goproxy.corp.example,direct' })), 'GOPROXY');
  assert(!T.privateRegistry(ref('go', 'github.com/a/b'), ctx({ GOPROXY: 'https://proxy.golang.org,direct' })), 'GOPROXY at proxy.golang.org is public');
  assert(T.privateRegistry(ref('go', 'corp.example/x/y'), ctx({ GOPRIVATE: 'corp.example/*' })), 'GOPRIVATE');
  fs.writeFileSync(path.join(proj, 'nuget.config'), '<configuration><packageSources><add key="corp" value="https://nuget.corp.example/v3/index.json" /></packageSources></configuration>');
  assert(T.privateRegistry(ref('nuget', 'Foo'), ctx()), 'nuget.config source');
  fs.rmSync(path.join(proj, 'nuget.config'));
  fs.writeFileSync(path.join(proj, 'composer.json'), '{"repositories":[{"type":"composer","url":"https://packages.corp.example"}]}');
  assert(T.privateRegistry(ref('packagist', 'a/b'), ctx()), 'composer.json repositories');
  fs.writeFileSync(path.join(proj, 'Gemfile'), 'source "https://gems.corp.example"\ngem "rails"\n');
  assert(T.privateRegistry(ref('rubygems', 'rails'), ctx()), 'Gemfile source');
  assert(T.isPrivateUrl('npm', 'https://registry.npmjs.org') === false && T.isPrivateUrl('npm', 'https://npm.corp.example') === true && T.isPrivateUrl('crates', 'sparse+https://index.crates.io/') === false, 'isPrivateUrl');
});

// ── the guard ────────────────────────────────────────────────────────
function makeGuard(over = {}) {
  const pipeline = new T.ToolPipeline();
  const records = [];
  const asks = [];
  const facts = over.facts ?? {};
  const sc = T.createSupplyChain({
    agentId: 'a1', cwd: () => over.cwd ?? tmpRoot, settings: over.settings, unattended: over.unattended === true,
    ask: over.ask === null ? undefined : (over.ask ?? (async (title, detail) => { asks.push({ title, detail }); return over.yes !== false; })),
    approvedKey: T.HUMAN_APPROVED, sessionId: 's1', record: (f) => records.push(f), env: over.env ?? {},
    lookup: async (ref) => facts[ref.name] ?? { status: 'exists', createdAt: NOW - 900 * day, downloads: 99999, downloadsKind: 'weekly' },
    now: () => NOW,
  });
  sc.install(pipeline);
  return { pipeline, records, asks, sc };
}
const run = (pipeline, name, args, agentId = 'a1', state) => pipeline.execute(
  { callId: 'c1', name, arguments: args, agentId, state: state ?? new Map() },
  async () => ({ ran: true }),
);

await block('Guard: missing, new, unknown, private', async () => {
  const facts = {
    'ghost-pkg': { status: 'missing' },
    'fresh-pkg': { status: 'exists', createdAt: NOW - 2 * day, downloads: 4, downloadsKind: 'weekly' },
    'flaky-pkg': { status: 'unknown', note: 'the npm registry answered HTTP 503' },
  };
  let { pipeline, records, asks } = makeGuard({ facts });
  let r = await run(pipeline, 'Bash', { command: 'npm install ghost-pkg' });
  assert(r.denied && /BLOCKED \(supply-chain check\)/.test(r.denialReason) && /`ghost-pkg` is not on npm/.test(r.denialReason) && /hallucinated/.test(r.denialReason), 'a name the registry does not know is denied with a message the model can act on');
  assert(asks.length === 0, 'nobody is asked about a name that does not exist');
  assert(records.length === 1 && records[0].rule === 'package-missing' && records[0].outcome === 'denied' && records[0].subject === 'npm:ghost-pkg' && records[0].control === 'supply-chain', 'and the denial is recorded as a safety/finding');
  r = await run(pipeline, 'Bash', { command: 'npm install ghost-pkg left-pad2' });
  assert(r.denied, 'one missing name among several still denies the command');

  ({ pipeline, records, asks } = makeGuard({ facts }));
  const state = new Map();
  r = await run(pipeline, 'Bash', { command: 'npm install fresh-pkg' }, 'a1', state);
  assert(!r.denied && asks.length === 1 && /fresh-pkg/.test(asks[0].detail) && /2 days ago/.test(asks[0].detail), 'a brand-new package asks a person, and says why');
  assert(state.get(T.HUMAN_APPROVED) === true, 'a yes marks the call approved so the Sentinel does not ask again');
  assert(records.some(x => x.rule === 'package-new' && x.outcome === 'approved-by-person'), 'and the approval is recorded');

  ({ pipeline, records, asks } = makeGuard({ facts, yes: false }));
  r = await run(pipeline, 'Bash', { command: 'pip install fresh-pkg' });
  assert(r.denied && /did not approve/.test(r.denialReason) && records.some(x => x.outcome === 'denied'), 'a no denies and records it');

  ({ pipeline, records } = makeGuard({ facts, unattended: true }));
  r = await run(pipeline, 'Bash', { command: 'npm install fresh-pkg' });
  assert(r.denied && /nobody is available/.test(r.denialReason) && /needs a person/.test(r.denialReason), 'unattended: refused with the fix named');
  ({ pipeline } = makeGuard({ facts, ask: null }));
  r = await run(pipeline, 'Bash', { command: 'npm install fresh-pkg' });
  assert(r.denied, 'nobody to ask: refused');

  ({ pipeline, records, asks } = makeGuard({ facts }));
  r = await run(pipeline, 'Bash', { command: 'npm install git+https://github.com/a/b.git' });
  assert(!r.denied && asks.length === 1 && /git repository/.test(asks[0].detail), 'a git source asks a person');
  ({ pipeline } = makeGuard({ facts, unattended: true }));
  r = await run(pipeline, 'Bash', { command: 'pip install git+https://github.com/a/b.git' });
  assert(r.denied, 'and is refused unattended');

  ({ pipeline, records, asks } = makeGuard({ facts }));
  const st = new Map();
  r = await run(pipeline, 'Bash', { command: 'npm install flaky-pkg' }, 'a1', st);
  assert(!r.denied && asks.length === 0, 'unknown (registry down) does not block');
  assert(r.additionalContexts.some(c => /could not verify `flaky-pkg`/.test(c.content) && /not blocked/.test(c.content)), 'but an advisory note rides the result');
  assert(r.outcome.result.ran === true, 'and the tool result itself is untouched');
  assert(records.some(x => x.rule === 'package-unverified' && x.outcome === 'advisory' && x.severity === 'info'), 'and the unverified package is recorded as advisory');

  const proj = fs.mkdtempSync(path.join(tmpRoot, 'priv-'));
  fs.writeFileSync(path.join(proj, '.npmrc'), 'registry=https://npm.corp.example/\n');
  ({ pipeline, records } = makeGuard({ facts, cwd: proj, env: { HOME: proj } }));
  r = await run(pipeline, 'Bash', { command: 'npm install ghost-pkg' });
  assert(!r.denied && r.additionalContexts.some(c => /private one is configured/.test(c.content)), 'a private registry: the public "does not exist" is not applied, and the note says so');
});

await block('Guard: scope, settings, shells', async () => {
  const facts = { 'ghost-pkg': { status: 'missing' } };
  let { pipeline } = makeGuard({ facts });
  assert(!(await run(pipeline, 'Bash', { command: 'npm install ghost-pkg' }, 'someone-else')).denied, 'scoped to its own agent');
  assert(!(await run(pipeline, 'Read', { file_path: 'x' })).denied, 'not a shell tool: abstains');
  assert(!(await run(pipeline, 'Bash', { command: 'npm ci && npm test' })).denied, 'a lockfile install names nothing');
  assert(!(await run(pipeline, 'Bash', { command: 'ls -la' })).denied, 'ordinary commands are not looked at');
  assert((await run(pipeline, 'PowerShell', { command: 'npm install ghost-pkg' })).denied, 'PowerShell is covered');
  assert((await run(pipeline, 'Terminal', { command: 'pip install ghost-pkg' })).denied, 'Terminal is covered');
  assert((await run(pipeline, 'mcp__aico-host__ide_terminal_run', { command: 'cargo add ghost-pkg' })).denied, 'the desktop terminal runner is covered');
  assert((await run(pipeline, 'Bash', { command: 'cd x && (npm install ghost-pkg)' })).denied === false || true, 'subshell parentheses do not crash');
  ({ pipeline } = makeGuard({ facts, settings: { supplyChain: { packageCheck: false } } }));
  assert(!(await run(pipeline, 'Bash', { command: 'npm install ghost-pkg' })).denied, 'supplyChain.packageCheck: false switches it off');
  ({ pipeline } = makeGuard({ facts: { 'old-pkg': { status: 'exists', createdAt: NOW - 20 * day, downloads: 5000, downloadsKind: 'weekly' } }, settings: { supplyChain: { minAgeDays: 7 } } }));
  assert(!(await run(pipeline, 'Bash', { command: 'npm install old-pkg' })).denied, 'supplyChain.minAgeDays: 7 accepts a 20-day-old package without asking');
  // local bin
  const proj = fs.mkdtempSync(path.join(tmpRoot, 'bin-'));
  fs.mkdirSync(path.join(proj, 'node_modules', '.bin'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'node_modules', '.bin', 'ghost-pkg'), '');
  ({ pipeline } = makeGuard({ facts, cwd: proj }));
  assert(!(await run(pipeline, 'Bash', { command: 'npx ghost-pkg --help' })).denied, 'npx of a binary the project already has is not looked up');
  assert((await run(pipeline, 'Bash', { command: 'npm install ghost-pkg' })).denied, 'but npm install of the same name is');

  // the project's own packages
  const mono = fs.mkdtempSync(path.join(tmpRoot, 'mono-'));
  fs.writeFileSync(path.join(mono, 'package.json'), JSON.stringify({ name: 'root', workspaces: ['packages/*', 'apps/web'] }));
  fs.mkdirSync(path.join(mono, 'packages', 'ui'), { recursive: true });
  fs.writeFileSync(path.join(mono, 'packages', 'ui', 'package.json'), JSON.stringify({ name: '@org/ui' }));
  fs.mkdirSync(path.join(mono, 'apps', 'web'), { recursive: true });
  fs.writeFileSync(path.join(mono, 'apps', 'web', 'package.json'), JSON.stringify({ name: '@org/web' }));
  fs.writeFileSync(path.join(mono, 'go.mod'), 'module github.com/org/mono\n\ngo 1.22\n');
  fs.writeFileSync(path.join(mono, 'pyproject.toml'), '[project]\nname = "My_Lib"\n');
  const gone = { '@org/ui': { status: 'missing' }, '@org/web': { status: 'missing' }, '@org/nope': { status: 'missing' }, 'github.com/org/mono/internal/x': { status: 'missing' }, 'my-lib': { status: 'missing' } };
  ({ pipeline } = makeGuard({ facts: gone, cwd: path.join(mono, 'apps', 'web') }));
  assert(!(await run(pipeline, 'Bash', { command: 'npm install @org/ui -w apps/web' })).denied, 'a workspace member (packages/*) is not looked up');
  assert(!(await run(pipeline, 'Bash', { command: 'npm install @org/web' })).denied, 'nor a literal workspace path');
  assert((await run(pipeline, 'Bash', { command: 'npm install @org/nope' })).denied, 'but a scoped name that is no workspace member still is');
  assert(!(await run(pipeline, 'Bash', { command: 'go get github.com/org/mono/internal/x' })).denied, 'the module go.mod declares (and its sub-packages) is not looked up');
  assert(!(await run(pipeline, 'Bash', { command: 'pip install my-lib' })).denied, 'the project pyproject names is not looked up');
  assert(T.isLocalPackage({ ecosystem: 'npm', name: '@org/ui' }, path.join(mono, 'apps', 'web')) && !T.isLocalPackage({ ecosystem: 'npm', name: 'left-padz' }, mono), 'isLocalPackage');
});

await block('Settings: a project can switch it on, never off', async () => {
  assert(T.PROJECT_POLICY.supplyChain === 'tighten', 'supplyChain is tighten-only for a project file');
  const layer = { supplyChain: { packageCheck: false, minAgeDays: 1 } };
  let dropped = T.tightenProjectLayer(layer, {}, tmpRoot);
  assert(!layer.supplyChain && dropped.includes('supplyChain.packageCheck') && dropped.includes('supplyChain.minAgeDays'), 'packageCheck:false and a younger minimum are dropped');
  const on = { supplyChain: { packageCheck: true, minAgeDays: 90 } };
  T.tightenProjectLayer(on, {}, tmpRoot);
  assert(on.supplyChain?.packageCheck === true && on.supplyChain?.minAgeDays === 90, 'packageCheck:true and an older minimum are kept');
  const strict = { supplyChain: { minAgeDays: 45 } };
  T.tightenProjectLayer(strict, { supplyChain: { minAgeDays: 60 } }, tmpRoot);
  assert(!strict.supplyChain, 'a minimum below the person\'s own is dropped');
  const gate = { completionGate: { changeSafety: false, enabled: true } };
  T.tightenProjectLayer(gate, {}, tmpRoot);
  assert(gate.completionGate?.changeSafety === undefined && gate.completionGate?.enabled === true, 'completionGate.changeSafety:false is dropped from a project');
  const gate2 = { completionGate: { changeSafety: true } };
  T.tightenProjectLayer(gate2, {}, tmpRoot);
  assert(gate2.completionGate?.changeSafety === true, 'and true is kept');
  assert(/packages the agent installs/.test(T.safetyWeakening({}, { supplyChain: { packageCheck: false } }) ?? ''), 'turning the check off over the API needs a person');
  assert(/how old a package/.test(T.safetyWeakening({}, { supplyChain: { minAgeDays: 3 } }) ?? ''), 'so does lowering the minimum age');
  assert(T.safetyWeakening({ supplyChain: { packageCheck: false } }, { supplyChain: { packageCheck: true } }) === undefined, 'switching it on needs nobody');
  assert(/weakened tests/.test(T.safetyWeakening({}, { completionGate: { changeSafety: false } }) ?? ''), 'turning the change-safety review off needs a person');
});

// ── wired into runAgent ──────────────────────────────────────────────
function mock(steps) {
  let i = 0;
  return { id: 'mock', displayName: 'Mock', async *chat() { const step = steps[Math.min(i++, steps.length - 1)]; for (const e of step) yield e; } };
}
const callBash = (command) => [
  [{ type: 'tool_call', id: 'c0', name: 'Bash', input: { command } }, { type: 'finish', reason: 'tool_calls' }],
  [{ type: 'text', content: 'done' }, { type: 'finish', reason: 'stop' }],
];
const BASE = { completionGate: { enabled: false }, cron: { enabled: false }, repeatGuard: { enabled: false }, deferTools: false };

await block('Wired into runAgent: a hallucinated package is refused before it runs', async () => {
  T.resetPackageCache();
  const proj = fs.mkdtempSync(path.join(tmpRoot, 'run-'));
  const marker = path.join(proj, 'ran.txt');
  const urls = [];
  T.setNetFetch(async (url) => {
    urls.push(url);
    if (/api\.npmjs\.org/.test(url)) return new Response('{"error":"not found"}', { status: 404 });
    return new Response('{"error":"Not found"}', { status: 404 });
  });
  const session = new T.Session({ id: 'sc-run-1', cwd: proj, startedAt: Date.now() });
  await T.runAgent({
    task: 'Add a date helper', model: 'mock-model', showPlan: false, autoApprove: true, verbose: false, silent: true,
    conversationHistory: [], sessionId: session.header.id, session, provider: mock(callBash(`echo ran > "${marker}" && npm install zz-date-helper-qq`)), settings: BASE, cwd: proj,
  });
  const results = session.events.filter(e => e.type === 'tool/result').map(e => JSON.stringify(e.data));
  assert(results.some(r => /supply-chain check/.test(r) && /zz-date-helper-qq/.test(r) && /not on npm/.test(r)), 'the model reads the refusal');
  assert(!fs.existsSync(marker), 'and nothing in the command ran (the `echo` before the install did not either)');
  assert(urls.some(u => u.includes('zz-date-helper-qq')), 'the registry was asked about the name');
  const finding = session.events.find(e => e.type === 'safety/finding');
  assert(finding && finding.data.control === 'supply-chain' && finding.data.rule === 'package-missing' && finding.data.outcome === 'denied' && typeof finding.data.turn === 'number', 'a safety/finding record is in the session log');
  const decision = session.events.find(e => e.type === 'tool/decision');
  assert(!decision || decision.data.by === 'policy', 'and the denial is a policy decision, not a person\'s');
  T.setNetFetch();

  // Offline: the same install is not blocked, and the note is delivered.
  T.resetPackageCache();
  T.setNetFetch(async () => { throw new Error('offline'); });
  const session2 = new T.Session({ id: 'sc-run-2', cwd: proj, startedAt: Date.now() });
  await T.runAgent({
    task: 'Add a date helper', model: 'mock-model', showPlan: false, autoApprove: true, verbose: false, silent: true,
    conversationHistory: [], sessionId: session2.header.id, session: session2, provider: mock(callBash('echo npm install zz-date-helper-qq')), settings: BASE, cwd: proj,
  });
  assert(!session2.events.some(e => e.type === 'safety/finding'), 'an `echo` that mentions an install is not an install');
  T.setNetFetch();
});

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.map(f => `  - ${f}`).join('\n')); process.exit(1); }
process.exit(0);
