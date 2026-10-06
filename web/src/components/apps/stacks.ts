/**
 * The words the Apps screen uses for a template's stack, in one pure module.
 *
 * Why this exists: the gallery, the create wizard and the card all need to say
 * "Python 3.12+", "runs in Docker" or "3 services" the same way, and the
 * catalogue is no longer nine Node templates (ADR 0031). Keeping the strings
 * here, away from the components, lets the web unit tests check them without a
 * DOM, and keeps the count in prose honest: it is the length of the list the
 * server sent, never a number typed into a sentence.
 *
 * What it does not do: decide anything. Whether a stack can run here is the
 * engine's probe (`availability` on each template, from `apps/templates`);
 * this only words it.
 */
import type { AppTemplate } from '../../api';

export type StackKey = 'node' | 'python' | 'java' | 'dotnet' | 'go' | 'php' | 'bundle';

export const STACK_LABEL: Record<StackKey, string> = {
  node: 'Node.js', python: 'Python', java: 'Java', dotnet: '.NET', go: 'Go', php: 'PHP', bundle: 'Bundles',
};

/** Chip order: Node first (the long-standing set), then the other stacks, bundles last. */
export const STACK_ORDER: StackKey[] = ['node', 'python', 'java', 'dotnet', 'go', 'php', 'bundle'];

type StackFields = Pick<AppTemplate, 'kind' | 'toolchain' | 'requires'>;

/** Which stack a template belongs to; undefined for pages and static sites, which need none. */
export function stackKey(t: StackFields): StackKey | undefined {
  if (t.kind === 'bundle') return 'bundle';
  if (t.toolchain?.id) return t.toolchain.id as StackKey;
  if (t.requires?.node) return 'node';
  return undefined;
}

/** What the template needs installed, as a person says it: "Python 3.12+", "Node >=22.5.0". */
export function stackNeeds(t: StackFields): string | undefined {
  const key = stackKey(t);
  if (!key || key === 'bundle') return undefined;
  const version = t.toolchain?.version ?? t.requires?.node;
  const pretty = version?.replace(/^>=\s*(\d[\d.]*)$/, '$1+');
  return `${key === 'node' ? 'Node' : STACK_LABEL[key]}${pretty ? ` ${pretty}` : ''}`;
}

/** A bundle's parts in one line: "api · web · db". */
export function servicesLine(t: Pick<AppTemplate, 'services'>): string | undefined {
  const ids = (t.services ?? []).map(s => s.id);
  return ids.length ? ids.join(' · ') : undefined;
}

export type Availability = { tone: 'ok' | 'docker' | 'missing'; text: string };

/** Whether this machine can run the template, in a line; nothing to say when it simply can. */
export function availabilityNote(t: Pick<AppTemplate, 'availability'>): Availability | undefined {
  const a = t.availability;
  if (!a || (a.ok && !a.message)) return undefined;
  const first = a.message.replace(/^Note:\s*/, '').split(/(?<=\.)\s/)[0] ?? a.message;
  return a.docker
    ? { tone: 'docker', text: `${first} Runs in Docker instead.` }
    : { tone: 'missing', text: first };
}

/** "14 templates" / "1 template" — from the list the server sent. */
export function templateCount(n: number): string {
  return `${n} template${n === 1 ? '' : 's'}`;
}
