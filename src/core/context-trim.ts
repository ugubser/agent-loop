/**
 * Context trimming for iterative tool calls.
 *
 * When a tool has `context.keepLast` configured, older call+result pairs
 * are replaced with compact summaries in the message array. The full
 * history remains in the transcript (JSONL) for debugging.
 *
 * `autoTrimConsumedResults` provides a generic "consumed" heuristic:
 * any tool_result from a prior iteration that the LLM has already acted
 * on (i.e., it is NOT from the current iteration) gets its content
 * replaced with a compact summary. This prevents large schema/RAG
 * results from persisting across dozens of iterations.
 */

import type { Message, ContentBlock, ToolUseBlock, ToolResultBlock } from "../types.js";

/** Minimum content length to bother trimming — small results aren't worth it */
const AUTO_TRIM_MIN_CHARS = 500;

/**
 * Trim tool_result content from all iterations EXCEPT the most recent one.
 * Results from the current iteration are kept intact so the LLM can see
 * what just happened. Older results are replaced with a one-line summary.
 *
 * Tools listed in `preservedTools` are never trimmed — their results stay
 * in context for the entire session. Configure per-tool via
 * `context.preserveResult: true` in the skill definition.
 *
 * Returns the original array if no trimming occurred.
 */
export function autoTrimConsumedResults(
  messages: Message[],
  preservedTools?: Set<string>,
): Message[] {
  // Find the index of the last assistant message — everything after it
  // (inclusive) is the "current iteration" and should not be trimmed.
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }
  if (lastAssistantIdx <= 0) return messages; // nothing to trim

  // Collect tool_use IDs from the current iteration's assistant message
  // so we can protect their matching tool_results (which come after).
  const currentToolIds = new Set<string>();
  const lastAssistant = messages[lastAssistantIdx];
  if (Array.isArray(lastAssistant.content)) {
    for (const block of lastAssistant.content) {
      if (block.type === "tool_use") {
        currentToolIds.add((block as ToolUseBlock).id);
      }
    }
  }

  // Build a map: tool_use_id → tool name (from all assistant messages)
  const toolNames = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== "assistant" || typeof msg.content === "string") continue;
    for (const block of msg.content as ContentBlock[]) {
      if (block.type === "tool_use") {
        toolNames.set((block as ToolUseBlock).id, (block as ToolUseBlock).name);
      }
    }
  }

  let changed = false;
  const result: Message[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Only process user messages that contain tool_result blocks
    if (msg.role !== "user" || typeof msg.content === "string") {
      result.push(msg);
      continue;
    }

    const blocks = msg.content as ContentBlock[];
    let msgChanged = false;
    const newBlocks: ContentBlock[] = [];

    for (const block of blocks) {
      if (block.type !== "tool_result") {
        newBlocks.push(block);
        continue;
      }

      const tr = block as ToolResultBlock;

      // Protect results from the current iteration
      if (currentToolIds.has(tr.tool_use_id)) {
        newBlocks.push(block);
        continue;
      }

      // Skip if already trimmed or too small to bother
      if (tr.content.length < AUTO_TRIM_MIN_CHARS ||
          tr.content.startsWith("[Prior ")) {
        newBlocks.push(block);
        continue;
      }

      // Skip tools marked with preserveResult in the skill config
      const toolName = toolNames.get(tr.tool_use_id);
      if (toolName && preservedTools?.has(toolName)) {
        newBlocks.push(block);
        continue;
      }

      // Trim: replace content with a compact summary
      const name = toolName ?? "tool";
      const preview = tr.content.slice(0, 120).replace(/\n/g, " ");
      const trimmedContent =
        `[Prior ${name} result: ${preview}… (${tr.content.length} chars trimmed)]`;

      newBlocks.push({
        type: "tool_result",
        tool_use_id: tr.tool_use_id,
        content: trimmedContent,
        is_error: tr.is_error,
      } as ToolResultBlock);
      msgChanged = true;
      changed = true;
    }

    result.push(msgChanged ? { ...msg, content: newBlocks } : msg);
  }

  return changed ? result : messages;
}

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
