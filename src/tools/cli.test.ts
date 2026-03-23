import { describe, it, expect } from "vitest";
import { CliToolExecutor, expandTemplates } from "./cli.js";
import type { CliToolDef } from "../types.js";

function echoTool(): CliToolDef {
  return {
    name: "echo_test",
    description: "Echo a message",
    command: "echo",
    args: ["${message}"],
    schema: { message: { type: "string", description: "Message to echo" } },
    timeout: 10,
    idempotent: true,
  };
}

describe("expandTemplates", () => {
  it("expands known keys with URL encoding", () => {
    const result = expandTemplates(
      ["-s", "https://api.com/q=${query}"],
      { query: "hello world" }
    );
    expect(result).toEqual(["-s", "https://api.com/q=hello%20world"]);
  });

  it("leaves unknown ${...} patterns literal", () => {
    const result = expandTemplates(["${unknown}"], { query: "test" });
    expect(result).toEqual(["${unknown}"]);
  });

  it("handles multiple placeholders in one arg", () => {
    const result = expandTemplates(
      ["${a}-${b}"],
      { a: "hello", b: "world" }
    );
    expect(result).toEqual(["hello-world"]);
  });

  it("URL-encodes special characters", () => {
    const result = expandTemplates(["${q}"], { q: "a&b=c" });
    expect(result).toEqual(["a%26b%3Dc"]);
  });

  it("does not expand ${...} in values (no recursion)", () => {
    const result = expandTemplates(["${q}"], { q: "${PATH}" });
    expect(result).toEqual(["%24%7BPATH%7D"]); // URL-encoded, not expanded
  });

  it("handles empty input", () => {
    const result = expandTemplates(["${q}"], {});
    expect(result).toEqual(["${q}"]);
  });

  it("handles no placeholders", () => {
    const result = expandTemplates(["-s", "--max-time", "30"], { q: "test" });
    expect(result).toEqual(["-s", "--max-time", "30"]);
  });
});

describe("CliToolExecutor", () => {
  it("registers tool with allowed command", () => {
    const executor = new CliToolExecutor(["echo"], 120);
    executor.register(echoTool());
    expect(executor.resolve("echo_test")).toBeTruthy();
  });

  it("throws when registering tool with disallowed command", () => {
    const executor = new CliToolExecutor(["echo"], 120);
    const tool = { ...echoTool(), command: "rm" };
    expect(() => executor.register(tool)).toThrow("not in the allowed");
  });

  it("generates correct tool schemas", () => {
    const executor = new CliToolExecutor(["echo"], 120);
    executor.register(echoTool());
    const schemas = executor.schemas();

    expect(schemas).toHaveLength(1);
    expect(schemas[0].name).toBe("echo_test");
    expect(schemas[0].input_schema.type).toBe("object");
    expect(schemas[0].input_schema.properties).toHaveProperty("message");
    expect(schemas[0].input_schema.required).toContain("message");
  });

  it("executes echo command and captures stdout", async () => {
    const executor = new CliToolExecutor(["echo"], 120);
    executor.register(echoTool());
    const result = await executor.execute("echo_test", { message: "hello" });
    expect(result.trim()).toBe("hello");
  });

  it("returns error for non-zero exit code", async () => {
    const executor = new CliToolExecutor(["false"], 120);
    const tool: CliToolDef = {
      name: "fail_test",
      description: "Always fails",
      command: "false",
      args: [],
      schema: {},
      timeout: 10,
      idempotent: true,
    };
    executor.register(tool);
    const result = await executor.execute("fail_test", {});
    expect(result).toContain("ERROR");
  });

  it("throws for unknown tool name", async () => {
    const executor = new CliToolExecutor(["echo"], 120);
    await expect(executor.execute("nonexistent", {})).rejects.toThrow(
      "Unknown tool"
    );
  });

  it("handles timeout", async () => {
    const executor = new CliToolExecutor(["sleep"], 120);
    const tool: CliToolDef = {
      name: "sleep_test",
      description: "Sleep forever",
      command: "sleep",
      args: ["60"],
      schema: {},
      timeout: 1, // 1 second timeout
      idempotent: true,
    };
    executor.register(tool);
    const result = await executor.execute("sleep_test", {});
    expect(result).toContain("ERROR: timeout");
  });

  it("registerAll registers multiple tools", () => {
    const executor = new CliToolExecutor(["echo", "cat"], 120);
    const tool1 = echoTool();
    const tool2: CliToolDef = {
      name: "cat_test",
      description: "Cat a file",
      command: "cat",
      args: ["${file}"],
      schema: { file: { type: "string" } },
      timeout: 10,
      idempotent: true,
    };
    executor.registerAll([tool1, tool2]);
    expect(executor.schemas()).toHaveLength(2);
  });
});
