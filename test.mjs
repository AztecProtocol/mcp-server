#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryDirectory = process.env.AZTEC_MCP_REPOS_DIR
  ? undefined
  : mkdtempSync(join(tmpdir(), "aztec-mcp-smoke-"));
if (temporaryDirectory) process.env.AZTEC_MCP_REPOS_DIR = temporaryDirectory;

async function test() {
  const { syncRepos, getStatus, searchAztecDocs } = await import("./dist/tools/index.js");
  const { searchCode, listExamples } = await import("./dist/utils/search.js");
  const { REPOS_DIR } = await import("./dist/utils/git.js");
  const { getLocalVersion } = await import("./dist/utils/version-check.js");
  const version = "v6.0.0-rc.6";

  console.log(`Testing ${version} in ${REPOS_DIR}`);
  const syncResult = await syncRepos({ version });
  assert.equal(syncResult.success, true, syncResult.message);
  assert.equal(syncResult.metadataSafe, true, syncResult.message);
  assert.deepEqual(syncResult.repos.map((repo) => repo.name), ["aztec-node"]);
  assert.equal(await getLocalVersion(), version);
  if (temporaryDirectory) {
    assert.equal(existsSync(join(REPOS_DIR, "aztec-packages")), false);
  }
  console.log(syncResult.message);

  const status = await getStatus();
  assert.equal(status.repos.find((repo) => repo.name === "aztec-node")?.cloned, true);

  const code = searchCode("PrivateSet", { repo: "aztec-node", filePattern: "*.nr", maxResults: 5 });
  assert.ok(code.length > 0, "Expected code search results");
  assert.ok(code.every((result) => result.repo === "aztec-node"));

  const examples = listExamples();
  assert.ok(examples.length > 0, "Expected contract examples");
  assert.ok(examples.every((example) => example.repo === "aztec-node"));

  const docs = await searchAztecDocs({ query: "storage", maxResults: 5 }, null);
  assert.equal(docs.kind, "ripgrep");
  assert.equal(docs.result.success, true, docs.result.message);
  assert.ok(docs.result.results.length > 0, "Expected local documentation search results");
  assert.ok(docs.result.results.every((result) => result.repo === "aztec-node"));

  console.log(`Passed: ${code.length} code matches, ${docs.result.results.length} docs matches, ${examples.length} examples.`);
}

try {
  await test();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
}
