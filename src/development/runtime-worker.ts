import { SEND_ERROR_MESSAGES, installSendOperations } from "./send-operations.js";
import { readFile, realpath, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import type { EnvironmentStatus, NetworkIdentity, RuntimeOperations, ProofTelemetry, RuntimeProgress } from "./session.js";
import { DEPLOYMENT_ERROR_MESSAGES, installDeploymentOperations } from "./deployment-operations.js";
import { CALL_ERROR_MESSAGES, installCallOperations } from "./call-operations.js";
import { CONTRACT_ERROR_MESSAGES, installContractOperations } from "./contract-operations.js";

export interface RuntimeContext { wallet: any; node: any; network: NetworkIdentity; stateDirectory: string; proofMode?: "fast" | "real"; loadModule(specifier: string): Promise<any>; rpcEvidence: {submissionResponse?: "accepted" | "rejected"; transportFailure: boolean} }
type Handler = (input: any, context: RuntimeContext) => Promise<any>;
const handlers = new Map<string, Handler>();
export function registerRuntimeOperation<K extends keyof RuntimeOperations>(operation: K, handler: (input: RuntimeOperations[K]["input"], context: RuntimeContext) => Promise<RuntimeOperations[K]["output"]>): void {
  if (["configure", "probe", "initialize", "close", "status", "accounts"].includes(operation) || handlers.has(operation)) throw new Error("Duplicate or reserved runtime operation");
  handlers.set(operation, handler);
}
installContractOperations(registerRuntimeOperation);
installSendOperations(registerRuntimeOperation);
installCallOperations(registerRuntimeOperation);
installDeploymentOperations(registerRuntimeOperation);
const OPERATION_ERROR_MESSAGES: Record<string, string> = { "stale-session": "This session was invalidated by chain replacement; explicitly reset its wallet state.", "session-state-corrupt": "The persisted chain anchor is invalid; inspect or reset this session state.", "node-unavailable": "The selected node is unavailable; inspect transaction evidence before considering another mutation.", "real-proving-disabled": "Real proof generation is disabled in this fast session.", ...CONTRACT_ERROR_MESSAGES, ...CALL_ERROR_MESSAGES, ...DEPLOYMENT_ERROR_MESSAGES, ...SEND_ERROR_MESSAGES };

async function main() {
  const root = await realpath(process.argv[2]); const url = process.argv[3];
  const installationUrl = pathToFileURL(join(root, "package.json")).href;
  const modules = new Map<string, any>();
  const loadModule = async (specifier: string) => {
    if (modules.has(specifier)) return modules.get(specifier);
    // Resolve import conditions, not require conditions: dual packages expose separate
    // singleton instances through CJS and ESM. Guards must wrap the instance the SDK uses.
    const path = await realpath(fileURLToPath(import.meta.resolve(specifier, installationUrl))); const rel = relative(root, path);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("SDK export resolves outside selected installation");
    const module = await import(pathToFileURL(path).href); modules.set(specifier, module); return module;
  };
  const proofTelemetry: ProofTelemetry = { guardInstalled: false, realProofRequests: 0, realProofCompletions: 0, blockedRealProofRequests: 0, realProofDurationMs: 0, asyncBackendRequests: 0, asyncBackendInitializations: 0, srsInitializationRequests: 0 };
  let configured = false; let realProving = false; let proving: any;
  let activeRequestId: number | undefined;
  let destroyBackend: (() => Promise<void>) | undefined;
  const progress = (phase: RuntimeProgress["phase"]) => { if (process.connected && activeRequestId !== undefined) process.send?.({ id: activeRequestId, progress: { phase, proofTelemetry: { ...proofTelemetry } } }); };
  const rpcEvidence: RuntimeContext["rpcEvidence"] = {transportFailure:false};
  let context: RuntimeContext | undefined; let node: any; let network: NetworkIdentity | undefined;
  let closed = false; let queue = Promise.resolve();
  let stateDirectory: string | undefined;
  let anchor: { blockNumber: number; blockHash: string } | undefined;
  let invalidationReason: string | undefined;
  const components: Record<string, string> = {};
  const saveAnchor = async (value: { blockNumber: number; blockHash: string }) => {
    if (!stateDirectory || (anchor?.blockNumber === value.blockNumber && anchor?.blockHash === value.blockHash)) return;
    const path = join(stateDirectory, "chain-anchor.json"); const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" }); await rename(temporary, path); anchor = value;
  };
  const stop = async () => { if (closed) return; closed = true; try { if (context) await context.wallet.stop(); } finally { await destroyBackend?.(); } };
  const inspect = async (): Promise<EnvironmentStatus> => {
    const info = await node.getNodeInfo();
    if (info.realProofs !== false || info.l1ChainId !== network!.l1ChainId || info.rollupVersion !== network!.rollupVersion || info.l1ContractAddresses.rollupAddress.toString() !== network!.rollupAddress || info.nodeVersion !== network!.nodeVersion ||
        components.l2ProtocolContractsHash !== network!.l2ProtocolContractsHash || components.l2CircuitsVkTreeRoot !== network!.l2CircuitsVkTreeRoot) invalidationReason ??= "Selected node identity, protocol components, or proof requirements changed.";
    const blockNumber = await node.getBlockNumber();
    if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) throw new Error("Invalid node progress");
    if (!invalidationReason && anchor) {
      if (blockNumber < anchor.blockNumber) invalidationReason = "Observed chain progress regressed below the persisted block anchor.";
      else {
        const previous = await node.getBlockData(anchor.blockNumber);
        if (!previous || previous.blockHash.toString() !== anchor.blockHash) invalidationReason = "The persisted block anchor was replaced or is no longer available.";
      }
    }
    if (!invalidationReason) {
      const latest = await node.getBlockData(blockNumber);
      if (!latest) throw new Error("Latest block metadata is unavailable");
      await saveAnchor({ blockNumber, blockHash: latest.blockHash.toString() });
    }
    return { chain: { status: invalidationReason ? "replaced" : "current", anchor, reason: invalidationReason }, network: network!, observedAt: new Date().toISOString(), blockNumber, cached: false, proofTelemetry: { ...proofTelemetry }, pxe: { freshness: "unknown", reason: "Wallet public API does not expose a synchronized block; account listing does not synchronize private state." }, workerPid: process.pid, walletInitializations: context ? 1 : 0 };
  };
  const execute = async (operation: string, input: any) => {
    if (operation === "close") { await stop(); return { closed: true }; }
    if (closed) throw new Error("Worker is closing");
    if (operation === "configure") {
      if (configured) throw new Error("Worker proof mode cannot be changed in place");
      configured = true; realProving = input.proofMode === "real"; proving = input.proving;
      if (realProving) {
        if (!proving || proving.backend !== "NativeUnixSocket") throw new Error("Missing validated proving configuration");
        // The native backend inherits CRS_PATH; its crsPath option applies only to WASM.
        process.env.CRS_PATH = proving.crsPath;
      }
      // Install guards before any SDK import can initialize its required hashing singleton.
      const { Barretenberg } = await loadModule("@aztec-foundation/bb.js");
      const originalBackend = Barretenberg.new;
      Barretenberg.new = async function (options: Record<string, unknown> = {}) {
        proofTelemetry.asyncBackendRequests++;
        const backend = await originalBackend.call(this, realProving ? { ...options, ...proving } : { ...options, skipSrsInit: true });
        proofTelemetry.asyncBackendInitializations++; return backend;
      };
      const originalSrs = Barretenberg.prototype.initSRSChonk;
      Barretenberg.prototype.initSRSChonk = async function (...args: unknown[]) {
        proofTelemetry.srsInitializationRequests++;
        if (!realProving) throw Object.assign(new Error("Proving SRS initialization is disabled in fast mode."), { code: "real-proving-disabled" });
        return originalSrs.apply(this, args);
      };
      destroyBackend = () => Barretenberg.destroySingleton();
      return { configured: true };
    }
    if (!configured) throw new Error("Worker proof configuration is required");
    if (operation === "probe") {
      const { createAztecNodeClient } = await loadModule("@aztec-labs/aztec.js/node");
      const { jsonStringify } = await loadModule("@aztec-labs/foundation/json-rpc");
      node = createAztecNodeClient(url, { fetch: async (host: string, body: unknown, headers: Record<string, string> = {}) => {
        try {
          const response = await fetch(host, { method: "POST", body: jsonStringify(body), headers: { "content-type": "application/json", ...headers }, signal: AbortSignal.timeout(15000) });
          if (!response.ok) throw new Error(`Node returned HTTP ${response.status}`);
          for (const name of ["l2ProtocolContractsHash", "l2CircuitsVkTreeRoot"]) {
            const value = response.headers.get(`x-aztec-${name}`); if (value !== null) components[name] = value;
          }
          const payload = await response.json();
          const requests = Array.isArray(body) ? body : [body];
          const responses = Array.isArray(payload) ? payload : [payload];
          for (const request of requests as any[]) if (typeof request?.method === "string" && /(?:^|_)sendTx$/.test(request.method)) {
            const reply = responses.find((value: any) => value?.id === request.id);
            if (reply) rpcEvidence.submissionResponse = reply.error ? "rejected" : "accepted";
          }
          return { response: payload, headers: response.headers };
        } catch (error) { rpcEvidence.transportFailure = true; throw error; }
      } });
      const info = await node.getNodeInfo();
      if (info.realProofs !== false || info.l1ChainId !== 31337 || !input.expectedNodeVersion || info.nodeVersion !== input.expectedNodeVersion) throw Object.assign(new Error("Fast mode requires the validated SDK/node version, local development chain 31337, and reported realProofs=false."), { code: "incompatible-node" });
      network = { nodeVersion: info.nodeVersion, l1ChainId: info.l1ChainId, rollupVersion: info.rollupVersion, rollupAddress: info.l1ContractAddresses.rollupAddress.toString(), realProofs: false, l2ProtocolContractsHash: components.l2ProtocolContractsHash, l2CircuitsVkTreeRoot: components.l2CircuitsVkTreeRoot };
      return network;
    }
    if (operation === "initialize") {
      if (!network || context) throw new Error("Worker has not been probed or already owns a wallet");
      stateDirectory = input.stateDirectory;
      const anchorPath = join(stateDirectory!, "chain-anchor.json");
      try {
        if (await realpath(anchorPath) !== anchorPath) throw new Error("Anchor alias");
        const saved = JSON.parse(await readFile(anchorPath, "utf8"));
        if (!Number.isSafeInteger(saved.blockNumber) || saved.blockNumber < 0 || typeof saved.blockHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(saved.blockHash)) throw new Error("Invalid anchor");
        anchor = saved;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") invalidationReason = "The persisted chain anchor is corrupt; explicitly reset this session state.";
      }
      const initial = await inspect();
      if (initial.chain.status === "replaced") return initial;
      const { EmbeddedWallet } = await loadModule("@aztec-labs/wallets/embedded");
      const { BBPrivateKernelProver } = await loadModule("@aztec-labs/bb-prover/client");
      if (typeof BBPrivateKernelProver?.prototype?.createChonkProof !== "function") throw new Error("Validated proof guard API is unavailable");
      const originalProof = BBPrivateKernelProver.prototype.createChonkProof;
      BBPrivateKernelProver.prototype.createChonkProof = async function (...args: unknown[]) {
        proofTelemetry.realProofRequests++;
        if (!realProving) { proofTelemetry.blockedRealProofRequests++; throw Object.assign(new Error("Real proof generation is disabled in this fast session."), { code: "real-proving-disabled" }); }
        const start = performance.now(); progress("proving");
        try { const proof = await originalProof.apply(this, args); proofTelemetry.realProofCompletions++; proofTelemetry.realProofDurationMs += performance.now() - start; progress("proof-generated"); return proof; }
        catch (error) { proofTelemetry.realProofDurationMs += performance.now() - start; progress("proof-failed"); throw error; }
      };
      proofTelemetry.guardInstalled = true;
      const wallet = await EmbeddedWallet.create(node, { pxe: { proverEnabled: realProving, ...(realProving ? { proverOrOptions: proving } : {}), syncChainTip: "proposed", dataDirectory: input.stateDirectory } });
      context = { wallet, node, network, stateDirectory: input.stateDirectory, proofMode: realProving ? "real" : "fast", loadModule, rpcEvidence };
      const { getInitialTestAccountsData } = await loadModule("@aztec-labs/accounts/testing");
      const known = new Set((await wallet.getAccounts()).map((a: any) => a.item.toString()));
      const accounts = await getInitialTestAccountsData();
      for (const [index, account] of accounts.entries()) if (!known.has(account.address.toString())) await wallet.createSchnorrInitializerlessAccount(account.secret, account.salt, account.signingKey, `test-${index}`);
      return inspect();
    }
    if (operation === "status") return inspect();
    rpcEvidence.transportFailure = false;
    const environment = await inspect();
    if (environment.chain.status === "replaced") throw Object.assign(new Error("Session invalidated"), { code: "stale-session" });
    if (!context) throw new Error("Session wallet is not initialized");
    if (operation === "accounts") return (await context.wallet.getAccounts()).map((account: any) => ({ address: account.item.toString(), alias: account.alias }));
    const handler = handlers.get(operation); if (!handler) throw new Error("Unsupported structured runtime operation");
    return handler(input, context);
  };
  process.on("message", (message: any) => {
    if (!Number.isSafeInteger(message?.id) || typeof message.operation !== "string") return;
    queue = queue.then(async () => {
      activeRequestId = message.id;
      try { const result = await execute(message.operation, message.input); if (process.connected) process.send?.({ id: message.id, ok: true, result }); }
      catch (error) {
        const reportedCode = (error as { code?: string }).code;
        const code = reportedCode && (["incompatible-node", "network-changed"].includes(reportedCode) || Object.hasOwn(OPERATION_ERROR_MESSAGES, reportedCode)) ? reportedCode : message.operation === "probe" || rpcEvidence.transportFailure ? "node-unavailable" : "runtime-failed";
        const safeMessage = OPERATION_ERROR_MESSAGES[code] ?? (["incompatible-node", "network-changed"].includes(code) ? (error as Error).message : "Runtime operation failed. Check installation, node availability, and session state.");
        if (process.connected) process.send?.({ id: message.id, ok: false, error: { code, message: safeMessage } });
      }
      if (message.operation === "close" && process.connected) process.disconnect();
      activeRequestId = undefined;
    });
  });
  process.once("disconnect", () => { void queue.then(stop).catch(() => { process.exitCode = 1; }); });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void queue.then(stop).finally(() => { if (process.connected) process.disconnect(); }); });
}
if (process.send) await main();
