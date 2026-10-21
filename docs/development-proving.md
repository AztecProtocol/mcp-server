# Explicit real proving

Normal sessions use `proofMode: "fast"` and `proverEnabled: false`. Real proving
requires a separate session selection with an existing, validated native backend:

```js
aztec_dev_session({
  operation: "open",
  projectPath: "/absolute/project",
  installationRoot: "/absolute/.aztec/versions/6.0.0-rc.3",
  nodeExecutable: "/absolute/node",
  nodeUrl: "http://127.0.0.1:8080",
  proofMode: "real",
  proving: {
    backend: "NativeUnixSocket",
    crsPath: "/absolute/existing/.bb-crs",
    threads: 2
  }
})
```

The separately tested backend is Foundation `6.0.0-rc.6` on Linux x64. Validation
checks the selected installation's native executable against SHA-256
`fa4b12adaefd5684b53b802346b9fe839ab3d6a4a829a5ea4efd6bd200e0829f`
and its version output. It requires an existing complete CRS cache:
`bn254_g1.dat` (at least 2 GiB), `bn254_g2.dat` (128 bytes), and
`grumpkin_g1_v2.flat.dat` (at least 16 MiB). Threads must be between 1 and 16.
The conservative complete-cache requirement prevents this profile from fetching
missing CRS data during ordinary proof generation. The cache is developer supplied;
the native implementation performs its own CRS checks.

Missing configuration, another binary, or missing dependencies fail before wallet
creation. The server never installs them, switches releases, automatically respawns
a failed prover, or changes a failed operation to fast mode. The native backend
inherits the validated `CRS_PATH`; the SDK's `crsPath` option alone only configures
its WASM path. The backend options are pinned before the SDK first creates its
shared cryptographic backend, so earlier hashing cannot override the selected
proving configuration.

Use session `switch` to change modes, supplying the current `sessionId` and all
new selection fields. An in-place `open` with another mode is rejected. Switching
drains admitted work, refuses unresolved submissions, closes the previous wallet
and backend, and assigns a new session ID. Reset preserves the selected mode and
configuration while discarding only that session's owned wallet state.

Deployment and send jobs expose `proving`, `proof-generated` or `proof-failed`
progress where the SDK supplies it, followed by submission and inclusion phases.
`proofTelemetry` contains cumulative session counters and generation duration;
it never contains witnesses, proof inputs, or account keys. `proofMode: "real"`
does not change `proofValidityEstablished: false`: the integration demonstrates
actual proof generation and local transaction inclusion, not independent proof
verification. The borrowed local node still reports `realProofs: false`.

Cancellation before submission preparation completes prevents starting the SDK
send. Once the SDK send sequence starts, it may finish proving and submit even
after cancellation or a job timeout. The server awaits that single response to
retain any returned hash, then stops local receipt waiting. It never claims to
cancel a chain transaction or retries a mutation. Real submission requests have
a 15-minute worker deadline; a forced interruption requires journal recovery.

Fast mode still uses the SDK's required Barretenberg cryptographic singleton for
Poseidon hashing. This is visible as one async backend initialization per worker.
Fast mode forces `skipSrsInit: true`, blocks the public WASM SRS initializer, and
guards `BBPrivateKernelProver.createChonkProof` before it can generate a proof.
Zero proof requests and zero SRS-initializer requests are the fast-mode evidence;
zero cryptographic-backend initializations is not a valid expectation for this SDK.
ESM public exports are resolved in the selected worker to instrument the same
singleton the SDK uses. Both modes explicitly close the backend at shutdown.

## Optional integration check

This slow check is explicitly selected; ordinary `npm test` does not generate
proofs. After building, provide a configuration JSON with the session fields above
and an existing registered/deployed fixture description:

```json
{
  "installationRoot": "/absolute/.aztec/versions/6.0.0-rc.3",
  "nodeExecutable": "/absolute/node",
  "nodeUrl": "http://127.0.0.1:8080",
  "projectPath": "/absolute/test-project",
  "proving": { "backend": "NativeUnixSocket", "crsPath": "/absolute/.bb-crs", "threads": 2 },
  "contract": {
    "address": "0x...",
    "artifactPath": "/absolute/counter_contract-Counter.json",
    "account": "0x...",
    "functionName": "increment",
    "args": ["0x..."]
  }
}
```

```sh
node scripts/validate-real-proving.mjs configuration.json evidence.json
```

The integration-only candidate validator remains inside the harness; no MCP
argument or environment setting bypasses production support checks. It uses the
actual MCP protocol to reject missing configuration and in-place mode changes,
register the fixture, send, observe proof progress, confirm inclusion, and switch
back to fast mode. It does not provision or stop the borrowed network.

The [recorded live check](development-evidence/2026-10-16-real-proving.json)
completed one native proof in about 9.69 seconds using two threads, observed
inclusion, and restored fast mode with zero proof/SRS requests. These are observed
local timings, not a latency guarantee. The [fast workflow](development-workflow.md)
has separate measurements and does not depend on real proving.
