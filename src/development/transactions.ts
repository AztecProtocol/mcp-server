import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Jobs, JobFailure, type JobSnapshot, type JobContext } from "./jobs.js";
import { projectProvenance, type ArtifactIdentity } from "./artifacts.js";
import { validateCallInput, type ContractCallInput } from "./contracts.js";
import { SessionError, type SessionService, type SessionSnapshot, type RuntimeProgress, type ProofTelemetry } from "./session.js";
import { classifyReceipt, writeTransactionRecord } from "./transaction-journal.js";

export interface DeploymentArguments {
  sessionId: string;
  buildJobId: string;
  artifactPath: string;
  account: string;
  initializerName?: string;
  arguments: unknown[];
  initialize: boolean;
  timeoutMs?: number;
}

export interface SendArguments extends ContractCallInput {
  sessionId: string;
  timeoutMs?: number;
}

export interface TransactionArtifact {
  path: string;
  contentHash: string;
  provenanceHash?: string;
  contractName?: string;
  classId?: string;
}

export interface SubmissionOutcome {
  address: string;
  txHash?: string;
  registered: boolean;
  submitted: boolean;
  outcome: "submitted" | "preparation-failed" | "submission-rejected" | "unknown-outcome";
  submissionReached: boolean;
  error?: {
    code: string;
    message: string;
  };
}

export interface TransactionReceipt {
  txHash: string;
  status: string;
  executionResult?: string;
  blockNumber?: number;
  blockHash?: string;
  transactionFee?: string;
  error?: string;
  observedAt?: string;
  network?: unknown;
  effects?: unknown;
  events?: unknown;
  source: "node";
  scope: "public";
}

export interface PreparedDeployment {
  preparedId: string;
  address: string;
  artifact: ArtifactIdentity;
  registered: boolean;
}

export interface SubmittedDeployment {
  address: string;
  txHash: string;
  registered: boolean;
  submitted: true;
}

export interface CompletedDeployment {
  address: string;
  registered: boolean;
  published: boolean;
  initialized: boolean;
}
export type TransactionState = "preparing" | "prepared" | "submitting" | "submitted" | "waiting" | "included" | "failed" | "unknown-outcome" | "cancelled-waiting" | "interrupted-before-submission";

export interface TransactionRecord {
  schemaVersion: 1;
  jobId: string;
  kind: "deploy" | "send";
  state: TransactionState;
  createdAt: string;
  updatedAt: string;
  sessionId: string;
  stateDirectory: string;
  projectPath: string;
  networkIdentity: string;
  runtimeIdentity: string;
  proofMode: "fast" | "real";
  proofValidityEstablished: false;
  proofTelemetry?: ProofTelemetry;
  account: string;
  artifact: TransactionArtifact;
  submissionReached?: boolean;
  intent: {
    initialize?: boolean;
    initializerName?: string;
    functionName?: string;
  };
  submissionAttempted: boolean;
  address?: string;
  txHash?: string;
  registered?: boolean;
  receipt?: TransactionReceipt;
  error?: {
    code: string;
    message: string;
  };
}

declare module "./session.js" {
  interface RuntimeOperations {
    "deployment-prepare": {
      input: {
        artifactPath: string;
        expectedContentHash: string;
        provenanceHash: string;
        account: string;
        initializerName?: string;
        arguments: unknown[];
        initialize: boolean;
      };
      output: PreparedDeployment;
    };
    "deployment-submit": {
      input: {
        preparedId: string;
      };
      output: SubmittedDeployment | SubmissionOutcome;
    };
    "deployment-complete": {
      input: {
        preparedId: string;
        txHash: string;
      };
      output: CompletedDeployment;
    };
    "deployment-discard": {
      input: {
        preparedId: string;
      };
      output: {
        discarded: true;
      };
    };
    "transaction-receipt": {
      input: {
        txHash: string;
        includeEffects?: boolean;
      };
      output: TransactionReceipt;
    };
    "send-prepare": {
      input: ContractCallInput & {
        expectedContentHash: string;
      };
      output: {
        preparedId: string;
        address: string;
        artifact: TransactionArtifact;
        registered: boolean;
      };
    };
    "send-submit": {
      input: {
        preparedId: string;
      };
      output: SubmissionOutcome;
    };
    "send-discard": {
      input: {
        preparedId: string;
      };
      output: {
        discarded: true;
      };
    };
  }
}

async function pause(signal: AbortSignal): Promise<void> {
  if (signal.aborted)
    return;
  await new Promise<void>(resolve => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, 500);
    signal.addEventListener("abort", done, { once: true });
  });
}

interface MutationPlan {
  kind: "deploy" | "send";
  account: string;
  artifact: TransactionArtifact;
  intent: TransactionRecord["intent"];
  prepare(): Promise<{
    preparedId: string;
    address: string;
    registered: boolean;
  }>;
  submit(preparedId: string, onProgress: (event: RuntimeProgress) => void): Promise<SubmittedDeployment | SubmissionOutcome>;
  complete(preparedId: string, txHash: string): Promise<{
    address: string;
    registered: boolean;
    published?: boolean;
    initialized?: boolean;
    functionName?: string;
  }>;
  discard(preparedId: string): Promise<unknown>;
}

export class TransactionService {
  private admissions = new Map<string, number>();
  private active = new Map<string, string>();
  constructor(private readonly sessions: Pick<SessionService, "status" | "request">, readonly jobs: Jobs) { }
  activeJobIds(sessionId: string): string[] { return [...this.active].filter(([, id]) => id === sessionId).map(([id]) => id); }
  assertIdle(sessionId: string): void {
    if ((this.admissions.get(sessionId) ?? 0) > 0 || this.activeJobIds(sessionId).length)
      throw new SessionError("session-busy", "A transaction is being admitted or is still active; wait or cancel and reconcile before changing sessions.");
  }
  private async admission<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    this.admissions.set(sessionId, (this.admissions.get(sessionId) ?? 0) + 1);
    try {
      return await work();
    } finally {
      const remaining = (this.admissions.get(sessionId) ?? 1) - 1;
      if (remaining)
        this.admissions.set(sessionId, remaining);
      else
        this.admissions.delete(sessionId);
    }
  }
  async inspect(sessionId: string, txHash: string): Promise<TransactionReceipt> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash))
      throw new SessionError("invalid-transaction-hash", "Provide a 32-byte hexadecimal transaction hash.");
    return this.sessions.request(sessionId, "transaction-receipt", { txHash, includeEffects: true });
  }
  deploy(input: DeploymentArguments): Promise<JobSnapshot> {
    return this.admission(input.sessionId, async () => {
      if (typeof input.initialize !== "boolean" || !Array.isArray(input.arguments))
        throw new SessionError("invalid-deployment", "Specify initialize as a boolean and arguments as an array.");
      if (!/^0x[0-9a-fA-F]{64}$/.test(input.account))
        throw new SessionError("invalid-account", "Select an account from the active session.");
      if (input.initializerName !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.initializerName))
        throw new SessionError("invalid-initializer", "Specify an initializer function name.");
      if (!isAbsolute(input.artifactPath))
        throw new SessionError("invalid-artifact-path", "Select an absolute compiled artifact path.");
      const session = await this.sessions.status(input.sessionId);
      const build = this.jobs.get(input.buildJobId);
      const result = build.result as {
        projectPath?: string;
        selection?: unknown;
        provenanceHash?: string;
        artifacts?: ArtifactIdentity[];
      } | undefined;
      if (build.status !== "completed" || !["compile", "test"].includes(build.kind) || result?.projectPath !== session.projectPath)
        throw new SessionError("invalid-build", "Select a successful build from this session's canonical project.");
      const path = await realpath(input.artifactPath);
      const artifact = result.artifacts?.find(a => a.path === path);
      if (!artifact || createHash("sha256").update(await readFile(path)).digest("hex") !== artifact.contentHash || await projectProvenance(session.projectPath, session.runtime, result.selection) !== artifact.provenanceHash)
        throw new SessionError("stale-artifact", "The selected artifact or its sources, dependencies, toolchain or options changed; compile again.");
      return this.start(session, {
        kind: "deploy", account: input.account, artifact, intent: { initialize: input.initialize, initializerName: input.initializerName },
        prepare: () => this.sessions.request(input.sessionId, "deployment-prepare", { artifactPath: artifact.path, expectedContentHash: artifact.contentHash, provenanceHash: artifact.provenanceHash, account: input.account, initializerName: input.initializerName, arguments: input.arguments, initialize: input.initialize }),
        submit: (preparedId, onProgress) => this.sessions.request(input.sessionId, "deployment-submit", { preparedId }, onProgress),
        complete: (preparedId, txHash) => this.sessions.request(input.sessionId, "deployment-complete", { preparedId, txHash }),
        discard: preparedId => this.sessions.request(input.sessionId, "deployment-discard", { preparedId }),
      }, input.timeoutMs);
    });
  }
  send(input: SendArguments): Promise<JobSnapshot> {
    return this.admission(input.sessionId, async () => {
      validateCallInput(input);
      const session = await this.sessions.status(input.sessionId);
      const inspection = await this.sessions.request(input.sessionId, "contract-inspect", { address: input.address });
      if (!inspection.association || !inspection.node.published ||
          !inspection.wallet.instanceRegistered || !inspection.wallet.artifactRegistered ||
          inspection.association.artifact.classId !== inspection.node.currentClassId) {
        throw new SessionError("missing-registration", "Register a matching deployed contract before sending.");
      }
      const artifact = inspection.association.artifact;
      return this.start(session, {
        kind: "send", account: input.account, artifact, intent: { functionName: input.functionName },
        prepare: () => this.sessions.request(input.sessionId, "send-prepare", { address: input.address, account: input.account, functionName: input.functionName, args: input.args, expectedContentHash: artifact.contentHash }),
        submit: (preparedId, onProgress) => this.sessions.request(input.sessionId, "send-submit", { preparedId }, onProgress),
        complete: async () => ({ address: input.address, registered: true, functionName: input.functionName }),
        discard: preparedId => this.sessions.request(input.sessionId, "send-discard", { preparedId }),
      }, input.timeoutMs);
    });
  }
  private start(session: SessionSnapshot, plan: MutationPlan, timeoutMs?: number): JobSnapshot {
    const job = this.jobs.start(plan.kind, async context => {
      try {
        return await this.run(context, session, plan);
      } finally {
        this.active.delete(context.id);
      }
    }, { timeoutMs });
    this.active.set(job.id, session.sessionId);
    void this.jobs.wait(job.id).finally(() => this.active.delete(job.id));
    return job;
  }
  private async run(context: JobContext, session: SessionSnapshot, plan: MutationPlan) {
    const record: TransactionRecord = {
      schemaVersion: 1, jobId: context.id, kind: plan.kind, state: "preparing",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      sessionId: session.sessionId, stateDirectory: session.stateDirectory, projectPath: session.projectPath,
      networkIdentity: session.networkIdentity, runtimeIdentity: session.runtimeIdentity,
      proofMode: session.proofMode, proofValidityEstablished: false,
      proofTelemetry: session.environment?.proofTelemetry, account: plan.account,
      artifact: plan.artifact, intent: plan.intent, submissionAttempted: false,
    };
    const checkpoint = async (state: TransactionState, patch: Partial<TransactionRecord> = {}) => {
      Object.assign(record, patch, { state, updatedAt: new Date().toISOString() });
      context.phase(state);
      context.record({ ...record, chainTransactionCancelled: false });
      await writeTransactionRecord(record);
    };
    let preparedId: string | undefined;
    try {
      await checkpoint("preparing");
      context.signal.throwIfAborted();
      const prepared = await plan.prepare();
      preparedId = prepared.preparedId;
      await checkpoint("prepared", { address: prepared.address, registered: prepared.registered });
      context.signal.throwIfAborted();
      await checkpoint("submitting", { submissionAttempted: true });
      const submitted = await plan.submit(preparedId, event => {
        record.proofTelemetry = event.proofTelemetry;
        context.phase(event.phase);
        context.record({ ...record, chainTransactionCancelled: false });
      });
      if ("outcome" in submitted && submitted.outcome !== "submitted") {
        await checkpoint(submitted.outcome === "unknown-outcome" ? "unknown-outcome" : "failed", { txHash: submitted.txHash, submissionReached: submitted.submissionReached, error: submitted.error });
        throw new JobFailure(submitted.error?.code ?? submitted.outcome, submitted.error?.message ?? "Transaction did not complete submission.", { ...record, chainTransactionCancelled: false });
      }
      if (!submitted.txHash)
        throw new Error("Submission returned no hash.");
      await checkpoint("submitted", { txHash: submitted.txHash, address: submitted.address, registered: submitted.registered, submissionReached: true });
      while (!context.signal.aborted) {
        await checkpoint("waiting");
        const receipt = await this.sessions.request(session.sessionId, "transaction-receipt", { txHash: submitted.txHash });
        const outcome = classifyReceipt(submitted.txHash, receipt);
        if (outcome === "invalid")
          throw new SessionError("invalid-transaction-receipt", "The node returned incomplete or inconsistent transaction evidence.");
        if (outcome === "dropped" || outcome === "reverted") {
          await checkpoint("failed", { receipt, error: { code: "transaction-failed", message: "Transaction was dropped or reverted; it was not retried." } });
          throw new JobFailure("transaction-failed", record.error!.message, { ...record, chainTransactionCancelled: false });
        }
        if (outcome === "included") {
          await checkpoint("waiting", { receipt });
          const completion = await plan.complete(preparedId, submitted.txHash);
          await checkpoint("included", { receipt, registered: true });
          return {
            ...completion, txHash: submitted.txHash, artifact: plan.artifact, receipt,
            included: true, submitted: true, accountScope: [plan.account],
            proofMode: session.proofMode, proofTelemetry: record.proofTelemetry,
            proofValidityEstablished: false, chainTransactionCancelled: false,
          };
        }
        await pause(context.signal);
      }
      await checkpoint("cancelled-waiting");
      return {
        address: record.address, txHash: record.txHash, submitted: true, included: false,
        registered: record.registered, cancelledWaiting: true,
        proofMode: session.proofMode, proofTelemetry: record.proofTelemetry,
        proofValidityEstablished: false, chainTransactionCancelled: false,
      };
    } catch (error) {
      if (record.state !== "failed" && record.state !== "unknown-outcome") {
        await checkpoint(record.submissionAttempted ? "unknown-outcome" : "failed", {
          error: {
            code: context.signal.aborted ? "waiting-interrupted" : error instanceof SessionError ? error.code : "transaction-preparation-failed",
            message: record.submissionAttempted
              ? "Submission or local waiting was interrupted; inspect the recorded hash or reconcile the job. No automatic retry occurred."
              : "Transaction preparation failed before submission.",
          },
        });
      }
      if (error instanceof JobFailure)
        throw error;
      throw new JobFailure(record.error?.code ?? "transaction-failed", record.error?.message ?? "Transaction failed.", { ...record, chainTransactionCancelled: false });
    } finally {
      if (preparedId)
        await plan.discard(preparedId).catch(() => { });
    }
  }
}
