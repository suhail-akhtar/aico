export interface AgentSpec {
  name: string;
  description: string;
  role: string;
  goals: string[];
  skills: string[];
  tools: string[];
  canDelegate: boolean;
  reportFormat: string;
  systemPromptXml: string;
  source: 'builtin' | 'user' | 'project';
  /** Optional: pin this agent to a specific model (e.g. "glm-4.6", "claude-sonnet-5") */
  model?: string;
}

export interface AgentCreateInput {
  name: string;
  description: string;
  role?: string;
  goals?: string[];
  skills?: string[];
  tools?: string[];
  canDelegate?: boolean;
  reportFormat?: string;
  scope?: 'user' | 'project';
  /** Optional: pin this agent to a specific model */
  model?: string;
}
