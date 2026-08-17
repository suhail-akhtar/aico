/**
 * The prompt document — an ordered, keyed set of sections.
 *
 * Callers build one of these instead of concatenating strings, which buys three
 * things string-building cannot:
 *
 *   - **No duplication by construction.** Sections are keyed by `id`, so a
 *     second contributor adding `security` replaces the first rather than
 *     appending a near-copy. String concatenation has no way to notice.
 *   - **Targeting without branching.** A section can be scoped to particular
 *     providers at the point it is written, rather than the prompt builder
 *     growing a switch over provider ids.
 *   - **Late rendering.** The shape is decided when the provider is known, so
 *     one document serves every vendor.
 *
 * @module prompt/document
 */

import type { PromptSection, PromptStyle } from './types.js';

export class PromptDocument {
  /** Insertion-ordered; Map preserves it, which is what makes `order` optional. */
  private readonly sections = new Map<string, PromptSection>();

  constructor(sections: readonly PromptSection[] = []) {
    for (const section of sections) this.add(section);
  }

  /**
   * Add a section, or replace the one already holding its id.
   *
   * Replacement keeps the original insertion position, so a later override of
   * an existing section does not silently move it to the end of the prompt.
   */
  add(section: PromptSection): this {
    if (!section.id) throw new Error('PromptSection requires an id');
    this.sections.set(section.id, section);
    return this;
  }

  /** Add several sections. Later entries win on id collisions. */
  addAll(sections: readonly PromptSection[]): this {
    for (const section of sections) this.add(section);
    return this;
  }

  /**
   * Append to an existing section's body, or create it if absent.
   *
   * For the case where two places legitimately contribute to one topic and
   * neither should clobber the other — memory files appending to project
   * context, say. Distinct from `add` on purpose: silently concatenating on
   * every `add` would make accidental duplication invisible again.
   */
  append(id: string, body: string, defaults: Omit<PromptSection, 'id' | 'body'> = {}): this {
    const existing = this.sections.get(id);
    if (!existing) return this.add({ id, body, ...defaults });
    this.sections.set(id, { ...existing, body: `${existing.body}\n\n${body}` });
    return this;
  }

  /** Remove a section. Returns whether it was there. */
  remove(id: string): boolean {
    return this.sections.delete(id);
  }

  has(id: string): boolean {
    return this.sections.has(id);
  }

  get(id: string): PromptSection | undefined {
    return this.sections.get(id);
  }

  /** A copy, so a caller can specialize a shared base without mutating it. */
  clone(): PromptDocument {
    return new PromptDocument([...this.sections.values()]);
  }

  /**
   * Sections that apply to `providerId`, in render order.
   *
   * `except` beats `only` so a broad opt-in can still be denied for one vendor
   * without rewriting the opt-in list.
   *
   * `style` is optional so that callers who only want the vendor view — tests,
   * introspection — need not invent one. Omitting it keeps every style-gated
   * section, which is the honest answer to "what could this document contain"
   * as distinct from "what will this request send".
   */
  forProvider(providerId: string, style?: PromptStyle): PromptSection[] {
    const applicable = [...this.sections.values()].filter((s) => {
      if (s.except?.includes(providerId)) return false;
      if (s.only && !s.only.includes(providerId)) return false;
      if (style && s.styles && !s.styles.includes(style)) return false;
      return true;
    });
    // Stable sort: equal `order` keeps insertion order, so most sections can
    // leave `order` unset and still land where they were written.
    return applicable
      .map((section, index) => ({ section, index }))
      .sort((a, b) =>
        (a.section.order ?? 0) - (b.section.order ?? 0) || a.index - b.index)
      .map(({ section }) => section);
  }

  /** Every section, unfiltered — for tests and diagnostics. */
  all(): PromptSection[] {
    return [...this.sections.values()];
  }

  get size(): number {
    return this.sections.size;
  }
}
