/**
 * `aico-control` — the command line of the organisation server (ADR 0040).
 *
 *   aico-control serve     start the server (HTTP API + admin portal)
 *   aico-control bootstrap create a tenant and its first owner on this host
 *
 * The first owner is created here, on the server's own host, and never over the
 * network: there is no unauthenticated "create the first admin" endpoint to find.
 *
 * TLS is required for anything but loopback (the app refuses otherwise): pass
 * `--tls-cert/--tls-key`, or `--behind-proxy --public-url https://...` when a
 * proxy terminates TLS.
 *
 * @module index
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlApp } from './app.js';

function parseArgs(argv: string[]): { cmd: string; flags: Record<string, string | true> } {
  const [cmd = 'help', ...rest] = argv;
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith('--')) continue;
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) flags[a.slice(2)] = true;
    else { flags[a.slice(2)] = next; i++; }
  }
  return { cmd, flags };
}

const HELP = `AICO Control (organisation server)

  aico-control serve [--data-dir DIR] [--port 7350] [--host 127.0.0.1] [--public-url URL]
                     [--behind-proxy] [--tls-cert FILE --tls-key FILE] [--allow-insecure-idp]
  aico-control bootstrap --slug acme --name "Acme" --owner you@acme.com
                     [--issuer URL --client-id ID [--client-secret SECRET]] [--jit]

Environment: CONTROL_MASTER_KEY (64 hex chars) overrides the key file in the data directory.
`;

async function main(): Promise<void> {
  const { cmd, flags } = parseArgs(process.argv.slice(2));
  const dataDir = path.resolve(String(flags['data-dir'] ?? process.env.CONTROL_DATA_DIR ?? './control-data'));
  const here = path.dirname(fileURLToPath(import.meta.url));
  const make = (): ControlApp => new ControlApp({
    dbFile: path.join(dataDir, 'control.db'), dataDir,
    ...(typeof flags['public-url'] === 'string' ? { publicUrl: flags['public-url'] } : {}),
    allowInsecureIdp: flags['allow-insecure-idp'] === true, behindProxy: flags['behind-proxy'] === true,
    portalDir: String(flags['portal-dir'] ?? path.join(here, 'portal')),
  });

  if (cmd === 'serve') {
    const app = make();
    const tls = typeof flags['tls-cert'] === 'string' && typeof flags['tls-key'] === 'string'
      ? { cert: fs.readFileSync(flags['tls-cert']), key: fs.readFileSync(flags['tls-key']) } : undefined;
    const port = await app.listen(Number(flags.port ?? 7350), String(flags.host ?? '127.0.0.1'), tls ? { cert: tls.cert.toString(), key: tls.key.toString() } : undefined);
    process.stdout.write(`AICO Control listening on ${app.publicUrl} (port ${port}); data in ${dataDir}\n`);
    return;
  }
  if (cmd === 'bootstrap') {
    const slug = String(flags.slug ?? '');
    const owner = String(flags.owner ?? '');
    if (!slug || !owner) { process.stderr.write(HELP); process.exitCode = 2; return; }
    const app = make();
    const idp = typeof flags.issuer === 'string' && typeof flags['client-id'] === 'string'
      ? { issuer: flags.issuer, clientId: flags['client-id'], ...(typeof flags['client-secret'] === 'string' ? { clientSecret: flags['client-secret'] } : {}) } : undefined;
    const { tenant, owner: u } = app.createTenant({ slug, name: String(flags.name ?? slug), ownerEmail: owner, settings: { jit: flags.jit === true, ...(idp ? { idp } : {}) } });
    process.stdout.write(`Created tenant ${tenant.slug} with owner ${u.email}.\n`);
    await app.close();
    return;
  }
  process.stdout.write(HELP);
}

main().catch(err => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
