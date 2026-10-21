#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectToolchain } from '../dist/development/toolchain.js';
import { runtimeIdentity } from '../dist/development/policy.js';
import { buildEnvironment } from '../dist/development/build.js';
import { runJobProcess } from '../dist/development/jobs.js';
process.env.LOG_LEVEL = 'silent';
const [workflowPath, outputPath] = process.argv.slice(2);
if (!outputPath)
  throw Error('Usage: selected-node scripts/validate-development-baseline.mjs WORKFLOW_EVIDENCE OUTPUT_JSON');
const workflow = JSON.parse(await readFile(workflowPath, 'utf8'));
assert.equal(workflow.status, 'passed');
const { installationRoot } = workflow.installation;
const nodeExecutable = workflow.installation.runtimeNode.path;
assert.equal(await realpath(process.execPath), await realpath(nodeExecutable));
const evidence = { checkedAt: new Date().toISOString(), baseline: 'Persistent direct public SDK; no MCP, ABI validation, artifact fingerprinting, journal fsync or chain-anchor guard', projectPath: workflow.projectPath, timings: {}, proofTelemetry: { realProofRequests: 0, asyncBackendRequests: 0, asyncBackendInitializations: 0, srsInitializationRequests: 0 }, node: workflow.opened.network };
async function timed(label, fn) { const start = performance.now(); const value = await fn(); evidence.timings[label] = performance.now() - start; return value; }
evidence.installation = await timed('uncachedInspection', () => inspectToolchain({ installationRoot, nodeExecutable }));
assert.equal(runtimeIdentity(evidence.installation), runtimeIdentity(workflow.installation));
assert(process.execArgv.includes('--experimental-import-meta-resolve'), 'Launch selected Node with --experimental-import-meta-resolve to resolve the same ESM SDK singleton');
const parentUrl = pathToFileURL(join(installationRoot, 'package.json')).href;
const load = specifier => import(import.meta.resolve(specifier, parentUrl));
const { Barretenberg } = await load('@aztec-foundation/bb.js');
const originalBackend = Barretenberg.new;
Barretenberg.new = async function (options = {}) { evidence.proofTelemetry.asyncBackendRequests++; const backend = await originalBackend.call(this, { ...options, skipSrsInit: true }); evidence.proofTelemetry.asyncBackendInitializations++; return backend; };
Barretenberg.prototype.initSRSChonk = async () => { evidence.proofTelemetry.srsInitializationRequests++; throw Error('Proving SRS initialization requested in fast baseline'); };
const { BBPrivateKernelProver } = await load('@aztec-labs/bb-prover/client');
BBPrivateKernelProver.prototype.createChonkProof = async () => { evidence.proofTelemetry.realProofRequests++; throw Error('Real proof requested in fast baseline'); };
const { createAztecNodeClient } = await load('@aztec-labs/aztec.js/node');
const { jsonStringify } = await load('@aztec-labs/foundation/json-rpc');
const { EmbeddedWallet } = await load('@aztec-labs/wallets/embedded');
const { Contract } = await load('@aztec-labs/aztec.js/contracts');
const { loadContractArtifact } = await load('@aztec-labs/stdlib/abi');
const { getInitialTestAccountsData } = await load('@aztec-labs/accounts/testing');
const node = createAztecNodeClient(workflow.opened.nodeUrl, { fetch: async (host, body, headers = {}) => { const response = await fetch(host, { method: 'POST', body: jsonStringify(body), headers: { 'content-type': 'application/json', ...headers }, signal: AbortSignal.timeout(15000) }); assert(response.ok); return { response: await response.json(), headers: response.headers }; } });
let wallet;
async function receipt(hash) { for (let i = 0; i < 240; i++) {
  const value = await node.getTxReceipt(hash);
  if (value.executionResult === 'success')
    return value;
  if (value.executionResult === 'reverted' || value.status === 'dropped')
    throw Error('Baseline transaction failed');
  await new Promise(r => setTimeout(r, 500));
} throw Error('Baseline inclusion timeout'); }
try {
  const controller = new AbortController();
  const context = { id: 'baseline', signal: controller.signal, record() { }, log() { }, phase() { } };
  for (const [label, args] of [['compilePrime', ['compile', '--workspace']], ['compileWarm', ['compile', '--workspace']], ['compileWarmRepeat2', ['compile', '--workspace']], ['compileWarmRepeat3', ['compile', '--workspace']], ['txeWarm', ['test', '--package', 'token_test']]]) {
    const result = await timed(label, () => runJobProcess(context, evidence.installation.cli.path, args, { cwd: workflow.projectPath, env: buildEnvironment(evidence.installation) }));
    assert.equal(result.exitCode, 0, result.output.slice(-3000));
    evidence[label] = { exitCode: result.exitCode, tail: result.output.slice(-1500) };
  }
  wallet = await timed('walletCold', () => EmbeddedWallet.create(node, { ephemeral: true, pxe: { proverEnabled: false, syncChainTip: 'proposed' } }));
  const accountData = await getInitialTestAccountsData();
  await timed('importAccounts', async () => { for (const [i, a] of accountData.entries())
    await wallet.createSchnorrInitializerlessAccount(a.secret, a.salt, a.signingKey, `test-${i}`); });
  const [alice, bob] = accountData.map(a => a.address);
  evidence.accounts = [alice.toString(), bob.toString()];
  const artifactPath = workflow.compileCold.result.artifacts.find(a => a.path.endsWith('DevelopmentToken.json')).path;
  const artifact = loadContractArtifact(JSON.parse(await readFile(artifactPath, 'utf8')));
  const deploy = Contract.deploy(wallet, artifact, [1000n, alice], 'constructor', { deployer: alice });
  const instance = await deploy.getInstance();
  const deployed = await timed('deploySubmission', () => deploy.send({ from: alice, wait: 'NO_WAIT' }));
  const deploymentReceipt = await timed('deployInclusionWait', () => receipt(deployed.txHash));
  evidence.deployment = { address: instance.address.toString(), txHash: deployed.txHash.toString(), blockNumber: deploymentReceipt.blockNumber };
  const contract = Contract.at(instance.address, artifact, wallet);
  const balance = account => contract.methods.balance_of(account).simulate({ from: account, includeMetadata: true });
  evidence.initialBalances = await timed('initialViews', async () => [(await balance(alice)).result.toString(), (await balance(bob)).result.toString()]);
  assert.deepEqual(evidence.initialBalances, ['1000', '0']);
  await timed('simulateCold', () => contract.methods.transfer(25n, bob).simulate({ from: alice, includeMetadata: true }));
  await timed('simulateWarm', () => contract.methods.transfer(25n, bob).simulate({ from: alice, includeMetadata: true }));
  const sent = await timed('sendSubmission', () => contract.methods.transfer(25n, bob).send({ from: alice, wait: 'NO_WAIT' }));
  const included = await timed('sendInclusionWait', () => receipt(sent.txHash));
  evidence.transfer = { txHash: sent.txHash.toString(), blockNumber: included.blockNumber };
  evidence.balances = await timed('freshViews', async () => [(await balance(alice)).result.toString(), (await balance(bob)).result.toString()]);
  assert.deepEqual(evidence.balances, ['975', '25']);
  const inspected = await timed('inspect', () => node.getTxReceipt(sent.txHash, { includeTxEffect: true }));
  assert(inspected.txEffect);
  evidence.inspection = { status: inspected.status, executionResult: inspected.executionResult, blockNumber: inspected.blockNumber };
  assert.equal(evidence.proofTelemetry.realProofRequests, 0);
  assert.equal(evidence.proofTelemetry.asyncBackendInitializations, 1);
  assert.equal(evidence.proofTelemetry.srsInitializationRequests, 0);
  evidence.walletInitializations = 1;
  evidence.status = 'passed';
}
catch (error) {
  evidence.error = { message: error.message };
  throw error;
}
finally {
  if (wallet)
    await wallet.stop();
  await Barretenberg.destroySingleton();
  await writeFile(outputPath, JSON.stringify(evidence, null, 2) + '\n');
}
console.log(JSON.stringify({ status: evidence.status, outputPath, timings: evidence.timings }));
