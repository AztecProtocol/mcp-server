import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Jobs } from "./jobs.js";
import { SessionError, type SessionService, type SessionSnapshot } from "./session.js";
import type { TransactionReceipt, TransactionRecord } from "./transactions.js";
import { classifyReceipt, readTransactionRecords, writeTransactionRecord, TransactionJournalError } from "./transaction-journal.js";

export type RecoveryOutcome = "not-submitted" | "unknown-outcome" | "pending" | "included" | "reverted" | "dropped";
export interface RecoveryJob {
  jobId: string; kind: "deploy" | "send"; state: TransactionRecord["state"];
  originalSessionId: string; networkIdentity: string; runtimeIdentity: string;
  account: string; artifact: TransactionRecord["artifact"]; address?: string; txHash?: string;
  registered?: boolean; submissionAttempted: boolean; submissionReached?: boolean; updatedAt: string;
}
export interface RecoveryResult {
  sessionId: string; job: RecoveryJob; outcome: RecoveryOutcome; resolved: boolean;
  receipt?: TransactionReceipt; observedAt: string; guidance: string;
  replayed: false; chainTransactionCancelled: false; proofMode: "fast" | "real"; proofValidityEstablished: false;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function validateRecoveryProvenance(record: TransactionRecord, session: SessionSnapshot) {
  if (record.projectPath !== session.projectPath || record.stateDirectory !== session.stateDirectory ||
      record.networkIdentity !== session.networkIdentity || record.runtimeIdentity !== session.runtimeIdentity) {
    throw new SessionError("recovery-provenance-mismatch", "Reopen the original project, network and runtime before reconciling this job.");
  }
}

function summary(record: TransactionRecord): RecoveryJob {
  return {
    jobId: record.jobId, kind: record.kind, state: record.state,
    originalSessionId: record.sessionId, networkIdentity: record.networkIdentity, runtimeIdentity: record.runtimeIdentity,
    account: record.account,
    artifact: { path: record.artifact.path, contentHash: record.artifact.contentHash,
      provenanceHash: record.artifact.provenanceHash, contractName: record.artifact.contractName, classId: record.artifact.classId },
    address: record.address, txHash: record.txHash, registered: record.registered,
    submissionAttempted: record.submissionAttempted, submissionReached: record.submissionReached, updatedAt: record.updatedAt,
  };
}

function deploymentAssociationNotRecorded(record: TransactionRecord, error: unknown): boolean {
  return record.kind === "deploy" && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function readRecoveryRecords(session: SessionSnapshot): Promise<TransactionRecord[]> {
  try { return await readTransactionRecords(session.stateDirectory); }
  catch (error) {
    if (error instanceof TransactionJournalError) {
      throw new SessionError("invalid-recovery-journal", "The durable transaction record is incomplete or inconsistent; it was not replayed.");
    }
    throw error;
  }
}

async function verifyArtifact(record: TransactionRecord) {
  const snapshot = join(record.stateDirectory, "contract-artifacts", `${record.artifact.contentHash}.json`);
  try {
    if (await realpath(snapshot) !== snapshot || (await stat(snapshot)).size > 64 * 1024 * 1024) throw new Error("Invalid snapshot");
    const hash = createHash("sha256").update(await readFile(snapshot)).digest("hex");
    if (hash !== record.artifact.contentHash) throw new Error("Changed snapshot");
  } catch {
    throw new SessionError("recovery-artifact-mismatch", "The original immutable artifact snapshot is unavailable or changed; restore it before reconciling this job.");
  }
  if (record.address) {
    const path = join(record.stateDirectory, "contract-associations", `${record.address}.json`);
    try {
      if (await realpath(path) !== path || (await stat(path)).size > 16384) throw new Error("Invalid association");
      const association = JSON.parse(await readFile(path, "utf8"));
      if (association.address !== record.address || association.artifact?.contentHash !== record.artifact.contentHash) throw new Error("Changed association");
    } catch (error) {
      if (deploymentAssociationNotRecorded(record, error)) return;
      throw new SessionError("recovery-artifact-mismatch", "The contract's persisted artifact association differs from this job; it was not replayed.");
    }
  } else if (record.kind === "send") {
    throw new SessionError("invalid-recovery-journal", "A send record must retain its registered contract address.");
  }
}

export class RecoveryService {
  private queue: Promise<unknown> = Promise.resolve();
  private admitted = new Map<string, number>();
  constructor(private readonly sessions: Pick<SessionService, "status" | "request">, private readonly jobs?: Jobs) {}
  assertIdle(sessionId: string): void {
    if (this.admitted.has(sessionId)) throw new SessionError("recovery-still-active", "Wait for receipt reconciliation to finish before changing this session.");
  }
  private idle(jobId: string) {
    if (!this.jobs) return;
    let job;
    try { job = this.jobs.get(jobId); } catch { return; }
    if (!job.finishedAt) throw new SessionError("job-still-active", "This job is still owned by the current process. Inspect or cancel its local waiting before recovery.");
  }
  async list(sessionId: string): Promise<{ sessionId: string; networkIdentity: string; jobs: RecoveryJob[]; truncated: boolean }> {
    const session = await this.sessions.status(sessionId);
    const records = await readRecoveryRecords(session);
    for (const record of records) validateRecoveryProvenance(record, session);
    records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { sessionId, networkIdentity: session.networkIdentity, jobs: records.slice(0, 100).map(summary), truncated: records.length > 100 };
  }
  reconcile(sessionId: string, jobId: string): Promise<RecoveryResult> {
    this.admitted.set(sessionId, (this.admitted.get(sessionId) ?? 0) + 1);
    const task = this.queue.then(() => this.reconcileOne(sessionId, jobId)).finally(() => {
      const remaining = this.admitted.get(sessionId)! - 1;
      if (remaining) this.admitted.set(sessionId, remaining);
      else this.admitted.delete(sessionId);
    });
    this.queue = task.catch(() => {});
    return task;
  }
  private async reconcileOne(sessionId: string, jobId: string): Promise<RecoveryResult> {
    if (!UUID.test(jobId)) throw new SessionError("invalid-job-id", "Select a durable transaction job identifier from recovery listing.");
    this.idle(jobId);
    const session = await this.sessions.status(sessionId);
    const record = (await readRecoveryRecords(session)).find(candidate => candidate.jobId === jobId);
    if (!record) throw new SessionError("unknown-transaction-job", "No durable transaction record exists in this session for that job.");
    validateRecoveryProvenance(record, session);
    this.idle(jobId);
    let outcome: RecoveryOutcome;
    let resolved = false;
    let guidance: string;
    let receipt: TransactionReceipt | undefined;
    if (!record.txHash) {
      if (!record.submissionAttempted || record.submissionReached === false) {
        outcome = "not-submitted"; resolved = true; record.state = "interrupted-before-submission";
        guidance = "No submission was reached. This job was not replayed; any new operation must be explicitly requested.";
      } else {
        outcome = "unknown-outcome"; record.state = "unknown-outcome";
        guidance = "Submission may have reached the node before a hash was recorded. Do not resubmit; reconcile using node or developer records first.";
      }
    } else {
      await verifyArtifact(record);
      const observed = await this.sessions.request(sessionId, "transaction-receipt", { txHash: record.txHash });
      const receiptOutcome = classifyReceipt(record.txHash, observed);
      if (receiptOutcome === "invalid") {
        throw new SessionError("invalid-recovery-receipt", "The node did not return a recognized receipt for the recorded hash.");
      }
      receipt = { txHash: observed.txHash, status: observed.status, executionResult: observed.executionResult,
        blockNumber: observed.blockNumber, blockHash: observed.blockHash, transactionFee: observed.transactionFee,
        error: observed.error?.slice(0, 512), observedAt: new Date().toISOString(), source: "node", scope: "public" };
      if (receiptOutcome === "pending") {
        outcome = "pending"; record.state = "waiting";
        guidance = "The recorded transaction is pending. Inspect this hash again; no submission was repeated.";
      } else if (receiptOutcome === "dropped") {
        outcome = "dropped"; record.state = "unknown-outcome";
        guidance = "The node currently reports this hash as dropped or unknown. This does not prove it was never submitted; do not resubmit automatically.";
      } else {
        outcome = receiptOutcome;
        resolved = true; record.state = outcome === "included" ? "included" : "failed";
        guidance = outcome === "included"
          ? "The recorded transaction was included. Refresh any verification view through its inclusion block; fast-mode inclusion does not establish proof validity."
          : "The recorded transaction was included but reverted. No retry was attempted.";
      }
      record.receipt = receipt;
    }
    record.updatedAt = new Date().toISOString();
    if (resolved) delete record.error;
    else record.error = { code: outcome, message: guidance };
    await writeTransactionRecord(record);
    return { sessionId, job: summary(record), outcome, resolved, receipt, observedAt: record.updatedAt, guidance,
      replayed: false, chainTransactionCancelled: false, proofMode: record.proofMode, proofValidityEstablished: false };
  }
}
