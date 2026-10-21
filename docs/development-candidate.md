# Development runtime preflight and candidate validation

Enable `AZTEC_MCP_DEV=true` to expose development tools. Repository search remains
independent, with Node 18+ support and no Aztec installation requirement. Development
preflight accepts explicit absolute `installationRoot` and `nodeExecutable` paths.
It does not use a different installation from PATH, download packages, or open a wallet.

The exact Labs rc.3 / Foundation rc.6 / Noir rc.3 / Node 24.12.0 tuple is now
supported following the [complete MCP workflow](development-workflow.md).
Production sessions also require its accepted chain, rollup protocol version,
protocol-contract hash and circuit verification-key root. A new local rollup
deployment address is allowed; different protocol components are rejected.
The historical candidate report below records the earlier, unpromoted stage.

The installation report records the CLI/compiler version output, the installation's
Node minimum and selected executable/version, Labs SDK and Foundation package
versions, public export paths, declared Foundation dependencies, available package
source metadata, and package-lock SHA-256. Missing components and incompatible
combinations include setup guidance. Absent provenance stays absent. Node package
engine minima alone do not establish that a full runtime works.

## Candidate checks

The integration harness is separate from production tool execution. From this
repository, after `npm run build`, run:

```sh
node scripts/validate-development-candidate.mjs \
  --installation-root /absolute/path/to/.aztec/versions/6.0.0-rc.3 \
  --node-executable /absolute/path/to/node \
  --node-url http://127.0.0.1:8080
```

Supply an existing local development network. The harness does not start or stop
that network. It runs public SDK module loading and ephemeral wallet creation in
a child using the selected Node executable. The node must report `realProofs=false`;
the wallet receives `pxe.proverEnabled=false` explicitly. Results and progress use
IPC, while SDK stdout/stderr are drained separately and counted without printing
potentially sensitive logs. The wallet must stop and the worker must exit naturally.
A timeout (120 seconds by default, configurable up to 300 seconds) is a failure,
including when `wallet.stop()` returned but left resources alive. Forced cleanup
terminates only the owned worker process group.

The report records actual node component headers, chain/rollup identity, proof
requirements, module-load outcomes, wallet lifecycle, and elapsed time. It never
claims proof generation or full workflow acceptance from configuration alone.
Success is `candidate-passed` with `productionSupported:false`: this preliminary
check alone never promotes a tuple. There is no MCP argument or
environment flag to bypass production compatibility checks.

## Recorded local candidate, 2026-10-16

The developer authorized upgrading the installation and starting a disposable local
network for validation. The official installer added Labs `6.0.0-rc.3` and selected
it, preserving the previous `5.2.0` installation. The new installation uses Noir
`1.0.0-rc.3`, Node `24.12.0`, and Foundation dependencies `6.0.0-rc.6`.

The [real probe report](development-evidence/2026-10-16-candidate.json) records a
successful public-module load, explicit fast wallet creation, wallet stop, and
natural worker exit against the disposable node on port 18080. This is live
candidate evidence, separate from fixture-based automated tests. It does not
validate compilation, transfers, persistence, or real proving.

Release evidence:

- The [Labs rc.3 installer](https://install.aztec-labs.com/6.0.0-rc.3/install)
  and [manifest](https://install.aztec-labs.com/6.0.0-rc.3/versions) identify the distribution.
- [Published Labs PXE rc.3 metadata](https://registry.npmjs.org/@aztec-labs%2Fpxe/6.0.0-rc.3)
  declares Foundation rc.6 dependencies.
- Foundation rc.6's `labs` gitlink is `1b6de149f4fe1cde3c5fb876d3822289f490cd2a`.
  The Labs rc.3 release tag points to `b37a5869760fb55faa8d4697d3ccbecc6f913fce`.
  These are different source identities; dependency versions and a source gitlink
  are recorded as separate evidence, not treated as interchangeable provenance.
- A Foundation-numbered `6.0.0-rc.6` installer returned HTTP 404. The installed
  Labs rc.3 candidate is explicitly identified; no same-number equivalence is assumed.

The 5.2.0 installation remains insufficient evidence for v6 support.
