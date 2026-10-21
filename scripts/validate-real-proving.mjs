import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { createDevelopmentBoundary } from "../dist/development/index.js";
import { inspectToolchain } from "../dist/development/toolchain.js";

const [configurationPath, outputPath] = process.argv.slice(2);
if (!configurationPath || !outputPath) throw new Error("Usage: node scripts/validate-real-proving.mjs CONFIG.json EVIDENCE.json");
const configuration = JSON.parse(await readFile(configurationPath, "utf8"));
const { installationRoot, nodeExecutable, nodeUrl, projectPath, proving, contract } = configuration;
const selection = { installationRoot, nodeExecutable, nodeUrl, projectPath };
const report = { check: "explicit-real-proving", startedAt: new Date().toISOString(), candidateHarness: true, phases: [] };
const validateRuntime = async input => {
  const runtime = await inspectToolchain(input);
  assert.deepEqual(runtime.diagnostics.filter(item => item.code !== "unsupported-runtime"), []);
  return runtime;
};
const boundary = createDevelopmentBoundary({ validateRuntime });
const server = await createServer({ developmentEnabled: true, loadDevelopment: async () => boundary });
const client = new Client({ name: "explicit-real-proving-check", version: "1.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport); await client.connect(clientTransport);
const call = async (name, args) => {
  const response = await client.callTool({ name, arguments: args });
  if (response.isError) throw new Error(JSON.stringify(response.structuredContent));
  return response.structuredContent;
};
try {
  const missing = await client.callTool({ name: "aztec_dev_session", arguments: { operation: "open", ...selection, proofMode: "real" } });
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent.error.code, "proving-configuration-required");
  report.missingConfigurationRejected = true;
  const opened = await call("aztec_dev_session", { operation: "open", ...selection, proofMode: "real", proving });
  assert.equal(opened.proverEnabled, true); report.session = opened;
  const modeChange = await client.callTool({ name: "aztec_dev_session", arguments: { operation: "open", ...selection, proofMode: "fast" } });
  assert.equal(modeChange.isError, true); assert.equal(modeChange.structuredContent.error.code, "session-already-open");
  report.inPlaceModeChangeRejected = true;
  await call("aztec_dev_contract", { operation: "register", sessionId: opened.sessionId, address: contract.address, artifactPath: contract.artifactPath });
  const start = performance.now();
  const submitted = await call("aztec_dev_contract", { operation: "send", sessionId: opened.sessionId, address: contract.address, functionName: contract.functionName, args: contract.args, account: contract.account, timeoutMs: 900000 });
  let job;
  for (;;) {
    job = await call("aztec_dev_job", { operation: "status", jobId: submitted.id });
    if (!report.phases.includes(job.phase)) report.phases.push(job.phase);
    if (job.finishedAt) break;
    if (performance.now() - start > 920000) throw new Error("Real-proving integration deadline exceeded");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  report.jobDurationMs = performance.now() - start; report.job = job;
  assert.equal(job.status, "completed"); assert.equal(job.result.proofMode, "real");
  assert.equal(job.result.proofValidityEstablished, false); assert.equal(job.result.included, true);
  assert.ok(report.phases.includes("proving"));
  const status = await call("aztec_dev_session", { operation: "status", sessionId: opened.sessionId });
  report.realTelemetry = status.environment.proofTelemetry;
  assert.ok(report.realTelemetry.realProofCompletions >= 1);
  assert.ok(report.realTelemetry.asyncBackendInitializations >= 1);
  assert.equal(report.realTelemetry.blockedRealProofRequests, 0);
  const fast = await call("aztec_dev_session", { operation: "switch", sessionId: opened.sessionId, ...selection, proofMode: "fast" });
  assert.notEqual(fast.sessionId, opened.sessionId); assert.equal(fast.proverEnabled, false);
  report.fastTelemetry = fast.environment.proofTelemetry;
  assert.equal(report.fastTelemetry.realProofRequests, 0); assert.equal(report.fastTelemetry.srsInitializationRequests, 0);
  assert.equal(report.fastTelemetry.asyncBackendInitializations, 1); // Required SDK Poseidon hashing singleton.
  report.fastModeRestoredThroughLifecycle = true;
  await call("aztec_dev_session", { operation: "close", sessionId: fast.sessionId });
  report.status = "passed";
} catch (error) { report.status = "failed"; report.error = error.message; process.exitCode = 1; }
finally {
  await server.close(); await client.close(); report.finishedAt = new Date().toISOString();
  await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, outputPath, phases: report.phases, realTelemetry: report.realTelemetry }));
}
