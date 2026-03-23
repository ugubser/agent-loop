import type { Message, ContentBlock, TranscriptEntry } from "../types.js";
import type { Session } from "./session.js";
import type { AnthropicProvider } from "../providers/anthropic.js";

/**
 * Compact session messages when context approaches the limit.
 *
 * Dual threshold:
 * - Soft (70%): compact with N=10 recent iterations preserved
 * - Hard (90%): compact with N=3 recent iterations preserved
 *
 * Fallback: if LLM summarization fails, truncate oldest messages.
 */
export async function compactSession(
  session: Session,
  provider: AnthropicProvider,
  model: string,
  log?: (entry: TranscriptEntry) => void
): Promise<void> {
  const { needed, recentN } = session.getCompactionTarget();
  if (needed === "none") return;

  const messages = session.messages;
  if (messages.length <= recentN) return; // Nothing to compact

  // Split messages: middle (to summarize) + recent window
  const splitIndex = findIterationBoundary(messages, recentN);
  const toSummarize = messages.slice(0, splitIndex);
  const recentWindow = messages.slice(splitIndex);

  if (toSummarize.length === 0) return;

  const beforeTokens = session.contextTokens();

  try {
    // Serialize messages for summarization
    const text = serializeMessages(toSummarize);
    const summary = await provider.summarize(text, model, 2000);

    // Build new message array: summary + recent window
    const summaryMessage: Message = {
      role: "user",
      content: `[Previous context summary]\n${summary}`,
    };
    const newMessages = [summaryMessage, ...recentWindow];

    session.replaceMessages(newMessages);

    // Check if we still have enough headroom (>30% free)
    if (session.contextRatio() > 0.7 && recentN > 3) {
      // Re-compact more aggressively
      await compactSession(session, provider, model, log);
      return;
    }
  } catch {
    // Fallback: truncate oldest messages (keep last 20 iterations)
    const fallbackSplit = findIterationBoundary(messages, 20);
    const kept = messages.slice(fallbackSplit);
    const truncationMessage: Message = {
      role: "user",
      content: "[TRUNCATED — compaction failed, older context removed]",
    };
    session.replaceMessages([truncationMessage, ...kept]);
  }

  const afterTokens = session.contextTokens();

  // Log compaction event
  log?.({
    type: "compaction",
    timestamp: new Date().toISOString(),
    data: {
      needed,
      recentN,
      beforeTokens,
      afterTokens,
      messagesBefore: messages.length,
      messagesAfter: session.messages.length,
    },
  });
}

/**
 * Find the index in messages where the last N iterations start.
 *
 * An "iteration" = one assistant message (possibly with tool_use blocks)
 * + all following user messages with tool_result content, until the next
 * assistant message.
 *
 * We count iterations from the END of the messages array.
 */
export function findIterationBoundary(
  messages: Message[],
  n: number
): number {
  let iterationCount = 0;
  let i = messages.length - 1;

  while (i >= 0 && iterationCount < n) {
    // Find the assistant message that starts this iteration
    while (i >= 0 && messages[i].role !== "assistant") {
      i--;
    }
    if (i < 0) break;
    iterationCount++;
    i--; // Move past this assistant message
  }

  // i+1 is the start of the recent window
  return Math.max(0, i + 1);
}

function serializeMessages(messages: Message[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      parts.push(`${msg.role}: ${msg.content}`);
    } else {
      const texts = msg.content
        .map((block: ContentBlock) => {
          if (block.type === "text") return block.text;
          if (block.type === "tool_use")
            return `[Tool call: ${block.name}(${JSON.stringify(block.input)})]`;
          if (block.type === "tool_result")
            return `[Tool result: ${block.content.slice(0, 500)}${block.content.length > 500 ? "..." : ""}]`;
          return "";
        })
        .filter(Boolean);
      parts.push(`${msg.role}: ${texts.join("\n")}`);
    }
  }
  return parts.join("\n\n");
}
