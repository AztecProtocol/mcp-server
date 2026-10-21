# Release packaging for public networks

`aztec_dev_release` requires development mode (`AZTEC_MCP_DEV=true`) and an explicitly selected, supported runtime tuple. It turns a verified local build into three files that you review and run yourself to deploy to a public Aztec network.

## Boundary

The tool never signs, never submits a transaction and never contacts a network. It writes three files and stops. You run the deploy script with your own `aztec-wallet`, your own keys and your own funds. The files hold names, paths and hashes only, never keys or secrets. The tool writes the node URL into the files and does not contact it.

## Package a build

All paths must be absolute. `outputDirectory` must also be normalized, with no trailing slash and no `..` segments.

```javascript
aztec_dev_release({
  operation: "package",
  buildJobId: buildJob.id,
  artifactPath: "/absolute/project/target/token-Token.json",
  installationRoot: "/absolute/aztec/versions/selected-version",
  nodeExecutable: "/absolute/node",
  outputDirectory: "/absolute/releases/token-1",
  args: ["1000", 7, true],
  initialize: true,
  account: "alice",
  fee: { method: "fee_juice" },
  nodeUrl: "https://node.example:8080"
})
```

| Input | Rule |
| --- | --- |
| `buildJobId` | A completed `compile` or `test` job in this server process. |
| `artifactPath` | One of that job's artifacts. |
| `installationRoot`, `nodeExecutable` | Must resolve to the same installation and Node executable that the build job used. The manifest records the resolved paths. |
| `outputDirectory` | The parent must exist. The directory must not exist. |
| `args` | Constructor arguments. Each is a string, a non-negative safe integer (0 to 2^53 - 1) or a boolean. Pass values above 2^53 - 1 and non-integers as strings. |
| `initialize` | `false` emits `--no-init`. |
| `initializerName` | Optional. A plain identifier. Rejected when `initialize` is `false`. |
| `account` | An `aztec-wallet` alias or address. |
| `fee` | `{ method: "fee_juice" }` or `{ method: "fpc-sponsored", fpcAddress }` with a `0x` hex address of 64 hex digits. Other methods are rejected. |
| `nodeUrl` | An `http:` or `https:` URL without a user name or password. |
| `contractAlias` | Optional. The default is the lower-case contract name. |

`args`, `account` and `contractAlias` must not begin with `-`, because the wallet could read them as options. `nodeUrl`, `account`, `contractAlias` and string `args` must not contain ASCII control characters (U+0000 to U+001F and U+007F), for example a newline or a tab. Unknown keys are rejected.

## Checks

The tool runs these checks in order. A failure returns an error with the listed code and writes nothing, except where noted.

1. The runtime is supported: `unsupported-runtime`.
2. The build job exists, is completed, and has the same selection: `invalid-build`.
3. The artifact belongs to the job, and its bytes and project inputs are unchanged: `stale-artifact`.
4. The tool creates the output directory: `output-exists` when it exists, `output-parent-missing` when the parent is missing, `output-not-canonical` when it resolves to a different path. In the last case the tool removes the new directory.

On macOS, `/tmp` is a symbolic link. Pass the resolved path, for example `/private/tmp/token-1`.

The tool renders all three files before it creates the directory. A value that the wallet could read as an option is an invalid input. The boundary rejects such values before any work. The renderer also refuses them with `invalid-script-value`. If a write fails, the tool removes the files and the directory and reports the original error.

## Files written

The tool writes `manifest.json`, `deploy.sh` and `CHECKLIST.md` into the new directory (mode `0o700`). The tool writes each file to a temporary name and renames it into place.

- `manifest.json` (mode `0o600`): the build job, the artifact path and SHA-256 hash, the deployment values, the fee method and the toolchain. The result returns the same object.
- `deploy.sh` (mode `0o700`): a variable block followed by one `aztec-wallet deploy` command. The script checks the artifact hash first and stops if the artifact changed. Every value is single-quoted.
- `CHECKLIST.md` (mode `0o600`): the steps below, with the real values filled in. Every value in its shell commands is single-quoted.

The result lists the directory, the three file paths and the manifest.

## Checklist flow

1. Before you run, compare the node version with the CLI version. Confirm that the account exists, or create it with the listed command. Confirm the fee method and its funding or sponsor address. Read the script.
2. Run: `bash <outputDirectory>/deploy.sh`.
3. After the run, record the printed address and transaction hash, confirm the receipt with `get-tx`, register the contract in other wallets with `register-contract`, and keep the manifest with the deployed address.

## Verify against the installed CLI

Two tests check the generated script against the real wallet. First produce a passing candidate record as described in [candidate validation](development-candidate.md). Then run:

```bash
AZTEC_MCP_CANDIDATE_RECORD=/absolute/candidate.json \
npm test -- tests/development/release-drift.test.ts tests/development/release-live.test.ts
```

- `release-drift.test.ts` reads the installed `@aztec-labs/cli-wallet` and checks that the `deploy` command, every flag in the rendered script, both fee methods and the commands in the checklist are declared. The flag list comes from the renderer output, so it cannot drift from the generator.
- `release-live.test.ts` compiles `tests/fixtures/development/private-token`, packages it into a new directory and runs `bash -n` on `deploy.sh`. The test never executes the script.

Both tests skip when `AZTEC_MCP_CANDIDATE_RECORD` is not set. On 2026-10-21, with CLI 6.0.0-rc.3, both tests passed.
