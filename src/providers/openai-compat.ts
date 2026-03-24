import type {
  Message,
  ContentBlock,
  ToolSchema,
  ProviderResponse,
  TextBlock,
  ToolUseBlock,
} from "../types.js";

/**
 * OpenAI-compatible provider. Works with LM Studio, Ollama, vLLM,
 * OpenAI, and any server that implements the /v1/chat/completions endpoint.
 */
export class OpenAICompatProvider {
  private baseUrl: string;
  private apiKey: string;
  private requestTimeout: number;

  constructor(baseUrl = "http://localhost:1234/v1", apiKey = "lm-studio", requestTimeout = 300_000) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.requestTimeout = requestTimeout;
  }

  async complete(params: {
    model: string;
    maxTokens: number;
    system: string;
    messages: Message[];
    tools?: ToolSchema[];
  }): Promise<ProviderResponse> {
    // Convert our message format to OpenAI format
    const openaiMessages = [
      { role: "system" as const, content: params.system },
      ...params.messages.map((m) => toOpenAIMessage(m)),
    ];

    // Convert tool schemas to OpenAI format
    const openaiTools = params.tools?.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));

    const body: Record<string, unknown> = {
      model: params.model,
      messages: openaiMessages,
      max_tokens: params.maxTokens,
    };
    if (openaiTools?.length) {
      body.tools = openaiTools;
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.requestTimeout),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LLM API error (${response.status}): ${text}`);
    }

    const data = (await response.json()) as OpenAIChatResponse;
    const choice = data.choices[0];
    if (!choice) {
      throw new Error("LLM returned no choices");
    }

    // Convert OpenAI response to our format
    const content: ContentBlock[] = [];

    if (choice.message.content) {
      content.push({
        type: "text",
        text: choice.message.content,
      } satisfies TextBlock);
    }

    if (choice.message.tool_calls?.length) {
      for (const tc of choice.message.tool_calls) {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(tc.function.arguments);
        } catch {
          input = { _raw: tc.function.arguments };
        }
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input,
        } satisfies ToolUseBlock);
      }
    }

    // If content is empty (model returned nothing), add empty text
    if (content.length === 0) {
      content.push({ type: "text", text: "" } satisfies TextBlock);
    }

    return {
      content,
      usage: {
        input: data.usage?.prompt_tokens ?? 0,
        output: data.usage?.completion_tokens ?? 0,
        total: data.usage?.total_tokens ?? 0,
      },
      stopReason: choice.finish_reason === "tool_calls" ? "tool_use" : "end_turn",
    };
  }

  async summarize(
    text: string,
    model: string,
    targetTokens = 2000
  ): Promise<string> {
    const response = await this.complete({
      model,
      maxTokens: targetTokens,
      system:
        "You are a precise summarizer. Summarize the following conversation history into a concise narrative. " +
        "Preserve: key findings, decisions made, errors encountered, and current task state. " +
        `Target: under ${targetTokens} tokens. Be factual and complete.`,
      messages: [{ role: "user", content: text }],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    return textBlock && "text" in textBlock ? textBlock.text : "";
  }
}

// --- OpenAI response types ---

interface OpenAIChatResponse {
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// --- Message format conversion ---

function toOpenAIMessage(msg: Message): Record<string, unknown> {
  if (typeof msg.content === "string") {
    return { role: msg.role, content: msg.content };
  }

  // Handle content blocks
  const blocks = msg.content;

  // Check if this is a tool_result message
  const toolResults = blocks.filter((b) => b.type === "tool_result");
  if (toolResults.length > 0) {
    // OpenAI format: one message per tool result
    // For simplicity, return the first one (multi-tool results
    // should be handled by the caller splitting messages)
    const tr = toolResults[0];
    if (tr.type === "tool_result") {
      return {
        role: "tool",
        tool_call_id: tr.tool_use_id,
        content: tr.content,
      };
    }
  }

  // Assistant message with tool calls
  const textParts = blocks.filter((b) => b.type === "text");
  const toolUses = blocks.filter((b) => b.type === "tool_use");

  const result: Record<string, unknown> = {
    role: msg.role,
    content: textParts.map((b) => (b.type === "text" ? b.text : "")).join("") || null,
  };

  if (toolUses.length > 0) {
    result.tool_calls = toolUses.map((b) => {
      if (b.type === "tool_use") {
        return {
          id: b.id,
          type: "function",
          function: {
            name: b.name,
            arguments: JSON.stringify(b.input),
          },
        };
      }
      return null;
    }).filter(Boolean);
  }

  return result;
}
