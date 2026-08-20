/**
 * The agent roster, and the two questions everything asks of it.
 *
 * Three places need this now — the picker, the `@` menu in the composer, and
 * the settings toggle that turns the whole idea off. Three copies of "fetch
 * the agents, drop the disabled ones, split mine from built in" would answer
 * differently the moment one of them was edited.
 *
 * @module agents
 */

import type { AgentSpec } from './api';

/** Agents matching a query, ranked so the obvious answer is first. */
export function searchAgents(agents: AgentSpec[], query: string): AgentSpec[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return agents;

  return agents
    .map(agent => {
      const name = agent.name.toLowerCase();
      const description = (agent.description ?? '').toLowerCase();
      const role = (agent.role ?? '').toLowerCase();

      // Ranked rather than filtered: typing "sec" should put `security` above
      // an agent that merely mentions security in its description, and a
      // straight alphabetical list buries the thing being typed.
      const score = name === needle ? 0
        : name.startsWith(needle) ? 1
          : name.includes(needle) ? 2
            : role.includes(needle) ? 3
              : description.includes(needle) ? 4
                : -1;
      return { agent, score };
    })
    .filter(hit => hit.score >= 0)
    .sort((a, b) => a.score - b.score || a.agent.name.localeCompare(b.agent.name))
    .map(hit => hit.agent);
}

/** Yours and the shipped ones, in that order — yours are what you came for. */
export function splitAgents(agents: AgentSpec[]): { mine: AgentSpec[]; builtin: AgentSpec[] } {
  return {
    mine: agents.filter(a => a.source !== 'builtin'),
    builtin: agents.filter(a => a.source === 'builtin'),
  };
}

/**
 * The `@name` being typed, if the caret sits inside one.
 *
 * Returns the query and where it starts, so selecting a result can remove
 * exactly the text that summoned the menu rather than guessing at it.
 *
 * Only fires at a word boundary, so an email address or a decorator does not
 * open an agent menu mid-sentence.
 */
export function mentionAt(text: string, caret: number): { query: string; from: number } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at === -1) return null;

  // Preceded by nothing or whitespace — `foo@bar` is not a mention.
  const prior = at > 0 ? before[at - 1]! : ' ';
  if (!/\s/.test(prior)) return null;

  const query = before.slice(at + 1);
  // A space ends it: once you have typed past the name, the menu is done.
  if (/\s/.test(query)) return null;
  // Agent names are conservative, and this keeps the menu from opening on
  // things that merely start with @.
  if (query && !/^[\w-]*$/.test(query)) return null;

  return { query, from: at };
}
