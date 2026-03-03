import { describe, it, expect } from "vitest";
import {
  formatSyncResult,
  formatStatus,
  formatSearchResults,
  formatExamplesList,
  formatExampleContent,
  formatFileContent,
} from "../../src/utils/format.js";

describe("formatSyncResult", () => {
  it("shows checkmark for success", () => {
    const result = formatSyncResult({
      success: true,
      message: "All good",
      version: "v1.0.0",
      repos: [{ name: "repo1", status: "Cloned repo1" }],
    });
    expect(result).toContain("✓ Sync completed");
    expect(result).toContain("Version: v1.0.0");
  });

  it("shows warning icon for failure", () => {
    const result = formatSyncResult({
      success: false,
      message: "Some failed",
      version: "v1.0.0",
      repos: [],
    });
    expect(result).toContain("⚠ Sync completed with errors");
  });

  it("shows per-repo icons based on error in status", () => {
    const result = formatSyncResult({
      success: false,
      message: "Mixed",
      version: "v1.0.0",
      repos: [
        { name: "good", status: "Cloned good" },
        { name: "bad", status: "Error: something failed" },
      ],
    });
    expect(result).toContain("✓ good");
    expect(result).toContain("✗ bad");
  });
});

describe("formatStatus", () => {
  it("includes header text and repos dir", () => {
    const result = formatStatus({
      reposDir: "/path/to/repos",
      repos: [],
    });
    expect(result).toContain("Aztec MCP Server Status");
    expect(result).toContain("Repos directory: /path/to/repos");
  });

  it("shows icons for cloned/uncloned repos", () => {
    const result = formatStatus({
      reposDir: "/repos",
      repos: [
        { name: "cloned-repo", description: "Desc1", cloned: true, commit: "abc1234" },
        { name: "uncloned-repo", description: "Desc2", cloned: false },
      ],
    });
    expect(result).toContain("✓ cloned-repo (abc1234)");
    expect(result).toContain("○ uncloned-repo");
  });

  it('shows "No repositories cloned" message when none cloned', () => {
    const result = formatStatus({
      reposDir: "/repos",
      repos: [
        { name: "repo1", description: "Desc", cloned: false },
      ],
    });
    expect(result).toContain("No repositories cloned");
  });

  it("displays sync metadata when present", () => {
    const result = formatStatus({
      reposDir: "/repos",
      repos: [],
      syncMetadata: {
        mcpVersion: "1.5.0",
        syncedAt: "2025-01-01T00:00:00.000Z",
        aztecVersion: "v1.0.0",
      },
    });
    expect(result).toContain("Last synced: 2025-01-01T00:00:00.000Z");
    expect(result).toContain("MCP server version: 1.5.0");
    expect(result).toContain("Aztec version: v1.0.0");
  });

  it("omits sync metadata lines when not present", () => {
    const result = formatStatus({
      reposDir: "/repos",
      repos: [],
    });
    expect(result).not.toContain("Last synced");
    expect(result).not.toContain("MCP server version");
    expect(result).not.toContain("Aztec version");
  });
});

describe("formatSearchResults", () => {
  it("returns early on failure", () => {
    const result = formatSearchResults({
      success: false,
      results: [],
      message: "Not cloned",
    });
    expect(result).toContain("Not cloned");
    expect(result).not.toContain("```");
  });

  it("returns early on empty results", () => {
    const result = formatSearchResults({
      success: true,
      results: [],
      message: "No matches",
    });
    expect(result).toContain("No matches");
    expect(result).not.toContain("```");
  });

  it("formats file:line in bold with code fences", () => {
    const result = formatSearchResults({
      success: true,
      results: [
        { file: "repo/src/main.nr", line: 10, content: "fn main() {", repo: "repo" },
      ],
      message: "Found 1 match",
    });
    expect(result).toContain("**repo/src/main.nr:10**");
    expect(result).toContain("```");
    expect(result).toContain("fn main() {");
  });
});

describe("formatExamplesList", () => {
  it("groups by repo with bold headers", () => {
    const result = formatExamplesList({
      success: true,
      examples: [
        { path: "p1", name: "token", repo: "aztec-examples", type: "contract" },
        { path: "p2", name: "escrow", repo: "aztec-packages", type: "contract" },
      ],
      message: "Found 2",
    });
    expect(result).toContain("**aztec-examples:**");
    expect(result).toContain("**aztec-packages:**");
    expect(result).toContain("  - token");
    expect(result).toContain("  - escrow");
  });

  it("returns message on failure", () => {
    const result = formatExamplesList({
      success: false,
      examples: [],
      message: "No repos cloned",
    });
    expect(result).toContain("No repos cloned");
  });
});

describe("formatExampleContent", () => {
  it("returns message on failure", () => {
    const result = formatExampleContent({
      success: false,
      message: "Not found",
    });
    expect(result).toBe("Not found");
  });

  it("returns noir code fence on success", () => {
    const result = formatExampleContent({
      success: true,
      example: { name: "token", repo: "aztec-examples", path: "p", type: "contract" },
      content: "fn main() {}",
      message: "Read token",
    });
    expect(result).toContain("```noir");
    expect(result).toContain("fn main() {}");
    expect(result).toContain("**token** (aztec-examples)");
  });
});

describe("formatFileContent", () => {
  it("returns message on failure", () => {
    const result = formatFileContent({
      success: false,
      message: "File not found",
    });
    expect(result).toBe("File not found");
  });

  it("returns raw content on success", () => {
    const result = formatFileContent({
      success: true,
      content: "raw file content here",
      message: "Read file",
    });
    expect(result).toBe("raw file content here");
  });
});
