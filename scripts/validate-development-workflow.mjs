#!/usr/bin/env node
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createDevelopmentBoundary } from '../dist/development/index.js';
import * as policy from '../dist/development/policy.js';
import { CANDIDATE_RUNTIME_PROFILE, networkProfileMismatches } from '../dist/development/runtime-support.js';
import { inspectToolchain } from '../dist/development/toolchain.js';
const [installationRoot, nodeExecutable, nodeUrl, outputPath, mode = 'candidate', incompatibleInstallation] = process.argv.slice(2);
if (!outputPath || !['candidate', 'supported'].includes(mode))
  throw Error('Usage: node scripts/validate-development-workflow.mjs INSTALLATION_ROOT NODE_EXECUTABLE NODE_URL OUTPUT_JSON [candidate|supported] [INCOMPATIBLE_INSTALLATION]');
const identity = 'a37420cea954f5b910d9c6315b6e14a7870bc636f6f5d6dfe90002d7fc36fb68';
const projectPath = await mkdtemp(join(tmpdir(), 'aztec-mcp-workflow-'));
await cp(new URL('../tests/fixtures/development/private-token/', import.meta.url), projectPath, { recursive: true });
process.env.AZTEC_MCP_REPOS_DIR = join(projectPath, 'search-cache');
const { createServer } = await import('../dist/server.js');
const evidence = { schemaVersion: 1, checkedAt: new Date().toISOString(), mode, projectPath, transport: 'MCP Client/InMemoryTransport/Server', timings: [], validation: [], limitations: ['In-memory MCP transport excludes process startup and stdio transport cost.', 'Local borrowed network uses realProofs=false; inclusion establishes no proof validity.'] };
evidence.repositorySync = { configuredCachePath: join(projectPath, 'search-cache/repos'), existsBefore: false };
await assert.rejects(stat(evidence.repositorySync.configuredCachePath), { code: 'ENOENT' });
const save = () => { const samples = evidence.timings.filter(t => t.tool === 'aztec_dev_job' && t.operation === 'status').map(t => t.elapsedMs).sort((a, b) => a - b); const compact = { ...evidence, timings: evidence.timings.filter(t => !(t.tool === 'aztec_dev_job' && t.operation === 'status')), polling: { count: samples.length, medianMs: samples[Math.floor(samples.length / 2)], p95Ms: samples[Math.floor(samples.length * 0.95)], maximumMs: samples.at(-1) } }; return writeFile(outputPath, JSON.stringify(compact, null, 2) + '\n'); };
const selected = { installationRoot, nodeExecutable };
const cold = performance.now();
evidence.installation = await inspectToolchain(selected);
evidence.coldUncachedInspectionMs = performance.now() - cold;
assert.equal(policy.runtimeIdentity(evidence.installation), identity);
let validator;
if (mode === 'candidate') {
  const candidate = policy.createCandidateRuntimeValidator?.(identity);
  assert(candidate, 'Build the candidate validator cache before running acceptance');
  validator = async (selection) => { const started = performance.now(); try {
    return await candidate(selection);
  }
  finally {
    evidence.validation.push({ elapsedMs: performance.now() - started });
  } };
}
let client, server, sessionId;
async function connect(enabled = true) {
  server = await createServer({ developmentEnabled: enabled, docsgptClient: null, loadDevelopment: async () => createDevelopmentBoundary({ validateRuntime: validator }) });
  client = new Client({ name: 'development-acceptance', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
}
async function disconnect() { if (client)
  await client.close(); if (server)
  await server.close(); client = server = undefined; }
async function call(name, args, expectedError) {
  const started = performance.now();
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  const value = response.structuredContent ?? JSON.parse(response.content[0].text);
  evidence.timings.push({ tool: name, operation: args.operation, elapsedMs: performance.now() - started });
  if (expectedError) {
    assert.equal(response.isError, true);
    assert.equal(value.error.code, expectedError);
  }
  else
    assert(!response.isError, JSON.stringify(value));
  return value;
}
async function poll(job) { for (let n = 0; n < 1800; n++) {
  const snapshot = await call('aztec_dev_job', { operation: 'status', jobId: job.id });
  if (['completed', 'failed', 'cancelled', 'timed-out'].includes(snapshot.status))
    return snapshot;
  await new Promise(r => setTimeout(r, 100));
} throw Error('Job did not finish'); }
async function build(operation, extra = {}) { const started = performance.now(); const job = await call('aztec_dev_build', { operation, projectPath, ...selected, ...extra }); const result = await poll(job); assert.equal(result.status, 'completed', JSON.stringify(result.error)); return { ...result, endToEndMs: performance.now() - started }; }
const open = () => call('aztec_dev_session', { operation: 'open', projectPath, ...selected, nodeUrl, proofMode: 'fast' });
let address, alice, bob;
const view = (account, minimumBlock) => call('aztec_dev_contract', { operation: 'view', sessionId, address, account, functionName: 'balance_of', args: [account], ...(minimumBlock === undefined ? {} : { minimumBlock }) });
try {
  await connect(false);
  evidence.searchOnlyCatalog = (await client.listTools()).tools.map(t => t.name);
  assert(!evidence.searchOnlyCatalog.some(n => n.startsWith('aztec_dev_')));
  await disconnect();
  await connect();
  evidence.catalog = (await client.listTools()).tools.map(t => t.name);
  evidence.incompatible = await call('aztec_dev_inspect', { operation: 'environment', installationRoot: '/missing-acceptance-installation', nodeExecutable });
  assert.equal(evidence.incompatible.supported, false);
  const incompatibleRoot = incompatibleInstallation ?? join(installationRoot, '../5.2.0');
  evidence.incompatibleTuple = await call('aztec_dev_inspect', { operation: 'environment', installationRoot: incompatibleRoot, nodeExecutable });
  assert.equal(evidence.incompatibleTuple.supported, false);
  try {
    await client.callTool({ name: 'aztec_dev_build', arguments: { operation: 'compile', projectPath, installationRoot: incompatibleRoot, nodeExecutable } });
    assert.fail('Incompatible runtime admitted');
  }
  catch (error) {
    assert.equal(error.code, -32602);
    assert(error.message.includes('unsupported-runtime'));
    evidence.incompatibleExecution = { code: error.code, message: error.message };
  }
  evidence.compileCold = await build('compile');
  await save();
  const artifact = evidence.compileCold.result.artifacts.find(a => a.contractName === 'DevelopmentToken') ?? evidence.compileCold.result.artifacts.find(a => a.path.endsWith('DevelopmentToken.json'));
  assert(artifact);
  const artifactMtime = (await stat(artifact.path)).mtimeMs;
  evidence.compileWarmSamples = [];
  for (let i = 0; i < 3; i++) {
    evidence.compileWarm = await build('compile');
    evidence.compileWarmSamples.push({ endToEndMs: evidence.compileWarm.endToEndMs, jobMs: evidence.compileWarm.durationMs });
    assert.equal((await stat(artifact.path)).mtimeMs, artifactMtime);
    assert.equal(evidence.compileWarm.result.artifacts.find(a => a.path === artifact.path).contentHash, artifact.contentHash);
  }
  await save();
  evidence.txe = await build('test', { package: 'token_test' });
  await save();
  const sessionStarted = performance.now();
  evidence.opened = await open();
  evidence.coldSessionOpenMs = performance.now() - sessionStarted;
  sessionId = evidence.opened.sessionId;
  assert.deepEqual(networkProfileMismatches(CANDIDATE_RUNTIME_PROFILE.network, evidence.opened.network), []);
  evidence.accounts = await call('aztec_dev_inspect', { operation: 'accounts', sessionId });
  const accounts = evidence.accounts.result ?? evidence.accounts;
  assert(accounts.length >= 2);
  [alice, bob] = accounts.map(a => a.address);
  evidence.alice = alice;
  evidence.bob = bob;
  const source = join(projectPath, 'token_contract/src/main.nr');
  const bytes = await readFile(source);
  await writeFile(source, Buffer.concat([bytes, Buffer.from('\n// stale build probe\n')]));
  evidence.staleArtifact = await call('aztec_dev_contract', { operation: 'deploy', sessionId, buildJobId: evidence.compileWarm.id, artifactPath: artifact.path, account: alice, args: ['1000', alice], initialize: true }, 'stale-artifact');
  await writeFile(source, bytes);
  const deployed = await call('aztec_dev_contract', { operation: 'deploy', sessionId, buildJobId: evidence.compileWarm.id, artifactPath: artifact.path, account: alice, args: ['1000', alice], initialize: true });
  evidence.deployment = await poll(deployed);
  assert.equal(evidence.deployment.status, 'completed', JSON.stringify(evidence.deployment.error));
  address = evidence.deployment.result.address;
  evidence.address = address;
  await save();
  evidence.initialBalances = [await view(alice, evidence.deployment.result.receipt.blockNumber), await view(bob, evidence.deployment.result.receipt.blockNumber)];
  assert.deepEqual(evidence.initialBalances.map(v => v.result), ['1000', '0']);
  evidence.simulateCold = await call('aztec_dev_contract', { operation: 'simulate', sessionId, address, account: alice, functionName: 'transfer', args: ['25', bob] });
  assert.equal(evidence.simulateCold.status, 'succeeded');
  evidence.simulateWarm = await call('aztec_dev_contract', { operation: 'simulate', sessionId, address, account: alice, functionName: 'transfer', args: ['25', bob] });
  assert.equal(evidence.simulateWarm.status, 'succeeded');
  const sent = await call('aztec_dev_contract', { operation: 'send', sessionId, address, account: alice, functionName: 'transfer', args: ['25', bob] });
  evidence.transfer = await poll(sent);
  assert.equal(evidence.transfer.status, 'completed', JSON.stringify(evidence.transfer.error));
  const block = evidence.transfer.result.receipt.blockNumber;
  evidence.balances = [await view(alice, block), await view(bob, block)];
  assert.deepEqual(evidence.balances.map(v => v.result), ['975', '25']);
  for (const value of evidence.balances) {
    assert(value.freshness.synchronizedThroughBlock >= block);
    assert.equal(value.proofValidityEstablished, false);
  }
  evidence.receipt = await call('aztec_dev_inspect', { operation: 'transaction', sessionId, txHash: evidence.transfer.result.txHash });
  assert(evidence.receipt.effects);
  await save();
  const failed = await call('aztec_dev_contract', { operation: 'send', sessionId, address, account: alice, functionName: 'transfer', args: ['999999', bob] });
  evidence.failure = await poll(failed);
  assert.equal(evidence.failure.status, 'failed');
  assert.equal(evidence.failure.evidence.submissionReached, false);
  assert.equal(evidence.failure.evidence.txHash, undefined);
  evidence.beforeRestart = await call('aztec_dev_session', { operation: 'status', sessionId });
  assert.equal(evidence.beforeRestart.environment.walletInitializations, 1);
  const proof = evidence.beforeRestart.environment.proofTelemetry;
  for (const key of ['realProofRequests', 'blockedRealProofRequests', 'srsInitializationRequests'])
    assert.equal(proof[key], 0, key);
  assert.equal(proof.asyncBackendInitializations, 1);
  assert.equal(proof.asyncBackendRequests, 1);
  await call('aztec_dev_session', { operation: 'close', sessionId });
  await disconnect();
  await connect();
  evidence.reopened = await open();
  sessionId = evidence.reopened.sessionId;
  assert.notEqual(sessionId, evidence.opened.sessionId);
  assert.deepEqual((await call('aztec_dev_inspect', { operation: 'accounts', sessionId })).result, accounts);
  evidence.registrationAfterRestart = await call('aztec_dev_inspect', { operation: 'contract', sessionId, address });
  assert.equal(evidence.registrationAfterRestart.ready, true);
  evidence.balancesAfterRestart = [await view(alice, block), await view(bob, block)];
  assert.deepEqual(evidence.balancesAfterRestart.map(v => v.result), ['975', '25']);
  const interrupted = await call('aztec_dev_contract', { operation: 'send', sessionId, address, account: alice, functionName: 'transfer', args: ['1', bob] });
  for (let n = 0; n < 2000; n++) {
    const state = await call('aztec_dev_job', { operation: 'status', jobId: interrupted.id });
    if (state.evidence?.txHash) {
      evidence.interrupted = state;
      assert(!state.finishedAt, 'Inclusion completed before the interruption; rerun against a new fixture');
      process.kill(evidence.reopened.environment.workerPid, 'SIGKILL');
      break;
    }
    if (state.finishedAt)
      throw Error(JSON.stringify(state));
    await new Promise(r => setTimeout(r, 10));
  }
  assert(evidence.interrupted?.evidence.txHash);
  evidence.interruptedTerminal = await poll(interrupted);
  evidence.recoverySession = await open();
  assert.notEqual(evidence.recoverySession.sessionId, sessionId);
  evidence.sameServerRecovery = true;
  sessionId = evidence.recoverySession.sessionId;
  evidence.unresolvedReset = await call('aztec_dev_session', { operation: 'reset', sessionId }, 'unresolved-submission');
  for (let n = 0; n < 60; n++) {
    evidence.recovery = await call('aztec_dev_job', { operation: 'recover', sessionId, jobId: interrupted.id });
    if (evidence.recovery.resolved)
      break;
    await new Promise(r => setTimeout(r, 500));
  }
  assert.equal(evidence.recovery.outcome, 'included');
  assert.equal(evidence.recovery.replayed, false);
  const recoveryBlock = evidence.recovery.receipt.blockNumber;
  evidence.recoveredBalances = [await view(alice, recoveryBlock), await view(bob, recoveryBlock)];
  assert.deepEqual(evidence.recoveredBalances.map(v => v.result), ['974', '26']);
  await save();
  const stateDirectory = evidence.recoverySession.stateDirectory;
  await call('aztec_dev_session', { operation: 'close', sessionId });
  const anchorPath = join(stateDirectory, 'chain-anchor.json');
  const anchor = JSON.parse(await readFile(anchorPath, 'utf8'));
  await writeFile(anchorPath, JSON.stringify({ ...anchor, blockHash: '0x' + '00'.repeat(32) }));
  evidence.chainReplacementFault = { method: 'Changed only this fixture wallet persisted anchor hash; borrowed node was not reset', blockNumber: anchor.blockNumber };
  evidence.invalidated = await open();
  sessionId = evidence.invalidated.sessionId;
  assert.equal(evidence.invalidated.state, 'invalidated');
  await call('aztec_dev_contract', { operation: 'view', sessionId, address, account: alice, functionName: 'balance_of', args: [alice] }, 'stale-session');
  evidence.reset = await call('aztec_dev_session', { operation: 'reset', sessionId });
  sessionId = evidence.reset.sessionId;
  assert.equal(evidence.reset.state, 'ready');
  evidence.afterReset = await call('aztec_dev_inspect', { operation: 'contract', sessionId, address });
  assert(evidence.afterReset.problems.includes('missing-registration'));
  await call('aztec_dev_contract', { operation: 'register', sessionId, address, artifactPath: artifact.path });
  evidence.balanceAfterReset = await view(alice, recoveryBlock);
  assert.equal(evidence.balanceAfterReset.result, '974');
  evidence.finalEnvironment = await call('aztec_dev_session', { operation: 'status', sessionId });
  for (const key of ['realProofRequests', 'blockedRealProofRequests', 'srsInitializationRequests']) assert.equal(evidence.finalEnvironment.environment.proofTelemetry[key], 0, key);
  assert.equal(evidence.finalEnvironment.environment.proofTelemetry.asyncBackendInitializations, 1);
  await call('aztec_dev_session', { operation: 'close', sessionId });
  await assert.rejects(stat(evidence.repositorySync.configuredCachePath), { code: 'ENOENT' });
  evidence.repositorySync.existsAfter = false;
  evidence.status = 'passed';
}
catch (error) {
  evidence.error = { message: error.message, stack: error.stack };
  throw error;
}
finally {
  await disconnect().catch(error => { evidence.shutdownError = error.message; });
  await save();
}
console.log(JSON.stringify({ status: evidence.status, outputPath, projectPath, address, coldCompileMs: evidence.compileCold.endToEndMs, warmCompileMs: evidence.compileWarm.endToEndMs, txeMs: evidence.txe.endToEndMs }));
