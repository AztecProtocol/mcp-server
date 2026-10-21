# Complete local development workflow

The development tools operate on an explicitly selected local installation, project and node. They do not install Aztec, provision a network, run arbitrary scripts or require the Noir LSP. Fast mode exercises local execution with real proving disabled; successful inclusion does not establish proof validity.

The accepted installation is an exact component tuple, not every release whose version begins with `6`. Inspect the selected installation through `aztec_dev_inspect(operation: "environment")`; it must report support. The recorded tuple combines Labs `6.0.0-rc.3`, Foundation `6.0.0-rc.6`, the recorded Nargo compiler and Node `24.12.0`. Its node profile includes the recorded protocol-contract hash, verification-key root, rollup version, chain ID and `realProofs: false`. A different local rollup address is allowed only with that same protocol profile. See the [installation evidence and prerequisites](development-candidate.md).

Build the server with `npm run build`, then launch it with `AZTEC_MCP_DEV=true` using the selected Node executable. Configure that command in an MCP client. Without this opt-in, the original search catalog remains available and no development runtime is loaded. Compilation/TXE tests need no wallet or node session. The selected CLI needs its ordinary dependencies and a free TXE port 8081; the server never terminates an existing listener.

## Reproducible private-token fixture

Copy `tests/fixtures/development/private-token` to a fresh local project directory. It contains a small integration-only token with a private initial supply, transfers from the caller, and account-scoped balance views. Its two TXE tests check the initial supply and a transfer. Dependencies are pinned to the validated Aztec Noir tag. The compiler may fetch those declared dependencies if absent; the MCP server does not synchronize its search repositories as part of development operations.

Use absolute project, installation and Node paths. First call `aztec_dev_build` with `operation: "compile"`, then poll `aztec_dev_job(operation: "status")` using the returned job ID. Retain the completed build ID and its `DevelopmentToken` artifact path. Run `aztec_dev_build(operation: "test", package: "token_test")` and poll that job as well. Repeat compilation without changing the project to reuse valid outputs.

Open a session with `aztec_dev_session(operation: "open", proofMode: "fast")`, supplying the same project/runtime and the compatible local node URL. Read `aztec_dev_inspect(operation: "accounts")` and select Alice and Bob from that session's registered local test accounts. The wallet stays alive between operations.

```javascript
const deploymentJob = aztec_dev_contract({
  operation: "deploy", sessionId, buildJobId, artifactPath,
  account: alice, args: ["1000", alice], initialize: true
})
```

Poll `aztec_dev_job(operation: "status", jobId: deploymentJob.id)` until completed.
Use its `result.address` as `address` below.

```javascript
aztec_dev_contract({
  operation: "simulate", sessionId, address, account: alice,
  functionName: "transfer", args: ["25", bob]
})
const sendJob = aztec_dev_contract({
  operation: "send", sessionId, address, account: alice,
  functionName: "transfer", args: ["25", bob]
})
```

Poll `aztec_dev_job(operation: "status", jobId: sendJob.id)` until completed.
Use its `result.receipt.blockNumber` as `minimumBlock` for both views.

```javascript
aztec_dev_contract({
  operation: "view", sessionId, address, account: alice,
  functionName: "balance_of", args: [alice], minimumBlock
})
aztec_dev_contract({
  operation: "view", sessionId, address, account: bob,
  functionName: "balance_of", args: [bob], minimumBlock
})
```

The expected balances are 975 and 25. Each view names its account scope and supplies a conservative synchronization lower bound covering the included transfer. A pre-transaction cached result cannot satisfy that check. Public receipt inspection separately exposes bounded public effects and raw events; it does not enumerate private logs or pretend to decode unsupported event schemas.

## Restart, interruption and reset

Closing the session preserves its wallet and exact registered artifact snapshots. Reopen the same canonical project/runtime/network after restarting the MCP server; select the new session ID. Ordinary jobs are process-local, while transaction journals are durable. Use `aztec_dev_job(operation: "list-persisted", sessionId)` to find interrupted transactions and `operation: "recover"` with the original job ID to inspect their outcomes. Recovery never sends again.

After submission starts, cancellation stops local waiting and retains the known hash. It cannot cancel a chain transaction. Unknown or unresolved submissions block close, switch and reset until reconciled. A hashless interruption during possible submission remains uncertain; the server does not infer that retrying is safe. See [transaction evidence and recovery](development-transactions.md) and [session lifecycle behavior](development-sessions.md).

Reset deliberately discards only the active session's MCP-owned wallet state. It preserves the borrowed node. Re-register contracts afterward using their original artifacts. The worker checks a persisted block anchor and invalidates the session if the node's canonical history no longer matches; reset must then be explicit. Acceptance fault-injects a changed persisted anchor to exercise this path without resetting the borrowed network.

## Run acceptance and the SDK comparison

After building, run the complete supported workflow with the exact selected installation and a compatible existing local node:

```sh
node scripts/validate-development-workflow.mjs \
  /absolute/aztec-installation /absolute/node \
  http://127.0.0.1:18080 /tmp/workflow.json supported \
  /absolute/incompatible-installation

/absolute/node --experimental-import-meta-resolve \
  scripts/validate-development-baseline.mjs \
  /tmp/workflow.json /tmp/sdk-baseline.json
```

The first harness uses a real MCP `Client`, `Server` and in-memory transport. It creates a fresh fixture project, compiles, runs TXE, deploys and transfers, checks both private balances, rejects an overdraw and stale build, verifies restart persistence, kills its owned worker after a durable transaction hash, reconciles without replay, and exercises reset protection and anchor invalidation. It leaves the supplied node running. The `candidate` mode is a code-owned acceptance option pinned to the exact candidate identity; it is not an MCP parameter or environment bypass.

The baseline uses the same public SDK, compiler, artifact, accounts and local node, with a separate persistent ephemeral wallet and a separate deployment. Its CLI compile is primed before three warm samples because the stale-artifact test changes source mtimes. Its TXE measurement uses warm artifacts and a newly started oracle, matching the official wrapper's normal behavior. Run the two harnesses sequentially because the TXE wrapper uses fixed port 8081.

Fast-mode telemetry distinguishes necessary cryptography from proving. Poseidon hashing requires one asynchronous Barretenberg singleton, and Schnorr uses the synchronous crypto API. Fast mode creates the crypto singleton with SRS initialization skipped, blocks explicit proving-SRS initialization and blocks real proof generation. The evidence records these separately; “no real proof” does not mean “no cryptographic backend.”

## Recorded acceptance and timings, 2026-10-16

The [supported MCP run](development-evidence/2026-10-16-workflow-supported.json) and [persistent SDK baseline](development-evidence/2026-10-16-sdk-baseline.json) both passed on this machine. The actual 5.2.0 installation was rejected. Two TXE tests passed, the private transfer produced balances 975/25, and recovery after an owned worker crash in the same MCP server produced 974/26 without replay. Registration and accounts survived restart. Stale artifacts, overdraw, unresolved-reset protection and changed-anchor invalidation were exercised. The configured search-repository cache remained absent throughout.

Both runs used the exact installation and node identities recorded in their reports. The MCP transport was in memory, so these measurements exclude server process startup and stdio transport costs. They ran sequentially on a shared host, with separate wallets and deployments; chain inclusion waits and host load were not controlled. Differences are observed end-to-end costs, not isolated measurements of transport overhead.

| Operation | MCP | Persistent SDK / official CLI |
| --- | ---: | ---: |
| Uncached installation inspection | 4.086 s | 4.462 s |
| Cold session open / wallet creation plus account import | 4.338 s | 24.113 s |
| Cold compile | approximately 35.6 s | 32.497 s priming compile |
| Warm compile, three samples | 4.113 / 3.409 / 3.514 s | 1.628 / 1.695 / 1.800 s |
| TXE, two passing tests | approximately 49.1 s | 39.063 s |
| Warm simulation | 1.004 s | 0.627 s |
| Transfer submission and inclusion | 5.280 s job plus 0.198 s admission | 2.301 s submission plus 2.603 s wait |
| Two fresh scoped balance views | 2.638 s | 1.242 s |
| Public receipt inspection | 30 ms | 11 ms |

The final SDK cold wallet/account measurement is an outlier: an earlier run with the same corrected module loading took approximately 1.29 seconds. These samples do not support a general cold-start speed comparison or a latency guarantee. Cold compilation also had different initial output state because the baseline had to prime artifacts after the stale-source check.

Material avoidable overhead was investigated before promotion. Repeated full installation inspection originally cost approximately 2.5 seconds per operation; the [preflight cache check](development-evidence/2026-10-16-preflight-cache.json) records warm inspections around 15–21 ms after caching with file-metadata invalidation. The final warm compile median is 3.514 seconds versus 1.695 seconds for the CLI. MCP compilation additionally fingerprints source and dependencies and validates artifact provenance. Views additionally check the persisted chain anchor and report freshness; mutations retain durable submission evidence. This comparison does not independently attribute all remaining time to those checks. Job-status polling itself measured a median 0.91 ms and p95 1.60 ms.

Each persistent wallet initialized once per worker. Both fast runs recorded one necessary asynchronous cryptographic backend, zero proving-SRS initializations, and zero real-proof requests. [Explicit real proving](development-proving.md) was validated separately; local inclusion on this non-verifying development node does not establish proof validity.
