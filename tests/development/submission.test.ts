import { describe, expect, it, vi } from "vitest";
import { observeSubmission } from "../../src/development/submission.js";

const txHash = `0x${"1".repeat(64)}`;
const tx = { getTxHash: () => ({ toString: () => txHash }) };
const result = { txHash: { toString: () => txHash } };
function fixture() {
  const sendTx = vi.fn(async (_tx: unknown) => undefined);
  const context = { node: { sendTx }, rpcEvidence: { submissionResponse: undefined as "accepted" | "rejected" | undefined, transportFailure: false } };
  return { context, sendTx };
}

describe("shared submission evidence", () => {
  it("observes exactly one acknowledged broadcast and restores the public method", async () => {
    const { context, sendTx } = fixture();
    const observed = await observeSubmission(context, async () => { await context.node.sendTx(tx); return result; });
    expect(observed).toMatchObject({ txHash, submitted: true, submissionReached: true, outcome: "submitted" });
    expect(sendTx).toHaveBeenCalledExactlyOnceWith(tx);
    expect(context.node.sendTx).toBe(sendTx);
  });

  it.each(["proof generation failed", "proving cancelled"])("positively records %s before broadcast", async message => {
    const { context, sendTx } = fixture();
    const observed = await observeSubmission(context, async () => { throw new Error(message); });
    expect(observed).toMatchObject({ submitted: false, submissionReached: false, outcome: "preparation-failed" });
    expect(observed.txHash).toBeUndefined();
    expect(sendTx).not.toHaveBeenCalled();
    expect(context.node.sendTx).toBe(sendTx);
  });

  it("retains a calculated hash when the submission acknowledgement is lost", async () => {
    const { context, sendTx } = fixture();
    sendTx.mockImplementation(async () => { context.rpcEvidence.transportFailure = true; throw new Error("connection lost"); });
    const observed = await observeSubmission(context, async () => { await context.node.sendTx(tx); return result; });
    expect(observed).toMatchObject({ txHash, submitted: false, submissionReached: true, outcome: "unknown-outcome" });
    expect(sendTx).toHaveBeenCalledTimes(1);
  });

  it("distinguishes an explicit RPC rejection without losing its hash or resubmitting", async () => {
    const { context, sendTx } = fixture();
    sendTx.mockImplementation(async () => { context.rpcEvidence.submissionResponse = "rejected"; throw new Error("rejected"); });
    const observed = await observeSubmission(context, async () => { await context.node.sendTx(tx); return result; });
    expect(observed).toMatchObject({ txHash, submitted: false, submissionReached: true, outcome: "submission-rejected" });
    expect(sendTx).toHaveBeenCalledTimes(1);
  });

  it("blocks a second SDK submission attempt and retains the original identity", async () => {
    const { context, sendTx } = fixture();
    const observed = await observeSubmission(context, async () => {
      await context.node.sendTx(tx); await context.node.sendTx(tx); return result;
    });
    expect(observed).toMatchObject({ txHash, submissionReached: true, outcome: "unknown-outcome" });
    expect(sendTx).toHaveBeenCalledTimes(1);
  });

  it("does not replace the observed identity with a mismatched SDK result", async () => {
    const { context, sendTx } = fixture();
    const observed = await observeSubmission(context, async () => {
      await context.node.sendTx(tx); return { txHash: { toString: () => `0x${"2".repeat(64)}` } };
    });
    expect(observed).toMatchObject({ txHash, submitted: false, outcome: "unknown-outcome" });
    expect(sendTx).toHaveBeenCalledTimes(1);
  });
});
