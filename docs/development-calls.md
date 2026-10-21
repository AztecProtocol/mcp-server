# Simulations and account-scoped views

Register a deployed contract and its matching compiled artifact first. Then use `aztec_dev_contract` with operation `view` or `simulate`, the current `sessionId`, contract `address`, `functionName`, positional `args`, and an `account` returned by account inspection.

For example, query the token's private balance with `functionName: "balance_of_private"`, `args: ["0x<32-byte owner address>"]`, and the selected account address. Supply a real hexadecimal address rather than the placeholder. To inspect public balance, select `balance_of_public`. Views accept utility functions and functions marked static in the ABI. Simulations also accept state-changing functions, but neither operation submits a chain transaction. Internal-only functions and initializers are excluded.

Arguments must match the registered immutable artifact. Ordinary JSON numbers must be safe integers. Use decimal strings such as `"340282366920938463463374607431768211455"` or `0x` hexadecimal strings for larger integers. Signed and unsigned ranges are checked, field values must be below the field modulus, and booleans must be actual JSON booleans. Aztec addresses use 32-byte hexadecimal strings; Ethereum addresses use 20-byte strings. Fixed arrays require their exact length and structs require every declared field with no extras. Strings are restricted to ASCII within the ABI's byte length because the candidate SDK encodes character codes rather than UTF-8. Unsupported ABI variants fail before execution.

Function-selector structs use their declared `inner` field. Bounded-vector structs use their declared fixed `storage` array and `len`; unused storage must be zero padded. The adapter converts these strictly checked forms to the SDK's supported representations.

Every result includes the selected account scope, artifact identity, function type, proof mode, and explicit `chainTransactionSubmitted: false`. A private balance of `"0"` means zero visible to that selected account in the executed view. It does not establish that no other account owns notes. The adapter supplies no additional account scopes. Results marked `dataStatus: "unavailable"` are failures or missing values, never zero balances; a successful function without a return value is marked `"no-return"`.

The persistent wallet serializes simulation and view operations because they can update PXE state. Its public simulation and utility APIs synchronize PXE and the relevant contract/account state before execution. The worker explicitly selects the proposed chain tip and disables real proving. Returned offchain note material is omitted; only the decoded function result crosses the worker boundary.

Use `minimumBlock` when verifying a transaction's inclusion. The call fails if the node has not reached that height. A successful response records a synchronization lower bound in `freshness.synchronizedThroughBlock`, a stable block hash, and the node's observation interval (`observedBlock` through `observedThroughBlock`). The same starting block must remain canonical after execution. The SDK's public simulation result omits its exact execution anchor, so `exactExecutionBlock` remains false. Proposed blocks can still be reorganized later; these observations are local execution evidence, not finality or proof validity.

A failed simulation returns `status: "failed"`, `dataStatus: "unavailable"`, and a phase-specific diagnostic. When an SDK failure matches a static contract assertion in the artifact, that assertion is returned—for example, `Balance too low`. Raw SDK traces, account secrets, and private offchain effects are not returned. Successful simulation establishes neither transaction inclusion nor proof validity.

## Validation

`npm test -- tests/development/calls.test.ts` covers exact integer and field bounds, boolean coercion rejection, addresses, fixed arrays, structs, selectors and bounded vectors, public/private function discovery, selected-account visibility, missing return values, safe contract assertion diagnostics, minimum-block requirements, and a changed canonical block during execution.

The live candidate evidence in [2026-10-16-calls.json](development-evidence/2026-10-16-calls.json) records an externally deployed token: Alice's private view returns `333`, Bob's scope querying Alice returns `0`, public balance returns `0`, a valid transfer simulation succeeds, and an overdraw reports `Balance too low`. None of these operations submits a transaction.
