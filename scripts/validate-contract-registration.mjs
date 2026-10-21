#!/usr/bin/env node
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ContractService } from "../dist/development/contracts.js";
import { SessionService } from "../dist/development/session.js";
import { inspectToolchain } from "../dist/development/toolchain.js";

const [fixturePath, installationRoot, nodeExecutable, nodeUrl, outputPath] = process.argv.slice(2);
if (!fixturePath || !installationRoot || !nodeExecutable || !nodeUrl || !outputPath) {
  throw new Error("Usage: node scripts/validate-contract-registration.mjs FIXTURE_JSON INSTALLATION_ROOT NODE_EXECUTABLE NODE_URL OUTPUT_JSON");
}
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const projectPath = await mkdtemp(join(tmpdir(), "aztec-mcp-registration-"));
const artifactPath = join(projectPath, "token.json");
await copyFile(fixture.artifactPath, artifactPath);
const originalBytes = await readFile(artifactPath);
const mismatchPath = join(installationRoot, "node_modules/@aztec-labs/noir-contracts.js/artifacts/token_bridge_contract-TokenBridge.json");
const sessions = new SessionService(async selection => {
  const report = await inspectToolchain(selection);
  assert.deepEqual(report.diagnostics.filter(diagnostic => diagnostic.code !== "unsupported-runtime"), []);
  return report;
});
const contracts = new ContractService(sessions);
const options = { installationRoot, nodeExecutable, nodeUrl, projectPath };
const evidence = { checkedAt: new Date().toISOString(), productionSupported: false, fixture: { address: fixture.address, deployTxHash: fixture.deployTxHash }, projectPath };
async function errorCode(operation) {
  try { await operation(); } catch (error) { return error.code; }
  throw new Error("Expected operation to reject");
}
try {
  const opened = await sessions.open(options);
  evidence.accounts = await sessions.accounts(opened.sessionId);
  evidence.initial = await contracts.inspect(opened.sessionId, { address: fixture.address, artifactPath });
  assert(evidence.initial.problems.includes("missing-registration"));
  evidence.mismatch = await errorCode(() => contracts.register(opened.sessionId, { address: fixture.address, artifactPath: mismatchPath }));
  assert.equal(evidence.mismatch, "artifact-mismatch");
  evidence.first = await contracts.register(opened.sessionId, { address: fixture.address, artifactPath });
  assert.equal(evidence.first.reused, false);
  evidence.repeated = await contracts.register(opened.sessionId, { address: fixture.address, artifactPath });
  assert.equal(evidence.repeated.reused, true);
  evidence.inspected = await contracts.inspect(opened.sessionId, { address: fixture.address });
  assert.equal(evidence.inspected.ready, true);
  const require = createRequire(join(installationRoot, "package.json"));
  const { AztecAddress } = await import(pathToFileURL(require.resolve("@aztec-labs/aztec.js/addresses")).href);
  const unknown = (await AztecAddress.random()).toString();
  evidence.unknown = await contracts.inspect(opened.sessionId, { address: unknown, artifactPath });
  assert(evidence.unknown.problems.includes("unknown-deployment"));
  evidence.unknownRegistration = await errorCode(() => contracts.register(opened.sessionId, { address: unknown, artifactPath }));
  assert.equal(evidence.unknownRegistration, "unknown-deployment");
  evidence.unavailable = await contracts.inspect(opened.sessionId, { address: fixture.address, artifactPath: join(projectPath, "missing.json") });
  assert(evidence.unavailable.problems.includes("artifact-unavailable"));
  await writeFile(artifactPath, Buffer.concat([originalBytes, Buffer.from("\n")]));
  evidence.changed = await errorCode(() => contracts.register(opened.sessionId, { address: fixture.address, artifactPath }));
  assert.equal(evidence.changed, "artifact-changed");
  await writeFile(artifactPath, originalBytes);
  await sessions.close(opened.sessionId);
  const reopened = await sessions.open(options);
  evidence.reopened = await contracts.inspect(reopened.sessionId, { address: fixture.address });
  assert.equal(evidence.reopened.ready, true);
  evidence.reopenedRegistration = await contracts.register(reopened.sessionId, { address: fixture.address, artifactPath });
  assert.equal(evidence.reopenedRegistration.reused, true);
  assert.deepEqual(await sessions.accounts(reopened.sessionId), evidence.accounts);
  evidence.staleSession = await errorCode(() => contracts.inspect(opened.sessionId, { address: fixture.address }));
  assert.equal(evidence.staleSession, "stale-session");
  await sessions.close(reopened.sessionId);
  evidence.status = "passed";
} finally {
  await sessions.shutdown();
  await writeFile(outputPath, JSON.stringify(evidence, null, 2));
}
console.log(JSON.stringify({ status: evidence.status, outputPath, projectPath }));
