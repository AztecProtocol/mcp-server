import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

const directory = mkdtempSync(join(tmpdir(), "aztec-mcp-search-test-"));
vi.stubEnv("AZTEC_MCP_REPOS_DIR", directory);
const { searchCode, searchDocs, listExamples, getResultPriority } = await import("../../src/utils/search.js");
const { getDocsSource, getActiveRepoNames } = await import("../../src/utils/sources.js");
const { lookupError, clearErrorCache } = await import("../../src/utils/error-lookup.js");
const { searchAztecDocs } = await import("../../src/tools/search.js");
const repos = join(directory, "repos");
const version = "v6.0.0-rc.6";
const commit = "b".repeat(40);
const snapshot = "aztec-node/docs/developer_versioned_docs/version-v6.0.0-rc.6";

function file(path: string, contents: string) {
  const full = join(repos, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
}
function metadata(extra: object = {}) {
  file(".sync-metadata.json", JSON.stringify({
    mcpVersion: "1.6.0", syncedAt: "", aztecVersion: version,
    repositories: { "aztec-node": commit }, ...extra,
  }));
}

beforeAll(() => {
  file("aztec-node/noir-projects/noir-contracts/token/src/main.nr", "contract Token { fn transfer() {} }");
  file("aztec-node/yarn-project/aztec.js/src/index.ts", "export function transfer() {}");
  file("aztec-node/docs/docs-developers/docs/tutorials/token.md", "Current token tutorial");
  file("aztec-node/docs/developer_versioned_docs/version-v5.2.0/tutorials/token.md", "Stale token tutorial");
  file("aztec-packages/yarn-project/old.ts", "export function transfer() {}");
  file("aztec-examples/stale/src/main.nr", "contract Stale { fn transfer() {} }");
  file("aztec-packages-docs/docs/old.md", "Stale token tutorial");
  file("aztec-node/.git/fixture", "");
  file("aztec-node/yarn-project/stdlib/src/tx/validator/error_texts.ts",
    "export const TX_ERROR_V6_FIXTURE = 'v6 fixture rejection';");
  file("aztec-packages/l1-contracts/src/core/libraries/Errors.sol", "error StaleFixtureError();");
});
beforeEach(() => {
  metadata();
  clearErrorCache();
  rmSync(join(repos, snapshot), { recursive: true, force: true });
});
afterAll(() => { rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); });

describe("split checkout searches with real files", () => {
  it("searches only active sources even when older clones remain on disk", () => {
    const results = searchCode("transfer", { filePattern: "*.{nr,ts}" });
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.repo === "aztec-node")).toBe(true);
    expect(searchCode("transfer", { repo: "aztec-packages", filePattern: "*.ts" })).toEqual([]);
  });

  it("lists and ranks contracts and SDK sources from the node checkout", () => {
    expect(listExamples().map((example) => [example.repo, example.name])).toEqual([["aztec-node", "token"]]);
    expect(getResultPriority({ repo: "aztec-node", file: "aztec-node/yarn-project/aztec.js/src/index.ts", content: "" })).toBe(1);
  });

  it("uses unversioned docs at the pinned commit instead of an unrelated snapshot", async () => {
    const results = searchDocs("token", { section: "tutorials" });
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain("Current");
    expect(getDocsSource().notice).toContain("No exact v6.0.0-rc.6");
    const response = await searchAztecDocs({ query: "token" }, null);
    expect(response.kind).toBe("ripgrep");
    if (response.kind === "ripgrep") {
      expect(response.result.success).toBe(true);
      expect(response.result.message).toContain(commit);
    }
  });

  it("prefers an exact snapshot when one exists", () => {
    file(`${snapshot}/tutorials/token.md`, "Exact token tutorial");
    expect(searchDocs("token").map((result) => result.content)).toEqual(["Exact token tutorial"]);
    expect(getDocsSource().notice).toContain("Documentation snapshot v6.0.0-rc.6");
  });

  it("reads v6 TX errors without parsing a stale optional protocol checkout", () => {
    expect(lookupError("v6 fixture rejection").catalogMatches.some((match) => match.entry.name === "TX_ERROR_V6_FIXTURE")).toBe(true);
    expect(lookupError("StaleFixtureError").catalogMatches.some((match) => match.entry.name === "StaleFixtureError")).toBe(false);
  });

  it("includes explicitly enabled protocol sources", () => {
    metadata({ repositories: { "aztec-node": commit, "aztec-packages": "a".repeat(40) } });
    expect(searchCode("transfer", { filePattern: "*.ts" }).map((result) => result.repo)).toContain("aztec-packages");
  });

  it("excludes the v6 node checkout after a completed downgrade", () => {
    metadata({ aztecVersion: "v4.3.0", repositories: undefined });
    const results = searchCode("transfer", { filePattern: "*.ts" });
    expect(results.map((result) => result.repo)).toEqual(["aztec-packages"]);
  });

  it("blocks searches after an interrupted migration", () => {
    metadata({ pendingVersion: "v6.0.0-rc.7" });
    expect(() => getActiveRepoNames()).toThrow("Sync for v6.0.0-rc.7 is incomplete");
    expect(() => searchDocs("token")).toThrow("incomplete");
    expect(() => listExamples()).toThrow("incomplete");
  });
});
