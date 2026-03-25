import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runLoop, type LoopContext } from "./loop.js";
import { Session } from "./session.js";
import { FileStore } from "../persistence/file-store.js";
import { CliToolExecutor } from "../tools/cli.js";
import { MockProvider } from "../../test/helpers/mock-provider.js";
import type { AgentConfig } from "../types.js";

const testConfig: AgentConfig = {
  model: { provider: "anthropic", model: "claude-sonnet-4-6", maxTokens: 4096 },
  session: { maxContext: 200000, checkpointInterval: 5, timeout: 21600 },
  skills: { dirs: ["./skills"] },
  persistence: { backend: "file", dir: "./sessions" },
  tools: { cli: { allowedCommands: ["echo"], timeout: 120 } },
};

async function makeContext(
  store: FileStore,
  provider: MockProvider,
  configOverrides?: Partial<AgentConfig>
): Promise<LoopContext> {
  const config = { ...testConfig, ...configOverrides };
  const session = await Session.create("test-skill", config, store);
  session.systemPrompt = "You are a test agent.";
  session.messages.push({ role: "user", content: "Do the task." });

  const executor = new CliToolExecutor(["echo"], 120);
  executor.register({
    name: "echo_test",
    description: "Echo",
    command: "echo",
    args: ["${message}"],
    schema: { message: { type: "string" } },
    timeout: 10,
    idempotent: true,
  });

  const lock = await store.acquireLock(session.id);

  return {
    session,
    provider: provider as unknown as import("../providers/anthropic.js").AnthropicProvider,
    executor,
    config,
    abortController: new AbortController(),
    lock,
    store,
  };
}

describe("runLoop", () => {
  let tmpDir: string;
  let store: FileStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-loop-"));
    store = new FileStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("completes after nudge when model returns text only", async () => {
    const provider = new MockProvider([
      { text: "Task complete. Here are the results." },
      { text: "Yes, I am done." },  // Response to completion nudge
    ]);
    const ctx = await makeContext(store, provider);
    await runLoop(ctx);

    expect(ctx.session.status).toBe("completed");
    expect(ctx.session.iteration).toBe(1); // nudge adds an iteration
    expect(provider.calls).toHaveLength(2);
    await store.releaseLock(ctx.lock);
  });

  it("executes tool calls and loops", async () => {
    const provider = new MockProvider([
      { toolCalls: [{ id: "t1", name: "echo_test", input: { message: "hello" } }] },
      { text: "Done after using echo." },
      { text: "Yes, confirmed done." },  // Response to completion nudge
    ]);
    const ctx = await makeContext(store, provider);
    await runLoop(ctx);

    expect(ctx.session.status).toBe("completed");
    expect(ctx.session.iteration).toBe(2); // tool iteration + nudge iteration
    expect(provider.calls).toHaveLength(3);
    // Session should have: user msg, assistant (tool call), user (tool result), assistant (done), user (nudge), assistant (confirm)
    expect(ctx.session.messages.length).toBeGreaterThanOrEqual(6);
    await store.releaseLock(ctx.lock);
  });

  it("handles unknown tool gracefully", async () => {
    const provider = new MockProvider([
      { toolCalls: [{ id: "t1", name: "nonexistent", input: {} }] },
      { text: "OK, I'll stop." },
    ]);
    const ctx = await makeContext(store, provider);
    await runLoop(ctx);

    expect(ctx.session.status).toBe("completed");
    // Tool result should contain error
    const toolResults = ctx.session.messages.filter(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some((b: { type: string }) => b.type === "tool_result")
    );
    expect(toolResults.length).toBeGreaterThan(0);
    await store.releaseLock(ctx.lock);
  });

  it("handles abort signal", async () => {
    const provider = new MockProvider([
      { toolCalls: [{ id: "t1", name: "echo_test", input: { message: "1" } }] },
      { toolCalls: [{ id: "t2", name: "echo_test", input: { message: "2" } }] },
      { text: "Never reached" },
    ]);
    const ctx = await makeContext(store, provider);

    // Abort after first iteration
    const origComplete = provider.complete.bind(provider);
    let callCount = 0;
    provider.complete = async (...args: Parameters<typeof origComplete>) => {
      callCount++;
      if (callCount >= 2) ctx.abortController.abort();
      return origComplete(...args);
    };

    await runLoop(ctx);
    expect(ctx.session.status).toBe("paused");
    expect(ctx.session.reason).toBe("signal");
    await store.releaseLock(ctx.lock);
  });

  it("respects maxSteps", async () => {
    const provider = new MockProvider([
      { toolCalls: [{ id: "t1", name: "echo_test", input: { message: "1" } }] },
      { toolCalls: [{ id: "t2", name: "echo_test", input: { message: "2" } }] },
      { toolCalls: [{ id: "t3", name: "echo_test", input: { message: "3" } }] },
      { text: "Never reached" },
    ]);
    const ctx = await makeContext(store, provider, {
      session: { ...testConfig.session, maxSteps: 2 },
    });
    await runLoop(ctx);

    expect(ctx.session.status).toBe("paused");
    expect(ctx.session.reason).toBe("max_steps");
    expect(ctx.session.iteration).toBe(2);
    await store.releaseLock(ctx.lock);
  });

  it("writes checkpoint on interval", async () => {
    const responses = [];
    for (let i = 0; i < 6; i++) {
      responses.push({
        toolCalls: [{ id: `t${i}`, name: "echo_test", input: { message: String(i) } }],
      });
    }
    responses.push({ text: "Done after 6 iterations." });

    const provider = new MockProvider(responses);
    const ctx = await makeContext(store, provider, {
      session: { ...testConfig.session, checkpointInterval: 5 },
    });
    await runLoop(ctx);

    // Should have checkpoint at iteration 5 (and force checkpoint at end)
    const checkpoints = await store.listCheckpoints(ctx.session.id);
    expect(checkpoints.length).toBeGreaterThanOrEqual(1);
    await store.releaseLock(ctx.lock);
  });

  it("handles multiple tool calls in one response", async () => {
    const provider = new MockProvider([
      {
        toolCalls: [
          { id: "t1", name: "echo_test", input: { message: "first" } },
          { id: "t2", name: "echo_test", input: { message: "second" } },
        ],
      },
      { text: "Both tools executed." },
    ]);
    const ctx = await makeContext(store, provider);
    await runLoop(ctx);

    expect(ctx.session.status).toBe("completed");
    // Should have tool results for both calls
    const toolResults = ctx.session.messages.filter(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some((b: { type: string }) => b.type === "tool_result")
    );
    expect(toolResults).toHaveLength(2);
    await store.releaseLock(ctx.lock);
  });

  it("handles use_skill built-in tool", async () => {
    // Create a skill file for the test
    const skillDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "test-skill.md"),
      `---
name: test-skill
description: A test skill
tools:
  - name: echo_test
    description: Echo
    command: echo
    args: ["\${message}"]
    schema:
      message: { type: "string" }
    timeout: 10
    idempotent: true
---

## Instructions
You are a test agent.
`
    );

    const skillCatalog = new Map([["test-skill", path.join(skillDir, "test-skill.md")]]);

    const provider = new MockProvider([
      // First call: model picks a skill
      { toolCalls: [{ id: "s1", name: "use_skill", input: { skill_name: "test-skill" } }] },
      // Second call: model uses the skill's tool
      { toolCalls: [{ id: "t1", name: "echo_test", input: { message: "hello" } }] },
      // Third call: done
      { text: "All done." },
    ]);

    const ctx = await makeContext(store, provider);
    ctx.skillCatalog = skillCatalog;
    ctx.skillSummaries = [{ name: "test-skill", description: "A test skill" }];

    await runLoop(ctx);

    expect(ctx.session.status).toBe("completed");
    // Should have: user msg, assistant(use_skill), user(result), assistant(echo), user(result), assistant(done)
    expect(ctx.session.messages.length).toBeGreaterThanOrEqual(6);
    // Verify use_skill result is in the messages
    const useSkillResult = ctx.session.messages.find(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some(
          (b: { type: string; content?: string }) =>
            b.type === "tool_result" && b.content?.includes("Loaded skill")
        )
    );
    expect(useSkillResult).toBeTruthy();
    await store.releaseLock(ctx.lock);
  });

  it("returns error for unknown skill in use_skill", async () => {
    const provider = new MockProvider([
      { toolCalls: [{ id: "s1", name: "use_skill", input: { skill_name: "nonexistent" } }] },
      { text: "OK." },
    ]);

    const ctx = await makeContext(store, provider);
    ctx.skillCatalog = new Map();
    ctx.skillSummaries = [];

    await runLoop(ctx);

    expect(ctx.session.status).toBe("completed");
    const errorResult = ctx.session.messages.find(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some(
          (b: { type: string; content?: string }) =>
            b.type === "tool_result" && b.content?.includes("not found")
        )
    );
    expect(errorResult).toBeTruthy();
    await store.releaseLock(ctx.lock);
  });
});
