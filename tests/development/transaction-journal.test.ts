import { mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasUnresolvedSubmission, validateTransactionRecord, readTransactionRecords, writeTransactionRecord } from "../../src/development/transaction-journal.js";
import type { TransactionRecord } from "../../src/development/transactions.js";

const txHash = `0x${"1".repeat(64)}`;
const receipt = { txHash, status: "proposed", executionResult: "success", blockNumber: 4,
  blockHash: `0x${"2".repeat(64)}`, source: "node" as const, scope: "public" as const };
function record(patch: Partial<TransactionRecord> = {}): TransactionRecord {
  return { schemaVersion: 1, jobId: "11111111-1111-1111-1111-111111111111", kind: "deploy", state: "submitted",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), sessionId: "session", stateDirectory: "/project/state",
    projectPath: "/project", networkIdentity: "network", runtimeIdentity: "runtime", proofMode: "fast", proofValidityEstablished: false,
    account: `0x${"3".repeat(64)}`, artifact: { path: "/project/artifact.json", contentHash: "a".repeat(64) },
    intent: { initialize: true }, submissionAttempted: true, txHash, ...patch };
}

describe("durable transaction evidence", () => {
  it("requires actual matching inclusion evidence to resolve a submitted mutation", () => {
    const included = record({ state: "included", receipt });
    expect(() => validateTransactionRecord(included)).not.toThrow();
    expect(hasUnresolvedSubmission(included)).toBe(false);
    const reverted = record({ state: "failed", receipt: { ...receipt, executionResult: "reverted" } });
    expect(() => validateTransactionRecord(reverted)).not.toThrow();
    expect(hasUnresolvedSubmission(reverted)).toBe(false);
  });

  it.each([
    { state: "included", receipt: undefined },
    { state: "included", txHash: undefined, receipt },
    { state: "included", receipt: { ...receipt, blockHash: undefined } },
    { state: "included", receipt: { ...receipt, txHash: `0x${"4".repeat(64)}` } },
    { state: "included", receipt: { ...receipt, executionResult: "reverted" } },
    { state: "included", receipt: { ...receipt, blockNumber: -1 } },
  ])("rejects inconsistent terminal evidence %j", patch => {
    expect(() => validateTransactionRecord({ ...record(), ...patch })).toThrow(/incomplete or inconsistent/);
  });

  it("keeps pending and dropped receipts unresolved", () => {
    for (const status of ["pending", "dropped"]) {
      const value = record({ state: "unknown-outcome", receipt: { txHash, status, source: "node", scope: "public" } });
      expect(() => validateTransactionRecord(value)).not.toThrow();
      expect(hasUnresolvedSubmission(value)).toBe(true);
    }
  });

  it("allows positive evidence that submission was never reached", () => {
    const value = record({ state: "failed", txHash: undefined, submissionReached: false });
    expect(() => validateTransactionRecord(value)).not.toThrow();
    expect(hasUnresolvedSubmission(value)).toBe(false);
  });
});

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function storedRecord() {
  const stateDirectory = await mkdtemp(join(tmpdir(), "mcp-journal-"));
  roots.push(stateDirectory);
  const value = record({ stateDirectory });
  await writeTransactionRecord(value);
  return { value, path: join(stateDirectory, "jobs", `${value.jobId}.json`) };
}

it("reads complete validated records and treats an absent journal as empty", async () => {
  const { value } = await storedRecord();
  expect(await readTransactionRecords(value.stateDirectory)).toEqual([value]);
  expect(await readTransactionRecords(join(value.stateDirectory, "missing"))).toEqual([]);
});

it.each([
  { state: "included", receipt: undefined },
  { jobId: "22222222-2222-2222-2222-222222222222" },
  { stateDirectory: "/another-session" },
  { artifact: { path: "/artifact.json", contentHash: "invalid" } },
])("rejects invalid persisted content or record identity %j", async patch => {
  const { value, path } = await storedRecord();
  await writeFile(path, JSON.stringify({ ...value, ...patch }));
  await expect(readTransactionRecords(value.stateDirectory)).rejects.toMatchObject({ code: "invalid-transaction-journal" });
});

it.each(["directory", "file"])("rejects a journal %s symlink", async target => {
  const { value, path } = await storedRecord();
  const original = target === "file" ? path : join(value.stateDirectory, "jobs");
  const moved = original + ".saved";
  await rename(original, moved);
  await symlink(moved, original);
  await expect(readTransactionRecords(value.stateDirectory)).rejects.toMatchObject({ code: "invalid-transaction-journal" });
});
