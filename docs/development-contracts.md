# Contract registration and inspection

Contract operations require the current session identifier. Open a supported local
session first, or use the explicitly selected candidate through the integration
harness until production compatibility is promoted.

```js
aztec_dev_contract({
  operation: "register",
  sessionId,
  address: "0x<32-byte-contract-address>",
  artifactPath: "/absolute/project/target/package-Contract.json"
})

aztec_dev_inspect({ operation: "contract", sessionId, address: "0x<32-byte-contract-address>" })
aztec_dev_inspect({ operation: "accounts", sessionId })
```

Registration associates a known deployed contract with its exact compiled artifact
in the dedicated project wallet. It never deploys, initializes, or submits a chain
transaction. The artifact's class is checked against the node's deployed instance
before wallet registration. Unchanged registration is reused. A rebuilt artifact
does not silently replace an existing association: the original artifact snapshot
and identity persist across wallet restart.

After rebuilding, sends, simulations, and views continue using that original
snapshot while its class still matches the deployment. Inspection separately
reports changes to the artifact at its original filesystem path.

Inspection reports separate filesystem, node, and wallet evidence. Node instance
lookup is pinned to `node.observedBlock`; wallet metadata describes its observation
window because its public SDK calls also consult the current node state. These are
not represented as a single atomic snapshot.

The `problems` list distinguishes an unknown/unpublished node instance, unavailable
local artifact, missing wallet registration, artifact/class mismatch, and an artifact
that changed since registration. “Unknown deployment” means the node has no published
instance; it is not proof that the address can never represent a private contract.
Results contain bounded identities and public account addresses, not full artifacts,
account secrets, or private database contents.

## Independent live fixture

The registration milestone uses a Token deployed independently through the candidate
SDK before MCP deployment support. Given a JSON file with `address`, `artifactPath`,
and at least two public `accounts`, reproduce the checks with:

```sh
npm run build
node scripts/validate-contract-registration.mjs \
  /absolute/fixture.json /absolute/aztec-installation /absolute/node \
  http://127.0.0.1:8080 /tmp/registration-evidence.json
```

This checks repeated registration, class mismatch, unknown contracts, changed local
artifacts, and close/reopen persistence. See the [recorded live result](development-evidence/2026-10-16-registration.json).
