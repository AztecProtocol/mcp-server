#!/usr/bin/env node
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ContractService } from "../dist/development/contracts.js";
import { Jobs } from "../dist/development/jobs.js";
import { RecoveryService } from "../dist/development/recovery.js";
import { SessionService } from "../dist/development/session.js";
import { inspectToolchain } from "../dist/development/toolchain.js";
import { readTransactionRecords } from "../dist/development/transaction-journal.js";
import { TransactionService } from "../dist/development/transactions.js";

const [fixturePath, installationRoot, nodeExecutable, nodeUrl, outputPath] = process.argv.slice(2);
if (!fixturePath || !installationRoot || !nodeExecutable || !nodeUrl || !outputPath) {
  throw new Error("Usage: node scripts/validate-transaction-recovery.mjs FIXTURE_JSON INSTALLATION_ROOT NODE_EXECUTABLE NODE_URL OUTPUT_JSON");
}
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const projectPath = await mkdtemp(join(tmpdir(), "aztec-mcp-recovery-live-"));
const artifactPath = join(projectPath, "token.json");
await copyFile(fixture.artifactPath, artifactPath);
const validator = async selection => {
  const report = await inspectToolchain(selection);
  assert.deepEqual(report.diagnostics.filter(diagnostic => diagnostic.code !== "unsupported-runtime"), []);
  return report;
};
const options = { installationRoot, nodeExecutable, nodeUrl, projectPath };
const jobs = new Jobs();
let sessions = new SessionService(validator);
const evidence = { checkedAt: new Date().toISOString(), productionSupported: false, projectPath, address: fixture.address };
try {
  const opened = await sessions.open(options);
  const contracts = new ContractService(sessions);
  const accounts = await sessions.accounts(opened.sessionId);
  const account = fixture.accounts[0];
  evidence.registration = await contracts.register(opened.sessionId, { address: fixture.address, artifactPath });
  const viewInput = { address: fixture.address, functionName: "balance_of_private", args: [account], account };
  evidence.before = await contracts.view(opened.sessionId, viewInput);
  assert.equal(evidence.before.status, "succeeded");
  let submits = 0;
  let interrupted = false;
  const transactions = new TransactionService({
    status: sessions.status.bind(sessions),
    request: async (sessionId, operation, input) => {
      if (operation === "send-submit") submits++;
      if (operation === "transaction-receipt" && !interrupted) {
        interrupted = true;
        const record = (await readTransactionRecords(opened.stateDirectory)).find(item => item.txHash === input.txHash);
        assert(record, "The hash must be durable before first receipt lookup");
        evidence.beforeInterruption = record;
        evidence.killedWorkerPid = opened.environment.workerPid;
        assert(Number.isInteger(evidence.killedWorkerPid) && evidence.killedWorkerPid > 1);
        process.kill(evidence.killedWorkerPid, "SIGKILL");
        await delay(100);
      }
      return sessions.request(sessionId, operation, input);
    },
  }, jobs);
  const job = await transactions.send({ sessionId: opened.sessionId, address: fixture.address,
    functionName: "mint_to_private", args: [account, "1"], account, timeoutMs: 120000 });
  evidence.interruptedJob = await jobs.wait(job.id);
  assert.equal(interrupted, true);
  assert.equal(evidence.interruptedJob.status, "failed");
  evidence.interruptedJournal = (await readTransactionRecords(opened.stateDirectory)).find(record => record.jobId === job.id);
  assert.equal(evidence.interruptedJournal.txHash, evidence.beforeInterruption.txHash);
  assert.equal(evidence.interruptedJournal.submissionAttempted, true);
  assert.equal(submits, 1);
  await sessions.shutdown();
  sessions = new SessionService(validator);
  const reopened = await sessions.open(options);
  evidence.reopenedWorkerPid = reopened.environment.workerPid;
  assert.notEqual(evidence.reopenedWorkerPid, evidence.killedWorkerPid);
  assert.deepEqual(await sessions.accounts(reopened.sessionId), accounts);
  evidence.accountsPreserved = true;
  const restoredContracts = new ContractService(sessions);
  evidence.restored = await restoredContracts.inspect(reopened.sessionId, { address: fixture.address });
  assert.equal(evidence.restored.ready, true);
  assert.equal(evidence.restored.association.artifact.contentHash, evidence.registration.artifact.contentHash);
  let recoverySubmits = 0;
  const recovery = new RecoveryService({ status: sessions.status.bind(sessions), request: (id, operation, input) => {
    if (operation.endsWith("-submit")) recoverySubmits++;
    return sessions.request(id, operation, input);
  } }, new Jobs());
  evidence.persisted = await recovery.list(reopened.sessionId);
  const deadline = Date.now() + 60000;
  do {
    evidence.recovered = await recovery.reconcile(reopened.sessionId, job.id);
    if (evidence.recovered.resolved) break;
    await delay(1000);
  } while (Date.now() < deadline);
  assert.equal(evidence.recovered.outcome, "included");
  assert.equal(evidence.recovered.replayed, false);
  evidence.after = await restoredContracts.view(reopened.sessionId, { ...viewInput, minimumBlock: evidence.recovered.receipt.blockNumber });
  assert.equal(evidence.after.status, "succeeded");
  assert.equal(BigInt(evidence.after.result) - BigInt(evidence.before.result), 1n);
  evidence.submissionCalls = submits;
  evidence.recoverySubmissionCalls = recoverySubmits;
  assert.equal(recoverySubmits, 0);
  await sessions.close(reopened.sessionId);
  evidence.status = "passed";
} finally {
  await jobs.close();
  await sessions.shutdown();
  await writeFile(outputPath, JSON.stringify(evidence, null, 2));
}
console.log(JSON.stringify({ status: evidence.status, outputPath, projectPath }));
