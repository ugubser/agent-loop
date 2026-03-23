import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runLoop, type LoopContext } from "../../src/core/loop.js";
import { Session } from "../../src/core/session.js";
import { FileStore } from "../../src/persistence/file-store.js";
import { CliToolExecutor } from "../../src/tools/cli.js";
import { MockProvider } from "../helpers/mock-provider.js";
import type { AgentConfig } from "../../src/types.js";

const testConfig: AgentConfig = {
  model: { provider: "anthropic", model: "claude-sonnet-4-6", maxTokens: 4096 },
  session: { maxContext: 200000, checkpointInterval: 2, timeout: 21600 },
  skills: { dirs: ["./skills"] },
  persistence: { backend: "file", dir: "" }, // Set in beforeEach
  tools: { cli: { allowedCommands: ["echo"], timeout: 120 } },
};

async function setupContext(
  store: FileStore,
  provider: MockProvider,
  config: AgentConfig
): Promise<LoopContext> {
  const session = await Session.create("test-skill", config, store);
  session.systemPrompt = "You are a test agent.";
  session.messages.push({ role: "user", content: "Run the integration test." });

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
    provider: provider as unknown as import("../../src/providers/anthropic.js").AnthropicProvider,
    executor,
    config,
    abortController: new AbortController(),
    lock,
    store,
  };
}

describe("Integration: Full Session Lifecycle", () => {
  let tmpDir: string;
  let store: FileStore;
  let config: AgentConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-integ-"));
    store = new FileStore(tmpDir);
    config = { ...testConfig, persistence: { ...testConfig.persistence, dir: tmpDir } };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("full run: start → iterate → complete", async () => {
    const provider = new MockProvider([
      { toolCalls: [{ id: "t1", name: "echo_test", input: { message: "step 1" } }] },
      { toolCalls: [{ id: "t2", name: "echo_test", input: { message: "step 2" } }] },
      { toolCalls: [{ id: "t3", name: "echo_test", input: { message: "step 3" } }] },
      { text: "All steps complete. Here is my report." },
    ]);

    const ctx = await setupContext(store, provider, config);
    await runLoop(ctx);

    // Verify final state
    expect(ctx.session.status).toBe("completed");
    expect(ctx.session.iteration).toBe(3);

    // Verify transcript has entries
    const transcript = await store.readTranscript(ctx.session.id);
    expect(transcript.length).toBeGreaterThan(0);

    // Verify state.json on disk
    const state = await store.readState(ctx.session.id);
    expect(state.status).toBe("completed");
    expect(state.iteration).toBe(3);

    // Verify checkpoint was written (interval=2, so at iteration 2)
    const checkpoints = await store.listCheckpoints(ctx.session.id);
    expect(checkpoints.length).toBeGreaterThanOrEqual(1);

    await store.releaseLock(ctx.lock);
  });

  it("crash recovery: start → crash → resume → complete", async () => {
    // Phase 1: Run and "crash" after 2 iterations
    const provider1 = new MockProvider([
      { toolCalls: [{ id: "t1", name: "echo_test", input: { message: "step 1" } }] },
      { toolCalls: [{ id: "t2", name: "echo_test", input: { message: "step 2" } }] },
      // Would continue but we abort
    ]);

    const ctx1 = await setupContext(store, provider1, config);
    const sessionId = ctx1.session.id;

    // Abort after second provider call to simulate crash mid-run
    const origComplete = provider1.complete.bind(provider1);
    let callCount = 0;
    provider1.complete = async (...args: Parameters<typeof origComplete>) => {
      callCount++;
      if (callCount >= 2) ctx1.abortController.abort();
      return origComplete(...args);
    };

    await runLoop(ctx1);
    expect(ctx1.session.status).toBe("paused");
    await store.releaseLock(ctx1.lock);

    // Phase 2: Resume the session
    const resumed = await Session.resume(sessionId, store);
    // Status should be crashed (we left it as "paused" from signal, but the concept is the same)
    // For a real crash, state.json would show "running"

    // Create a new provider for the resumed session
    const provider2 = new MockProvider([
      { toolCalls: [{ id: "t3", name: "echo_test", input: { message: "resumed step" } }] },
      { text: "Completed after resume." },
    ]);

    const lock2 = await store.acquireLock(sessionId);
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

    await runLoop({
      session: resumed,
      provider: provider2 as unknown as import("../../src/providers/anthropic.js").AnthropicProvider,
      executor,
      config,
      abortController: new AbortController(),
      lock: lock2,
      store,
    });

    expect(resumed.status).toBe("completed");
    // Messages should contain history from both runs
    expect(resumed.messages.length).toBeGreaterThan(2);
    await store.releaseLock(lock2);
  });

  it("session listing shows all sessions", async () => {
    const provider = new MockProvider([{ text: "Done." }]);

    // Create 3 sessions
    for (let i = 0; i < 3; i++) {
      const ctx = await setupContext(store, provider, config);
      await runLoop(ctx);
      await store.releaseLock(ctx.lock);
    }

    const sessions = await store.listSessions();
    expect(sessions).toHaveLength(3);
    expect(sessions.every((s) => s.status === "completed")).toBe(true);
  });
});
