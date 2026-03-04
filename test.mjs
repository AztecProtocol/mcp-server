#!/usr/bin/env node
/**
 * Simple test script for Aztec MCP Server functionality
 */

import { syncRepos, getStatus } from "./dist/tools/index.js";
import { searchCode, listExamples } from "./dist/utils/search.js";
import { REPOS_DIR } from "./dist/utils/git.js";

async function test() {
  console.log("=== Aztec MCP Server Test ===\n");
  console.log(`Repos directory: ${REPOS_DIR}\n`);

  // Test 1: Check status before sync
  console.log("1. Checking initial status...");
  const initialStatus = await getStatus();
  console.log(`   Repos configured: ${initialStatus.repos.length}`);
  for (const repo of initialStatus.repos) {
    console.log(`   - ${repo.name}: ${repo.cloned ? "cloned" : "not cloned"}`);
  }
  console.log();

  // Test 2: Sync repos (this will take a while)
  console.log("2. Syncing repositories (this may take a few minutes)...");
  const syncResult = await syncRepos({
    version: "v4.0.0-devnet.2-patch.1",
    force: true  // Force re-clone to get all repos at the tag
  });
  console.log(`   Success: ${syncResult.success}`);
  console.log(`   Version: ${syncResult.version}`);
  for (const repo of syncResult.repos) {
    console.log(`   - ${repo.name}: ${repo.status}`);
  }
  console.log();

  // Test 3: Check status after sync
  console.log("3. Checking status after sync...");
  const afterStatus = await getStatus();
  for (const repo of afterStatus.repos) {
    const commit = repo.commit ? ` (${repo.commit})` : "";
    console.log(`   - ${repo.name}: ${repo.cloned ? "cloned" : "not cloned"}${commit}`);
  }
  console.log();

  // Test 4: Search for code
  console.log("4. Searching for 'PrivateSet' in .nr files...");
  const codeResults = searchCode("PrivateSet", { filePattern: "*.nr", maxResults: 5 });
  console.log(`   Found ${codeResults.length} results`);
  for (const result of codeResults.slice(0, 3)) {
    console.log(`   - ${result.file}:${result.line}`);
  }
  console.log();

  // Test 5: List examples
  console.log("5. Listing contract examples...");
  const examples = listExamples();
  console.log(`   Found ${examples.length} examples`);
  for (const example of examples.slice(0, 5)) {
    console.log(`   - ${example.name} (${example.repo})`);
  }
  console.log();

  console.log("=== Tests Complete ===");
}

test().catch(console.error);
