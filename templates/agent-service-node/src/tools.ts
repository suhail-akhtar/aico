/**
 * The tools the agent may call. One worked tool; copy its shape.
 *
 * A tool is a schema the model sees and a function that runs. Arguments arrive
 * as a JSON string and are validated here, never trusted: the model will send
 * `{"expression": "2 +"}` eventually, and the tool's answer to that is an
 * error message the model can read, not an exception the loop has to catch.
 */
import type { ToolSchema } from './model.js';

export interface Tool {
  schema: ToolSchema;
  run(args: Record<string, unknown>): Promise<string>;
}

/** The worked tool: evaluate an arithmetic expression, safely. */
export const calculator: Tool = {
  schema: {
    type: 'function',
    function: {
      name: 'calculate',
      description: 'Evaluate an arithmetic expression with + - * / ( ) and decimal numbers. Use it for any arithmetic rather than doing it in your head.',
      parameters: {
        type: 'object',
        properties: { expression: { type: 'string', description: 'For example "(12.5 * 4) / 3".' } },
        required: ['expression'],
      },
    },
  },
  async run(args) {
    const expression = String(args.expression ?? '').trim();
    if (!/^[\d\s+\-*/().]+$/.test(expression)) return 'Error: only digits, spaces, + - * / ( ) and . are allowed.';
    try {
      // Digits and operators only, checked above — no identifiers can reach this.
      const value = Function(`"use strict"; return (${expression});`)() as unknown;
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'Error: the expression did not produce a finite number.';
      return String(value);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

/** The current time, so the model never guesses the date. */
export const clock: Tool = {
  schema: {
    type: 'function',
    function: { name: 'now', description: 'The current date and time in ISO 8601, UTC.', parameters: { type: 'object', properties: {} } },
  },
  async run() { return new Date().toISOString(); },
};

/** Register a tool here and it is offered on every request. */
export const TOOLS: Tool[] = [calculator, clock];

export function toolByName(name: string, tools: Tool[] = TOOLS): Tool | undefined {
  return tools.find(t => t.schema.function.name === name);
}
