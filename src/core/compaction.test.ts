import { describe, it, expect } from "vitest";
import { findIterationBoundary } from "./compaction.js";
import type { Message } from "../types.js";

// Helper to build message sequences
function assistantMsg(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function toolCallMsg(toolId: string, name: string): Message {
  return {
    role: "assistant",
    content: [
      { type: "text", text: "Using tool" },
      { type: "tool_use", id: toolId, name, input: {} },
    ],
  };
}

function toolResultMsg(toolId: string, result: string): Message {
  return {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: toolId, content: result },
    ],
  };
}

function userMsg(text: string): Message {
  return { role: "user", content: text };
}

describe("findIterationBoundary", () => {
  it("returns 0 for empty messages", () => {
    expect(findIterationBoundary([], 5)).toBe(0);
  });

  it("returns 0 when fewer iterations than N", () => {
    const messages = [
      userMsg("hello"),
      assistantMsg("hi"),
    ];
    expect(findIterationBoundary(messages, 5)).toBe(0);
  });

  it("finds boundary for simple assistant-only iterations", () => {
    const messages = [
      userMsg("task"),           // 0
      assistantMsg("step 1"),    // 1 - iteration 1
      assistantMsg("step 2"),    // 2 - iteration 2
      assistantMsg("step 3"),    // 3 - iteration 3
      assistantMsg("step 4"),    // 4 - iteration 4
      assistantMsg("step 5"),    // 5 - iteration 5
    ];
    // Keep last 3 iterations → start at index 3
    const boundary = findIterationBoundary(messages, 3);
    expect(boundary).toBe(3);
  });

  it("handles tool call + tool result iterations", () => {
    const messages = [
      userMsg("task"),                         // 0
      toolCallMsg("t1", "search"),             // 1 - iteration 1 starts
      toolResultMsg("t1", "result 1"),         // 2 - part of iteration 1
      toolCallMsg("t2", "search"),             // 3 - iteration 2 starts
      toolResultMsg("t2", "result 2"),         // 4 - part of iteration 2
      assistantMsg("done"),                    // 5 - iteration 3
    ];
    // Keep last 2 iterations → iterations 2 and 3
    const boundary = findIterationBoundary(messages, 2);
    expect(boundary).toBe(3); // starts at iteration 2's assistant message
  });

  it("handles multi-tool iterations", () => {
    const messages = [
      userMsg("task"),                         // 0
      toolCallMsg("t1", "search"),             // 1 - iteration 1 (assistant)
      toolResultMsg("t1", "result 1"),         // 2 - tool result (user)
      toolCallMsg("t2", "fetch"),              // 3 - iteration 2 (assistant)
      toolResultMsg("t2", "result 2"),         // 4 - tool result (user)
    ];
    // Keep last 1 iteration → just the last assistant + its tool results
    const boundary = findIterationBoundary(messages, 1);
    expect(boundary).toBe(3);
  });

  it("N=0 returns length (keep nothing)", () => {
    const messages = [userMsg("a"), assistantMsg("b")];
    expect(findIterationBoundary(messages, 0)).toBe(messages.length);
  });
});
