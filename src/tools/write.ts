import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { resolveInsideWorkspace } from './path.js';
import { commitFile } from './file-writer.js';
import { dominantEol, toEol } from './eol.js';
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

  /*
    An existing file keeps the line endings it already had.

    A model writes `\n`. Overwriting a CRLF file with that turns a two-line
    change into a diff claiming every line changed — which buries the actual
    edit, and on Windows is the common case rather than the exception, because
    `core.autocrlf` defaults to true. A new file gets `\n`, since there is
    nothing to preserve and that is what the rest of the toolchain emits.

    The previous contents are read once and handed to `commitFile`, which needs
    them anyway to apply a diff rather than replace the document wholesale.
  */
  const previous = existsSync(resolved) ? await readFile(resolved, 'utf8') : null;
  const content = previous === null
    ? input.content
    : toEol(input.content, dominantEol(previous));

  // Through the run's writer when it has one, so an edit made from inside an
  // editor lands in its undo stack rather than arriving as an external change.
  await commitFile(resolved, content, previous);
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
