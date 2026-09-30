/**
 * `aico vault …` — the credential vault from a terminal.
 *
 * The commands that let a value out (`show`, `export`) or destroy one
 * (`remove`) need three things: an interactive terminal on both ends, a typed
 * confirmation naming the credential, and not being run from the agent's own
 * shell. Each is a hurdle, not a wall, and they are described that way in
 * the docs:
 *
 *  - The agent's Bash has no terminal, so `isTTY` is false there. A process
 *    can allocate a pseudo-terminal (`script`, `expect`, Python's `pty`), so
 *    this alone would not be enough.
 *  - Every shell AICO spawns carries `AICO_AGENT_SHELL=1`, and these commands
 *    refuse to run under it. A command can unset a variable, so this alone
 *    would not be enough either.
 *  - The shell guard refuses `aico vault show|export` outright.
 *  - With a passphrase vault, or a grant passphrase set, the person must also
 *    type that passphrase — which the model does not have. This is the one
 *    real barrier, and the docs recommend setting it.
 *
 * Secrets are read with a hidden prompt, or from stdin when piped (so a
 * script can add a credential without it appearing in argv or history).
 *
 * @module vault/cli
 */

import fs from 'node:fs';
import type { Command } from 'commander';
import { newScryptParams, scryptKey, unwrap, wrap, type ScryptParams, type Wrapped } from './crypto.js';
import { promptHidden } from './human.js';
import { getVault } from './index.js';
import { generatePassword, generateSshKeyPair, generateToken } from './generate.js';
import { CREDENTIAL_KINDS, SECRET_FIELDS, VaultError, type CredentialKind, type CredentialMeta, type Policy } from './types.js';

const EXPORT_LABEL = 'aico-vault-export';

interface ExportFile {
  format: 'aico-vault-export';
  version: 1;
  scrypt: ScryptParams;
  data: Wrapped;
}

function fail(message: string): never {
  console.error(`  ✗ ${message}`);
  process.exit(1);
}

/** Refuse from the agent's shell or a non-interactive session. */
function requireHuman(what: string): void {
  if (process.env.AICO_AGENT_SHELL === '1') fail(`${what} cannot be run from an AICO agent's shell.`);
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail(`${what} needs an interactive terminal.`);
}

async function readLine(question: string): Promise<string> {
  const readline = await import('node:readline');
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => { rl.close(); resolve(a.trim()); });
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

/** Open the vault for this CLI process, asking for the passphrase when it has one. */
async function openVault(opts: { create?: boolean } = {}) {
  const vault = getVault();
  const st = vault.status();
  if (!st.exists) {
    if (!opts.create) fail('There is no credential vault yet. `aico vault add` creates one.');
    try {
      await vault.store.init();
    } catch (err) {
      if (err instanceof VaultError && err.code === 'unavailable' && process.stdin.isTTY) {
        console.log('  No OS keyring is available, so the vault will be sealed with a passphrase.');
        const p1 = await promptHidden('  New vault passphrase: ');
        const p2 = await promptHidden('  Again: ');
        if (p1 !== p2) fail('The passphrases did not match.');
        const { passphraseKeyProvider } = await import('./keys.js');
        const { configureVault } = await import('./index.js');
        const fresh = configureVault({ dir: vault.dir, keyProvider: passphraseKeyProvider });
        await fresh.store.init({ passphrase: p1 });
        return fresh;
      }
      throw err;
    }
    return vault;
  }
  if (st.interactive && !vault.store.isUnlocked()) {
    if (!process.stdin.isTTY) fail('The vault is passphrase-sealed and this is not an interactive terminal.');
    await vault.unlock(await promptHidden('  Vault passphrase: '));
  } else {
    await vault.ready();
    if (!vault.store.isUnlocked()) await vault.store.unlock();
  }
  return vault;
}

/** When a grant passphrase exists (keyring vaults), `show`/`export` also need it. */
async function requireGrantPassphrase(vault: ReturnType<typeof getVault>): Promise<void> {
  const st = vault.status();
  if (st.interactive) return; // already typed to unlock
  if (!st.grantPassphrase) {
    console.log('  (Tip: `aico vault grant-passphrase` makes reveals also require a passphrase the agent cannot know.)');
    return;
  }
  if (!(await vault.store.verifyHumanPassphrase(await promptHidden('  Grant passphrase: ')))) fail('Wrong passphrase.');
}

function row(c: { name: string; kind: string; username?: string; host?: string; url?: string; createdBy: string; quarantined?: boolean }): string {
  const where = c.url ?? c.host ?? '—';
  return `  ${c.name.padEnd(28)} ${c.kind.padEnd(13)} ${(c.username ?? '').padEnd(16)} ${where.padEnd(32)} ${c.createdBy.startsWith('agent') ? 'agent' : 'user'}${c.quarantined ? '  [quarantined]' : ''}`;
}

export function registerVaultCommands(program: Command): void {
  const cmd = program.command('vault').description('manage the credential vault (the agent uses credentials by name, never by value)');

  cmd.command('init')
    .description('create the vault (OS keyring, or a passphrase with --passphrase)')
    .option('--passphrase', 'seal with a passphrase instead of the OS keyring')
    .action(async (o: { passphrase?: boolean }) => {
      const vault = getVault();
      if (vault.status().exists) fail('A vault already exists.');
      if (o.passphrase) {
        requireHuman('Creating a passphrase vault');
        const p1 = await promptHidden('  New vault passphrase: ');
        if (p1 !== await promptHidden('  Again: ')) fail('The passphrases did not match.');
        const { passphraseKeyProvider } = await import('./keys.js');
        const { configureVault } = await import('./index.js');
        await configureVault({ dir: vault.dir, keyProvider: passphraseKeyProvider }).store.init({ passphrase: p1 });
      } else {
        await vault.store.init();
      }
      console.log(`  ✓ Vault created at ${vault.dir} (${getVault().status().provider}).`);
      process.exit(0);
    });

  cmd.command('list')
    .description('list credentials (metadata only)')
    .option('--host <host>', 'only those bound to this host')
    .option('--kind <kind>', 'only this kind')
    .action(async (o: { host?: string; kind?: string }) => {
      const vault = await openVault();
      const creds = await vault.list({ ...(o.host ? { host: o.host } : {}), ...(o.kind ? { kind: o.kind as CredentialKind } : {}) });
      if (!creds.length) console.log('  The vault is empty.');
      for (const c of creds) console.log(row(c));
      process.exit(0);
    });

  cmd.command('add <name>')
    .description('store a credential; the secret is read from a hidden prompt or stdin')
    .requiredOption('-k, --kind <kind>', `one of: ${CREDENTIAL_KINDS.join(', ')}`)
    .option('-u, --username <username>')
    .option('--host <host>', 'host it may be used with')
    .option('--port <port>')
    .option('--url <url>', 'origin it may be used with (write http:// explicitly for plain http)')
    .option('-d, --description <text>')
    .option('--field <field>', 'secret field to set (default: the kind\'s main field)')
    .option('--generate', 'generate a random value instead of reading one')
    .option('--allow-shell', 'allow {{secret:name}} in agent shell commands (each approved by you)')
    .action(async (name: string, o: Record<string, string | boolean | undefined>) => {
      const kind = String(o.kind) as CredentialKind;
      if (!CREDENTIAL_KINDS.includes(kind)) fail(`Unknown kind "${kind}".`);
      const field = typeof o.field === 'string' ? o.field : SECRET_FIELDS[kind][0]!;
      let value: string;
      let pub: { publicKey?: string; fingerprint?: string } | undefined;
      if (o.generate) {
        if (kind === 'ssh-key') {
          const pair = generateSshKeyPair(name);
          value = pair.privateKey;
          pub = { publicKey: pair.publicKey, fingerprint: pair.fingerprint };
        } else value = kind === 'api-token' ? generateToken() : generatePassword();
      } else if (process.stdin.isTTY) {
        value = await promptHidden(`  ${field}: `);
      } else {
        value = await readStdin();
      }
      if (!value) fail('No secret given.');
      const vault = await openVault({ create: true });
      const policy: Partial<Policy> = o.allowShell ? { allowShell: true } : {};
      const { credential, warnings } = await vault.create({
        name, kind, secret: { [field]: value },
        ...(typeof o.username === 'string' ? { username: o.username } : {}),
        ...(typeof o.host === 'string' ? { host: o.host } : {}),
        ...(typeof o.port === 'string' ? { port: Number(o.port) } : {}),
        ...(typeof o.url === 'string' ? { url: o.url } : {}),
        ...(typeof o.description === 'string' ? { description: o.description } : {}),
        ...(pub ? { public: pub } : {}),
        policy,
        createdBy: 'user',
      });
      console.log(`  ✓ Stored "${credential.name}". The agent can use it as {{secret:${credential.name}}}.`);
      if (pub?.publicKey) console.log(`  Public key: ${pub.publicKey}`);
      for (const w of warnings) console.log(`  ⚠ ${w}`);
      process.exit(0);
    });

  cmd.command('remove <name>')
    .description('delete a credential (asks for confirmation)')
    .action(async (name: string) => {
      requireHuman('Removing a credential');
      const vault = await openVault();
      const c = await vault.get(name);
      if (await readLine(`  Type "${c.name}" to delete it: `) !== c.name) fail('Not confirmed.');
      vault.store.remove(c.id);
      vault.audit.append({ action: 'delete', outcome: 'ok', credentialId: c.id, name: c.name, actor: 'cli' });
      console.log(`  ✓ Deleted "${c.name}".`);
      process.exit(0);
    });

  cmd.command('show <name>')
    .description('reveal a credential\'s values on this terminal (asks for confirmation)')
    .action(async (name: string) => {
      requireHuman('Revealing a credential');
      const vault = await openVault();
      const c = await vault.get(name);
      await requireGrantPassphrase(vault);
      if (await readLine(`  Type "show ${c.name}" to reveal it: `) !== `show ${c.name}`) fail('Not confirmed.');
      const { secret } = await vault.revealForOwner(c.id, 'reveal', 'cli');
      console.log('');
      for (const [field, value] of Object.entries(secret)) console.log(`  ${field}:\n${value}\n`);
      process.exit(0);
    });

  cmd.command('export <file>')
    .description('export every credential, encrypted with a passphrase you choose')
    .action(async (file: string) => {
      requireHuman('Exporting the vault');
      const vault = await openVault();
      await requireGrantPassphrase(vault);
      if (await readLine('  Type "export" to write every credential to a file: ') !== 'export') fail('Not confirmed.');
      const p1 = await promptHidden('  Export passphrase: ');
      if (p1.length < 8) fail('Use at least 8 characters.');
      if (p1 !== await promptHidden('  Again: ')) fail('The passphrases did not match.');
      const records = [];
      for (const c of await vault.list()) records.push(await vault.revealForOwner(c.id, 'export', 'cli'));
      const scrypt = newScryptParams();
      const out: ExportFile = {
        format: 'aico-vault-export', version: 1, scrypt,
        data: wrap(scryptKey(p1, scrypt), Buffer.from(JSON.stringify(records), 'utf8'), EXPORT_LABEL),
      };
      fs.writeFileSync(file, JSON.stringify(out, null, 1), { mode: 0o600 });
      console.log(`  ✓ Exported ${records.length} credential(s) to ${file}.`);
      process.exit(0);
    });

  cmd.command('import <file>')
    .description('import an encrypted export')
    .option('--replace', 'replace credentials with the same name')
    .action(async (file: string, o: { replace?: boolean }) => {
      requireHuman('Importing credentials');
      let parsed: ExportFile;
      try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as ExportFile; } catch { fail('That is not a readable export file.'); }
      if (parsed.format !== 'aico-vault-export') fail('That is not an AICO vault export.');
      const plain = unwrap(scryptKey(await promptHidden('  Export passphrase: '), parsed.scrypt), parsed.data, EXPORT_LABEL);
      if (!plain) fail('Wrong passphrase, or the file was modified.');
      const records = JSON.parse(plain.toString('utf8')) as Array<{ meta: CredentialMeta; policy: Policy; secret: Record<string, string> }>;
      plain.fill(0);
      const vault = await openVault({ create: true });
      let added = 0;
      let skipped = 0;
      for (const r of records) {
        if (vault.store.has(r.meta.name)) {
          if (!o.replace) { skipped++; continue; }
          vault.store.remove(r.meta.name);
        }
        vault.store.create({
          name: r.meta.name, kind: r.meta.kind, secret: r.secret, policy: r.policy, createdBy: r.meta.createdBy,
          ...(r.meta.username ? { username: r.meta.username } : {}),
          ...(r.meta.host ? { host: r.meta.host } : {}),
          ...(r.meta.port ? { port: r.meta.port } : {}),
          ...(r.meta.url ? { url: r.meta.url } : {}),
          ...(r.meta.description ? { description: r.meta.description } : {}),
          ...(r.meta.public ? { public: r.meta.public } : {}),
          tags: r.meta.tags,
        });
        added++;
      }
      vault.audit.append({ action: 'import', outcome: 'ok', actor: 'cli', reason: `${added} added, ${skipped} skipped` });
      console.log(`  ✓ Imported ${added}; skipped ${skipped} that already existed${skipped ? ' (use --replace)' : ''}.`);
      process.exit(0);
    });

  cmd.command('grant-passphrase')
    .description('set the passphrase that authorises reveals and policy loosening (keyring vaults)')
    .action(async () => {
      requireHuman('Setting the grant passphrase');
      const vault = await openVault();
      const current = vault.status().grantPassphrase ? await promptHidden('  Current grant passphrase: ') : undefined;
      const p1 = await promptHidden('  New grant passphrase: ');
      if (p1 !== await promptHidden('  Again: ')) fail('The passphrases did not match.');
      vault.store.setGrantPassphrase(p1, current);
      console.log('  ✓ Grant passphrase set.');
      process.exit(0);
    });

  cmd.command('lock')
    .description('lock a running server\'s vault (--server <tokenised url>)')
    .option('--server <url>', 'the URL `aico serve` printed')
    .action(async (o: { server?: string }) => {
      if (!o.server) {
        console.log('  A CLI command holds the key only while it runs. To lock a running server, pass --server <url>.');
        process.exit(0);
      }
      await callServer(o.server, 'vault/lock', {});
      console.log('  ✓ Locked.');
      process.exit(0);
    });

  cmd.command('unlock')
    .description('unlock a running server\'s passphrase vault (--server <tokenised url>), or check the passphrase')
    .option('--server <url>', 'the URL `aico serve` printed')
    .action(async (o: { server?: string }) => {
      requireHuman('Unlocking');
      const passphrase = await promptHidden('  Vault passphrase: ');
      if (o.server) {
        await callServer(o.server, 'vault/unlock', { passphrase });
        console.log('  ✓ The server\'s vault is unlocked.');
      } else {
        await getVault().unlock(passphrase);
        console.log('  ✓ Passphrase is correct. (The CLI holds the key only while a command runs.)');
      }
      process.exit(0);
    });

  cmd.command('audit')
    .description('show the audit trail')
    .option('-n, --limit <n>', 'entries', '50')
    .option('--name <name>', 'only this credential')
    .action(async (o: { limit: string; name?: string }) => {
      const entries = getVault().auditTrail({ limit: Number(o.limit) || 50, ...(o.name ? { name: o.name } : {}) });
      for (const e of entries.reverse()) {
        console.log(`  ${new Date(e.at).toISOString()}  ${e.action.padEnd(13)} ${e.outcome.padEnd(8)} ${(e.name ?? '').padEnd(24)} ${e.tool ?? ''} ${e.target ?? ''} ${e.reason ?? ''}`.trimEnd());
      }
      if (!entries.length) console.log('  No audit entries.');
      process.exit(0);
    });
}

async function callServer(serverUrl: string, route: string, body: unknown): Promise<void> {
  let u: URL;
  try { u = new URL(serverUrl); } catch { fail('--server must be the full URL `aico serve` printed, with its token.'); }
  const token = u.searchParams.get('token');
  if (!token) fail('The server URL has no token in it.');
  const res = await fetch(`${u.origin}/api/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-aico-token': token },
    body: JSON.stringify(body),
  });
  if (!res.ok) fail(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
}
