import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, open, readdir } from "node:fs/promises";
import type { TransactionRecord } from "./transactions.js";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const INCLUDED = new Set(["proposed", "checkpointed", "proven", "finalized"]);
const STATES = new Set(["preparing", "prepared", "submitting", "submitted", "waiting", "included", "failed", "unknown-outcome", "cancelled-waiting", "interrupted-before-submission"]);
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const matches = (pattern: RegExp, value: unknown): value is string => typeof value === "string" && pattern.test(value);
const timestamp = (value: unknown): boolean => text(value) && Number.isFinite(Date.parse(value));

export class TransactionJournalError extends Error {
  readonly code = "invalid-transaction-journal";
  constructor() { super("The durable transaction record is incomplete or inconsistent."); }
}

export type ReceiptOutcome = "pending" | "dropped" | "included" | "reverted" | "invalid";

export function classifyReceipt(txHash: unknown, receipt: unknown): ReceiptOutcome {
  if (!object(receipt) || !matches(HEX32, txHash) || !matches(HEX32, receipt.txHash) ||
      txHash.toLowerCase() !== receipt.txHash.toLowerCase()) return "invalid";
  if (receipt.status === "pending" || receipt.status === "dropped") return receipt.status;
  if (!INCLUDED.has(receipt.status) || !Number.isSafeInteger(receipt.blockNumber) ||
      receipt.blockNumber < 0 || !matches(HEX32, receipt.blockHash)) return "invalid";
  if (receipt.executionResult === "success") return "included";
  if (receipt.executionResult === "reverted") return "reverted";
  return "invalid";
}

/** Inclusion needs matching transaction identity and concrete block evidence, not a state label. */
export function hasIncludedReceipt(record: Pick<TransactionRecord, "txHash" | "receipt">): boolean {
  const outcome = classifyReceipt(record.txHash, record.receipt);
  return outcome === "included" || outcome === "reverted";
}

/** Shared by recovery and destructive lifecycle admission; malformed terminal evidence fails closed. */
export function validateTransactionRecord(value: unknown): asserts value is TransactionRecord {
  if (!object(value) || value.schemaVersion !== 1 || !matches(UUID, value.jobId) ||
      !["deploy", "send"].includes(value.kind) || !STATES.has(value.state) ||
      !text(value.sessionId) || !text(value.projectPath) || !isAbsolute(value.projectPath) ||
      !text(value.stateDirectory) || !isAbsolute(value.stateDirectory) || !text(value.networkIdentity) || !text(value.runtimeIdentity) ||
      !timestamp(value.createdAt) || !timestamp(value.updatedAt) ||
      !["fast", "real"].includes(value.proofMode) || value.proofValidityEstablished !== false || !matches(HEX32, value.account) ||
      typeof value.submissionAttempted !== "boolean" || (value.submissionReached !== undefined && typeof value.submissionReached !== "boolean") ||
      !object(value.artifact) || !text(value.artifact.path) || !isAbsolute(value.artifact.path) || !matches(SHA256, value.artifact.contentHash) ||
      (value.artifact.provenanceHash !== undefined && !matches(SHA256, value.artifact.provenanceHash)) ||
      !object(value.intent) || (value.txHash !== undefined && !matches(HEX32, value.txHash)) ||
      (value.address !== undefined && !matches(HEX32, value.address)) ||
      (!value.txHash && ["submitted", "waiting", "included", "cancelled-waiting"].includes(value.state)) ||
      (value.txHash && (!value.submissionAttempted || value.submissionReached === false)) ||
      (value.submissionReached === true && !value.submissionAttempted)) throw new TransactionJournalError();
  if (value.receipt !== undefined && classifyReceipt(value.txHash, value.receipt) === "invalid") {
    throw new TransactionJournalError();
  }
  if (value.state === "included" && classifyReceipt(value.txHash, value.receipt) !== "included") {
    throw new TransactionJournalError();
  }
}

/** Call only after structural validation. Dropped/unknown receipts never prove non-submission. */
export function hasUnresolvedSubmission(record: TransactionRecord): boolean {
  return record.submissionAttempted && record.submissionReached !== false && !hasIncludedReceipt(record);
}

export async function writeTransactionRecord(record: TransactionRecord): Promise<void> {
  const directory = join(record.stateDirectory, "jobs");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await realpath(directory) !== directory) throw new TransactionJournalError();
  const temporary = join(directory, `${record.jobId}.${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(record) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, join(directory, `${record.jobId}.json`));
  const parent = await open(directory, "r");
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}

export async function readTransactionRecords(stateDirectory: string): Promise<TransactionRecord[]> {
  const directory = join(stateDirectory, "jobs");
  let names: string[];
  try {
    if (await realpath(directory) !== directory) throw new TransactionJournalError();
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: TransactionRecord[] = [];
  for (const name of names.sort().filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
    const path = join(directory, name);
    if (await realpath(path) !== path) throw new TransactionJournalError();
    let record: unknown;
    try { record = JSON.parse(await readFile(path, "utf8")); }
    catch { throw new TransactionJournalError(); }
    validateTransactionRecord(record);
    if (record.jobId !== name.slice(0, -5) || record.stateDirectory !== stateDirectory) throw new TransactionJournalError();
    records.push(record);
  }
  return records;
}
