/**
 * AskUserQuestion — pause and ask the human.
 *
 * Fine when there is a human. The failure mode is when there is not.
 *
 * ## Why this cannot fall back to a prompt
 *
 * The original fallback opened a `readline` on `process.stdin` and waited. For
 * an interactive REPL that is correct. For a cron job at 3am, a background
 * agent, or a task submitted over MCP, it is a hang with no timeout and no
 * diagnostic — the run simply never returns, and the only visible symptom is
 * that a scheduled job silently stopped producing anything.
 *
 * Under `aico mcp-serve` it was worse still: the question went to
 * `process.stdout`, which is the JSON-RPC stream, and the read then consumed
 * the client's own protocol messages looking for an answer.
 *
 * This is the same bug as the interactive permission prompt, in a second place.
 * The rule that fixes both: **headless work gets a decision, never a question.**
 *
 * @module tools/askuser
 */

export interface AskUserInput {
  question: string;
}

/** Global callback — set by the Ink UI, the readline REPL, or the web server. */
let askUserCallback: ((question: string) => Promise<string>) | null = null;

export function setAskUserCallback(cb: (question: string) => Promise<string>): void {
  askUserCallback = cb;
}

/**
 * Is there a person who could actually answer?
 *
 * A registered callback means some UI owns the conversation. Otherwise the only
 * remaining route is the terminal, and that is only a route if stdin is
 * attached to one — a piped or closed stdin cannot answer, and waiting on it is
 * waiting forever.
 */
export function canAskUser(): boolean {
  return askUserCallback !== null || process.stdin.isTTY === true;
}

/** What a headless run is told instead of being left to wait. */
export const NO_ONE_TO_ASK =
  'There is nobody to ask — this run has no interactive user (it is a scheduled, '
  + 'background, or externally submitted job). Do not ask again. Decide using what you '
  + 'have, state the assumption you made, and if the answer genuinely cannot be guessed, '
  + 'stop and report exactly what you needed to know and why.';

export async function askUser(input: AskUserInput): Promise<string> {
  if (askUserCallback) {
    return askUserCallback(input.question);
  }

  // No callback and no terminal: answer immediately rather than blocking on a
  // stdin nobody is typing into.
  if (process.stdin.isTTY !== true) {
    return NO_ONE_TO_ASK;
  }

  const { createInterface } = await import('readline');
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`\n❓ ${input.question}\n> `, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export const askUserDefinition = {
  name: 'AskUserQuestion',
  description:
    'Ask the human user a clarifying question and wait for their response. Use this when you '
    + 'need information that is not available in the codebase or context — e.g. preferred name, '
    + 'API keys, design decisions. The user will see the question and type an answer.\n\n'
    + 'Not available to scheduled or background runs, because there is nobody there to answer.',
  inputSchema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'The question to ask the user. Be specific and concise.',
      },
    },
    required: ['question'],
  },
};
