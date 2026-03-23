import { describe, it, expect } from "vitest";
import { OpenAICompatProvider } from "./openai-compat.js";

describe("OpenAICompatProvider", () => {
  it("constructs with defaults", () => {
    const provider = new OpenAICompatProvider();
    expect(provider).toBeTruthy();
  });

  it("constructs with custom baseUrl", () => {
    const provider = new OpenAICompatProvider("http://localhost:8080/v1", "test-key");
    expect(provider).toBeTruthy();
  });

  it("complete method exists", () => {
    const provider = new OpenAICompatProvider();
    expect(typeof provider.complete).toBe("function");
  });

  it("summarize method exists", () => {
    const provider = new OpenAICompatProvider();
    expect(typeof provider.summarize).toBe("function");
  });
});
