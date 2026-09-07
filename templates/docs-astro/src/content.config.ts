import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

/**
 * The docs collection: every Markdown file under src/content/docs is a page.
 * Frontmatter is validated here, so a page with no title fails the build
 * rather than rendering blank.
 */
const docs = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/docs' }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    /** Sidebar order within a section; lower first. */
    order: z.number().default(100),
    /** Sidebar section heading; pages with the same section are grouped. */
    section: z.string().default('Guide'),
    draft: z.boolean().default(false),
  }),
});

export const collections = { docs };
