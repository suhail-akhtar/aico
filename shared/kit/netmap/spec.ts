/**
 * The network diagram an orchestrator emits.
 *
 * WHY NOT MERMAID. Mermaid draws graphs, and a network is a graph, so the
 * temptation is real. But an operator reading a network picture needs things a
 * flowchart cannot carry: a device TYPE with a recognisable icon, an address,
 * a zone boundary, and an edge that says `TCP/5432 →` with a health colour.
 * Encoding those into Mermaid node labels produces a diagram that is technically
 * correct and unreadable — and worse, unqueryable: you cannot ask "which links
 * are down" of a string.
 *
 * So this is a typed spec. Every field an operator needs is a field, which
 * means the same data can draw the picture, drive a health rollup, and be
 * refreshed by a binding.
 *
 * IT DESCRIBES, IT DOES NOT ASSERT. A node's `status` is what some source said,
 * carried through with its provenance. Nothing here computes health, and the
 * renderer never infers "down" from a missing reading — an unknown state draws
 * as unknown, because a grey node an operator investigates is better than a
 * green one they trust.
 */
import { z } from 'zod';

/**
 * Case-insensitive enum.
 *
 * A model writes "UP" or "Firewall" as readily as "up" or "firewall", and
 * rejecting the whole diagram over letter case is pedantry that costs the
 * operator their picture. The VOCABULARY is still closed — an invented value is
 * still refused — only the casing is forgiven.
 */
// `const T` matters: without it the tuple widens to string[] and every
// `Record<NodeKind, …>` lookup downstream becomes an unchecked string index.
const loose = <const T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess((v) => (typeof v === 'string' ? v.trim().toLowerCase() : v), z.enum(values));

/**
 * Device classes, closed on purpose.
 *
 * Each maps to a drawn icon. An open string would mean a model inventing
 * `type: "thingy"` and getting a blank box — a bounded list makes the failure
 * visible at validation instead of at render.
 */
export const NodeKind = loose([
  'host',       // a general server
  'vm',
  'container',
  'router',
  'switch',
  'firewall',
  'loadbalancer',
  'database',
  'storage',
  'service',    // a logical application endpoint
  'cloud',      // an external provider or SaaS
  'client',     // a workstation or user population
  'unknown',
]);
export type NodeKind = z.infer<typeof NodeKind>;

/**
 * Operational state.
 *
 * `unknown` is a first-class value and the DEFAULT. Most estates have things
 * nothing is collecting from, and drawing those as healthy is the single most
 * dangerous thing a topology picture can do.
 */
export const NodeStatus = loose(['up', 'degraded', 'down', 'unknown']);
export type NodeStatus = z.infer<typeof NodeStatus>;

export const NetNode = z.object({
  id: z.string().min(1).max(80),
  /** Hostname or display name — what the operator calls it. */
  label: z.string().min(1).max(80),
  kind: NodeKind.default('unknown'),
  status: NodeStatus.default('unknown'),
  /** IPv4/IPv6 address or CIDR. Free-form: an estate has both, plus VIPs. */
  address: z.string().max(60).optional(),
  /** A second line of detail — role, OS, instance size. */
  detail: z.string().max(80).optional(),
  /**
   * Which tier the node sits in. Drives the LAYOUT: layered left-to-right, so
   * the same spec always draws the same picture. Absent nodes are placed by
   * their distance from a tier-0 node.
   */
  tier: z.coerce.number().int().min(0).max(11).optional(),
  /** Grouping box — a VLAN, a subnet, a datacentre, an availability zone. */
  zone: z.string().max(60).optional(),
  /** Called out as the subject of the answer. */
  focus: z.boolean().default(false),
});
export type NetNode = z.infer<typeof NetNode>;

/**
 * A link between two nodes.
 *
 * `protocol` and `port` are separate fields rather than one label because
 * "which links carry 5432" is a question worth being able to answer.
 */
export const NetLink = z.object({
  from: z.string().min(1).max(80),
  to: z.string().min(1).max(80),
  /** TCP, UDP, HTTPS, AMQP, iSCSI — whatever the source called it. */
  protocol: z.string().max(24).optional(),
  /**
   * COERCED from a string on purpose.
   *
   * A model writes `"port": "9000"` about as often as `9000` — it is reading it
   * out of `ss -tnp` output, where it is text. Rejecting the whole diagram over
   * that produced exactly one outcome in the field: the operator saw
   * `links.1.port: Expected number, received string` instead of their network.
   * The value is unambiguous, so it is accepted and converted.
   */
  port: z.coerce.number().int().min(0).max(65_535).optional(),
  /** Free label when protocol/port is not the point: "replication", "NFSv4". */
  label: z.string().max(48).optional(),
  /** 'both' draws arrowheads at each end. */
  direction: loose(['forward', 'both']).default('forward'),
  status: NodeStatus.default('unknown'),
  /** Dashes the line — for a path that exists but is not currently carrying. */
  dashed: z.boolean().default(false),
  /**
   * Animate traffic along the line, and in which direction.
   *
   * This is how an agent SHOWS an in/out flow rather than describing it: an
   * inbound scan and an outbound API call read differently at a glance when one
   * animates toward the host and the other away from it.
   *
   * Default is 'none'. Motion is a claim that something is flowing NOW, and a
   * diagram that animates every line by default is making that claim about
   * links nobody measured.
   */
  flow: loose(['none', 'forward', 'reverse', 'both']).default('none'),
});
export type NetLink = z.infer<typeof NetLink>;

/**
 * The whole picture.
 *
 * Bounded because this is model-authored and laid out synchronously in the
 * renderer: 120 nodes is already past what anyone can read, and an unbounded
 * spec is a frozen window.
 */
export const NetMapSpec = z.object({
  title: z.string().max(120).optional(),
  nodes: z.array(NetNode).min(1).max(120),
  links: z.array(NetLink).max(400).default([]),
  /** Draw the zone boxes. Off for a small diagram where they are just noise. */
  showZones: z.boolean().default(true),
  /** Left-to-right suits a traffic path; top-to-bottom suits a dependency tree. */
  direction: z.enum(['LR', 'TB']).default('LR'),
});
export type NetMapSpec = z.infer<typeof NetMapSpec>;

/**
 * Validate, and report what was wrong in terms of the DIAGRAM.
 *
 * A link naming a node that does not exist is the most common model error here,
 * and Zod cannot see it — so it is checked separately and reported as a dropped
 * link rather than a failed diagram. Nine correct links plus a named gap beats
 * refusing to draw anything.
 */
export interface ParsedNetMap {
  ok: boolean;
  spec?: NetMapSpec;
  /** Links dropped because an endpoint is not in `nodes`. */
  danglingLinks: string[];
  error?: string;
}

export function parseNetMap(raw: unknown): ParsedNetMap {
  const r = NetMapSpec.safeParse(raw);
  if (!r.success) {
    return {
      ok: false,
      danglingLinks: [],
      error: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  }

  const ids = new Set(r.data.nodes.map((n) => n.id));
  const dangling: string[] = [];
  const links = r.data.links.filter((l) => {
    const ok = ids.has(l.from) && ids.has(l.to);
    if (!ok) dangling.push(`${l.from} → ${l.to}`);
    return ok;
  });

  // Duplicate ids would make a link ambiguous, which is worse than a dropped
  // one — refuse rather than pick.
  if (ids.size !== r.data.nodes.length) {
    return { ok: false, danglingLinks: [], error: 'two nodes share an id, so the links are ambiguous' };
  }

  return { ok: true, spec: { ...r.data, links }, danglingLinks: dangling };
}
