# Tracked compilation and TXE tests

These tools require development mode (`AZTEC_MCP_DEV=true`) and an explicitly selected, supported runtime tuple. A candidate installation may execute only inside the opt-in integration harness until the complete acceptance workflow promotes it. Compilation and TXE testing do not require an open wallet or a local rollup node.

## Compile and inspect a job

Use absolute paths; the selected installation supplies the CLI, compiler, postprocessor and runtime Node. No alternate installation is taken from `PATH` or `.aztecrc`.

```javascript
const buildJob = aztec_dev_build({
  operation: "compile",
  projectPath: "/absolute/project",
  installationRoot: "/absolute/aztec/versions/selected-version",
  nodeExecutable: "/absolute/node",
  timeoutMs: 300000
})
aztec_dev_job({ operation: "status", jobId: buildJob.id })
aztec_dev_job({ operation: "logs", jobId: buildJob.id })
aztec_dev_job({ operation: "cancel", jobId: buildJob.id })
```

`package` optionally selects one package; omitting it compiles the workspace. The server passes arguments directly to executables without a shell command string. Status includes queued/running/terminal state, phase, timestamps, duration and result or failure evidence. Cancellation is asynchronous; poll status until terminal. Terminal states are `completed`, `failed`, `cancelled` and `timed-out`.

Build results include located diagnostics where recognized and contract artifact identities containing an absolute path, SHA-256 content hash, source/dependency/compiler/options provenance hash and contract name. Raw output remains available when diagnostics cannot be parsed. Nonzero exits or signals always fail even when output claims success. Inputs changing during compilation invalidate the result.

The before/after check covers already cached Git dependencies as well as local sources. First-time downloads of pinned dependencies are allowed, but do not excuse changes to other dependencies that were present when compilation started.

The upstream `target` directory stays in place. A provenance receipt in `.aztec-mcp/build.json` records which inputs and artifact bytes were validated. An unchanged receipt preserves upstream incremental compilation. Changed sources, resolved dependencies, toolchain, selection or artifact bytes trigger fresh compilation before Aztec postprocessing. Before that refresh, recognized artifacts in the selected output set move to `.aztec-mcp/build-artifacts/<id>/`; results expose `quarantinedArtifacts`, and logs retain their recovery paths even if compilation fails. Their bytes are preserved, but removed or renamed contracts cannot inherit the new build's provenance. Unrelated JSON and unselected package outputs remain in place; only newly generated selected artifacts are certified after the refresh. Unchanged warm builds do not quarantine outputs. This receipt is metadata, not a second artifact cache; removing it causes existing outputs to be revalidated through compilation. Build fingerprints exclude `target`, `.git`, `node_modules` and `.aztec-mcp`. Local dependency sources and resolved tagged Git dependency sources are included. Symlinked build inputs are currently rejected explicitly.

One build/test job per canonical project can run in this MCP process. Retention is bounded to 100 jobs and the last 1 MiB of logs per job. Creating another job evicts the oldest terminal job when necessary; active jobs are never silently evicted. Jobs and logs are process-local, so ordinary build job history does not survive an MCP restart. Log responses report truncation and offsets. Execution defaults to five minutes and accepts a timeout up to thirty minutes. Cancellation, timeout and wrapper exit terminate only the process group owned by that job, including its oracle descendants.

## Run contract tests with TXE

```javascript
aztec_dev_build({
  operation: "test",
  projectPath: "/absolute/project",
  installationRoot: "/absolute/aztec/versions/selected-version",
  nodeExecutable: "/absolute/node",
  package: "counter_test",
  testFilter: "test_constructor"
})
```

The selected installation's `aztec test` wrapper handles compilation prerequisites and starts TXE. Test package and name-substring selection are forwarded as structured arguments. This release's wrapper requires `nc` and free local TCP port 8081. An existing service on that port is reported as `oracle-port-unavailable`; the MCP never stops it. Concurrent owned TXE test runs are rejected rather than sharing oracle state. Owned TXE processes are cleaned up on success, failure, timeout or cancellation.

Results include the selection, recognized test names, pass/fail counts, timings and diagnostics. `summaryStatus: "unavailable"` with null counts means output could not be interpreted; it never implies zero failing tests. A failed command preserves the test summary and raw logs in its failure evidence. TXE checks contract behavior against its oracle environment; they do not establish end-to-end rollup behavior or real-proof validity.

## Reproduce live fixture validation

`tests/fixtures/development/counter` is the selected distribution's private-counter template with pinned Aztec.nr dependencies. Its test crate deploys a counter, reads the owner's private value and increments it through TXE. The live test copies the fixture into a temporary directory, compiles it, checks warm reuse, introduces a genuine compiler error, runs a selected passing test, and changes its expected value to produce a deliberate failing assertion. The original fixture remains unchanged.

First produce a passing candidate record as described in [candidate validation](development-candidate.md). Then run:

```bash
AZTEC_MCP_CANDIDATE_RECORD=/absolute/candidate.json \
AZTEC_MCP_BUILD_EVIDENCE=/tmp/build-evidence.json \
npm test -- tests/development/build-live.test.ts
```

The harness re-inspects component identities against the supplied record before allowing candidate execution. The normal test suite skips this live check unless a record is explicitly supplied. Its fixture dependencies may be resolved by the compiler's normal pinned-dependency workflow; the MCP does not install a toolchain or provision a network.

On the supplied machine, Labs/CLI 6.0.0-rc.3, Foundation 6.0.0-rc.6, Noir 1.0.0-rc.3 (`5a7ee9bf`) and Node 24.12.0 compiled the fixture, preserved a warm incremental build, rejected a real syntax error, and passed the selected TXE constructor test. One recorded warm compile took 1.878 seconds; the first selected TXE run including recompilation took 55.320 seconds. These are observed local conditions, not latency guarantees or full compatibility promotion. Upstream compiler diagnostics, including emitted Brillig constraint warnings, are preserved in the logs.
