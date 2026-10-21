import type { RuntimeContext } from "./runtime-worker.js";
import type { SubmissionOutcome } from "./transactions.js";

type ObservedSubmission = Omit<SubmissionOutcome, "address" | "registered">;
type SubmittedHash = { txHash: { toString(): string } };
const HEX32 = /^0x[0-9a-fA-F]{64}$/;

export async function observeSubmission(
  context: Pick<RuntimeContext, "node" | "rpcEvidence">,
  submit: () => Promise<SubmittedHash>,
  assertionFor?: (error: unknown) => string | undefined,
): Promise<ObservedSubmission> {
  let submissionReached = false;
  let txHash: string | undefined;
  const original = context.node.sendTx;
  context.rpcEvidence.submissionResponse = undefined;
  context.rpcEvidence.transportFailure = false;
  context.node.sendTx = async (tx: { getTxHash(): { toString(): string } }) => {
    if (submissionReached) throw new Error("A second node submission was blocked.");
    const calculated = tx.getTxHash().toString();
    if (!HEX32.test(calculated)) throw new Error("The transaction hash is invalid.");
    txHash = calculated;
    submissionReached = true;
    return original.call(context.node, tx);
  };
  try {
    const result = await submit();
    if (!submissionReached || !txHash || result.txHash.toString().toLowerCase() !== txHash.toLowerCase()) {
      throw new Error("The SDK did not confirm the observed submission identity.");
    }
    return { txHash, submitted: true, outcome: "submitted", submissionReached: true };
  } catch (error) {
    const assertion = assertionFor?.(error);
    const rejected = submissionReached && context.rpcEvidence.submissionResponse === "rejected";
    const outcome = !submissionReached ? "preparation-failed" : rejected ? "submission-rejected" : "unknown-outcome";
    const code = !submissionReached
      ? context.rpcEvidence.transportFailure ? "node-unavailable" : assertion ? "simulation-failed" : "transaction-preparation-failed"
      : rejected ? "submission-rejected" : "unknown-submission-outcome";
    const message = assertion ? `Contract assertion failed: ${assertion}` : !submissionReached
      ? "The wallet failed before node submission; check proving configuration, node availability, account scope and contract preconditions."
      : rejected ? "The node explicitly rejected the transaction; inspect the retained hash. No retry occurred."
      : "No submission acknowledgement was received; inspect the retained hash. No retry occurred.";
    return { txHash, submitted: false, outcome, submissionReached, error: { code, message } };
  } finally {
    context.node.sendTx = original;
  }
}
