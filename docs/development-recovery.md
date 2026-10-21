# Recovering interrupted development transactions

After a worker or MCP process stops, reopen the original project with the same runtime and node. The saved wallet accounts, contract registrations, immutable artifact snapshots, and transaction journals remain in its network-specific session directory. Recovery does not require another build or deployment.

Use `aztec_dev_job` with `{ "operation": "list-persisted", "sessionId": "<new-session-id>" }` to list persisted transaction identities. Then use `{ "operation": "recover", "sessionId": "<new-session-id>", "jobId": "<original-job-id>" }` to reconcile one job. Its original session identifier remains provenance; the request uses the newly opened session identifier. A job still running in the current MCP process must finish or stop local waiting before recovery.

Recovery checks the original project, runtime, network identity, and saved artifact association. For a known hash it performs a receipt lookup and updates the durable journal. It never invokes transaction submission. The result includes `replayed: false`, `resolved`, `outcome`, and guidance:

| Outcome | Meaning and next action |
| --- | --- |
| `not-submitted` | Submission was never reached, or the worker positively reported a failure before broadcast. Any new operation requires an explicit request. |
| `unknown-outcome` without a hash | Submission might have reached the node before the hash was saved. Do not resubmit. A developer must reconcile external node or transaction records first. |
| `pending` | Inspect the recorded hash again later. |
| `dropped` | This node currently reports the hash as dropped or unknown. That observation does not prove it was never submitted; automatic retries remain disabled. |
| `included` | The transaction succeeded. Refresh a view using the receipt's inclusion block as `minimumBlock`. Fast-mode inclusion does not establish proof validity. |
| `reverted` | The transaction was included but reverted. Recovery does not retry it. |

Cancelling local waiting preserves any known hash and does not cancel a chain transaction. Unresolved submissions prevent session close, switch, and reset; reconcile them first. An uncertain submission without a hash remains unresolved and needs developer investigation. Recovery refuses a changed or missing immutable artifact snapshot, a different saved contract association, and a different network or runtime.

Journals record public operation identity, account address, artifact hashes, phase, and receipt evidence; they omit call arguments and account secrets. Hash persistence is awaited before receipt polling. Files and their containing directory are synchronized before submission proceeds past a journal checkpoint.

`scripts/validate-transaction-recovery.mjs` is a candidate integration check. It kills only its own worker after the hash is durably saved, reopens the same wallet, confirms preserved accounts and registration, reconciles through receipt lookup, and checks a fresh private balance changed exactly once. Unit checks cover interruption before submission and uncertainty before hash persistence.
