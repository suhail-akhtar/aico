import { readFile, writeFile } from 'fs/promises';

export interface NotebookEditInput {
  notebook_path: string;
  cell_number: number;
  new_source: string;
  cell_type?: 'code' | 'markdown';
  edit_mode?: 'replace' | 'insert' | 'delete';
}

interface NotebookCell {
  cell_type: string;
  source: string[];
  metadata: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: number | null;
}

interface Notebook {
  nbformat: number;
  nbformat_minor: number;
  metadata: Record<string, unknown>;
  cells: NotebookCell[];
}

export async function notebookEdit(input: NotebookEditInput): Promise<{ success: boolean; message: string }> {
  const mode = input.edit_mode ?? 'replace';
  const cellType = input.cell_type ?? 'code';

  let notebook: Notebook;
  try {
    const content = await readFile(input.notebook_path, 'utf8');
    notebook = JSON.parse(content) as Notebook;
  } catch (err) {
    return { success: false, message: `Failed to read notebook: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!notebook.cells || !Array.isArray(notebook.cells)) {
    return { success: false, message: 'Invalid notebook format — no cells array found.' };
  }

  const sourceLines = input.new_source.split('\n').map((line, i, arr) =>
    i < arr.length - 1 ? line + '\n' : line,
  );

  switch (mode) {
    case 'replace': {
      if (input.cell_number < 0 || input.cell_number >= notebook.cells.length) {
        return { success: false, message: `Cell ${input.cell_number} out of range (0-${notebook.cells.length - 1}).` };
      }
      notebook.cells[input.cell_number].source = sourceLines;
      if (input.cell_type) {
        notebook.cells[input.cell_number].cell_type = input.cell_type;
      }
      // Clear outputs for code cells on edit
      if (notebook.cells[input.cell_number].cell_type === 'code') {
        notebook.cells[input.cell_number].outputs = [];
        notebook.cells[input.cell_number].execution_count = null;
      }
      break;
    }
    case 'insert': {
      const insertIdx = Math.min(Math.max(0, input.cell_number), notebook.cells.length);
      const newCell: NotebookCell = {
        cell_type: cellType,
        source: sourceLines,
        metadata: {},
        ...(cellType === 'code' ? { outputs: [], execution_count: null } : {}),
      };
      notebook.cells.splice(insertIdx, 0, newCell);
      break;
    }
    case 'delete': {
      if (input.cell_number < 0 || input.cell_number >= notebook.cells.length) {
        return { success: false, message: `Cell ${input.cell_number} out of range (0-${notebook.cells.length - 1}).` };
      }
      notebook.cells.splice(input.cell_number, 1);
      break;
    }
    default:
      return { success: false, message: `Unknown edit_mode: ${mode}` };
  }

  try {
    await writeFile(input.notebook_path, JSON.stringify(notebook, null, 1));
    return { success: true, message: `Notebook ${mode}d cell ${input.cell_number} successfully.` };
  } catch (err) {
    return { success: false, message: `Failed to write notebook: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export const notebookEditDefinition = {
  name: 'NotebookEdit',
  description: 'Edit Jupyter notebook (.ipynb) cells. Supports replace, insert, and delete operations on individual cells by 0-based index.',
  inputSchema: {
    type: 'object',
    properties: {
      notebook_path: { type: 'string', description: 'Absolute path to the .ipynb file.' },
      cell_number: { type: 'number', description: '0-based cell index to operate on.' },
      new_source: { type: 'string', description: 'The new source code/markdown for the cell.' },
      cell_type: { type: 'string', enum: ['code', 'markdown'], description: 'Cell type (default: code). Required for insert mode.' },
      edit_mode: { type: 'string', enum: ['replace', 'insert', 'delete'], description: 'Operation: replace (default), insert, or delete.' },
    },
    required: ['notebook_path', 'cell_number', 'new_source'],
  },
};
