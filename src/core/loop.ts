import type {
  AgentConfig,
  LockHandle,
  ToolUseBlock,
} from "../types.js";
import { Session } from "./session.js";
import { AnthropicProvider } from "../providers/anthropic.js";
import { CliToolExecutor } from "../tools/cli.js";
import { compactSession } from "./compaction.js";
import { loadSkill, discoverSkills, buildSystemPrompt } from "../skills/loader.js";
import { FileStore } from "../persistence/file-store.js";

export interface LoopContext {
  session: Session;
  provider: AnthropicProvider;
  executor: CliToolExecutor;
  config: AgentConfig;
  abortController: AbortController;
  lock: LockHandle;
  store: FileStore;
}

export async function runLoop(ctx: LoopContext): Promise<void> {
  const { session, provider, executor, config, abortController, lock, store } = ctx;

  await session.setRunning();

  // Register signal handlers
  const cleanup = setupSignalHandlers(abortController, session, lock, store);

  try {
    while (!session.isTimedOut() && !session.isMaxSteps() && !abortController.signal.aborted) {
      // 1. Check compaction threshold
      const { needed } = session.getCompactionTarget();
      if (needed !== "none") {
        await compactSession(
          session,
          provider,
          config.model.model,
          async (entry) => {
            await store.appendTranscript(session.id, entry);
          }
        );
      }

      // 2. Call the model
      let response;
      try {
        response = await provider.complete({
          model: config.model.model,
          maxTokens: config.model.maxTokens,
          system: session.systemPrompt,
          messages: session.messages,
          tools: executor.schemas().length > 0 ? executor.schemas() : undefined,
        });
      } catch (err: unknown) {
        // Provider error — pause session
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Provider error: ${message}`);
        await session.setPaused("provider_error");
        await session.forceCheckpoint();
        return;
      }

      // 3. Check if text only (no tool calls)
      const toolUseBlocks = response.content.filter(
        (b): b is ToolUseBlock => b.type === "tool_use"
      );

      if (toolUseBlocks.length === 0) {
        // Normal completion — model returned text with no tool calls
        await session.addAssistantMessage(response);
        await session.setCompleted();
        await session.forceCheckpoint();
        return;
      }

      // 4. Execute tool calls
      await session.addAssistantMessage(response);

      for (const toolCall of toolUseBlocks) {
        if (abortController.signal.aborted) break;

        const tool = executor.resolve(toolCall.name);
        if (!tool) {
          await session.addToolResult(
            toolCall.id,
            `ERROR: Unknown tool "${toolCall.name}"`,
            true
          );
          continue;
        }

        try {
          const result = await executor.execute(
            toolCall.name,
            toolCall.input
          );
          await session.addToolResult(toolCall.id, result);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          await session.addToolResult(toolCall.id, `ERROR: ${message}`, true);
        }
      }

      // 5. Increment iteration and checkpoint
      session.iteration++;
      await session.checkpoint();
    }

    // Determine why we exited
    if (abortController.signal.aborted) {
      await session.setPaused("signal");
    } else if (session.isTimedOut()) {
      await session.setPaused("timeout");
    } else if (session.isMaxSteps()) {
      await session.setPaused("max_steps");
    }
    await session.forceCheckpoint();
  } finally {
    cleanup();
  }
}

export async function startNewSession(
  skillName: string,
  config: AgentConfig,
  store: FileStore,
  task?: string
): Promise<string> {
  // Discover and load skill
  const skills = await discoverSkills(config.skills.dirs);
  const skillPath = skills.get(skillName);
  if (!skillPath) {
    const available = Array.from(skills.keys()).join(", ");
    throw new Error(
      `Skill "${skillName}" not found. Available: ${available || "none"}`
    );
  }
  const skill = await loadSkill(skillPath);

  // Create session
  const session = await Session.create(skillName, config, store);
  const lock = await store.acquireLock(session.id);

  // Set up tools
  const executor = new CliToolExecutor(
    config.tools.cli.allowedCommands,
    config.tools.cli.timeout
  );
  if (skill.tools.length > 0) {
    executor.registerAll(skill.tools);
  }

  // Build system prompt
  session.systemPrompt = buildSystemPrompt({ skill, task });

  // Add initial user message with the task
  if (task) {
    session.messages.push({ role: "user", content: task });
    await store.appendTranscript(session.id, {
      type: "message",
      timestamp: new Date().toISOString(),
      iteration: 0,
      data: { role: "user", content: task },
    });
  }

  // Create provider
  const provider = new AnthropicProvider();

  // Run the loop
  const abortController = new AbortController();
  try {
    await runLoop({
      session,
      provider,
      executor,
      config,
      abortController,
      lock,
      store,
    });
  } finally {
    await store.releaseLock(lock);
  }

  return session.id;
}

export async function resumeSession(
  sessionId: string,
  config: AgentConfig,
  store: FileStore
): Promise<void> {
  const lock = await store.acquireLock(sessionId);
  const session = await Session.resume(sessionId, store);

  if (session.status === "crashed") {
    console.warn(
      "Session crashed previously. Resuming with at-least-once tool semantics."
    );
  }

  // Re-load skill
  const skills = await discoverSkills(config.skills.dirs);
  const skillPath = skills.get(session.skillName);
  if (!skillPath) {
    await store.releaseLock(lock);
    throw new Error(`Skill "${session.skillName}" not found for resume`);
  }
  const skill = await loadSkill(skillPath);

  // Re-build executor
  const executor = new CliToolExecutor(
    config.tools.cli.allowedCommands,
    config.tools.cli.timeout
  );
  if (skill.tools.length > 0) {
    executor.registerAll(skill.tools);
  }

  // Re-build system prompt if not restored from checkpoint
  if (!session.systemPrompt) {
    session.systemPrompt = buildSystemPrompt({ skill });
  }

  const provider = new AnthropicProvider();
  const abortController = new AbortController();

  try {
    await runLoop({
      session,
      provider,
      executor,
      config,
      abortController,
      lock,
      store,
    });
  } finally {
    await store.releaseLock(lock);
  }
}

function setupSignalHandlers(
  controller: AbortController,
  session: Session,
  lock: LockHandle,
  store: FileStore
): () => void {
  const handler = () => {
    console.log("\nGraceful shutdown — waiting for current tool to complete...");
    controller.abort();
  };

  const exitHandler = () => {
    // Best-effort cleanup
    try {
      store.releaseLock(lock);
    } catch {
      // Ignore
    }
  };

  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  process.on("beforeExit", exitHandler);

  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
    process.off("beforeExit", exitHandler);
  };
}
