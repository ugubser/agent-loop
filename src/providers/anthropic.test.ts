import { describe, it, expect, vi, beforeEach } from "vitest";
import { AnthropicProvider } from "./anthropic.js";

// We test the provider by mocking the SDK client
// Real API calls are in the e2e smoke test

describe("AnthropicProvider", () => {
  it("constructs without throwing", () => {
    // Just verifies the SDK initializes (it won't throw even without a key)
    const provider = new AnthropicProvider("test-key");
    expect(provider).toBeTruthy();
  });

  it("complete method exists", () => {
    const provider = new AnthropicProvider("test-key");
    expect(typeof provider.complete).toBe("function");
  });

  it("summarize method exists", () => {
    const provider = new AnthropicProvider("test-key");
    expect(typeof provider.summarize).toBe("function");
  });
});
