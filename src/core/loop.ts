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
import { trimToolContext, autoTrimConsumedResults } from "./context-trim.js";
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

  // Track consecutive text-only responses (no tool calls).
  // After 3 in a row, we assume the model is genuinely done.
  let consecutiveTextOnly = 0;

  // Track consecutive malformed JSON errors for the same tool
  let consecutiveMalformedJson = 0;

  // Loop detection: rolling window of tool call signatures
  const recentToolSigs: string[] = [];
  let loopWarningCount = 0;

  // Token budget warning (fire once)
  let tokenWarningIssued = false;

  try {
    while (
      !session.isTimedOut() &&
      !session.isMaxSteps() &&
      !session.isTokenBudgetExhausted() &&
      !abortController.signal.aborted
    ) {
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

      // 2. Call the model with retry on transient errors
      const maxRetries = config.model.providerRetries ?? 3;
      const retryDelays = [5000, 15000, 30000];
      let response;
      let lastProviderError: unknown;

      const cliSchemas = executor.schemas();
      const allTools = ctx.skillCatalog
        ? [USE_SKILL_SCHEMA, ...cliSchemas]
        : cliSchemas;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          response = await provider.complete({
            model: config.model.model,
            maxTokens: config.model.maxTokens,
            system: session.systemPrompt,
            messages: session.messages,
            tools: allTools.length > 0 ? allTools : undefined,
          });
          break; // success
        } catch (err: unknown) {
          lastProviderError = err;
          const message = err instanceof Error ? err.message : String(err);
          const errName = err instanceof Error ? (err.constructor?.name ?? err.name ?? "Error") : typeof err;
          console.error(`\nProvider error [${errName}] attempt ${attempt + 1}/${maxRetries} at iteration ${session.iteration}: ${message}`);

          if (attempt < maxRetries - 1) {
            const delay = retryDelays[attempt] ?? 30000;
            console.error(`Retrying in ${delay / 1000}s...`);
            await new Promise(r => setTimeout(r, delay));
          }
        }
      }

      if (!response) {
        // All retries exhausted — pause session
        const message = lastProviderError instanceof Error ? lastProviderError.message : String(lastProviderError);
        const errName = lastProviderError instanceof Error
          ? (lastProviderError.constructor?.name ?? (lastProviderError as Error).name ?? "Error")
          : typeof lastProviderError;
        const stack = lastProviderError instanceof Error ? lastProviderError.stack : undefined;
        console.error(`\nProvider error [${errName}] after ${maxRetries} attempts at iteration ${session.iteration}: ${message}`);
        if (stack) {
          console.error(`Stack: ${stack.split("\n").slice(0, 5).join("\n")}`);
        }
        console.error(`Context: messages=${session.messages.length}, model=${config.model.model}, baseUrl=${config.model.baseUrl ?? "default"}`);
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
        // Check if the response is truly empty (no text content at all)
        const hasText = response.content.some(
          (b) => b.type === "text" && b.text.trim().length > 0
        );

        if (!hasText) {
          consecutiveTextOnly++;
          if (consecutiveTextOnly >= 5) {
            // Too many empty retries — give up
            await session.setCompleted();
            await session.forceCheckpoint();
            return;
          }

          // Inject a nudge so the retry has different context.
          // First empty gets a gentle poke; subsequent ones escalate.
          const nudge: Message = {
            role: "user",
            content: consecutiveTextOnly === 1
              ? "Your previous response was empty. Review the last tool result and continue with the next step."
              : `Empty response ${consecutiveTextOnly} times in a row. You MUST call a tool or provide a final summary. Do not return an empty response.`,
          };
          session.messages.push(nudge);
          await store.appendTranscript(session.id, {
            type: "message",
            timestamp: new Date().toISOString(),
            iteration: session.iteration,
            data: nudge,
          });
          console.error(`[empty-response] Injected nudge (attempt ${consecutiveTextOnly}/5) at iteration ${session.iteration}`);
          continue;
        }

        // Non-empty text without tool calls — model chose to respond with text
        await session.addAssistantMessage(response);
        consecutiveTextOnly++;

        // Check if the text looks like a final summary (contains completion signals
        // and is substantial enough to be a summary, not just a brief remark)
        const responseText = response.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("");
        const looksComplete = responseText.length > 200 &&
          /\b(complete|completed|finished|successful|done)\b/i.test(responseText);

        if (consecutiveTextOnly >= 3 || (consecutiveTextOnly >= 1 && looksComplete)) {
          // Genuinely done — either 3 consecutive text responses,
          // or a substantial summary with completion signals
          await session.setCompleted();
          await session.forceCheckpoint();
          return;
        }

        // Inject a directive continuation prompt.
        const continuation: Message = {
          role: "user",
          content: "You responded with text instead of a tool call. If there are pending questions, unanswered steps, or remaining work, call the appropriate tool NOW. Only provide a final summary if the task is fully complete.",
        };
        session.messages.push(continuation);
        await store.appendTranscript(session.id, {
          type: "message",
          timestamp: new Date().toISOString(),
          iteration: session.iteration,
          data: continuation,
        });
        session.iteration++;
        await store.writeState(session.id, session.state);
        await session.checkpoint();
        continue;
      }

      // Reset consecutive text-only counter when model uses tools
      consecutiveTextOnly = 0;

      // 4. Execute tool calls
      await session.addAssistantMessage(response);

      // Token budget warning (stderr only, fire once)
      if (!tokenWarningIssued && session.isTokenBudgetWarning()) {
        const usage = session.state.tokenUsage.input;
        const max = config.session.maxTotalTokens!;
        console.warn(`[budget] Token budget 80% consumed (${usage} / ${max} input tokens)`);
        tokenWarningIssued = true;
      }

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

        // Context trimming: if the tool has keepLast configured, trim older pairs
        const keepLast = tool.context?.keepLast;
        if (keepLast !== undefined) {
          const before = session.messages.length;
          const trimmed = trimToolContext(session.messages, toolCall.name, keepLast);
          if (trimmed !== session.messages) {
            session.replaceMessages(trimmed);
            console.log(`[trim] ${toolCall.name}: ${before} → ${trimmed.length} messages (keepLast=${keepLast})`);
          }
        }
      }

      // 5a. Malformed JSON counter — detect repeated failures
      const lastResults = session.messages[session.messages.length - 1];
      if (lastResults?.role === "user" && Array.isArray(lastResults.content)) {
        const hasJsonError = (lastResults.content as Array<{ type: string; content?: string }>).some(
          b => b.type === "tool_result" && typeof b.content === "string" && b.content.startsWith("ERROR: Malformed JSON")
        );
        if (hasJsonError) {
          consecutiveMalformedJson++;
          if (consecutiveMalformedJson >= 3) {
            const advisory: Message = {
              role: "user",
              content: "You have failed to produce valid JSON 3 times in a row. Simplify your response — send fewer fields or split into multiple smaller calls.",
            };
            session.messages.push(advisory);
            await store.appendTranscript(session.id, {
              type: "message",
              timestamp: new Date().toISOString(),
              iteration: session.iteration,
              data: advisory,
            });
            consecutiveMalformedJson = 0;
          }
        } else {
          consecutiveMalformedJson = 0;
        }
      }

      // 5b. Loop detection — track tool call signatures
      for (const toolCall of toolUseBlocks) {
        const firstVal = Object.values(toolCall.input)[0];
        const sig = `${toolCall.name}:${typeof firstVal === "string" ? firstVal : JSON.stringify(firstVal)}`;
        recentToolSigs.push(sig);
        if (recentToolSigs.length > 6) recentToolSigs.shift();
      }

      if (recentToolSigs.length >= 3) {
        const last3 = recentToolSigs.slice(-3);
        if (last3[0] === last3[1] && last3[1] === last3[2]) {
          loopWarningCount++;
          if (loopWarningCount >= 2) {
            console.error(`\nLoop detected: tool called identically 6+ times at iteration ${session.iteration}`);
            await session.setPaused("loop_detected");
            await session.forceCheckpoint();
            return;
          }
          // First warning — inject advisory into messages
          const advisory: Message = {
            role: "user",
            content: "WARNING: You appear to be in a loop — the last 3 tool calls produced the same result. Change your approach or accept the current state and move on.",
          };
          session.messages.push(advisory);
          await store.appendTranscript(session.id, {
            type: "message",
            timestamp: new Date().toISOString(),
            iteration: session.iteration,
            data: advisory,
          });
        }
      }

      // 5c. Auto-trim consumed tool results from prior iterations
      const autoTrimmed = autoTrimConsumedResults(session.messages, executor.preservedToolNames());
      if (autoTrimmed !== session.messages) {
        const beforeTokens = session.contextTokens();
        session.replaceMessages(autoTrimmed);
        const afterTokens = session.contextTokens();
        console.log(`[auto-trim] Trimmed consumed results: ${beforeTokens} → ${afterTokens} est. tokens`);
      }

      // 6. Increment iteration, persist state, and checkpoint
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
    } else if (session.isTokenBudgetExhausted()) {
      await session.setPaused("token_budget");
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
  task?: string,
  configPath?: string
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
    session.systemPrompt = buildRouterPrompt({ skills: skillSummaries, task, configPath });
    console.log(
      `Router mode — available skills: ${skillSummaries.map((s) => s.name).join(", ")}`
    );
  } else {
    const skillPath = skillCatalog.get(sessionSkillName)!;
    const skill = await loadSkill(skillPath);
    session.systemPrompt = buildSystemPrompt({ skill, task, configPath });
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
