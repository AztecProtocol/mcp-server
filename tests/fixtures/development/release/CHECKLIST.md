# Release checklist for Token

## Before you run

1. Confirm the target node version matches the toolchain. The CLI version is `v6.0.0-rc.3`. Run the command below and compare `nodeVersion` in the response with the CLI version. A mismatch can make the deployment fail.

   ```bash
   curl -s -X POST 'https://node.example:8080' -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"node_getNodeInfo","params":[]}'
   ```

2. Confirm the account `alice` exists in this wallet's data directory. If the account does not exist yet, create it. `create-account` registers and deploys the account in one step. Use `deploy-account` only for an account that you registered with `--register-only`.

   ```bash
   '/opt/aztec/bin/aztec-wallet' create-account --node-url 'https://node.example:8080' --alias 'alice' --payment 'method=fpc-sponsored,fpc=0xabababababababababababababababababababababababababababababababab'
   '/opt/aztec/bin/aztec-wallet' deploy-account 'alice' --node-url 'https://node.example:8080' --payment 'method=fpc-sponsored,fpc=0xabababababababababababababababababababababababababababababababab'
   ```

3. Confirm the fee method. This release pays through the sponsor `0xabababababababababababababababababababababababababababababababab`. Confirm it is the address the network publishes for this release.
4. Read the script `/work/release/deploy.sh`. You can change every value in its variable block.

## Run

1. Run the script:

   ```bash
   bash '/work/release/deploy.sh'
   ```

## After

1. Record the printed address and transaction hash in your project.
2. Confirm the receipt. Replace `<txHash>` with the recorded hash:

   ```bash
   '/opt/aztec/bin/aztec-wallet' --node-url 'https://node.example:8080' get-tx <txHash>
   ```

3. Register the contract in any other wallet. Replace `<address>` with the recorded address:

   ```bash
   '/opt/aztec/bin/aztec-wallet' register-contract <address> '/work/project/artifact.json' --node-url 'https://node.example:8080'
   ```

4. Keep `/work/release/manifest.json` with the deployed address. It records which verified build the deployment used.
