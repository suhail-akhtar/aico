import path from 'path';

export interface PwdInput {
  resolve?: boolean;
}

export function getWorkingDirectory(input: PwdInput): string {
  const cwd = process.cwd();
  if (input.resolve) {
    return path.resolve(cwd);
  }
  return cwd;
}

export const pwdDefinition = {
  name: 'Pwd',
  description: 'Gets the current working directory.',
  inputSchema: {
    type: 'object',
    properties: {
      resolve: { type: 'boolean', description: 'Resolve to an absolute path.' },
    },
    required: [],
  },
};
