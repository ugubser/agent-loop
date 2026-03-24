// Session status — clean enum, sub-state via reason field
export type SessionStatus = "running" | "paused" | "completed" | "crashed";

export interface SessionState {
  id: string;
  status: SessionStatus;
  reason?: string; // e.g., "provider_error", "signal", "timeout", "disk_full"
  skillName: string;
  startedAt: string; // ISO 8601
  updatedAt: string;
  iteration: number;
  lastCheckpoint?: string; // "checkpoint-005.json"
  tokenUsage: TokenUsage;
  config: AgentConfig;
}

export interface TokenUsage {
  input: number;
  output: number;
  total: number;
}

export interface AgentConfig {
  model: {
    provider: string; // "anthropic" | "openai-compat" | "lmstudio"
    model: string;
    maxTokens: number;
    baseUrl?: string; // For openai-compat/lmstudio: e.g., "http://localhost:1234/v1"
    apiKey?: string; // For openai-compat: API key (defaults to "lm-studio")
    requestTimeout?: number; // Milliseconds before aborting an LLM request (default: 300000)
  };
  session: {
    maxContext: number;
    checkpointInterval: number;
    timeout: number; // seconds
    maxSteps?: number;
  };
  skills: {
    dirs: string[];
  };
  persistence: {
    backend: string;
    dir: string;
  };
  tools: {
    cli: {
      allowedCommands: string[];
      timeout: number; // seconds
    };
  };
}

// Messages matching Anthropic API shape
export interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

// Transcript entry (JSONL lines)
export interface TranscriptEntry {
  type: "message" | "tool_result" | "compaction" | "status_change" | "error";
  timestamp: string;
  iteration?: number;
  data: unknown;
}

// Tool definitions
export interface CliToolDef {
  name: string;
  description: string;
  command: string;
  args: string[];
  schema: Record<string, { type: string; description?: string }>;
  stdinParam?: string; // parameter name whose value is piped to stdin
  env?: Record<string, string>; // extra environment variables for this tool
  timeout: number; // seconds
  idempotent: boolean;
}

// Tool schema for Anthropic API
export interface ToolSchema {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

// Skill summary (lightweight, for routing)
export interface SkillSummary {
  name: string;
  description: string;
}

// Skill definition
export interface SkillDef {
  name: string;
  description: string;
  instructions: string; // markdown body
  tools: CliToolDef[];
}

// Checkpoint shape
export interface Checkpoint {
  sessionId: string;
  iteration: number;
  timestamp: string;
  messages: Message[];
  systemPrompt: string;
  tokenUsage: TokenUsage;
}

// Lock handle
export interface LockHandle {
  fd: number;
  path: string;
}

// Provider response
export interface ProviderResponse {
  content: ContentBlock[];
  usage: TokenUsage;
  stopReason: string;
}
