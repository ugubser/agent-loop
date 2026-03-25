import type {
  AgentConfig,
  LockHandle,
  Message,
  ToolUseBlock,
} from "../types.js";
import { Session } from "./session.js";
import { AnthropicProvider } from "../providers/anthropic.js";
import { OpenAICompatProvider } from "../providers/openai-compat.js";
import { CliToolExecutor } from "../tools/cli.js";
import { compactSession } from "./compaction.js";
import {
  loadSkill,
  discoverSkills,
  loadSkillSummaries,
  buildSystemPrompt,
  buildRouterPrompt,
} from "../skills/loader.js";
import { FileStore } from "../persistence/file-store.js";
import type { ToolSchema, SkillSummary } from "../types.js";

// Provider interface — any object with complete() and summarize()
export type Provider = AnthropicProvider | OpenAICompatProvider;

export interface LoopContext {
  session: Session;
  provider: Provider;
  executor: CliToolExecutor;
  config: AgentConfig;
  abortController: AbortController;
  lock: LockHandle;
  store: FileStore;
  skillCatalog?: Map<string, string>; // name → path (for use_skill)
  skillSummaries?: SkillSummary[];     // for system prompt
}

const USE_SKILL_SCHEMA: ToolSchema = {
  name: "use_skill",
  description:
    "Load a skill to get its specialized tools. Call this to start working with a specific skill, or to switch to a different skill mid-task.",
  input_schema: {
    type: "object",
    properties: {
      skill_name: {
        type: "string",
        description: "Name of the skill to load",
      },
    },
    required: ["skill_name"],
  },
};

export function createProvider(config: AgentConfig): Provider {
  if (config.model.provider === "openai-compat" || config.model.provider === "lmstudio") {
    return new OpenAICompatProvider(
      config.model.baseUrl ?? "http://localhost:1234/v1",
      config.model.apiKey ?? "lm-studio",
      config.model.requestTimeout ?? 300_000
    );
  }
  return new AnthropicProvider(config.model.apiKey, config.model.authToken);
}

export async function runLoop(ctx: LoopContext): Promise<void> {
  const { session, provider, executor, config, abortController, lock, store } = ctx;

  await session.setRunning();

  // Register signal handlers
  const cleanup = setupSignalHandlers(abortController, session, lock, store);

  // Track whether we've already nudged the model to confirm completion
  let completionConfirmed = false;

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

      // 2. Call the model — include use_skill alongside CLI tools when catalog exists
      let response;
      try {
        const cliSchemas = executor.schemas();
        const allTools = ctx.skillCatalog
          ? [USE_SKILL_SCHEMA, ...cliSchemas]
          : cliSchemas;

        response = await provider.complete({
          model: config.model.model,
          maxTokens: config.model.maxTokens,
          system: session.systemPrompt,
          messages: session.messages,
          tools: allTools.length > 0 ? allTools : undefined,
        });
      } catch (err: unknown) {
        // Provider error — pause session
        const message = err instanceof Error ? err.message : String(err);
        console.error(`\nProvider error: ${message}`);
        if (err instanceof Error && err.name === "TimeoutError") {
          console.error("Hint: The LLM request timed out. The model may be too slow or the server unresponsive.");
        }
        await session.setPaused("provider_error");
        await session.forceCheckpoint();
        return;
      }

      // 3. Check for truncated output (max_tokens hit)
      const toolUseBlocks = response.content.filter(
        (b): b is ToolUseBlock => b.type === "tool_use"
      );

      if (response.stopReason === "max_tokens") {
        console.error(`\nWarning: model output was truncated (max_tokens). Increase maxTokens in config.`);
        if (toolUseBlocks.length > 0) {
          // Tool calls were truncated — don't execute them, tell the model
          await session.addAssistantMessage(response);
          for (const toolCall of toolUseBlocks) {
            await session.addToolResult(
              toolCall.id,
              "ERROR: Your output was truncated (max_tokens reached). The tool call arguments are incomplete. " +
              "Reduce the size of your tool call or split it into multiple smaller calls.",
              true
            );
          }
          session.iteration++;
          await store.writeState(session.id, session.state);
          await session.checkpoint();
          continue;
        }
      }

      if (toolUseBlocks.length === 0) {
        await session.addAssistantMessage(response);

        // If this is the first time the model stopped without tool calls,
        // nudge it to confirm it's really done before completing.
        if (!completionConfirmed) {
          completionConfirmed = true;
          const nudge: Message = {
            role: "user",
            content: "Are you done? If there are remaining steps, unanswered questions, or warnings to fix, continue by calling the appropriate tool. If the task is truly complete with no issues, respond with your final summary.",
          };
          session.messages.push(nudge);
          await store.appendTranscript(session.id, {
            type: "message",
            timestamp: new Date().toISOString(),
            iteration: session.iteration,
            data: nudge,
          });
          session.iteration++;
          await store.writeState(session.id, session.state);
          await session.checkpoint();
          continue;
        }

        // Second time without tool calls — genuinely done
        await session.setCompleted();
        await session.forceCheckpoint();
        return;
      }

      // Reset confirmation flag when model uses tools
      completionConfirmed = false;

      // 4. Execute tool calls
      await session.addAssistantMessage(response);

      for (const toolCall of toolUseBlocks) {
        if (abortController.signal.aborted) break;

        // Handle built-in use_skill tool
        if (toolCall.name === "use_skill" && ctx.skillCatalog) {
          const skillName = String(toolCall.input.skill_name ?? "");
          const skillPath = ctx.skillCatalog.get(skillName);
          if (!skillPath) {
            const available = Array.from(ctx.skillCatalog.keys()).join(", ");
            await session.addToolResult(
              toolCall.id,
              `ERROR: Skill "${skillName}" not found. Available: ${available}`,
              true
            );
            continue;
          }

          try {
            const skill = await loadSkill(skillPath);
            executor.clearTools();
            if (skill.tools.length > 0) {
              executor.registerAll(skill.tools);
            }

            // Update system prompt with skill instructions + keep skill catalog visible
            session.systemPrompt = buildSystemPrompt({
              skill,
              task: undefined, // task is already in the conversation
              availableSkills: ctx.skillSummaries,
            });

            const toolNames = skill.tools.map((t) => t.name).join(", ");
            await session.addToolResult(
              toolCall.id,
              `Loaded skill: ${skillName}. Tools now available: ${toolNames || "none (instructions only)"}`
            );
            console.log(`Switched to skill: ${skillName}`);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            await session.addToolResult(
              toolCall.id,
              `ERROR loading skill: ${message}`,
              true
            );
          }
          continue;
        }

        // Handle CLI tools
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

      // 5. Increment iteration, persist state, and checkpoint
      session.iteration++;
      await store.writeState(session.id, session.state);
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
  skillName: string | undefined,
  config: AgentConfig,
  store: FileStore,
  task?: string
): Promise<string> {
  const skillCatalog = await discoverSkills(config.skills.dirs);
  const executor = new CliToolExecutor(
    config.tools.cli.allowedCommands,
    config.tools.cli.timeout
  );

  let sessionSkillName: string;
  let skillSummaries: SkillSummary[] | undefined;

  if (skillName && skillName !== "auto") {
    // Direct skill mode — load a specific skill
    const skillPath = skillCatalog.get(skillName);
    if (!skillPath) {
      const available = Array.from(skillCatalog.keys()).join(", ");
      throw new Error(
        `Skill "${skillName}" not found. Available: ${available || "none"}`
      );
    }
    const skill = await loadSkill(skillPath);
    if (skill.tools.length > 0) {
      executor.registerAll(skill.tools);
    }
    sessionSkillName = skillName;
  } else {
    // Router mode — agent picks the skill dynamically
    sessionSkillName = "auto";
  }

  // Create session
  const session = await Session.create(sessionSkillName, config, store);
  const lock = await store.acquireLock(session.id);

  // Build system prompt
  if (sessionSkillName === "auto") {
    skillSummaries = await loadSkillSummaries(config.skills.dirs);
    session.systemPrompt = buildRouterPrompt({ skills: skillSummaries, task });
    console.log(
      `Router mode — available skills: ${skillSummaries.map((s) => s.name).join(", ")}`
    );
  } else {
    const skillPath = skillCatalog.get(sessionSkillName)!;
    const skill = await loadSkill(skillPath);
    session.systemPrompt = buildSystemPrompt({ skill, task });
  }

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
  const provider = createProvider(config);

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
      skillCatalog: sessionSkillName === "auto" ? skillCatalog : undefined,
      skillSummaries,
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

  const skillCatalog = await discoverSkills(config.skills.dirs);
  const executor = new CliToolExecutor(
    config.tools.cli.allowedCommands,
    config.tools.cli.timeout
  );

  let skillSummaries: SkillSummary[] | undefined;
  const isRouterMode = session.skillName === "auto";

  if (!isRouterMode) {
    // Direct skill mode — re-load the specific skill
    const skillPath = skillCatalog.get(session.skillName);
    if (!skillPath) {
      await store.releaseLock(lock);
      throw new Error(`Skill "${session.skillName}" not found for resume`);
    }
    const skill = await loadSkill(skillPath);
    if (skill.tools.length > 0) {
      executor.registerAll(skill.tools);
    }
    if (!session.systemPrompt) {
      session.systemPrompt = buildSystemPrompt({ skill });
    }
  } else {
    // Router mode — restore with skill catalog
    skillSummaries = await loadSkillSummaries(config.skills.dirs);
    if (!session.systemPrompt) {
      session.systemPrompt = buildRouterPrompt({ skills: skillSummaries });
    }
  }

  const provider = createProvider(config);
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
      skillCatalog: isRouterMode ? skillCatalog : undefined,
      skillSummaries,
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
