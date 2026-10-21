#!/usr/bin/env node
import { fork } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const publicSpecifiers = [
  '@aztec-labs/aztec.js/node', '@aztec-labs/aztec.js/contracts',
  '@aztec-labs/wallets/embedded', '@aztec-labs/pxe/config', '@aztec-labs/foundation/json-rpc',
];
const componentKeys = ['l1ChainId', 'l1RollupAddress', 'rollupVersion', 'l2ProtocolContractsHash', 'l2CircuitsVkTreeRoot', 'packageVersion'];
const errorText = error => (error instanceof Error ? error.message : String(error)).slice(0, 4000);
function inside(root, resolved) {
  const relative = path.relative(root, resolved);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function send(message) {
  if (process.connected) await new Promise((resolve, reject) => {
    process.send(message, error => error ? reject(error) : resolve());
  });
}

async function worker(rootArgument, url, expectedNode) {
  const evidence = { phase: 'installation', modules: [], wallet: { created: false, stopped: false } };
  let wallet;
  let passed = false;
  try {
    const root = await realpath(rootArgument);
    if (await realpath(process.execPath) !== expectedNode) throw new Error('Selected Node executable was not used');
    evidence.runtimeNode = { path: process.execPath, version: process.version };
    const require = createRequire(path.join(root, 'package.json'));
    const modules = new Map();
    evidence.phase = 'module-loading';
    for (const specifier of publicSpecifiers) {
      const entry = { specifier, loaded: false };
      evidence.modules.push(entry);
      try {
        entry.path = await realpath(require.resolve(specifier));
        if (!inside(root, entry.path)) throw new Error(`Public export resolves outside selected installation: ${specifier}`);
        modules.set(specifier, await import(pathToFileURL(entry.path).href));
        entry.loaded = true;
      } catch (error) {
        entry.error = errorText(error);
        throw error;
      } finally { await send({ kind: 'progress', evidence }); }
    }
    const { createAztecNodeClient } = modules.get('@aztec-labs/aztec.js/node');
    const { EmbeddedWallet } = modules.get('@aztec-labs/wallets/embedded');
    const { jsonStringify } = modules.get('@aztec-labs/foundation/json-rpc');
    if (typeof createAztecNodeClient !== 'function' || typeof EmbeddedWallet?.create !== 'function' || typeof jsonStringify !== 'function') {
      throw new Error('Candidate public SDK exports do not expose the required APIs');
    }
    const observedHeaders = {};
    const transport = async (host, body, extraHeaders = {}) => {
      const response = await fetch(host, {
        method: 'POST', body: jsonStringify(body),
        headers: { 'content-type': 'application/json', ...extraHeaders },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`Node RPC returned HTTP ${response.status}`);
      for (const key of componentKeys) {
        const value = response.headers.get(`x-aztec-${key}`);
        if (value !== null) {
          if (observedHeaders[key] !== undefined && observedHeaders[key] !== value) throw new Error(`Node component identity changed during probe: ${key}`);
          observedHeaders[key] = value;
        }
      }
      return { response: await response.json(), headers: response.headers };
    };
    evidence.phase = 'node-identity';
    await send({ kind: 'progress', evidence });
    const node = createAztecNodeClient(url, { fetch: transport });
    const info = await node.getNodeInfo();
    evidence.node = {
      url, nodeVersion: info.nodeVersion, l1ChainId: info.l1ChainId, rollupVersion: info.rollupVersion,
      rollupAddress: info.l1ContractAddresses.rollupAddress.toString(),
      realProofs: info.realProofs, componentHeaders: observedHeaders,
    };
    if (info.realProofs !== false) throw new Error('Fast-mode candidate requires the node to report realProofs=false');
    evidence.phase = 'wallet-creation';
    evidence.fastMode = { requestedProverEnabled: false, nodeRealProofs: false, realProofGenerationTested: false };
    await send({ kind: 'progress', evidence });
    wallet = await EmbeddedWallet.create(node, { ephemeral: true, pxe: { proverEnabled: false } });
    evidence.wallet.created = true;
    if (typeof wallet.stop !== 'function') throw new Error('Candidate wallet has no public stop method');
    passed = true;
  } catch (error) { evidence.error = errorText(error); }
  finally {
    if (wallet) {
      evidence.phase = 'wallet-shutdown';
      await send({ kind: 'progress', evidence });
      try { await wallet.stop(); evidence.wallet.stopped = true; }
      catch (error) { passed = false; evidence.shutdownError = errorText(error); }
    }
    evidence.phase = passed ? 'complete' : 'failed';
    process.exitCode = passed ? 0 : 1;
    await send({ kind: 'complete', evidence, passed });
    process.disconnect();
  }
}

async function probe(root, nodeExecutable, nodeUrl, timeoutMs) {
  const started = performance.now();
  const env = { ...process.env };
  delete env.NODE_OPTIONS; delete env.NODE_PATH;
  const child = fork(scriptPath, ['--worker', root, nodeUrl, nodeExecutable], {
    execPath: nodeExecutable, execArgv: [], env, cwd: root,
    detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let evidence = { phase: 'worker-start', modules: [] };
  let completed = false, passed = false, timedOut = false;
  const logs = { stdoutBytes: 0, stderrBytes: 0 };
  child.stdout.on('data', data => { logs.stdoutBytes += data.length; });
  child.stderr.on('data', data => { logs.stderrBytes += data.length; });
  child.on('message', message => {
    if (message?.kind === 'progress' || message?.kind === 'complete') evidence = message.evidence;
    if (message?.kind === 'complete') { completed = true; passed = message.passed === true; }
  });
  const killOwned = () => {
    if (!child.pid) return;
    try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const onSignal = () => { killOwned(); process.exitCode = 1; };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  const outcome = await new Promise(resolve => {
    const timer = setTimeout(() => { timedOut = true; killOwned(); }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); resolve({ error: errorText(error) }); });
    child.once('exit', (exitCode, signal) => { clearTimeout(timer); resolve({ exitCode, signal }); });
  });
  process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
  const naturalExit = !timedOut && !outcome.error && outcome.signal === null;
  return {
    status: passed && completed && naturalExit && outcome.exitCode === 0 ? 'candidate-passed' : 'candidate-failed',
    productionSupported: false, evidence, shutdown: { naturalExit, completed, timedOut, ...outcome }, logs,
    elapsedMs: Math.round(performance.now() - started),
  };
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node scripts/validate-development-candidate.mjs --installation-root /absolute/aztec --node-executable /absolute/node --node-url http://127.0.0.1:8080 [--timeout-ms 120000]'); return;
  }
  const options = {};
  const allowed = new Set(['--installation-root', '--node-executable', '--node-url', '--timeout-ms']);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!allowed.has(key) || options[key] !== undefined || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Invalid or duplicate argument: ${key}`);
    options[key] = args[index + 1];
  }
  for (const key of ['--installation-root', '--node-executable']) {
    if (!options[key] || !path.isAbsolute(options[key])) throw new Error(`${key} must be an explicit absolute path`);
  }
  if (!options['--node-url']) throw new Error('--node-url is required; supply an existing local development node');
  const url = new URL(options['--node-url']);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('--node-url must be an explicitly selected loopback HTTP(S) endpoint without credentials, query, or fragment');
  }
  const timeoutMs = Number(options['--timeout-ms'] ?? 120000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new Error('--timeout-ms must be an integer from 1000 to 300000');
  const root = await realpath(options['--installation-root']);
  const nodeExecutable = await realpath(options['--node-executable']);
  const { inspectToolchain } = await import('../dist/development/toolchain.js');
  const installation = await inspectToolchain({ installationRoot: root, nodeExecutable });
  const structuralErrors = installation.diagnostics.filter(d => d.code !== 'unsupported-runtime');
  const result = structuralErrors.length ? {
    status: 'candidate-failed', productionSupported: false, error: 'Resolve installation diagnostics before candidate execution.',
  } : await probe(root, nodeExecutable, url.href, timeoutMs);
  console.log(JSON.stringify({ schemaVersion: 1, checkedAt: new Date().toISOString(), installation, ...result }, null, 2));
  if (result.status !== 'candidate-passed') process.exitCode = 1;
}

try {
  if (process.argv[2] === '--worker') {
    if (!process.send) throw new Error('The worker requires the integration harness IPC channel');
    await worker(process.argv[3], process.argv[4], process.argv[5]);
  } else { await main(process.argv.slice(2)); }
} catch (error) {
  console.log(JSON.stringify({ status: 'candidate-failed', productionSupported: false, error: errorText(error) }, null, 2));
  process.exitCode = 1;
}
