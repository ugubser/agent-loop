import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  loadDefaultPrompts,
  loadPromptsFile,
  mergePrompts,
  validatePrompts,
  resolvePrompts,
  getPrompt,
  getThreshold,
  format,
} from "./prompts.js";

describe("prompts: defaults file", () => {
  it("loads the canonical config.prompts.default.yaml without error", () => {
    const base = loadDefaultPrompts();
    expect(base).toBeTypeOf("object");
    expect(base.identities).toBeTypeOf("object");
    expect(base.nudges).toBeTypeOf("object");
    expect(base.markers).toBeTypeOf("object");
    expect(base.compaction).toBeTypeOf("object");
    expect(base.thresholds).toBeTypeOf("object");
  });

  it("validates as a complete PromptsConfig", () => {
    const base = loadDefaultPrompts();
    expect(() => validatePrompts(base)).not.toThrow();
  });
});

describe("prompts: mergePrompts", () => {
  it("returns base unchanged when override is undefined", () => {
    const base = { a: 1, b: { c: 2 } };
    expect(mergePrompts(base, undefined)).toEqual(base);
  });

  it("overrides primitive values", () => {
    const base = { a: 1, b: 2 };
    const override = { a: 99 };
    expect(mergePrompts(base, override)).toEqual({ a: 99, b: 2 });
  });

  it("recursively merges nested objects", () => {
    const base = { nudges: { foo: "x", bar: "y" } };
    const override = { nudges: { foo: "z" } };
    expect(mergePrompts(base, override)).toEqual({
      nudges: { foo: "z", bar: "y" },
    });
  });

  it("arrays in override replace arrays in base", () => {
    const base = { list: [1, 2, 3] };
    const override = { list: [9] };
    expect(mergePrompts(base, override)).toEqual({ list: [9] });
  });

  it("does not mutate the base object", () => {
    const base: Record<string, unknown> = { a: { b: 1 } };
    const override = { a: { b: 2 } };
    const result = mergePrompts(base, override);
    expect((base.a as Record<string, unknown>).b).toBe(1);
    expect((result.a as Record<string, unknown>).b).toBe(2);
  });
});

describe("prompts: validatePrompts", () => {
  it("throws with the list of missing keys", () => {
    const incomplete = {
      identities: { base: "x" },
      // missing identities.router and everything else
    };
    expect(() => validatePrompts(incomplete)).toThrow(/identities\.router/);
  });

  it("accepts a config that has every required key", () => {
    const complete = loadDefaultPrompts();
    expect(() => validatePrompts(complete)).not.toThrow();
  });
});

describe("prompts: resolvePrompts", () => {
  it("returns the validated defaults when no override is given", () => {
    const result = resolvePrompts(undefined);
    expect(result.identities.base).toContain("autonomous agent");
    expect(result.thresholds.empty_response_max_attempts).toBe(5);
  });

  it("layers an inline-object override on top of defaults", () => {
    const result = resolvePrompts({
      identities: { base: "OVERRIDE IDENTITY" },
    });
    expect(result.identities.base).toBe("OVERRIDE IDENTITY");
    expect(result.identities.router).toContain("multiple skills"); // default preserved
    expect(result.thresholds.empty_response_max_attempts).toBe(5); // default preserved
  });

  it("loads an override file by path and merges it", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prompts-test-"));
    try {
      const overridePath = path.join(tmpDir, "override.yaml");
      fs.writeFileSync(
        overridePath,
        "thresholds:\n  empty_response_max_attempts: 99\n"
      );
      const result = resolvePrompts(overridePath);
      expect(result.thresholds.empty_response_max_attempts).toBe(99);
      expect(result.thresholds.text_only_max_attempts).toBe(3); // default
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("throws when an override file does not exist", () => {
    expect(() => resolvePrompts("/nonexistent/path.yaml")).toThrow(/not found/);
  });
});

describe("prompts: getPrompt / getThreshold", () => {
  const prompts = resolvePrompts(undefined);

  it("getPrompt resolves dotted paths to string values", () => {
    expect(getPrompt(prompts, "identities.base")).toContain("autonomous agent");
    expect(getPrompt(prompts, "markers.truncation")).toContain("TRUNCATED");
  });

  it("getPrompt throws for missing paths", () => {
    expect(() => getPrompt(prompts, "identities.missing")).toThrow();
  });

  it("getThreshold returns the numeric value", () => {
    expect(getThreshold(prompts, "empty_response_max_attempts")).toBe(5);
    expect(getThreshold(prompts, "compaction_hard_ratio")).toBe(0.9);
  });
});

describe("prompts: format", () => {
  it("replaces {placeholder} with values", () => {
    expect(format("Hello {name}, you have {n} messages", { name: "Alice", n: 3 })).toBe(
      "Hello Alice, you have 3 messages"
    );
  });

  it("leaves unknown placeholders intact", () => {
    expect(format("Hi {known} and {unknown}", { known: "X" })).toBe(
      "Hi X and {unknown}"
    );
  });

  it("handles numeric values", () => {
    expect(format("Count: {n}", { n: 42 })).toBe("Count: 42");
  });

  it("returns the template unchanged when no placeholders", () => {
    expect(format("nothing here", { x: "y" })).toBe("nothing here");
  });
});
