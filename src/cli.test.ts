import { describe, it, expect } from "vitest";
import { loadConfig } from "./cli.js";

describe("loadConfig", () => {
  it("returns defaults when config file not found", () => {
    const config = loadConfig("/nonexistent/config.yaml");
    expect(config.model.provider).toBe("anthropic");
    expect(config.session.timeout).toBe(21600);
    expect(config.persistence.dir).toBe("./sessions");
    expect(config.tools.cli.allowedCommands).toContain("curl");
  });

  it("has correct default checkpoint interval", () => {
    const config = loadConfig("/nonexistent/config.yaml");
    expect(config.session.checkpointInterval).toBe(5);
  });

  it("has correct default max context", () => {
    const config = loadConfig("/nonexistent/config.yaml");
    expect(config.session.maxContext).toBe(200000);
  });
});
