/**
 * AskUserQuestion — lets the agent pause and ask the human a question.
 * In Ink mode this resolves via a React callback (onAskUser).
 * In readline mode it uses a readline question.
 */

export interface AskUserInput {
  question: string;
}

/** Global callback — set by Ink UI or readline REPL before running agent */
let askUserCallback: ((question: string) => Promise<string>) | null = null;

export function setAskUserCallback(cb: (question: string) => Promise<string>): void {
  askUserCallback = cb;
}

export async function askUser(input: AskUserInput): Promise<string> {
  if (askUserCallback) {
    return askUserCallback(input.question);
  }
  // Fallback: readline if no callback registered
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
    'Ask the human user a clarifying question and wait for their response. Use this when you need information that is not available in the codebase or context — e.g. preferred name, API keys, design decisions. The user will see the question and type an answer.',
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
