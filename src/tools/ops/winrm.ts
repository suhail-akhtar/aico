/**
 * `WinRmExec`: run PowerShell on a Windows machine through WinRM (PowerShell
 * remoting), with a stored credential the agent never sees.
 *
 * **Windows engines only, on purpose.** WinRM's normal authentication is
 * Negotiate (Kerberos, falling back to NTLM) with message-level encryption.
 * Re-implementing that in JavaScript is a security-sensitive protocol stack;
 * the npm options are either unmaintained (`nodejs-winrm`, last release 2022)
 * or 0.0.x and Basic-only, and Basic over plain HTTP sends the password in
 * the clear. Windows already ships a correct client — `Invoke-Command` — so
 * that is what runs. From Linux or macOS the supported route to a Windows
 * host is its built-in OpenSSH Server and `SshExec`; the tool says so rather
 * than half-working. (ADR 0007.)
 *
 * How the password gets to PowerShell without touching argv or disk:
 * `powershell.exe -EncodedCommand <driver>` where the driver holds only the
 * target, the user name and the auth mode; it reads the password, any
 * `{{secret:…}}` values and the script body from **stdin** (base64 lines),
 * builds a `PSCredential` from a `SecureString`, and calls `Invoke-Command`.
 * Stored values reach the remote script as `-ArgumentList` parameters, so the
 * script text — shown to the person approving, logged by the far side's
 * script-block logging — carries `$AICO_SECRET_n`, never a value.
 *
 * TLS: `-UseSSL` on 5986. Certificate checks are skipped (`-SkipCACheck
 * -SkipCNCheck`) only when the credential's owner allowed self-signed
 * certificates. The engine never edits `TrustedHosts` (a machine setting);
 * when NTLM over HTTP needs it, the error says what the owner must do.
 *
 * @module tools/ops/winrm
 */

import { spawn } from 'node:child_process';
import { parsePlaceholders } from '../../vault/placeholders.js';
import {
  appendCapped, checkRate, clampSeconds, credentialLabel, MASK_NOTE, maskUnknownSecrets, normaliseHost, openOp, OpsError,
  progressReporter, useCredential, validHost, validPort,
} from './common.js';
import { classifyRemoteCommand } from './destructive.js';

export interface WinRmExecInput {
  host: string;
  port?: number;
  credential: string;
  script: string;
  use_ssl?: boolean;
  authentication?: 'negotiate' | 'kerberos' | 'basic' | 'credssp';
  timeout?: number;
}

const AUTH_MODES: Record<string, string> = { negotiate: 'Negotiate', kerberos: 'Kerberos', basic: 'Basic', credssp: 'Credssp' };

/** PowerShell single-quoted literal. */
export function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Rewrite `{{secret:…}}` in a PowerShell script to `$AICO_SECRET_n` variables.
 * In a double-quoted string the reference becomes `$($AICO_SECRET_n)`; in a
 * single-quoted one it cannot expand, so it is refused. Pure.
 */
export function bindPowerShellPlaceholders(script: string): { script: string; refs: Array<{ variable: string; raw: string; field?: string }> } {
  const found = parsePlaceholders(script);
  const refs: Array<{ variable: string; raw: string; field?: string }> = [];
  const byKey = new Map<string, string>();
  let out = '';
  let at = 0;
  for (const ref of found) {
    const before = script.slice(0, ref.start);
    const singles = (before.match(/'/g) ?? []).length;
    const doubles = (before.match(/"/g) ?? []).length;
    if (singles % 2 === 1 && doubles % 2 === 0) {
      throw new OpsError('A {{secret:…}} reference inside a single-quoted PowerShell string cannot expand. Use double quotes or none.');
    }
    const key = `${ref.name}.${ref.field ?? ''}`;
    let variable = byKey.get(key);
    if (!variable) {
      variable = `AICO_SECRET_${refs.length + 1}`;
      byKey.set(key, variable);
      refs.push({ variable, raw: ref.raw, ...(ref.field ? { field: ref.field } : {}) });
    }
    out += script.slice(at, ref.start) + (doubles % 2 === 1 ? `$($${variable})` : `$${variable}`);
    at = ref.end;
  }
  return { script: out + script.slice(at), refs };
}

/**
 * The driver PowerShell runs. Holds no secret: the password, values and
 * script body arrive on stdin. `loopback` runs the script block locally
 * instead of remoting — used only by the test suite to exercise the stdin
 * path on a machine with no WinRM endpoint; the tool never sets it.
 */
export function buildWinRmDriver(opts: {
  host: string; port: number; user: string; useSsl: boolean; auth: string; skipCertChecks: boolean; secretCount: number; loopback?: boolean;
}): string {
  const params = Array.from({ length: opts.secretCount }, (_, i) => `$AICO_SECRET_${i + 1}`).join(', ');
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    '$in = [Console]::In',
    'function Read-Line64 { $l = $in.ReadLine(); if ($null -eq $l) { throw "missing input" }; [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($l)) }',
    '$sec = ConvertTo-SecureString (Read-Line64) -AsPlainText -Force',
    `$cred = New-Object System.Management.Automation.PSCredential(${psQuote(opts.user)}, $sec)`,
    '$argList = @()',
    `for ($i = 0; $i -lt ${opts.secretCount}; $i++) { $argList += ,(Read-Line64) }`,
    '$body = Read-Line64',
    `$sb = [ScriptBlock]::Create("param(${params.replace(/\$/g, '`$')})" + [Environment]::NewLine + $body)`,
    // Setup failures stop the driver; the script's own errors are collected
    // and streamed as they arrive, so its earlier output is never lost.
    "$ErrorActionPreference = 'Continue'",
    '$script:failed = $false',
    'try {',
    opts.loopback
      ? '  $null = $cred.GetNetworkCredential().Password.Length; & $sb @argList 2>&1 | ForEach-Object {'
      : [
        `  $o = @{ ComputerName = ${psQuote(opts.host)}; Port = ${opts.port}; Credential = $cred; Authentication = ${psQuote(opts.auth)}; ScriptBlock = $sb; ArgumentList = $argList }`,
        opts.useSsl ? '  $o.UseSSL = $true' : '',
        opts.skipCertChecks ? '  $o.SessionOption = New-PSSessionOption -SkipCACheck -SkipCNCheck -SkipRevocationCheck' : '',
        '  Invoke-Command @o 2>&1 | ForEach-Object {',
      ].filter(Boolean).join('\n'),
    '    if ($_ -is [System.Management.Automation.ErrorRecord]) { [Console]::Error.WriteLine($_.ToString()); $script:failed = $true }',
    '    else { ($_ | Out-String -Width 4096).TrimEnd() | ForEach-Object { [Console]::Out.WriteLine($_) } }',
    '  }',
    '} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 2 }',
    'if ($script:failed) { exit 1 } else { exit 0 }',
  ].join('\n');
}

/** Run a driver with its stdin lines. Values exist only in this child's stdin pipe. */
export function runPowerShellDriver(driver: string, lines: string[], opts: { timeoutMs: number; signal?: AbortSignal; onOutput?: (t: string) => void }):
  Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; cancelled: boolean }> {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', Buffer.from(driver, 'utf16le').toString('base64')], {
      windowsHide: true,
      env: { ...process.env, AICO_AGENT_SHELL: '1' },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cancelled = false;
    let done = false;
    const kill = (): void => { try { child.kill(); } catch { /* gone */ } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, opts.timeoutMs);
    timer.unref?.();
    const onAbort = (): void => { cancelled = true; kill(); };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d: Buffer) => { const t = d.toString('utf8'); stdout = appendCapped(stdout, t); opts.onOutput?.(t); });
    child.stderr.on('data', (d: Buffer) => { const t = d.toString('utf8'); stderr = appendCapped(stderr, t); opts.onOutput?.(t); });
    const finish = (code: number | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut, cancelled });
    };
    child.on('error', (err) => { stderr += `Could not start PowerShell: ${err.message}`; finish(null); });
    child.on('close', (code) => finish(code));
    child.stdin.on('error', () => { /* the child exited before reading everything */ });
    child.stdin.end(lines.map(l => Buffer.from(l, 'utf8').toString('base64')).join('\n') + '\n');
  });
}

/** Hints for the errors people actually hit with WinRM. */
function winrmHint(stderr: string, useSsl: boolean): string | undefined {
  if (/TrustedHosts/i.test(stderr)) {
    return 'This machine does not trust that host for NTLM over HTTP. The owner can use HTTPS (use_ssl, port 5986) — preferred — '
      + 'or add the host to WSMan TrustedHosts themselves; AICO does not change that machine setting.';
  }
  if (/Access is denied|logon failure|username or password is incorrect/i.test(stderr)) return 'The host rejected the stored credential.';
  if (/cannot connect|WinRM cannot complete|No connection could be made/i.test(stderr)) {
    return `WinRM is not reachable (is the service enabled and port ${useSsl ? 5986 : 5985} open?).`;
  }
  if (/certificate/i.test(stderr) && useSsl) return 'The host\'s certificate is not trusted. Self-signed is accepted only if the credential allows it.';
  return undefined;
}

export async function winRmExec(input: WinRmExecInput, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (process.platform !== 'win32') {
    throw new OpsError('WinRmExec needs AICO running on Windows (it uses Windows\' own PowerShell remoting client). From here, '
      + 'enable the Windows host\'s built-in OpenSSH Server and use SshExec with PowerShell commands.');
  }
  if (!validHost(input.host)) throw new OpsError('`host` must be a host name or IP address.');
  if (typeof input.script !== 'string' || !input.script.trim()) throw new OpsError('`script` is required.');
  if (input.script.length > 100_000) throw new OpsError('The script is over 100 KB.');
  const host = normaliseHost(input.host);
  const useSsl = input.use_ssl ?? (input.port === 5986);
  const port = validPort(input.port, useSsl ? 5986 : 5985);
  const auth = AUTH_MODES[input.authentication ?? 'negotiate'];
  if (!auth) throw new OpsError('`authentication` must be negotiate, kerberos, basic or credssp.');
  if (auth === 'Basic' && !useSsl) throw new OpsError('Basic authentication over plain HTTP would send the password readable on the wire. Use use_ssl.');
  const timeoutS = clampSeconds(input.timeout, 120, 30 * 60);
  checkRate('WinRmExec', host);
  const bound = bindPowerShellPlaceholders(input.script);
  const verdict = classifyRemoteCommand(input.script);
  const target = `${host}:${port}`;
  const summary = input.script.length > 100 ? `${input.script.slice(0, 97)}…` : input.script;
  const op = openOp({ tool: 'WinRmExec', target, credential: credentialLabel(input.credential ?? ''), summary });
  const lines: string[] = [];
  try {
    const purpose = `${verdict.destructive ? `DESTRUCTIVE (${verdict.reasons.join(', ')}). ` : ''}WinRmExec on ${target}${useSsl ? ' (https)' : ''}: ${input.script}`;
    const secret = await useCredential(input.credential, { tool: 'WinRmExec', host: target, purpose, requireApproval: verdict.destructive });
    let user: string | undefined;
    let skipCertChecks = false;
    try {
      user = secret.username;
      if (!user) throw new OpsError(`The credential "${secret.name}" does not name a user (DOMAIN\\user or user@domain).`);
      if (!['winrm', 'login', 'basic-auth', 'ssh-password', 'generic'].includes(secret.kind)) {
        throw new OpsError(`The credential "${secret.name}" is a ${secret.kind}, not a password WinRM can use.`);
      }
      skipCertChecks = useSsl && secret.allowSelfSigned;
      lines.push(secret.value());
    } finally {
      secret.release();
    }
    for (const r of bound.refs) {
      const s = await useCredential(r.raw, { tool: 'WinRmExec', host: target, purpose: `use in a script on ${target}: ${input.script}`.slice(0, 2000) });
      try { lines.push(s.value(r.field)); } finally { s.release(); }
    }
    lines.push(bound.script);
    const driver = buildWinRmDriver({ host, port, user: user!, useSsl, auth, skipCertChecks, secretCount: bound.refs.length });
    const startedAt = Date.now();
    const progress = progressReporter(startedAt);
    let live = '';
    const out = await runPowerShellDriver(driver, lines, {
      timeoutMs: timeoutS * 1000, ...(signal ? { signal } : {}),
      onOutput: (t) => { live = appendCapped(live, t, 64_000); progress.report(live); },
    });
    lines.length = 0;
    const notes: string[] = [];
    if (out.timedOut) notes.push(`Stopped after ${timeoutS}s.`);
    const hint = winrmHint(out.stderr, useSsl);
    if (hint) notes.push(hint);
    const so = maskUnknownSecrets(out.stdout);
    const se = maskUnknownSecrets(out.stderr);
    if (so.masked || se.masked) notes.push(MASK_NOTE);
    const exit = out.code ?? 124;
    if (out.cancelled) op.fail('cancelled', { cancelled: true });
    else if (exit === 0) op.done('exit 0');
    else op.fail(`exit ${exit}`);
    return {
      host, port, transport: useSsl ? 'https' : 'http (message-encrypted by Negotiate)', user, credential: credentialLabel(input.credential),
      exit_code: exit, stdout: so.text, stderr: se.text, duration_ms: Date.now() - startedAt,
      ...(verdict.destructive ? { approved_as: `destructive: ${verdict.reasons.join(', ')}` } : {}),
      ...(notes.length ? { notes } : {}),
      work_id: op.id,
    };
  } catch (err) {
    op.fail(err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    lines.length = 0;
  }
}

export const winRmExecDefinition = {
  name: 'WinRmExec',
  description: 'Run PowerShell on a Windows machine through WinRM (PowerShell remoting) with a stored credential you never '
    + 'see (username in the credential as DOMAIN\\user or user@domain). Needs AICO running on Windows; from Linux/macOS use '
    + 'SshExec against the host\'s OpenSSH Server. Put {{secret:NAME}} where a stored value must go (it arrives as a '
    + 'parameter, never in the script text). Destructive scripts (service stops, firewall changes, deletes, reboots) are '
    + 'shown to a person to approve first. Prefer use_ssl (5986).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      host: { type: 'string' },
      port: { type: 'number', description: 'Default 5985 (http), 5986 with use_ssl.' },
      credential: { type: 'string', description: 'Stored credential name (winrm or login).' },
      script: { type: 'string', description: 'PowerShell to run on the host.' },
      use_ssl: { type: 'boolean', description: 'WinRM over HTTPS (5986). Recommended.' },
      authentication: { type: 'string', enum: ['negotiate', 'kerberos', 'basic', 'credssp'], description: 'Default negotiate. Basic only over HTTPS.' },
      timeout: { type: 'number', description: 'Seconds, default 120, max 1800.' },
    },
    required: ['host', 'credential', 'script'],
  },
};
