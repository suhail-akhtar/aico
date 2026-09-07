/**
 * The agent loop: ask the model, run what it asks for, ask again, until it
 * answers in words. Bounded in steps, and every step is reported to whoever
 * is listening so a client can stream progress.
 */
import { complete, type ChatMessage, type ModelConfig } from './model.js';
import { TOOLS, toolByName, type Tool } from './tools.js';

export const SYSTEM_PROMPT = `You are the assistant behind __APP_TITLE__: __APP_DESCRIPTION__
Answer plainly and briefly. Use a tool when one applies rather than guessing; the calculator is for any arithmetic.
When you have the answer, say it — do not describe the tools you used.`;

/** Something a listener can show while the loop runs. */
export type AgentEvent =
  | { type: 'step'; step: number }
  | { type: 'tool_call'; name: string; arguments: string }
  | { type: 'tool_result'; name: string; result: string }
  | { type: 'answer'; content: string }
  | { type: 'error'; message: string };

export interface AgentOptions {
  model: ModelConfig;
  tools?: Tool[];
  maxSteps?: number;
  onEvent?: (event: AgentEvent) => void;
}

export interface AgentResult {
  answer: string;
  /** The full transcript, to persist and to continue from. */
  messages: ChatMessage[];
  steps: number;
}

/**
 * Run the loop over an existing transcript plus one new user message.
 *
 * Tool results always go back as `tool` messages, even errors — a model told
 * "Error: division by zero" fixes its expression; a model whose call vanished
 * asks again forever.
 */
export async function runAgent(history: ChatMessage[], userText: string, opts: AgentOptions): Promise<AgentResult> {
  const tools = opts.tools ?? TOOLS;
  const maxSteps = opts.maxSteps ?? 8;
  const messages: ChatMessage[] = [
    ...(history[0]?.role === 'system' ? [] : [{ role: 'system' as const, content: SYSTEM_PROMPT }]),
    ...history,
    { role: 'user', content: userText },
  ];

  for (let step = 1; step <= maxSteps; step++) {
    opts.onEvent?.({ type: 'step', step });
    const reply = await complete(opts.model, messages, tools.map(t => t.schema));

    if (reply.toolCalls.length === 0) {
      const answer = reply.content.trim() || '(no answer)';
      messages.push({ role: 'assistant', content: answer });
      opts.onEvent?.({ type: 'answer', content: answer });
      return { answer, messages, steps: step };
    }

    messages.push({ role: 'assistant', content: reply.content || null, tool_calls: reply.toolCalls });
    for (const call of reply.toolCalls) {
      const name = call.function.name;
      opts.onEvent?.({ type: 'tool_call', name, arguments: call.function.arguments });
      const tool = toolByName(name, tools);
      let result: string;
      if (!tool) {
        result = `Error: no tool called "${name}". Available: ${tools.map(t => t.schema.function.name).join(', ')}.`;
      } else {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>; }
        catch { result = 'Error: arguments were not valid JSON.'; }
        result ??= await tool.run(args).catch(err => `Error: ${err instanceof Error ? err.message : String(err)}`);
      }
      opts.onEvent?.({ type: 'tool_result', name, result });
      messages.push({ role: 'tool', tool_call_id: call.id, name, content: result });
    }
  }

  const message = `Stopped after ${maxSteps} steps without a final answer.`;
  opts.onEvent?.({ type: 'error', message });
  messages.push({ role: 'assistant', content: message });
  return { answer: message, messages, steps: maxSteps };
}
