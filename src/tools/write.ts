import { resolveInsideWorkspace } from './path.js';
import { commitFile } from './file-writer.js';
import { recordBeforeWrite, recordAfterWrite } from '../checkpoint/index.js';

export interface WriteInput {
  file_path: string;
  content: string;
}

export async function writeFile(input: WriteInput): Promise<string> {
  const resolved = resolveInsideWorkspace(input.file_path, 'file_path');
  // Before the write, so what is captured is the state the turn started from.
  // A no-op when nothing is recording.
  await recordBeforeWrite(resolved);
  // Through the run's writer when it has one, so an edit made from inside an
  // editor lands in its undo stack rather than arriving as an external change.
  await commitFile(resolved, input.content);
  // After it, so a later outside edit can be told from an untouched file —
  // which is what lets restore skip work that is not the agent's to undo.
  await recordAfterWrite(resolved);
  return `Successfully wrote ${input.content.length} characters to ${input.file_path}`;
}

export const writeDefinition = {
  name: 'Write',
  description: 'Write content to a file, creating parent directories as needed.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to the file to write.' },
      content: { type: 'string', description: 'Content to write to the file.' },
    },
    required: ['file_path', 'content'],
  },
};
