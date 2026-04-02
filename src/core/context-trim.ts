/**
 * Context trimming for iterative tool calls.
 *
 * When a tool has `context.keepLast` configured, older call+result pairs
 * are replaced with compact summaries in the message array. The full
 * history remains in the transcript (JSONL) for debugging.
 */

import type { Message, ContentBlock, ToolUseBlock, ToolResultBlock } from "../types.js";

interface ToolPair {
  /** Index of the assistant message containing the tool_use block */
  assistantIdx: number;
  /** Index of the tool_use block within the assistant message's content */
  blockIdx: number;
  /** The tool_use block's id */
  toolUseId: string;
  /** Index of the user message containing the matching tool_result */
  resultIdx: number;
  /** The tool result content (for summary) */
  resultContent: string;
  /** Whether the result was an error */
  isError: boolean;
}

/**
 * Trim older call+result pairs for a specific tool, keeping only the
 * last `keepLast` pairs. Older pairs are replaced with a compact
 * user-message summary. Returns a new array if trimming occurred,
 * or the original array if no changes were needed.
 */
export function trimToolContext(
  messages: Message[],
  toolName: string,
  keepLast: number,
): Message[] {
  // Find all call+result pairs for this tool
  const pairs: ToolPair[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant" || typeof msg.content === "string") continue;

    const blocks = msg.content as ContentBlock[];
    for (let b = 0; b < blocks.length; b++) {
      const block = blocks[b];
      if (block.type !== "tool_use" || block.name !== toolName) continue;

      const toolUseId = (block as ToolUseBlock).id;

      // Find the matching tool_result in subsequent messages
      for (let j = i + 1; j < messages.length; j++) {
        const resultMsg = messages[j];
        if (resultMsg.role !== "user" || typeof resultMsg.content === "string") continue;

        const resultBlocks = resultMsg.content as ContentBlock[];
        const match = resultBlocks.find(
          (rb) => rb.type === "tool_result" && (rb as ToolResultBlock).tool_use_id === toolUseId,
        );

        if (match && match.type === "tool_result") {
          const tr = match as ToolResultBlock;
          pairs.push({
            assistantIdx: i,
            blockIdx: b,
            toolUseId,
            resultIdx: j,
            resultContent: tr.content,
            isError: tr.is_error === true,
          });
          break;
        }
      }
    }
  }

  // Nothing to trim
  const toTrim = pairs.length - keepLast;
  if (toTrim <= 0) return messages;

  const pairsToTrim = pairs.slice(0, toTrim);

  // Build sets of messages/blocks to remove
  const removeMessages = new Set<number>();
  const removeBlocks = new Map<number, Set<number>>(); // msgIdx → set of block indices

  // Collect summaries for trimmed pairs
  const summaries: string[] = [];

  for (const pair of pairsToTrim) {
    const assistantMsg = messages[pair.assistantIdx];
    const assistantBlocks = assistantMsg.content as ContentBlock[];

    // Count how many tool_use blocks for THIS tool are in the assistant message
    const toolBlocksInMsg = assistantBlocks.filter(
      (b) => b.type === "tool_use" && b.name === toolName,
    ).length;

    const otherBlocks = assistantBlocks.filter(
      (b) => !(b.type === "tool_use" && (b as ToolUseBlock).id === pair.toolUseId),
    );

    if (otherBlocks.length === 0 || (otherBlocks.length === 1 && otherBlocks[0].type === "text" && !(otherBlocks[0] as { text: string }).text.trim())) {
      // Assistant message only had this tool call (or empty text) — remove entire message
      removeMessages.add(pair.assistantIdx);
    } else {
      // Assistant message has other content — just mark this block for removal
      if (!removeBlocks.has(pair.assistantIdx)) {
        removeBlocks.set(pair.assistantIdx, new Set());
      }
      removeBlocks.get(pair.assistantIdx)!.add(pair.blockIdx);
    }

    // Check if the result message only has this one tool_result
    const resultMsg = messages[pair.resultIdx];
    const resultBlocks = resultMsg.content as ContentBlock[];
    const otherResultBlocks = resultBlocks.filter(
      (b) => !(b.type === "tool_result" && (b as ToolResultBlock).tool_use_id === pair.toolUseId),
    );

    if (otherResultBlocks.length === 0) {
      removeMessages.add(pair.resultIdx);
    }
    // If there are other result blocks, we'd need to filter — but in practice
    // each tool_result gets its own user message in this framework.

    // Build summary
    const preview = pair.resultContent.slice(0, 120).replace(/\n/g, " ");
    const status = pair.isError ? "error" : "ok";
    summaries.push(`[Prior ${toolName} call → ${preview}… (${status})]`);
  }

  // Build new message array
  const result: Message[] = [];
  let summaryInserted = false;

  for (let i = 0; i < messages.length; i++) {
    if (removeMessages.has(i)) {
      // Insert combined summary before the first kept message after trimmed region
      if (!summaryInserted && summaries.length > 0) {
        // Find where to insert — before the next non-removed message
        // We'll insert on the next non-removed iteration
      }
      continue;
    }

    // Insert summary once, right before the first kept message after trimming
    if (!summaryInserted && summaries.length > 0 && i > (pairsToTrim[0]?.assistantIdx ?? 0)) {
      // Insert as a user message to maintain role alternation
      const lastMsg = result[result.length - 1];
      if (lastMsg?.role === "user" && typeof lastMsg.content === "string") {
        // Merge into existing user message
        lastMsg.content += "\n\n" + summaries.join("\n");
      } else {
        result.push({
          role: "user",
          content: summaries.join("\n"),
        });
      }
      summaryInserted = true;
    }

    // Handle messages where we only remove specific blocks
    if (removeBlocks.has(i)) {
      const blocksToRemove = removeBlocks.get(i)!;
      const msg = messages[i];
      const blocks = msg.content as ContentBlock[];
      const kept = blocks.filter((_, idx) => !blocksToRemove.has(idx));
      if (kept.length > 0) {
        result.push({ ...msg, content: kept });
      }
      continue;
    }

    result.push(messages[i]);
  }

  // If summary wasn't inserted yet (all trimmed pairs were at the end), append it
  if (!summaryInserted && summaries.length > 0) {
    result.push({
      role: "user",
      content: summaries.join("\n"),
    });
  }

  return result;
}
