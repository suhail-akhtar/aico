/**
 * The sidebar, from the collection. Pure, so it is tested without Astro:
 * group by section, order within a section by `order` then title, drop drafts,
 * and keep sections in the order their first page appears.
 */
export interface NavEntry { id: string; title: string; section: string; order: number; draft: boolean }
export interface NavSection { section: string; pages: Array<{ id: string; title: string; href: string }> }

export function buildNav(entries: NavEntry[], base = '/docs/'): NavSection[] {
  const sections = new Map<string, NavSection>();
  const sorted = [...entries]
    .filter(e => !e.draft)
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  for (const e of sorted) {
    const section = sections.get(e.section) ?? { section: e.section, pages: [] };
    section.pages.push({ id: e.id, title: e.title, href: `${base}${e.id}/` });
    sections.set(e.section, section);
  }
  return [...sections.values()];
}

/** The page before and after `id` in reading order, for the footer links. */
export function neighbours(nav: NavSection[], id: string): { prev?: NavSection['pages'][number]; next?: NavSection['pages'][number] } {
  const flat = nav.flatMap(s => s.pages);
  const i = flat.findIndex(p => p.id === id);
  if (i < 0) return {};
  return { ...(i > 0 ? { prev: flat[i - 1] } : {}), ...(i < flat.length - 1 ? { next: flat[i + 1] } : {}) };
}
