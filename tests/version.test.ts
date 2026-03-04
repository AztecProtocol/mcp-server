import { describe, it, expect } from "vitest";
import { MCP_VERSION } from "../src/version.js";

describe("MCP_VERSION", () => {
  it("is a valid semver string", () => {
    expect(MCP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("matches package.json version", async () => {
    const { createRequire } = await import("module");
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json");
    expect(MCP_VERSION).toBe(pkg.version);
  });
});
