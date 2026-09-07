/**
 * `.aico/backlog.md`, read.
 *
 * The file the agent keeps (see the app-plan skill): iterations as `##`
 * headings, stories as `- [ ]` / `- [x]` bullets, each followed by an indented
 * `Done when:` line. Pure, so it is unit-tested and shared with nothing that
 * needs a browser.
 *
 * @module components/apps/backlog
 */

export interface Story {
  text: string;
  done: boolean;
  doneWhen?: string;
}

export interface Iteration {
  title: string;
  stories: Story[];
}

export interface Backlog {
  title?: string;
  iterations: Iteration[];
  done: number;
  total: number;
}

export function parseBacklog(markdown: string): Backlog {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const iterations: Iteration[] = [];
  let title: string | undefined;
  let current: Iteration | undefined;
  let last: Story | undefined;
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h1 = /^#\s+(.+)$/.exec(line);
    if (h1 && !title) { title = h1[1]!.replace(/^Backlog\s*[—-]\s*/, '').trim(); continue; }
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2) { current = { title: h2[1]!.trim(), stories: [] }; iterations.push(current); last = undefined; continue; }
    const story = /^-\s+\[( |x|X)\]\s+(.+)$/.exec(line);
    if (story) {
      if (!current) { current = { title: 'Stories', stories: [] }; iterations.push(current); }
      last = { text: story[2]!.trim(), done: story[1] !== ' ' };
      current.stories.push(last);
      continue;
    }
    const doneWhen = /^\s+Done when:\s*(.+)$/i.exec(line);
    if (doneWhen && last) { last.doneWhen = (last.doneWhen ? `${last.doneWhen} ` : '') + doneWhen[1]!.trim(); continue; }
    // A continuation of the story text or of its Done-when line.
    if (last && /^\s{4,}\S/.test(line)) {
      if (last.doneWhen !== undefined) last.doneWhen += ` ${line.trim()}`;
      else last.text += ` ${line.trim()}`;
    }
  }
  const all = iterations.flatMap(i => i.stories);
  return { ...(title ? { title } : {}), iterations, done: all.filter(s => s.done).length, total: all.length };
}

/** The first open story, in reading order — what "next" means. */
export function nextStory(backlog: Backlog): { iteration: Iteration; story: Story } | undefined {
  for (const iteration of backlog.iterations) {
    const story = iteration.stories.find(s => !s.done);
    if (story) return { iteration, story };
  }
  return undefined;
}
