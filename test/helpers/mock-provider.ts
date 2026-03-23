import type { ProviderResponse, ContentBlock, ToolUseBlock, TextBlock } from "../../src/types.js";

interface MockResponse {
  toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  text?: string;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * MockProvider returns scripted responses for deterministic testing.
 * Each call to complete() returns the next response in the sequence.
 */
export class MockProvider {
  private responses: MockResponse[];
  private callIndex = 0;
  public calls: Array<{ system: string; messages: unknown[]; tools?: unknown[] }> = [];

  constructor(responses: MockResponse[]) {
    this.responses = responses;
  }

  async complete(params: {
    model: string;
    maxTokens: number;
    system: string;
    messages: unknown[];
    tools?: unknown[];
  }): Promise<ProviderResponse> {
    this.calls.push({
      system: params.system,
      messages: params.messages,
      tools: params.tools,
    });

    if (this.callIndex >= this.responses.length) {
      // Default: return text to end the loop
      return {
        content: [{ type: "text", text: "Done." } satisfies TextBlock],
        usage: { input: 100, output: 50, total: 150 },
        stopReason: "end_turn",
      };
    }

    const resp = this.responses[this.callIndex++];
    const content: ContentBlock[] = [];
    const inputTokens = resp.inputTokens ?? 100;
    const outputTokens = resp.outputTokens ?? 50;

    if (resp.text) {
      content.push({ type: "text", text: resp.text } satisfies TextBlock);
    }

    if (resp.toolCalls?.length) {
      if (!resp.text) {
        content.push({ type: "text", text: "Using tools." } satisfies TextBlock);
      }
      for (const tc of resp.toolCalls) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: tc.input,
        } satisfies ToolUseBlock);
      }
    }

    const hasToolCalls = (resp.toolCalls?.length ?? 0) > 0;

    return {
      content,
      usage: { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens },
      stopReason: hasToolCalls ? "tool_use" : "end_turn",
    };
  }

  async summarize(text: string, model: string, targetTokens?: number): Promise<string> {
    return `Summary of ${text.length} chars of conversation.`;
  }
}
