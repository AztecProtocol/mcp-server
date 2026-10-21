# Local deployment and transaction evidence

Execution requires a validated local session with real proving explicitly disabled. Candidate execution remains confined to the integration harness until the complete workflow promotes that runtime tuple. Fast-mode inclusion demonstrates local execution, not proof validity.

## Deploy a selected build

Start a [tracked compilation](development-build.md), retain its job ID and select an artifact returned by that job. Open a session for the same canonical project and choose an account returned by the session.

```javascript
aztec_dev_contract({
  operation: "deploy",
  sessionId: "active-session",
  buildJobId: "successful-build-id",
  artifactPath: "/absolute/project/target/counter_contract-Counter.json",
  account: "0x...session-account...",
  initializerName: "constructor",
  args: ["5", "0x...session-account..."],
  initialize: true
})
aztec_dev_job({ operation: "status", jobId: "deployment-job-id" })
```

`initialize` is required. `true` calls the selected initializer; `false` publishes the instance without calling it. Arguments are ABI-validated in both cases because they contribute to the instance address. Omitting `initializerName` selects `constructor`, or the sole initializer when unambiguous. The deployment binds its address to the selected account before submission. Class and instance publication remain enabled.

The artifact path and content must match the selected completed build, and its source, dependency, toolchain and options fingerprint must still match the session. A stale artifact is rejected before submission. The worker preserves the exact artifact bytes before any submission, and confirmed deployment retains its content hash, class identity and build provenance in the existing contract association. Rebuilding the source file does not replace that association.

Jobs distinguish preparation, submission, waiting and inclusion. Their `evidence` field exposes the transaction hash as soon as submission returns. Results separately report registration, instance publication, initialization, submission and inclusion; they retain the public receipt, block identity and fee when available. Successful fast-mode results include `proofValidityEstablished: false`.

```javascript
aztec_dev_contract({
  operation: "inspect",
  sessionId: "active-session",
  address: "0x...deployment-result-address..."
})
```

The session reuses its wallet/PXE across these calls. Deployment does not open another wallet or request another confirmation inside the selected local session.

## Cancellation and interrupted outcomes

Cancel a job through `aztec_dev_job` and poll it to a terminal state. Once submission starts, the server waits for that one in-flight response so a returned hash is retained, then stops local inclusion waiting. `cancelledWaiting: true` and `chainTransactionCancelled: false` explicitly distinguish local cancellation from chain cancellation. A failed, reverted, dropped or uncertain submission is never retried automatically.

Per-session journals live under `.aztec-mcp/sessions/<network>/jobs/`. The server records the submission attempt before invoking the SDK, then records a known hash before polling. Writes use a temporary file, file synchronization, atomic rename and directory synchronization. Journals retain project/network/runtime/account/artifact provenance and explicit fast mode, while omitting initializer and function arguments. If a worker disappears during submission without returning a hash, the job reports `unknown-outcome`; inspect or reconcile it before considering a new mutation.

The [recorded candidate deployment](development-evidence/deployment-candidate.json) rejected malformed initializer arguments, deployed the private-counter fixture in 7.481 seconds, and inspected its exact artifact association at successful inclusion block 7. That observation is specific to the recorded machine/runtime/network and is not a latency guarantee or full compatibility promotion.

## Send, inspect and verify a state change

Registered contracts use the same tracked lifecycle as deployments. Select a state-changing function from the exact registered ABI and provide the explicit sender account. Utility and static functions use `view` or `simulate` instead.

```javascript
aztec_dev_contract({
  operation: "send", sessionId: "active-session",
  address: "0x...counter-address...", account: "0x...owner...",
  functionName: "increment", args: ["0x...owner..."]
})
aztec_dev_job({ operation: "status", jobId: "send-job-id" })
const receipt = aztec_dev_inspect({
  operation: "transaction", sessionId: "active-session",
  txHash: "0x...included-transaction-hash..."
})
aztec_dev_contract({
  operation: "view", sessionId: "active-session",
  address: "0x...counter-address...", account: "0x...owner...",
  functionName: "get_counter", args: ["0x...owner..."],
  minimumBlock: receipt.blockNumber
})
```

Receipt inspection reports public effects, bounded raw public-event fields, network identity and block provenance. Private log contents and private events are not enumerated. Account-scoped views provide the private-state verification, and `minimumBlock` prevents accepting pre-inclusion state. Event fields are marked undecoded rather than presented as ABI-decoded events.

The SDK performs its normal preparation and simulation once. Failures distinguish contract simulation, preparation or node unavailability before broadcast, an explicit node rejection, reverted/dropped inclusion, and uncertain submission. When a send reaches node submission, its deterministic transaction hash is retained even if the acknowledgement is lost. There is no retry of a mutation; an interrupted caller must inspect or reconcile the recorded outcome. Cancellation before execution releases the session's lifecycle guard; cancellation after submission preserves an unresolved journal until reconciliation.

The [candidate send evidence](development-evidence/send-candidate.json) records a successful private-counter send in 4.960 seconds, a fresh value change from 6 to 7, a rejected token overdraw before broadcast, and another real send whose local waiting was cancelled after submission. That cancelled job's hash subsequently reached successful inclusion, and a fresh view read 8. One wallet instance handled the whole run and the real-proof guard recorded zero requests. These are service integration measurements on the recorded local runtime; complete MCP-boundary timings and compatibility promotion are tracked separately in ticket 13.

The reproducible harness is `scripts/validate-development-send.mjs DEPLOYMENT_EVIDENCE CALL_EVIDENCE OUTPUT_JSON`. It re-inspects the selected installation and uses the concrete local counter/token fixtures in those evidence files. The cancellation hook runs only in the harness after the actual SDK submission response; it does not mock a transaction or receipt. Targeted tests additionally exercise node rejection, lost acknowledgement, reverted inclusion, bounded effect projection, admission races and queued cancellation.
