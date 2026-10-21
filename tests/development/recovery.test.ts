import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Jobs } from "../../src/development/jobs.js";
import { RecoveryService } from "../../src/development/recovery.js";
import type { TransactionRecord } from "../../src/development/transactions.js";
import { readTransactionRecords, writeTransactionRecord } from "../../src/development/transaction-journal.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const txHash = `0x${"a".repeat(64)}`;

async function fixture(patch: Partial<TransactionRecord> = {}) {
  const projectPath = await mkdtemp(join(tmpdir(), "mcp-recovery-")); roots.push(projectPath);
  const stateDirectory = join(projectPath, ".aztec-mcp", "sessions", "network");
  await mkdir(join(stateDirectory, "contract-artifacts"), { recursive: true });
  const bytes = '{"name":"Original"}';
  const contentHash = hash(bytes);
  await writeFile(join(stateDirectory, "contract-artifacts", `${contentHash}.json`), bytes);
  const record: TransactionRecord = {
    schemaVersion: 1, jobId: randomUUID(), kind: "deploy", state: "prepared",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    sessionId: "previous-session", stateDirectory, projectPath,
    networkIdentity: "network", runtimeIdentity: "runtime", proofMode: "fast", proofValidityEstablished: false,
    account: `0x${"1".repeat(64)}`, artifact: { path: join(projectPath, "removed-source.json"), contentHash, provenanceHash: hash("build") },
    intent: { initialize: true }, submissionAttempted: false, ...patch,
  };
  await writeTransactionRecord(record);
  const snapshot: any = { sessionId: "reopened-session", projectPath, stateDirectory, networkIdentity: "network", runtimeIdentity: "runtime" };
  const receipt = { txHash, status: "proposed", executionResult: "success", blockNumber: 9, blockHash: `0x${"b".repeat(64)}`, source: "node", scope: "public" };
  const sessions: any = { status: vi.fn(async () => snapshot), request: vi.fn(async () => receipt) };
  return { record, snapshot, receipt, sessions, recovery: new RecoveryService(sessions) };
}

describe("interrupted transaction recovery", () => {
  it("rejects included markers lacking valid inclusion evidence before node lookup", async () => {
    const { recovery, record, sessions } = await fixture({ state: "included", submissionAttempted: true, txHash });
    await expect(recovery.reconcile("reopened-session", record.jobId)).rejects.toMatchObject({ code: "invalid-recovery-journal" });
    expect(sessions.request).not.toHaveBeenCalled();
  });
  it("holds lifecycle admission through queued reconciliation and releases it after errors", async () => {
    const { recovery, record } = await fixture();
    const first = recovery.reconcile("reopened-session", record.jobId);
    const second = recovery.reconcile("reopened-session", "invalid");
    const rejected = expect(second).rejects.toMatchObject({ code: "invalid-job-id" });
    expect(() => recovery.assertIdle("reopened-session")).toThrow(/reconciliation/);
    await first;
    await rejected;
    expect(() => recovery.assertIdle("reopened-session")).not.toThrow();
  });
  it("identifies interruption before submission without sending or querying a transaction", async () => {
    const { recovery, record, sessions } = await fixture();
    const result = await recovery.reconcile("reopened-session", record.jobId);
    expect(result).toMatchObject({ outcome: "not-submitted", resolved: true, replayed: false });
    expect(sessions.request).not.toHaveBeenCalled();
    expect((await readTransactionRecords(record.stateDirectory))[0].state).toBe("interrupted-before-submission");
  });

  it("preserves uncertainty between possible submission and durable hash persistence", async () => {
    const { recovery, record, sessions } = await fixture({ state: "submitting", submissionAttempted: true });
    const result = await recovery.reconcile("reopened-session", record.jobId);
    expect(result).toMatchObject({ outcome: "unknown-outcome", resolved: false, replayed: false });
    expect(result.guidance).toContain("Do not resubmit");
    expect(sessions.request).not.toHaveBeenCalled();
    expect((await readTransactionRecords(record.stateDirectory))[0].state).toBe("unknown-outcome");
  });

  it("distinguishes a confirmed failure before broadcast from an uncertain submission attempt", async () => {
    const { recovery, record, sessions } = await fixture({ state: "failed", submissionAttempted: true, submissionReached: false });
    expect(await recovery.reconcile("reopened-session", record.jobId)).toMatchObject({ outcome: "not-submitted", resolved: true });
    expect(sessions.request).not.toHaveBeenCalled();
  });

  it("reconciles a known hash after restart using the saved artifact even when its original source is absent", async () => {
    const { recovery, record, sessions } = await fixture({ state: "cancelled-waiting", submissionAttempted: true, txHash });
    const result = await recovery.reconcile("reopened-session", record.jobId);
    expect(result).toMatchObject({ outcome: "included", resolved: true, replayed: false, proofValidityEstablished: false });
    expect(sessions.request).toHaveBeenCalledExactlyOnceWith("reopened-session", "transaction-receipt", { txHash });
    expect((await readTransactionRecords(record.stateDirectory))[0]).toMatchObject({ state: "included", txHash, receipt: { blockNumber: 9 } });
  });

  it("keeps pending and dropped observations unresolved without resubmitting", async () => {
    const { recovery, record, sessions } = await fixture({ state: "submitted", submissionAttempted: true, txHash });
    sessions.request.mockResolvedValueOnce({ txHash, status: "pending", source: "node", scope: "public" });
    expect(await recovery.reconcile("reopened-session", record.jobId)).toMatchObject({ outcome: "pending", resolved: false });
    sessions.request.mockResolvedValueOnce({ txHash, status: "dropped", source: "node", scope: "public" });
    expect(await recovery.reconcile("reopened-session", record.jobId)).toMatchObject({ outcome: "dropped", resolved: false, replayed: false });
    expect((await readTransactionRecords(record.stateDirectory))[0].state).toBe("unknown-outcome");
    expect(sessions.request.mock.calls.every((call: unknown[]) => call[1] === "transaction-receipt")).toBe(true);
  });

  it.each(["networkIdentity", "runtimeIdentity", "projectPath"])("refuses recovery against another %s", async field => {
    const { recovery, record, sessions, snapshot } = await fixture({ submissionAttempted: true, txHash });
    snapshot[field] = field === "projectPath" ? "/other-project" : "different";
    await expect(recovery.reconcile("reopened-session", record.jobId)).rejects.toMatchObject({ code: "recovery-provenance-mismatch" });
    expect(sessions.request).not.toHaveBeenCalled();
  });

  it("refuses altered artifact snapshots and associations before receipt lookup", async () => {
    const { recovery, record, sessions } = await fixture({ submissionAttempted: true, txHash });
    const artifactPath = join(record.stateDirectory, "contract-artifacts", `${record.artifact.contentHash}.json`);
    await writeFile(artifactPath, "changed");
    await expect(recovery.reconcile("reopened-session", record.jobId)).rejects.toMatchObject({ code: "recovery-artifact-mismatch" });
    expect(sessions.request).not.toHaveBeenCalled();
  });

  it("rejects recovery under a changed contract artifact association", async () => {
    const address = `0x${"2".repeat(64)}`;
    const { recovery, record, sessions } = await fixture({ kind: "send", submissionAttempted: true, txHash, address });
    await mkdir(join(record.stateDirectory, "contract-associations"));
    await writeFile(join(record.stateDirectory, "contract-associations", `${address}.json`), JSON.stringify({ address, artifact: { contentHash: hash("different") } }));
    await expect(recovery.reconcile("reopened-session", record.jobId)).rejects.toMatchObject({ code: "recovery-artifact-mismatch" });
    expect(sessions.request).not.toHaveBeenCalled();
  });

  it("lists only bounded public job identities", async () => {
    const { recovery, record } = await fixture();
    await writeFile(join(record.stateDirectory, "jobs", `${record.jobId}.json`), JSON.stringify({ ...record, unexpectedSecret: "fixture-secret" }));
    const listed = await recovery.list("reopened-session");
    expect(listed.jobs).toHaveLength(1);
    expect(listed.jobs[0].originalSessionId).toBe("previous-session");
    expect(JSON.stringify(listed)).not.toContain("fixture-secret");
  });

  it("does not race a still-running local job or overwrite its journal", async () => {
    const { record, sessions } = await fixture();
    const jobs = new Jobs();
    let release!: () => void;
    const task = new Promise<void>(resolve => { release = resolve; });
    const job = jobs.start("deploy", () => task);
    record.jobId = job.id;
    await writeTransactionRecord(record);
    const before = await readFile(join(record.stateDirectory, "jobs", `${job.id}.json`), "utf8");
    try {
      await expect(new RecoveryService(sessions, jobs).reconcile("reopened-session", job.id)).rejects.toMatchObject({ code: "job-still-active" });
      expect(await readFile(join(record.stateDirectory, "jobs", `${job.id}.json`), "utf8")).toBe(before);
    } finally { release(); await jobs.wait(job.id); }
  });
});

it("allows deployment recovery before its association was recorded but requires one for sends", async () => {
  const address = `0x${"2".repeat(64)}`;
  const deployment = await fixture({ submissionAttempted: true, txHash, address });
  expect(await deployment.recovery.reconcile("reopened-session", deployment.record.jobId)).toMatchObject({ outcome: "included", resolved: true });
  const send = await fixture({ kind: "send", submissionAttempted: true, txHash, address });
  await expect(send.recovery.reconcile("reopened-session", send.record.jobId)).rejects.toMatchObject({ code: "recovery-artifact-mismatch" });
  expect(send.sessions.request).not.toHaveBeenCalled();
});
