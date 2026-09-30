/**
 * AICO Desktop — unit tests for the unified vault's browser rules and the
 * purchase/send gate: migrating 0.28.0 browser passwords into engine
 * credentials (names, exact-origin policies, idempotence, verification), and
 * classifying an agent's click as a commit, with real-looking labels in
 * several languages and the non-commits that must stay ungated. Pure modules,
 * bundled with esbuild and run in Node.
 *
 *   node scripts/test-browser-vault.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-desk-vault-'));

async function load(entry, name) {
  const file = path.join(out, `${name}.mjs`);
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: file, logLevel: 'error' });
  return import(pathToFileURL(file).href);
}

let pass = 0; let fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}

const unify = await load(path.join(desktop, 'electron/browser-vault-unify.ts'), 'unify');
const gate = await load(path.join(desktop, 'electron/browser-commit-gate.ts'), 'gate');

// ── Migration ──
{
  const entries = [
    { id: 'a', origin: 'https://github.com', username: 'alice@example.com', password: 'Test-Pw-One-1', created: 1, updated: 1 },
    { id: 'b', origin: 'https://github.com', username: 'bob', password: 'Test-Pw-Two-2', note: 'recovery: test-code', created: 1, updated: 1 },
    { id: 'c', origin: 'http://localhost:3000', username: '', password: 'Test-Pw-Three-3', created: 1, updated: 1 },
    { id: 'd', origin: 'not a url', username: 'x', password: 'y', created: 1, updated: 1 },
    { id: 'e', origin: 'https://nas.local:5001', username: 'admin', password: 'Test-Pw-Four-4', created: 1, updated: 1 },
  ];
  const plan = unify.planMigration(entries, [{ name: 'login-github-com-alice-example-com', kind: 'ssh-key', tags: [] }]);
  const logins = plan.create.filter(c => c.body.kind === 'login');
  ok(logins.length === 4 && plan.unusable.includes('d'), 'migration: every usable entry becomes a login; a broken one is reported', plan.unusable);
  const a = logins.find(c => c.entryId === 'a').body;
  ok(a.name === 'login-github-com-alice-example-com-2', 'migration: names are readable and never clash with an existing credential', a.name);
  ok(a.url === 'https://github.com' && a.username === 'alice@example.com' && a.secret.password === 'Test-Pw-One-1', 'migration: origin, username and password carried over');
  ok(JSON.stringify(a.policy) === JSON.stringify({ allowedOrigins: ['https://github.com'], allowedTools: ['Browser', 'browser_login'], approval: 'session', allowShell: false }),
    'migration: exact origin, browser tools only, asked once a session, no shell', a.policy);
  ok(a.createdBy === 'user' && a.tags.includes('browser') && a.tags.includes('migrated'), 'migration: a person\'s credential, tagged browser + migrated');
  ok(logins.find(c => c.entryId === 'e').body.url === 'https://nas.local:5001', 'migration: the port is part of the origin');
  const note = plan.create.find(c => c.body.kind === 'note');
  ok(note && note.body.secret.text === 'recovery: test-code' && !JSON.stringify(logins).includes('recovery'), 'migration: a note becomes its own note credential, never a (model-visible) description');
  ok(note.body.policy.approval === 'every-use', 'migration: a note asks every time it is used');
  const names = plan.create.map(c => c.body.name);
  ok(new Set(names).size === names.length && names.every(n => /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(n)), 'migration: every name is unique and valid', names);
  // Idempotent: run again against what the first run created.
  const after = plan.create.map(c => ({ name: c.body.name, kind: c.body.kind, username: c.body.username, url: c.body.url, tags: c.body.tags }));
  const again = unify.planMigration(entries, after);
  ok(again.create.length === 0 && again.already.length === 4, 'migration: a second run creates nothing', again);
  ok(unify.verifyMigration(entries, after).length === 0, 'migration: verification finds every usable entry');
  ok(unify.verifyMigration(entries, after.filter(x => x.username !== 'bob')).join() === 'b', 'migration: verification names what is missing');
}
{
  const taken = new Set();
  const n1 = unify.credentialNameFor('https://Example.COM', 'Some User', taken);
  ok(n1 === 'login-example-com-some-user', 'names: lower-case; dots, spaces and @ become dashes (vault names allow no dots)', n1);
  const long = unify.credentialNameFor(`https://${'a'.repeat(80)}.example.com`, 'b'.repeat(40), taken);
  ok(long.length <= 64, 'names: long hosts and usernames are cut to the vault\'s limit', long.length);
  ok(unify.webOrigin('https://user:pw@evil.example/') === null && unify.webOrigin('ftp://x') === null, 'origins: credentials-in-URL and non-web schemes are refused');
}

// ── The commit gate ──
{
  const gated = [
    ['Place order', {}], ['Place your order', {}], ['Pay now', {}], ['Pay $42.99', {}], ['Buy now', {}], ['Complete purchase', {}],
    ['Confirm and pay', {}], ['Submit order', {}], ['Pay with card', {}],
    ['Zahlungspflichtig bestellen', {}], ['Jetzt kaufen', {}], ['Finalizar compra', {}], ['Realizar pedido', {}], ['Comprar ahora', {}],
    ['Payer', {}], ['Valider ma commande', {}], ['Acquista ora', {}], ['Conferma ordine', {}], ['Bestelling plaatsen', {}],
    ['注文を確定する', {}], ['提交订单', {}], ['立即购买', {}],
    ['Confirm booking', {}], ['Send', {}], ['Send message', {}], ['Post', {}], ['Publish', {}], ['Senden', {}], ['Envoyer', {}],
    ['Delete account', {}], ['Delete', {}], ['Permanently delete', {}], ['Cancel subscription', {}], ['Löschen', {}], ['Supprimer', {}],
    ['Book now', { checkout: true }], ['Continue', { cardFields: 2 }], ['Subscribe', { url: 'https://shop.example/checkout/review' }],
  ];
  for (const [label, extra] of gated) {
    const v = gate.classifyCommit({ label, ...extra });
    ok(v !== null, `gate: "${label}"${Object.keys(extra).length ? ' (on a checkout page)' : ''} is a commit`, v);
  }
  const free = [
    'Add to cart', 'Add to Bag', 'In den Warenkorb', 'Añadir al carrito', 'Ajouter au panier', 'Aggiungi al carrello', 'カートに入れる', '加入购物车',
    'Proceed to checkout', 'Checkout', 'Continue to payment', 'View cart', 'Apply coupon', 'Remove', 'Next', 'Search', 'Sign in', 'Log in',
    'Save draft', 'Book now', 'Continue', 'Subscribe', 'Confirm', 'Reply', 'Paypal', 'Payment options', 'Learn more', 'Delete filter chip x',
  ];
  for (const label of free) {
    const v = gate.classifyCommit({ label, url: 'https://shop.example/product/123' });
    ok(v === null, `gate: "${label}" (off a checkout page) is not a commit`, v);
  }
  ok(gate.classifyCommit({ label: 'Add to cart', checkout: true, cardFields: 3 }) === null, 'gate: "Add to cart" is never a commit, even on a checkout page');
  ok(gate.classifyCommit({ label: 'Proceed to checkout', checkout: true }) === null, 'gate: moving on to the checkout is not the commit');
  const byForm = gate.classifyCommit({ label: 'Go', submits: true, formAction: 'https://shop.example/checkout/placeOrder', checkout: true });
  ok(byForm?.kind === 'purchase', 'gate: a form posted to a place-order endpoint from a checkout page is a commit, whatever the button says', byForm);
  ok(gate.classifyCommit({ label: 'Go', submits: true, formAction: 'https://shop.example/search' }) === null, 'gate: an ordinary form submit is not');
  const enter = gate.classifyCommit({ label: '', formButtons: ['Place order'] });
  ok(enter?.kind === 'purchase', 'gate: Enter in a form whose submit button is "Place order" is a commit');
  const q = gate.commitQuestion({ kind: 'purchase', label: 'place order', reason: 'x' }, 'https://shop.example');
  ok(/buy or pay/.test(q.title) && /shop\.example/.test(q.title) && q.okLabel === 'Allow purchase', 'gate: the question says what will happen and where', q);
}

// ── Where a login may be filled (browser-vault-core.ts), with the LAN rule ──
{
  const core = await load(path.join(desktop, 'electron/browser-vault-core.ts'), 'core');
  ok(core.canFill('https://bank.example', 'https://bank.example/login').ok, 'fill: the exact https origin');
  ok(!core.canFill('https://bank.example', 'https://bank.example.evil.test/').ok, 'fill: a look-alike host is refused');
  ok(!core.canFill('https://bank.example', 'https://bank.example:8443/').ok, 'fill: another port is another origin');
  ok(!core.canFill('http://10.0.0.5:8080', 'http://10.0.0.5:8080/').ok, 'fill: http on a LAN address, without the credential\'s own policy: refused');
  ok(core.canFill('http://10.0.0.5:8080', 'http://10.0.0.5:8080/', 'http://10.0.0.5:8080/', { policyAllowsHttp: true }).ok, 'fill: http on a LAN address the credential is explicitly bound to: allowed');
  ok(!core.canFill('http://shop.example', 'http://shop.example/', 'http://shop.example/', { policyAllowsHttp: true }).ok, 'fill: http to a public address is refused even if a policy said so (main\'s second look)');
  ok(!core.canFill('https://10.0.0.5', 'https://10.0.0.5/', 'https://ads.example/', {}).ok, 'fill: never into another site\'s frame');
  ok(core.isPrivateOrigin('http://192.168.1.10') && core.isPrivateOrigin('https://nas.local:5001') && core.isPrivateOrigin('http://[::1]:3000') && core.isPrivateOrigin('http://172.20.0.2'),
    'private: RFC 1918, .local, loopback v6');
  ok(!core.isPrivateOrigin('http://172.32.0.1') && !core.isPrivateOrigin('https://example.com') && !core.isPrivateOrigin('http://8.8.8.8'), 'private: public addresses are not');
}

console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(out, { recursive: true, force: true }); } catch { /* temp cleanup */ }
process.exit(fail ? 1 : 0);
