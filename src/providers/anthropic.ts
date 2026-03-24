import Anthropic from "@anthropic-ai/sdk";
import type {
  Message,
  ContentBlock,
  ToolSchema,
  ProviderResponse,
  TextBlock,
  ToolUseBlock,
} from "../types.js";

export class AnthropicProvider {
  private client: Anthropic;

  constructor(apiKey?: string, authToken?: string) {
    this.client = new Anthropic({
      apiKey: authToken ? null : apiKey,  // Falls back to ANTHROPIC_API_KEY env
      authToken,                          // Falls back to ANTHROPIC_AUTH_TOKEN env
    });
  }

  async complete(params: {
    model: string;
    maxTokens: number;
    system: string;
    messages: Message[];
    tools?: ToolSchema[];
  }): Promise<ProviderResponse> {
    const apiTools = params.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool["input_schema"],
    }));

    const response = await this.client.messages.create({
      model: params.model,
      max_tokens: params.maxTokens,
      system: params.system,
      messages: params.messages as Anthropic.MessageParam[],
      ...(apiTools?.length ? { tools: apiTools } : {}),
    });

    const content: ContentBlock[] = response.content.map((block) => {
      if (block.type === "text") {
        return { type: "text", text: block.text } satisfies TextBlock;
      }
      if (block.type === "tool_use") {
        return {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        } satisfies ToolUseBlock;
      }
      // Fallback for unknown block types
      return { type: "text", text: JSON.stringify(block) } satisfies TextBlock;
    });

    return {
      content,
      usage: {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
        total: response.usage.input_tokens + response.usage.output_tokens,
      },
      stopReason: response.stop_reason ?? "end_turn",
    };
  }

  async summarize(
    text: string,
    model: string,
    targetTokens = 2000
  ): Promise<string> {
    const response = await this.client.messages.create({
      model,
      max_tokens: targetTokens,
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
