/**
 * The model, behind one function, over any OpenAI-compatible endpoint.
 *
 * OpenAI, OpenRouter, DeepSeek, Kimi, Ollama and most gateways speak
 * `/chat/completions`, so one client covers them: `MODEL_BASE_URL`,
 * `MODEL_API_KEY`, `MODEL`. `fetch` is injectable, which is how the tests run
 * the whole agent loop against a scripted model with no key and no network.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolSchema {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ModelReply {
  content: string;
  toolCalls: ToolCall[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
}

export function modelConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  return {
    baseUrl: (env.MODEL_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, ''),
    apiKey: env.MODEL_API_KEY ?? '',
    model: env.MODEL ?? 'gpt-4o-mini',
  };
}

/** One non-streaming completion. Streaming to the client is done by the route, per step. */
export async function complete(config: ModelConfig, messages: ChatMessage[], tools: ToolSchema[]): Promise<ModelReply> {
  const doFetch = config.fetch ?? fetch;
  const res = await doFetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`model ${res.status}: ${text.slice(0, 300) || res.statusText}`);
  }
  const body = await res.json() as {
    choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] } }>;
    usage?: ModelReply['usage'];
  };
  const message = body.choices?.[0]?.message;
  return {
    content: message?.content ?? '',
    toolCalls: message?.tool_calls ?? [],
    ...(body.usage ? { usage: body.usage } : {}),
  };
}
