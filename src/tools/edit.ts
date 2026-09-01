import { readFile } from 'fs/promises';
import { resolveInsideWorkspace } from './path.js';
import { commitFile } from './file-writer.js';
import { dominantEol, toEol, toLf } from './eol.js';
import { recordBeforeWrite, recordAfterWrite } from '../checkpoint/index.js';

export interface EditInput {
  file_path: string;
  old_str: string;
  new_str: string;
}

export async function editFile(input: EditInput): Promise<string> {
  const resolved = resolveInsideWorkspace(input.file_path, 'file_path');
  // Captured before the edit, so restore reaches the state the turn started
  // from rather than the state before the most recent of several edits.
  await recordBeforeWrite(resolved);
  const original = await readFile(resolved, 'utf8');

  /*
    Matched in the file's own line endings, not the model's.

    A model writes `\n` — it is what it perceives and what JSON encodes — while
    a file checked out on Windows holds `\r\n`, because `core.autocrlf` defaults
    to true there. Matching the two literally finds nothing, and the error says
    the string was not found, which reads as the model having made it up. It is
    the same file; only the endings differ.

    So the needle is converted to whatever the file already uses, and so is the
    replacement — writing `\n` into a CRLF file would leave it mixed and make
    the next edit fail for the mirror-image reason.
  */
  const eol = dominantEol(original);
  const oldStr = toEol(input.old_str, eol);
  const newStr = toEol(input.new_str, eol);

  const occurrences = countOccurrences(original, oldStr);

  if (occurrences === 0) {
    /*
      Said differently when the endings are the only difference.

      Before this, a whitespace-only mismatch and a genuinely wrong snippet
      produced the identical message, so the one thing that would have explained
      four failed edits in a row was the one thing the error could not say.
    */
    /*
      Only to choose the message — never to perform the replacement.

      A fuzzy match is the right way to explain a failure and the wrong way to
      edit a file: replacing text the model did not actually specify is how an
      agent changes a line nobody looked at. So this decides what to say, and
      the edit still refuses.

      Both near-misses are worth naming because they are the two that happen.
      Line endings are invisible and platform-imposed; indentation is visible
      and mis-copied constantly — tabs read as spaces in almost every rendering
      of a transcript.
    */
    const squashed = (t: string): string => toLf(t).replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n');
    const nearMiss = countOccurrences(squashed(original), squashed(input.old_str)) === 1;
    throw new Error(
      nearMiss
        ? `str_replace failed: the string matches ${input.file_path} except for whitespace or `
          + 'line endings — check the indentation, and whether tabs were copied as spaces. '
          + 'Re-read the file and copy the exact text.'
        : `str_replace failed: the string to replace was not found in ${input.file_path}`,
    );
  }
  if (occurrences > 1) {
    throw new Error(
      `str_replace failed: found ${occurrences} occurrences of the string in ${input.file_path} — must be unique`,
    );
  }

  // `split`/`join` rather than `String.replace`, which treats `$&` and friends
  // in the replacement as substitution patterns — a real hazard when the new
  // text is source code containing a `$`.
  const at = original.indexOf(oldStr);
  const updated = original.slice(0, at) + newStr + original.slice(at + oldStr.length);
  // `original` is handed over rather than re-read: it is already here, and a
  // second read would open a window in which the two could disagree.
  await commitFile(resolved, updated, original);
  await recordAfterWrite(resolved);

  const oldLines = input.old_str.split('\n').length;
  const newLines = input.new_str.split('\n').length;
  return `Successfully edited ${input.file_path}: replaced ${oldLines} line(s) with ${newLines} line(s)`;
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

export const editDefinition = {
  name: 'Edit',
  description:
    'Replace the first (and only) occurrence of old_str with new_str in a file. Errors if the string is not found or appears multiple times.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to the file to edit.' },
      old_str: { type: 'string', description: 'The exact string to find and replace.' },
      new_str: { type: 'string', description: 'The string to replace old_str with.' },
    },
    required: ['file_path', 'old_str', 'new_str'],
  },
};
