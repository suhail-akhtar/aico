/**
 * Where `HttpRequest` may send a request, decided on the addresses a name
 * actually resolves to.
 *
 * Two jobs pull against each other. Self-hosted servers on a LAN are the core
 * use case — "configure Grafana on 10.0.0.5" means private addresses and
 * plain http — so a blanket private-address ban would make the tool useless.
 * But a prompt injection that gets the agent to fetch
 * `http://169.254.169.254/latest/meta-data/iam/…` walks off with the cloud
 * host's own credentials, and one that reaches `http://127.0.0.1:7340/api/…`
 * talks to AICO's own server. So:
 *
 *  - **Never:** cloud metadata endpoints (by name and by address, IPv4 and
 *    IPv6, including IPv4-mapped forms), the unspecified address, multicast
 *    and broadcast. No credential, setting or approval unlocks these.
 *  - **Public addresses:** allowed.
 *  - **Private, loopback, link-local, CGNAT, unique-local:** allowed only when
 *    something the owner controls names the target — the credential being
 *    used admits this origin (the vault checked, possibly with a person's
 *    approval), or some stored credential is bound to this host (a server the
 *    owner or an earlier setup registered), or it is the loopback end of an
 *    AICO SSH tunnel. Otherwise refused, with the fix named.
 *
 * The decision is made on every resolved address (a name that resolves to one
 * public and one private address is judged by the private one) and the
 * request is then pinned to the address that was checked, so DNS rebinding
 * between check and connect gets nothing. Every redirect hop is re-checked.
 *
 * Honest scope: the agent also has Bash, and `curl` is not routed through
 * this. This policy protects the tool that carries credentials, and makes the
 * obvious injected request fail; the Bash safety classifier and the vault's
 * shell guard are separate, pattern-based lines.
 *
 * @module tools/ops/ssrf
 */

import dns from 'node:dns/promises';
import net from 'node:net';

export type AddressClass =
  | 'public' | 'private' | 'loopback' | 'link-local' | 'cgnat' | 'unique-local'
  | 'metadata' | 'unspecified' | 'multicast' | 'reserved';

/** Hosts that are cloud metadata services by name. */
const METADATA_NAMES = new Set([
  'metadata.google.internal', 'metadata.goog', 'metadata', 'instance-data', 'instance-data.ec2.internal',
  'metadata.azure.com', 'metadata.platformequinix.com', 'metadata.oraclecloud.com',
]);

/** Metadata services by address: AWS/GCP/Azure/OCI/DO (IMDS), AWS ECS task metadata, Alibaba, Azure wireserver, AWS IMDS over IPv6. */
const METADATA_ADDRESSES = new Set([
  '169.254.169.254', '169.254.170.2', '169.254.170.23', '100.100.100.200', '168.63.129.16', '169.254.169.123',
  'fd00:ec2::254', 'fd00:ec2::23',
]);

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((n, p) => (n << 8) + Number(p), 0) >>> 0;
}

function inV4(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (v4ToInt(ip) & mask) === (v4ToInt(base) & mask);
}

/** Expand an IPv6 address to 8 groups of 4 hex digits. */
export function expandV6(ip: string): string {
  let addr = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]!;
  // Embedded IPv4 tail (::ffff:1.2.3.4) → two hex groups.
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (v4 && net.isIPv4(v4[1]!)) {
    const n = v4ToInt(v4[1]!);
    addr = addr.slice(0, -v4[1]!.length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail = ''] = addr.split('::');
  const h = head ? head.split(':') : [];
  const t = addr.includes('::') ? (tail ? tail.split(':') : []) : [];
  const fill = addr.includes('::') ? Array(8 - h.length - t.length).fill('0') : [];
  return [...h, ...fill, ...t].map(g => g.padStart(4, '0')).join(':');
}

/** The IPv4 address inside an IPv4-mapped / -compatible / NAT64 IPv6 address, if any. */
function embeddedV4(v6: string): string | undefined {
  const g = expandV6(v6).split(':');
  const tail = (): string => {
    const hi = parseInt(g[6]!, 16);
    const lo = parseInt(g[7]!, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  };
  if (g.slice(0, 5).every(x => x === '0000') && (g[5] === 'ffff' || g[5] === '0000') && !(g[5] === '0000' && g[6] === '0000')) return tail();
  if (g[0] === '0064' && g[1] === 'ff9b') return tail(); // 64:ff9b::/96 NAT64
  return undefined;
}

/** Classify one IP address. Anything that is not an IP is `reserved` (callers resolve names first). */
export function classifyAddress(raw: string): AddressClass {
  const ip = raw.trim().replace(/^\[|\]$/g, '').split('%')[0]!.toLowerCase();
  if (net.isIPv4(ip)) {
    if (METADATA_ADDRESSES.has(ip)) return 'metadata';
    if (ip === '0.0.0.0' || inV4(ip, '0.0.0.0', 8)) return 'unspecified';
    if (ip === '255.255.255.255' || inV4(ip, '224.0.0.0', 4)) return 'multicast';
    if (inV4(ip, '127.0.0.0', 8)) return 'loopback';
    if (inV4(ip, '10.0.0.0', 8) || inV4(ip, '172.16.0.0', 12) || inV4(ip, '192.168.0.0', 16)) return 'private';
    if (inV4(ip, '169.254.0.0', 16)) return 'link-local';
    if (inV4(ip, '100.64.0.0', 10)) return 'cgnat';
    if (inV4(ip, '192.0.0.0', 24) || inV4(ip, '198.18.0.0', 15) || inV4(ip, '240.0.0.0', 4)) return 'reserved';
    return 'public';
  }
  if (net.isIPv6(ip)) {
    const full = expandV6(ip);
    const compact = full.replace(/(^|:)0{1,3}(?=[0-9a-f])/g, '$1');
    for (const m of METADATA_ADDRESSES) if (net.isIPv6(m) && expandV6(m) === full) return 'metadata';
    const v4 = embeddedV4(ip);
    if (v4) return classifyAddress(v4);
    if (full === '0000:0000:0000:0000:0000:0000:0000:0000') return 'unspecified';
    if (full === '0000:0000:0000:0000:0000:0000:0000:0001') return 'loopback';
    if (full.startsWith('ff')) return 'multicast';
    if (/^fe[89ab]/.test(full)) return 'link-local';
    if (/^f[cd]/.test(full)) return 'unique-local';
    if (compact.startsWith('2001:0db8') || full.startsWith('2001:0db8')) return 'reserved';
    return 'public';
  }
  return 'reserved';
}

/** Classes that are never reachable, whatever vouches for them. */
const NEVER: ReadonlySet<AddressClass> = new Set(['metadata', 'unspecified', 'multicast', 'reserved']);

export interface TargetFacts {
  /** The URL's host (name or IP literal), lower-case, no brackets. */
  host: string;
  port: number;
  /** Every address the host resolves to. */
  addresses: string[];
  /** The credential in use was resolved by the vault for this exact origin. */
  credentialAdmits: boolean;
  /** Some stored credential's scope names this host (a server the owner registered). */
  knownTarget: boolean;
  /** This loopback port is the near end of an open AICO SSH tunnel. */
  tunnelPort: boolean;
}

export type TargetDecision =
  | { allowed: true; address: string; class: AddressClass }
  | { allowed: false; reason: string };

/** Decide a target. Pure. */
export function decideTarget(f: TargetFacts): TargetDecision {
  if (METADATA_NAMES.has(f.host.replace(/\.$/, ''))) {
    return { allowed: false, reason: `${f.host} is a cloud metadata service. It is never reachable from this tool.` };
  }
  if (!f.addresses.length) return { allowed: false, reason: `${f.host} did not resolve to any address.` };
  const classes = f.addresses.map(a => ({ address: a, cls: classifyAddress(a) }));
  const blocked = classes.find(c => NEVER.has(c.cls));
  if (blocked) {
    return {
      allowed: false,
      reason: blocked.cls === 'metadata'
        ? `${f.host} resolves to ${blocked.address}, a cloud metadata address. It is never reachable from this tool.`
        : `${f.host} resolves to ${blocked.address} (${blocked.cls}), which this tool never contacts.`,
    };
  }
  const nonPublic = classes.find(c => c.cls !== 'public');
  if (!nonPublic) return { allowed: true, address: classes[0]!.address, class: 'public' };
  const vouched = f.credentialAdmits || f.knownTarget || (nonPublic.cls === 'loopback' && f.tunnelPort && classes.every(c => c.cls === 'loopback'));
  if (!vouched) {
    return {
      allowed: false,
      reason: `${f.host} is a ${nonPublic.cls} address (${nonPublic.address}). Private, loopback and link-local targets are `
        + 'reachable only with a stored credential bound to that host (CredentialList shows what is bound where), or through '
        + 'an SshTunnel. Ask the owner to store or bind a credential for it if this is their server.',
    };
  }
  // Pin to a non-public address when that is what vouched; any is fine otherwise.
  return { allowed: true, address: nonPublic.address, class: nonPublic.cls };
}

/** Resolve a host to every address (an IP literal resolves to itself). */
export async function resolveAll(host: string): Promise<string[]> {
  const h = host.replace(/^\[|\]$/g, '');
  if (net.isIP(h)) return [h];
  try {
    const list = await dns.lookup(h, { all: true, verbatim: true });
    return [...new Set(list.map(a => a.address))];
  } catch {
    return [];
  }
}
