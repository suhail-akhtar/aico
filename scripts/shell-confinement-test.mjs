/**
 * Shell confinement (ADR 0027), offline.
 *
 * Why it exists: in the Phase 0 benchmark an auto-approve turn downloaded a
 * 76 MB Go toolchain into its session folder and began writing shims into
 * `C:\Users\<user>\bin` — outside the workspace, on PATH. The file tools were
 * confined; the shell tools were not. Each block asserts what must now hold:
 *
 *   - the classifier (`assessShellCommand`) finds writes outside the allowed
 *     roots, executable downloads, global installs, running what was
 *     downloaded, and lasting system changes — in POSIX, PowerShell and cmd
 *     forms, with `~`/`$HOME`/`%USERPROFILE%`/`$env:USERPROFILE` expanded and
 *     relative paths resolved through `cd` chains;
 *   - it does NOT flag ordinary work (builds in the project, npm install in
 *     the project, git in the repo, temp files, reads) — false positives are
 *     tested as hard as findings;
 *   - the Go-toolchain incident, reproduced call by call, is caught at every
 *     step that left the project;
 *   - the guard asks a person in auto mode, refuses when unattended, does not
 *     ask twice after the permission card, and honours the person's
 *     `shell.allowedWriteRoots` / `shell.allowDownloads`;
 *   - wired into `runAgent`: refused unattended, runs once a person says yes,
 *     and the ask-mode card names the outside effect;
 *   - the escape hatches are user-only settings and widening them needs a person.
 *
 * Offline and free: nothing here runs a command outside a temp directory and
 * nothing touches ~/.aico.
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'node:url';

for (const k of Object.keys(process.env)) if (/_API_KEY$/.test(k)) delete process.env[k];

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

// ── fixed contexts: pure path rules, the same on any host ────────────
const WIN_TMP = 'C:\\Users\\me\\AppData\\Local\\Temp';
const WIN_WS = 'C:\\Users\\me\\.aico\\workspace\\projects\\proj-1';
const WIN = () => ({
  platform: 'win32', cwd: 'C:\\work\\proj', projectRoot: 'C:\\work\\proj',
  roots: ['C:\\work\\proj', WIN_WS, WIN_TMP, 'C:\\Users\\me\\.aico\\tmp'],
  scratchRoots: [WIN_TMP, 'C:\\Users\\me\\.aico\\workspace'],
  home: 'C:\\Users\\me', tmpdir: WIN_TMP,
  env: { USERPROFILE: 'C:\\Users\\me', TEMP: WIN_TMP, APPDATA: 'C:\\Users\\me\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
  tracker: T.newDownloadTracker(),
});
const NIX = () => ({
  platform: 'posix', cwd: '/home/me/proj', projectRoot: '/home/me/proj',
  roots: ['/home/me/proj', '/home/me/.aico/workspace/projects/proj-1', '/tmp', '/home/me/.aico/tmp'],
  scratchRoots: ['/tmp', '/home/me/.aico/workspace'],
  home: '/home/me', tmpdir: '/tmp', env: { HOME: '/home/me' },
  tracker: T.newDownloadTracker(),
});

const kindsOf = (cmd, ctx) => T.assessShellCommand(cmd, ctx).map(f => f.kind);
function flags(cmd, ctx, kind, target, label) {
  const found = T.assessShellCommand(cmd, ctx);
  const hit = found.find(f => f.kind === kind && (target === undefined || f.target.toLowerCase() === target.toLowerCase()));
  assert(Boolean(hit), `${label ?? cmd} → ${kind}${target ? ` ${target}` : ''}${hit ? '' : ` (got ${JSON.stringify(found.map(f => [f.kind, f.target]))})`}`);
}
function clean(cmd, ctx, label) {
  const found = T.assessShellCommand(cmd, ctx);
  assert(found.length === 0, `${label ?? cmd} → nothing${found.length ? ` (got ${JSON.stringify(found.map(f => [f.kind, f.target]))})` : ''}`);
}

await block('POSIX writes outside the project', async () => {
  flags('echo hi > /etc/motd', NIX(), 'write-outside', '/etc/motd');
  flags('echo x >> ~/.profile_extra', NIX(), 'write-outside', '/home/me/.profile_extra');
  flags('cp tool ~/bin/', NIX(), 'write-outside', '/home/me/bin');
  flags('cp -r dist $HOME/deploy', NIX(), 'write-outside', '/home/me/deploy', 'cp -r keeps the source as a source');
  flags('mv build/app /usr/local/bin/app', NIX(), 'write-outside', '/usr/local/bin/app');
  flags('rm -rf ../sibling', NIX(), 'write-outside', '/home/me/sibling');
  flags('mkdir -p ${HOME}/.config/foo', NIX(), 'write-outside', '/home/me/.config/foo');
  flags('touch /var/tmp/marker', NIX(), 'write-outside', '/var/tmp/marker');
  flags('make | tee ~/build.log', NIX(), 'write-outside', '/home/me/build.log');
  flags('ln -s /home/me/proj/bin/tool ~/bin/tool', NIX(), 'write-outside', '/home/me/bin/tool');
  flags('chmod +x ~/bin/go', NIX(), 'write-outside', '/home/me/bin/go');
  flags('install -m 755 tool /usr/local/bin', NIX(), 'write-outside', '/usr/local/bin');
  flags("sed -i 's/a/b/' ~/.bashrc_local", NIX(), 'write-outside', '/home/me/.bashrc_local');
  flags('tar -xzf src.tgz -C /opt', NIX(), 'write-outside', '/opt');
  flags('unzip pkg.zip -d ~/tools', NIX(), 'write-outside', '/home/me/tools');
  flags('git clone https://github.com/x/y.git ~/src/y', NIX(), 'write-outside', '/home/me/src/y');
  flags('git -C ../other commit -am wip', NIX(), 'write-outside', '/home/me/other');
  flags('git config --global user.name Someone', NIX(), 'write-outside', '/home/me/.gitconfig');
  flags('npm install --prefix ~/global-tools left-pad', NIX(), 'write-outside', '/home/me/global-tools');
  flags('pip install --target /opt/pylibs requests', NIX(), 'write-outside', '/opt/pylibs');
  flags('dd if=img of=/dev/sdb2', NIX(), 'write-outside', '/dev/sdb2');
  flags('rsync -a dist/ ~/backup/', NIX(), 'write-outside', '/home/me/backup');
  flags('find ~/cache -name "*.tmp" -delete', NIX(), 'write-outside', '/home/me/cache');
  flags('cat > ~/bin/go <<\'EOF\'\n#!/bin/sh\nexec /x/go "$@"\nEOF', NIX(), 'write-outside', '/home/me/bin/go', 'heredoc into ~/bin');
  flags('bash -c "echo x > /etc/hosts.extra"', NIX(), 'write-outside', '/etc/hosts.extra', 'bash -c is read inside');
  flags('echo $(cp a ~/stash/a) done', NIX(), 'write-outside', '/home/me/stash/a', 'command substitution is read too');
  flags('D=$HOME/bin; cp tool $D/tool', NIX(), 'write-outside', '/home/me/bin/tool', 'a variable assigned earlier on the line');
  flags('sudo -u root tee /etc/apt/sources.list.d/x.list', NIX(), 'write-outside', '/etc/apt/sources.list.d/x.list', 'through sudo');
});

await block('cd chains and relative paths resolve against the moving cwd', async () => {
  flags('cd .. && cd .. && echo x > y', NIX(), 'write-outside', '/home/y');
  flags('cd /tmp && cd ../etc && touch z', NIX(), 'write-outside', '/etc/z');
  flags('pushd ~ && touch notes.txt && popd', NIX(), 'write-outside', '/home/me/notes.txt');
  clean('cd src && echo x > out.txt', NIX(), 'cd into the project, write there');
  clean('pushd ~ && popd && touch a.txt', NIX(), 'popd returns to the project');
  flags('cd .. ; Set-Content -Path y.txt -Value 1', WIN(), 'write-outside', 'C:\\work\\y.txt');
  flags('Set-Location $HOME; New-Item -ItemType File x.txt', WIN(), 'write-outside', 'C:\\Users\\me\\x.txt');
  flags('cd /d D:\\other && echo x > y.txt', WIN(), 'write-outside', 'D:\\other\\y.txt');
  flags('cd ~/..; echo x > z', NIX(), 'write-outside', '/home/z');
});

await block('Windows: PowerShell and cmd forms, env expansion', async () => {
  flags('New-Item -ItemType Directory -Force -Path $env:USERPROFILE\\bin', WIN(), 'write-outside', 'C:\\Users\\me\\bin');
  flags('Set-Content -Path "$HOME\\bin\\go.cmd" -Value "@echo off"', WIN(), 'write-outside', 'C:\\Users\\me\\bin\\go.cmd');
  flags('"hi" | Out-File -FilePath C:\\Windows\\Temp\\x.txt', WIN(), 'write-outside', 'C:\\Windows\\Temp\\x.txt');
  flags('Copy-Item .\\tool.exe -Destination "$env:LOCALAPPDATA\\Programs\\tool.exe"', WIN(), 'write-outside', 'C:\\Users\\me\\AppData\\Local\\Programs\\tool.exe');
  flags('Move-Item -Path C:\\Users\\me\\Desktop\\a.txt -Destination .\\a.txt', WIN(), 'write-outside', 'C:\\Users\\me\\Desktop\\a.txt', 'Move-Item removes its source');
  flags('Remove-Item -Recurse -Force C:\\Users\\me\\Documents\\old', WIN(), 'write-outside', 'C:\\Users\\me\\Documents\\old');
  flags('Add-Content $PROFILE "Set-Alias g git"', WIN(), 'write-outside', 'C:\\Users\\me\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1');
  flags('copy build\\app.exe %USERPROFILE%\\bin\\', WIN(), 'write-outside', 'C:\\Users\\me\\bin');
  flags('del /s /q %APPDATA%\\npm-cache', WIN(), 'write-outside', 'C:\\Users\\me\\AppData\\Roaming\\npm-cache');
  flags('mkdir %USERPROFILE%\\tools', WIN(), 'write-outside', 'C:\\Users\\me\\tools');
  flags('echo x > /c/Users/me/bin/x', WIN(), 'write-outside', 'C:\\Users\\me\\bin\\x', 'Git Bash /c/ path');
  flags('Expand-Archive pkg.zip -DestinationPath C:\\tools\\pkg', WIN(), 'write-outside', 'C:\\tools\\pkg');
  flags('[IO.File]::WriteAllText("C:\\Users\\me\\bin\\x.cmd", "x")', WIN(), 'write-outside', 'C:\\Users\\me\\bin\\x.cmd');
  flags('pwsh -NoProfile -Command "Set-Content C:\\ProgramData\\x.txt 1"', WIN(), 'write-outside', 'C:\\ProgramData\\x.txt', 'pwsh -Command is read inside');
  flags('cmd /c copy a.txt C:\\Users\\Public\\a.txt', WIN(), 'write-outside', 'C:\\Users\\Public\\a.txt');
});

await block('Lasting system changes (persistence)', async () => {
  for (const cmd of [
    'setx PATH "%PATH%;C:\\Users\\me\\bin"',
    'reg add HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v x /d y',
    'schtasks /create /tn x /tr C:\\x.exe /sc daily',
    'sc.exe create svc binPath= C:\\x.exe',
    'New-ItemProperty -Path HKCU:\\Software\\X -Name y -Value 1',
    '[Environment]::SetEnvironmentVariable("Path", $p, "User")',
    'Register-ScheduledTask -TaskName x -Action $a',
  ]) assert(kindsOf(cmd, WIN()).includes('persistence'), `${cmd} → persistence`);
  for (const cmd of ['systemctl --user enable x.service', 'crontab mycron', 'launchctl load ~/Library/LaunchAgents/x.plist']) {
    assert(kindsOf(cmd, NIX()).includes('persistence'), `${cmd} → persistence`);
  }
  clean('crontab -l', NIX(), 'listing the crontab changes nothing');
  clean('systemctl status nginx', NIX(), 'systemctl status');
});

await block('Downloads of programs and archives', async () => {
  flags('curl -LO https://go.dev/dl/go1.22.4.linux-amd64.tar.gz', NIX(), 'download');
  flags('curl -fsSL -o node.tar.xz https://nodejs.org/dist/v20.11.0/node-v20.11.0-linux-x64.tar.xz', NIX(), 'download');
  flags('wget https://github.com/x/y/releases/download/v1/y-linux', NIX(), 'download', undefined, 'a GitHub release asset');
  flags('curl https://example.com/tool.zip > tool.zip', NIX(), 'download', undefined, 'curl to a redirect');
  flags('Invoke-WebRequest -Uri https://go.dev/dl/go1.22.4.windows-amd64.zip -OutFile go.zip', WIN(), 'download');
  flags('iwr https://example.com/setup.exe -OutFile $env:TEMP\\setup.exe', WIN(), 'download');
  flags('Start-BitsTransfer -Source https://example.com/x.msi -Destination .\\x.msi', WIN(), 'download');
  flags('certutil -urlcache -split -f https://example.com/a.exe a.exe', WIN(), 'download');
  flags('bitsadmin /transfer j https://example.com/a.zip C:\\work\\proj\\a.zip', WIN(), 'download');
  flags('(New-Object Net.WebClient).DownloadFile("https://example.com/x.zip", "C:\\work\\proj\\x.zip")', WIN(), 'download');
  flags('curl -L https://example.com/pkg.tar.gz | tar xz -C ~/sdk', NIX(), 'download', undefined, 'download piped into tar');
  flags('curl -L https://example.com/pkg.tar.gz | tar xz -C ~/sdk', NIX(), 'write-outside', '/home/me/sdk', 'and the extraction outside');
  flags('curl -o ~/Downloads/data.json https://api.example.com/data.json', NIX(), 'write-outside', '/home/me/Downloads/data.json', 'a data download outside is still a write outside');
  clean('curl -s https://api.example.com/v1/items', NIX(), 'an API call to stdout');
  clean('curl -o data.json https://api.example.com/data.json', NIX(), 'a data file into the project');
  clean('wget -qO- https://example.com/health', NIX(), 'wget to stdout');
  clean('Invoke-RestMethod https://api.example.com/items | ConvertTo-Json', WIN(), 'irm of data');
  const allow = { ...NIX(), allowDownloads: true };
  clean('curl -LO https://go.dev/dl/go1.22.4.linux-amd64.tar.gz', allow, 'shell.allowDownloads: the download alone needs nobody');
});

await block('Global installs vs project-local installs', async () => {
  for (const cmd of [
    'npm install -g typescript', 'npm i --global pnpm', 'pnpm add -g turbo', 'yarn global add serve', 'bun add -g x',
    'pip install --user requests', 'pip install requests', 'python -m pip install black', 'pipx install ruff',
    'cargo install ripgrep', 'go install golang.org/x/tools/gopls@latest', 'gem install rails', 'dotnet tool install -g dotnet-ef',
    'brew install go', 'sudo apt-get install -y golang', 'dnf install go', 'pacman -S go', 'rustup toolchain install nightly',
    'uv tool install ruff', 'conda install numpy', 'npm link', 'corepack enable',
  ]) assert(kindsOf(cmd, NIX()).includes('global-install'), `${cmd} → global-install`);
  for (const cmd of ['winget install GoLang.Go', 'choco install golang -y', 'scoop install go', 'Install-Module PSReadLine -Scope CurrentUser', 'msiexec /i go.msi /quiet']) {
    assert(kindsOf(cmd, WIN()).includes('global-install'), `${cmd} → global-install`);
  }
  clean('npm install', NIX(), 'npm install in the project');
  flags('cd ~ && npm install express', NIX(), 'write-outside', '/home/me/node_modules', 'a "local" install in the home folder');
  clean('npm i -D vitest && npm run build', NIX(), 'a dev dependency and a build');
  clean('pnpm install --frozen-lockfile', NIX(), 'pnpm install in the project');
  clean('yarn add react', NIX(), 'yarn add in the project');
  clean('python -m venv .venv && .venv/bin/pip install -r requirements.txt', NIX(), 'pip from the project venv');
  clean('source .venv/bin/activate && pip install -e .', NIX(), 'pip after activating a venv');
  clean('.venv\\Scripts\\activate; pip install requests', WIN(), 'pip after activating a venv (Windows)');
  clean('pip install requests', { ...NIX(), env: { HOME: '/home/me', VIRTUAL_ENV: '/home/me/proj/.venv' } }, 'pip inside an active venv');
  clean('pip install --target ./vendor requests', NIX(), 'pip --target into the project');
  clean('cargo build --release && go build ./...', NIX(), 'builds');
  clean('npm install -g typescript', { ...NIX(), allowDownloads: true }, 'shell.allowDownloads covers global installs');
});

await block('Running what was downloaded', async () => {
  flags('/tmp/go/bin/go version', NIX(), 'run-downloaded', '/tmp/go/bin/go', 'a binary in temp, outside the project');
  flags('& "$env:TEMP\\go\\bin\\go.exe" version', WIN(), 'run-downloaded', `${WIN_TMP}\\go\\bin\\go.exe`);
  flags('export PATH=/tmp/go/bin:$PATH && go version', NIX(), 'run-downloaded', '/tmp/go/bin', 'temp on PATH');
  const ctx = NIX();
  T.assessShellCommand('curl -LO https://ziglang.org/download/0.13.0/zig-linux-x86_64-0.13.0.tar.xz', ctx);
  T.assessShellCommand('tar -xf zig-linux-x86_64-0.13.0.tar.xz', ctx);
  flags('./zig-linux-x86_64-0.13.0/zig version', ctx, 'run-downloaded', undefined, 'unpacked into the project, then run (tracked across calls)');
  clean('./node_modules/.bin/vite build', ctx, 'the project\'s own tools still run after a download');
  clean('./gradlew test && ./scripts/check.sh', NIX(), 'project scripts');
  clean('bash /tmp/aico-check.sh', NIX(), 'a script the agent wrote to temp, run by an interpreter');
  const ctx2 = NIX();
  T.assessShellCommand('curl -fsSL https://example.com/install.sh -o /tmp/install.sh', ctx2);
  flags('sh /tmp/install.sh', ctx2, 'run-downloaded', '/tmp/install.sh', 'a downloaded installer script, run by sh');
});

await block('No false positives on normal dev work', async () => {
  for (const cmd of [
    'npm run build', 'npm test 2>&1 | tail -20', 'tsc --noEmit > /dev/null 2>&1', 'node scripts/gen.mjs > src/generated.ts',
    'git status && git add -A && git commit -m "fix: a > b"', 'git checkout -b feature && git push origin feature',
    'git clone https://github.com/x/y.git vendor/y', 'mkdir -p build/out && cp -r assets build/out/',
    'rm -rf dist node_modules/.cache', 'echo hi > /tmp/scratch.txt', 'mktemp -d', 'cat /etc/os-release', 'ls -la ~ && cat ~/.gitconfig',
    'grep -r TODO src | wc -l', 'find . -name "*.log" -delete', 'tar -czf dist.tgz dist', 'unzip fixtures.zip -d test/fixtures',
    'python - <<EOF\nimport os\nopen("/etc/passwd")\nEOF', 'cargo test 2> errors.txt', 'docker build -t app .',
    'sed -i "s/x/y/" src/a.ts', 'touch .env.example', 'echo done >&2', 'ls > $null', 'cmd 2>nul',
  ]) clean(cmd, NIX());
  for (const cmd of [
    'Get-ChildItem -Recurse | Select-String TODO', 'npm run build | Out-File build.log', 'New-Item -ItemType Directory -Force -Path .\\out',
    'Remove-Item -Recurse -Force .\\dist', 'Set-Content -Path .\\notes.md -Value "x"', 'echo x > $env:TEMP\\aico.txt',
    'dotnet build -c Release', 'Copy-Item .\\a.txt -Destination .\\b.txt', 'git -C C:\\work\\proj status',
    'Expand-Archive .\\fixtures.zip -DestinationPath .\\test', 'Write-Output hi | Out-Null', 'mkdir out 2>nul',
    'echo x > C:\\Users\\me\\.aico\\workspace\\projects\\proj-1\\sessions\\s1\\scratch\\a.txt',
  ]) clean(cmd, WIN());
});

await block('The Go-toolchain incident, reproduced call by call (Windows)', async () => {
  const ctx = WIN();
  const scratch = `${WIN_WS}\\sessions\\s1\\scratch`;
  const step = (cmd) => T.assessShellCommand(cmd, ctx);
  let f = step(`Invoke-WebRequest -Uri https://go.dev/dl/go1.22.4.windows-amd64.zip -OutFile ${scratch}\\go.zip`);
  assert(f.some(x => x.kind === 'download') && !f.some(x => x.kind === 'write-outside'), '1. the 76 MB toolchain download needs a person (it lands in scratch, which is allowed)');
  f = step(`Expand-Archive -Path ${scratch}\\go.zip -DestinationPath ${scratch} -Force`);
  assert(f.length === 0 && ctx.tracker.extracted.length === 1, '2. unpacking into scratch is allowed, and remembered');
  f = step('New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\\bin"');
  assert(f.some(x => x.kind === 'write-outside' && x.target === 'C:\\Users\\me\\bin'), '3. creating C:\\Users\\me\\bin is outside');
  f = step(`Set-Content -Path "$HOME\\bin\\go.cmd" -Value "@${scratch}\\go\\bin\\go.exe %*"`);
  assert(f.some(x => x.kind === 'write-outside' && /\\bin\\go\.cmd$/.test(x.target)), '4. the shim in ~/bin is outside');
  f = step(`& "${scratch}\\go\\bin\\go.exe" version`);
  assert(f.some(x => x.kind === 'run-downloaded'), '5. running the downloaded go.exe needs a person');
  f = step(`$env:PATH = "${scratch}\\go\\bin;$env:PATH"; go version`);
  assert(f.some(x => x.kind === 'run-downloaded'), '6. putting it on PATH needs a person');
});

await block('The same incident in POSIX form, in one line', async () => {
  const f = T.assessShellCommand('curl -LO https://go.dev/dl/go1.22.4.linux-amd64.tar.gz && tar -C ~/.local -xzf go1.22.4.linux-amd64.tar.gz && mkdir -p ~/bin && ln -sf ~/.local/go/bin/go ~/bin/go && ~/.local/go/bin/go version', NIX());
  const k = new Set(f.map(x => x.kind));
  assert(k.has('download') && k.has('write-outside') && k.has('run-downloaded'), `download, writes outside and running it are all found (${[...k].join(', ')})`);
  assert(f.some(x => x.target === '/home/me/bin/go') && f.some(x => x.target === '/home/me/.local'), 'with the exact paths');
  assert(/writes outside the project|downloads|runs a downloaded/.test(T.describeFindings(f)), 'and a one-line description for the card');
});

await block('The guard: asks in auto mode, refuses unattended, never asks twice', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-confine-'));
  const outside = path.join(os.homedir(), 'aico-confinement-test-never-written', 'x.txt');
  const make = (o) => {
    const pipeline = new T.ToolPipeline();
    const sc = T.createShellConfinement({ agentId: 'a1', cwd: () => project, unattended: false, approvedKey: T.HUMAN_APPROVED, ...o });
    sc.install(pipeline);
    return { pipeline, sc };
  };
  const ran = [];
  const run = async (pipeline, name, args, agentId = 'a1', state = new Map()) => pipeline.execute(
    { callId: 'c', name, arguments: args, agentId, state },
    async (ctx) => { ran.push(ctx.arguments.command); return 'ran'; },
  );
  const asks = [];
  let answer = false;
  let { pipeline } = make({ ask: async (title, detail) => { asks.push(detail); return answer; } });
  let r = await run(pipeline, 'Bash', { command: `echo x > "${outside}"` });
  assert(r.denied && asks.length === 1 && asks[0].includes('writes outside the project') && asks[0].includes('full autonomy'), 'auto mode: a person is asked, with the path, and a no refuses');
  answer = true;
  const state = new Map();
  r = await run(pipeline, 'Bash', { command: `echo x > "${outside}"` }, 'a1', state);
  assert(!r.denied && state.get(T.HUMAN_APPROVED) === true, 'a yes lets it run and marks the call approved (the Sentinel will not ask again)');
  r = await run(pipeline, 'PowerShell', { command: 'winget install GoLang.Go' });
  assert(asks.length === 3 && asks[2].includes('installs software outside the project'), 'PowerShell is covered too');
  const before = asks.length;
  r = await run(pipeline, 'Bash', { command: 'npm install && npm run build' });
  assert(!r.denied && asks.length === before, 'ordinary work: nobody is asked');
  r = await run(pipeline, 'Read', { file_path: outside });
  assert(!r.denied && asks.length === before, 'not a shell tool: abstains');
  r = await run(pipeline, 'Bash', { command: `echo x > "${outside}"` }, 'someone-else');
  assert(!r.denied && asks.length === before, 'scoped to its own agent');
  const shown = new Map([[T.SHELL_CONFINEMENT_SHOWN, true]]);
  r = await run(pipeline, 'Bash', { command: `echo x > "${outside}"` }, 'a1', shown);
  assert(!r.denied && asks.length === before, 'after the permission card showed it and the person said yes: not asked twice');
  r = await run(pipeline, 'mcp__aico-host__ide_terminal_run', { command: 'cargo install ripgrep' });
  assert(asks.length === before + 1, 'the desktop terminal runner is covered too');

  ({ pipeline } = make({ unattended: true, ask: async () => true }));
  r = await run(pipeline, 'Bash', { command: 'curl -LO https://go.dev/dl/go1.22.4.linux-amd64.tar.gz' });
  assert(r.denied && /nobody is available/.test(r.denialReason) && /shell\.allowDownloads/.test(r.denialReason), 'unattended: refused, never run, and the reason names the fix');
  ({ pipeline } = make({}));
  r = await run(pipeline, 'Bash', { command: `cp a "${outside}"` });
  assert(r.denied, 'nobody to ask: refused');

  const allowedDir = path.dirname(outside);
  ({ pipeline } = make({ settings: { shell: { allowedWriteRoots: [allowedDir], allowDownloads: true } } }));
  r = await run(pipeline, 'Bash', { command: `echo x > "${outside}"` });
  assert(!r.denied, 'shell.allowedWriteRoots: that folder needs nobody');
  r = await run(pipeline, 'Bash', { command: 'npm i -g typescript' });
  assert(!r.denied, 'shell.allowDownloads: global installs need nobody');
  r = await run(pipeline, 'Bash', { command: `echo x > "${path.join(os.homedir(), 'elsewhere.txt')}"` });
  assert(r.denied, 'but another folder still does');
  assert(!fs.existsSync(path.dirname(outside)), 'nothing was written outside (the dispatch is a stub)');

  const { sc } = make({});
  assert(/writes outside the project/.test(sc.note('Bash', { command: `echo x > "${outside}"` }) ?? ''), 'note(): the permission card text');
  assert(sc.note('Bash', { command: 'npm test' }) === undefined, 'note(): nothing for ordinary work');
  fs.rmSync(project, { recursive: true, force: true });
});

await block('Settings: user-only, and widening needs a person', async () => {
  assert(T.PROJECT_POLICY.shell === 'user-only', 'a project settings file cannot set shell.*');
  assert(/download/.test(T.safetyWeakening({}, { shell: { allowDownloads: true } }) ?? ''), 'turning on downloads needs a person');
  assert(/folder outside the project/.test(T.safetyWeakening({ shell: { allowedWriteRoots: ['/a'] } }, { shell: { allowedWriteRoots: ['/a', '/b'] } }) ?? ''), 'adding a write root needs a person');
  assert(T.safetyWeakening({ shell: { allowedWriteRoots: ['/a', '/b'], allowDownloads: true } }, { shell: { allowedWriteRoots: ['/a'] } }) === undefined, 'narrowing needs nobody');
});

await block('The Sentinel sees downloads and installs (when settings let them through)', async () => {
  const facts = { cwd: os.tmpdir(), tainted: false };
  const t1 = T.sentinelTrigger('Bash', { command: 'curl -LO https://go.dev/dl/go1.22.4.linux-amd64.tar.gz' }, facts);
  assert(t1?.effect === 'external', `an executable download is reviewed as external (${t1?.effect})`);
  const t2 = T.sentinelTrigger('PowerShell', { command: 'winget install GoLang.Go' }, facts);
  assert(t2?.effect === 'exec', `a global install through PowerShell is reviewed as exec (${t2?.effect})`);
  assert(T.sentinelTrigger('Bash', { command: 'npm install' }, facts) === undefined, 'a project install is not reviewed');
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
let n = 0;
async function turn(command, extra = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-confine-run-'));
  const session = new T.Session({ id: `confine-${++n}`, cwd: tmp, startedAt: Date.now() });
  await T.runAgent({
    task: 'Set up the toolchain', model: 'mock-model', showPlan: false, autoApprove: true, verbose: false, silent: true,
    conversationHistory: [], sessionId: session.header.id, session, provider: mock(callBash(command)), settings: BASE, cwd: tmp,
    ...extra,
  });
  const results = session.events.filter(e => e.type === 'tool/result').map(e => JSON.stringify(e.data));
  fs.rmSync(tmp, { recursive: true, force: true });
  return results;
}

await block('Wired into runAgent', async () => {
  // `echo ok` runs and the download after `||` never does: harmless in bash, PowerShell and cmd.
  const cmd = 'echo ok || curl -o go.zip https://go.dev/dl/go1.22.4.windows-amd64.zip';
  let results = await turn(cmd, { headless: true });
  assert(results.some(r => /shell confinement/.test(r) && /nobody is available/.test(r)) && !results.some(r => /"ok/.test(r) || /\\nok|ok\\n/.test(r)), 'auto + unattended: refused before it ran');
  const asked = [];
  results = await turn(cmd, { onApprovalRequired: async (t, d) => { asked.push(d); return true; } });
  assert(asked.length === 1 && /downloads a program or archive/.test(asked[0]) && results.some(r => /ok/.test(r)) && !results.some(r => /shell confinement/.test(r)), 'auto with a person: asked once, and it ran on yes');
  const cards = [];
  const approvals = [];
  results = await turn(cmd, {
    autoApprove: false,
    onPermissionRequest: async (tool, detail) => { cards.push(detail); return true; },
    onApprovalRequired: async (t, d) => { approvals.push(d); return true; },
  });
  assert(cards.length === 1 && /^downloads a program or archive: https:\/\/go\.dev/.test(cards[0]), `ask mode: the normal card names it first (${cards[0]?.slice(0, 80)})`);
  assert(approvals.length === 0, 'and the guard does not ask the same person again');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.map(f => `  - ${f}`).join('\n')); process.exit(1); }
process.exit(0);
