#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { SessionService } from '../dist/development/session.js';
import { ContractService } from '../dist/development/contracts.js';
import { TransactionService } from '../dist/development/transactions.js';
import { Jobs } from '../dist/development/jobs.js';
import { inspectToolchain } from '../dist/development/toolchain.js';
const [deploymentPath, callsPath, outputPath] = process.argv.slice(2);
if (!outputPath)
  throw Error('Usage: node scripts/validate-development-send.mjs DEPLOYMENT_EVIDENCE CALL_EVIDENCE OUTPUT_JSON');
const deployment = JSON.parse(await readFile(deploymentPath, 'utf8'));
const calls = JSON.parse(await readFile(callsPath, 'utf8'));
const options = Object.fromEntries(['projectPath', 'installationRoot', 'nodeExecutable', 'nodeUrl'].map(k => [k, deployment.session[k]]));
const evidence = { checkedAt: new Date().toISOString(), projectPath: options.projectPath, productionSupported: false };
const sessions = new SessionService(async (selection) => { const report = await inspectToolchain(selection); assert.deepEqual(report.diagnostics.filter(d => d.code !== 'unsupported-runtime'), []); evidence.runtime = report; return report; });
const jobs = new Jobs();
const contracts = new ContractService(sessions);
let cancelJob;
let submissionCalls = 0;
const transactions = new TransactionService({ status: id => sessions.status(id), request: async (id, op, input) => { if (op === 'send-submit')
    submissionCalls++; const result = await sessions.request(id, op, input); if (op === 'send-submit' && cancelJob) {
    jobs.cancel(cancelJob);
    cancelJob = undefined;
  } return result; } }, jobs);
sessions.setLifecycleGuard(id => transactions.assertIdle(id));
try {
  const session = await sessions.open(options);
  evidence.session = session;
  const id = session.sessionId;
  const address = deployment.deployed.result.address;
  const account = deployment.deployed.evidence.account;
  await contracts.register(id, { address, artifactPath: deployment.deployed.result.artifact.path });
  const view = minimumBlock => contracts.view(id, { address, account, functionName: 'get_counter', args: [account], minimumBlock });
  evidence.before = await view();
  assert.equal(evidence.before.status, 'succeeded');
  const started = performance.now();
  const send = await transactions.send({ sessionId: id, address, account, functionName: 'increment', args: [account] });
  evidence.sent = await jobs.wait(send.id);
  evidence.sendMs = performance.now() - started;
  assert.equal(evidence.sent.status, 'completed', JSON.stringify(evidence.sent.error));
  evidence.inspected = await transactions.inspect(id, evidence.sent.result.txHash);
  assert(evidence.inspected.effects);
  assert(evidence.inspected.events);
  evidence.after = await view(evidence.sent.result.receipt.blockNumber);
  assert.equal(BigInt(evidence.after.result), BigInt(evidence.before.result) + 1n);
  assert(evidence.after.observedThroughBlock >= evidence.sent.result.receipt.blockNumber);
  const token = calls.calls[0];
  await contracts.register(id, { address: token.address, artifactPath: token.artifact.path });
  const failed = await transactions.send({ sessionId: id, address: token.address, account: token.accountScope[0], functionName: 'transfer', args: [account, '999999'] });
  evidence.failed = await jobs.wait(failed.id);
  assert.equal(evidence.failed.status, 'failed');
  assert.equal(evidence.failed.error.code, 'simulation-failed');
  assert.equal(evidence.failed.evidence.submissionReached, false);
  assert.equal(evidence.failed.evidence.txHash, undefined);
  const cancelled = await transactions.send({ sessionId: id, address, account, functionName: 'increment', args: [account] });
  cancelJob = cancelled.id;
  evidence.cancelled = await jobs.wait(cancelled.id);
  assert.equal(evidence.cancelled.status, 'cancelled');
  assert.equal(evidence.cancelled.result.cancelledWaiting, true);
  assert.equal(evidence.cancelled.result.chainTransactionCancelled, false);
  assert(evidence.cancelled.result.txHash);
  for (let i = 0; i < 30; i++) {
    evidence.cancelledReceipt = await transactions.inspect(id, evidence.cancelled.result.txHash);
    if (evidence.cancelledReceipt.executionResult === 'success')
      break;
    await new Promise(r => setTimeout(r, 500));
  }
  assert.equal(evidence.cancelledReceipt.executionResult, 'success');
  evidence.afterCancelled = await view(evidence.cancelledReceipt.blockNumber);
  assert.equal(BigInt(evidence.afterCancelled.result), BigInt(evidence.after.result) + 1n);
  evidence.submissionCalls = submissionCalls;
  assert.equal(submissionCalls, 3);
  evidence.environment = (await sessions.status(id)).environment;
  assert.equal(evidence.environment.walletInitializations, 1);
  assert.equal(evidence.environment.proofTelemetry.realProofRequests, 0);
  assert.equal(evidence.environment.proofTelemetry.blockedRealProofRequests, 0);
  evidence.status = 'passed';
}
finally {
  await jobs.close();
  await sessions.shutdown();
  await writeFile(outputPath, JSON.stringify(evidence, null, 2) + '\n');
}
console.log(JSON.stringify({ status: evidence.status, outputPath, sendMs: evidence.sendMs, cancelledJob: evidence.cancelled?.id }));
