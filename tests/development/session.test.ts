import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let SessionService: typeof import("../../src/development/session.js").SessionService;
const roots: string[] = [];
const services: InstanceType<typeof SessionService>[] = [];
beforeAll(async () => {
  ({ SessionService } = await import("../../dist/development/session.js"));
}, 30000);
afterEach(async () => { await Promise.all(services.splice(0).map(s => s.shutdown().catch(() => {}))); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "aztec-session-test-")); roots.push(root);
  const projectPath = join(root, "project"); await mkdir(projectPath);
  const info = { nodeVersion: "6.0.0-rc.3", l1ChainId: 31337, rollupVersion: 1, l1ContractAddresses: { rollupAddress: "0x123" }, realProofs: false, ...overrides };
  async function module(name: string, subpath: string, code: string) {
    const directory = join(root, "node_modules", "@aztec-labs", name); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({ name: `@aztec-labs/${name}`, type: "module", exports: { [`./${subpath}`]: "./index.js" } }));
    await writeFile(join(directory, "index.js"), code);
  }
  await writeFile(join(root, "node-info.json"), JSON.stringify(info));
  await module("aztec.js", "node", `import { readFile } from 'node:fs/promises'; export const createAztecNodeClient=()=>({getNodeInfo:async()=>JSON.parse(await readFile(${JSON.stringify(join(root, "node-info.json"))},'utf8')),getBlockNumber:async()=>JSON.parse(await readFile(${JSON.stringify(join(root, "node-info.json"))},'utf8')).blockNumber??7,getBlockData:async()=>({blockHash:JSON.parse(await readFile(${JSON.stringify(join(root, "node-info.json"))},'utf8')).blockHash??'0x'+'1'.repeat(64)})});`);
  await module("foundation", "json-rpc", "export const jsonStringify=JSON.stringify;");
  await module("accounts", "testing", `export const getInitialTestAccountsData=async()=>[0,1,2].map(i=>({address:'address'+i,secret:'secret'+i,salt:0,signingKey:'key'+i}));`);
  await module("bb-prover", "client", "export class BBPrivateKernelProver { async createChonkProof(){throw Error('unguarded real proof');} }");
  const bbDirectory = join(root, "node_modules", "@aztec-foundation", "bb.js"); await mkdir(bbDirectory, { recursive: true });
  await writeFile(join(bbDirectory, "package.json"), JSON.stringify({ name: "@aztec-foundation/bb.js", type: "module", exports: { ".": { require: "./index.cjs", default: "./index.js" } } }));
  await writeFile(join(bbDirectory, "index.cjs"), "module.exports={Barretenberg:class {static async new(){throw Error('wrong CommonJS singleton');}}};");
  await writeFile(join(bbDirectory, "index.js"), "export class Barretenberg { static async new(options){if(options?.skipSrsInit!==true)throw Error('SRS not disabled'); return new Barretenberg();} async initSRSChonk(){throw Error('unguarded SRS');} static async destroySingleton(){} }");
  await module("wallets", "embedded", `import {Barretenberg} from '@aztec-foundation/bb.js'; import {BBPrivateKernelProver} from '@aztec-labs/bb-prover/client'; import {readFile,writeFile} from 'node:fs/promises'; export class EmbeddedWallet { static async create(node,{pxe}) { if(pxe.proverEnabled!==false)throw Error('proving enabled'); if((await node.getNodeInfo()).attemptProof) await new BBPrivateKernelProver().createChonkProof(); if((await node.getNodeInfo()).attemptBackend) await Barretenberg.new(); console.log('SDK log must not reach MCP stdout'); const path=pxe.dataDirectory+'/accounts.json'; let accounts=JSON.parse(await readFile(path,'utf8').catch(()=>'[]')); return {getAccounts:async()=>{const delay=(await node.getNodeInfo()).accountDelayMs??0;if(delay)await new Promise(resolve=>setTimeout(resolve,delay));return accounts;},createSchnorrInitializerlessAccount:async(secret,salt,key,alias)=>{accounts.push({item:'address'+secret.slice(-1),alias});await writeFile(path,JSON.stringify(accounts));},stop:async()=>{await writeFile(pxe.dataDirectory+'/stopped','yes');}};}}`);
  const report: any = { installationRoot: root, target: "6.0.0-rc.6", supported: false, runtimeNode: { path: process.execPath, version: process.version }, compiler: {}, cli: {}, packages: [{ name: "@aztec-labs/aztec.js", version: "6.0.0-rc.3" }], provenance: {}, publicExports: [], diagnostics: [] };
  const create = () => { const service = new SessionService(async () => report); services.push(service); return service; };
  return { root, options: { projectPath, installationRoot: root, nodeExecutable: process.execPath, nodeUrl: "http://127.0.0.1:8080" }, create };
}
describe("persistent session worker", () => {
  it("reuses one worker, persists accounts across service restarts and rejects stale IDs", async () => {
    const { create, options } = await fixture(); const first = create(); const opened = await first.open(options);
    expect(opened.environment.proofTelemetry).toMatchObject({ guardInstalled: true, realProofRequests: 0, realProofCompletions: 0 });
    const accounts = await first.accounts(opened.sessionId); expect(accounts).toHaveLength(3); expect(JSON.stringify(accounts)).not.toMatch(/secret|signingKey/);
    expect((await first.open(options)).sessionId).toBe(opened.sessionId);
    expect((await first.status(opened.sessionId)).environment.workerPid).toBe(opened.environment.workerPid);
    await first.close(opened.sessionId); expect(await readFile(join(opened.stateDirectory, "stopped"), "utf8")).toBe("yes");
    const second = create(); const reopened = await second.open(options); expect(reopened.sessionId).not.toBe(opened.sessionId);
    expect(await second.accounts(reopened.sessionId)).toEqual(accounts);
    await expect(second.status(opened.sessionId)).rejects.toThrow("stale-session");
  });
  it("rejects competing ownership and switching projects without close", async () => {
    const { create, options, root } = await fixture(); const first = create(); await first.open(options);
    await expect(create().open(options)).rejects.toThrow("store-in-use");
    const other = join(root, "other"); await mkdir(other);
    await expect(first.open({ ...options, projectPath: other })).rejects.toThrow("session-already-open");
  });
  it.each([{ realProofs: true }, { l1ChainId: 1 }, { nodeVersion: "5.2.0" }])("rejects incompatible node %j", async overrides => {
    const { create, options } = await fixture(overrides); await expect(create().open(options)).rejects.toThrow("incompatible-node");
  });
  it("rejects unavailable nodes and proof modes without creating a wallet", async () => {
    const { create, options, root } = await fixture(); await rm(join(root, "node-info.json"));
    await expect(create().open(options)).rejects.toThrow("node-unavailable");
    await expect(create().open({ ...options, proofMode: "real" } as any)).rejects.toThrow("proving-configuration-required");
    await expect(create().open({ ...options, proofMode: "fast", proving: { backend: "NativeUnixSocket", crsPath: "/tmp" } })).rejects.toThrow("invalid-proving-configuration");
  });
  it("recovers a lock only after both recorded processes are dead", async () => {
    const { create, options } = await fixture(); const service = create(); const opened = await service.open(options); await service.close(opened.sessionId);
    const lock = join(opened.stateDirectory, "owner.lock");
    await writeFile(lock, JSON.stringify({ owner: "aztec-mcp", pid: 2147483647, workerPid: 2147483646, token: "dead" }));
    const restored = await service.open(options); expect(restored.stateDirectory).toBe(opened.stateDirectory);
  });
  it("replaces a dead worker in the same service while preserving an unresolved transaction", async () => {
    const { create, options } = await fixture(); const service = create(); const opened = await service.open(options);
    const jobId = "00000000-0000-4000-8000-000000000123";
    const directory = join(opened.stateDirectory, "jobs"); await mkdir(directory);
    const record = { schemaVersion: 1, jobId, kind: "send", state: "unknown-outcome", sessionId: opened.sessionId,
      stateDirectory: opened.stateDirectory, projectPath: opened.projectPath, networkIdentity: opened.networkIdentity,
      runtimeIdentity: opened.runtimeIdentity, proofMode: "fast", proofValidityEstablished: false,
      account: `0x${"1".repeat(64)}`, address: `0x${"2".repeat(64)}`, txHash: `0x${"3".repeat(64)}`,
      artifact: { path: join(options.projectPath, "fixture.json"), contentHash: "a".repeat(64) },
      intent: { functionName: "increment" }, submissionAttempted: true, submissionReached: true,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const journal = join(directory, `${jobId}.json`); await writeFile(journal, JSON.stringify(record));
    process.kill(opened.environment.workerPid, "SIGKILL");
    await new Promise(resolve => setTimeout(resolve, 75));
    const reopened = await service.open(options);
    expect(reopened.sessionId).not.toBe(opened.sessionId);
    expect(reopened.stateDirectory).toBe(opened.stateDirectory);
    expect(JSON.parse(await readFile(journal, "utf8"))).toEqual(record);
    await expect(service.close(reopened.sessionId)).rejects.toThrow("unresolved-submission");
  });
  it("blocks real proof creation if an SDK code path unexpectedly requests it", async () => {
    const { create, options } = await fixture({ attemptProof: true });
    await expect(create().open(options)).rejects.toThrow("real-proving-disabled");
  });
  it("permits required hashing while disabling SRS initialization in the ESM backend", async () => {
    const { create, options } = await fixture({ attemptBackend: true });
    const session = await create().open(options);
    expect(session.environment.proofTelemetry).toMatchObject({ asyncBackendInitializations: 1, srsInitializationRequests: 0, realProofRequests: 0 });
  });
  it("allows an explicitly requested reset to repair a corrupt persisted chain anchor", async () => {
    const { create, options } = await fixture(); const service = create();
    const opened = await service.open(options); await service.close(opened.sessionId);
    await writeFile(join(opened.stateDirectory, "chain-anchor.json"), "invalid JSON");
    const invalidated = await service.open(options);
    expect(invalidated.state).toBe("invalidated");
    expect(invalidated.environment.walletInitializations).toBe(0);
    const reset = await service.reset(invalidated.sessionId);
    expect(reset.state).toBe("ready"); expect(reset.sessionId).not.toBe(invalidated.sessionId);
  });
  it("notices changed proof requirements during status", async () => {
    const { create, options, root } = await fixture(); const service = create(); const opened = await service.open(options);
    const path = join(root, "node-info.json"); const info = JSON.parse(await readFile(path, "utf8")); info.realProofs = true; await writeFile(path, JSON.stringify(info));
    expect((await service.status(opened.sessionId)).state).toBe("invalidated");
    await expect(service.accounts(opened.sessionId)).rejects.toThrow("stale-session");
  });
});


describe("safe session lifecycle", () => {
  it("drains queued calls, rejects new admissions, then switches with a fresh ID", async () => {
    const { create, options, root } = await fixture({ accountDelayMs: 75 }); const service = create(); const first = await service.open(options);
    const other = join(root, "other-project"); await mkdir(other); const order: string[] = [];
    const pending = service.accounts(first.sessionId).then(value => { order.push("accounts"); return value; });
    const switching = service.switchTo(first.sessionId, { ...options, projectPath: other }).then(value => { order.push("switched"); return value; });
    await expect(service.status(first.sessionId)).rejects.toThrow("session-transitioning");
    expect(await pending).toHaveLength(3); const next = await switching;
    expect(order).toEqual(["accounts", "switched"]); expect(next.sessionId).not.toBe(first.sessionId);
    expect(next.projectPath).toBe(other); await expect(service.accounts(first.sessionId)).rejects.toThrow("stale-session");
    expect(() => process.kill(first.environment.workerPid, 0)).toThrow();
  });
  it("uses the admission/job guard before touching stores", async () => {
    const { create, options } = await fixture(); const service = create(); const first = await service.open(options);
    service.setLifecycleGuard(() => { throw new Error("session-busy: queued transaction preparation"); });
    await expect(service.close(first.sessionId)).rejects.toThrow("session-busy");
    await expect(service.reset(first.sessionId)).rejects.toThrow("session-busy");
    expect((await service.status(first.sessionId)).sessionId).toBe(first.sessionId);
    service.setLifecycleGuard(() => {}); await service.close(first.sessionId);
  });
  it("blocks unresolved durable submissions including ambiguous dropped receipts", async () => {
    const { create, options } = await fixture(); const service = create(); const first = await service.open(options);
    const directory = join(first.stateDirectory, "jobs"); await mkdir(directory);
    const jobId = "11111111-1111-1111-1111-111111111111"; const path = join(directory, `${jobId}.json`);
    const txHash = `0x${"3".repeat(64)}`;
    const record = { schemaVersion: 1, jobId, kind: "deploy", sessionId: first.sessionId,
      projectPath: first.projectPath, networkIdentity: first.networkIdentity, runtimeIdentity: first.runtimeIdentity,
      proofMode: "fast", proofValidityEstablished: false, account: `0x${"4".repeat(64)}`,
      artifact: { path: join(first.projectPath, "artifact.json"), contentHash: "a".repeat(64) }, intent: { initialize: true },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stateDirectory: first.stateDirectory,
      state: "unknown-outcome", submissionAttempted: true, txHash, receipt: { txHash, status: "dropped", source: "node", scope: "public" } };
    await writeFile(path, JSON.stringify(record)); await expect(service.close(first.sessionId)).rejects.toThrow("unresolved-submission");
    await expect(service.reset(first.sessionId)).rejects.toThrow(jobId);
    await writeFile(path, JSON.stringify({ ...record, state: "included", receipt: { txHash, status: "proposed", executionResult: "success", blockNumber: 7, blockHash: `0x${"1".repeat(64)}`, source: "node", scope: "public" } }));
    await service.close(first.sessionId);
  });
  it("refuses reset for an included marker without matching inclusion evidence", async () => {
    const { create, options } = await fixture(); const service = create(); const first = await service.open(options);
    const directory = join(first.stateDirectory, "jobs"); await mkdir(directory);
    const jobId = "11111111-1111-1111-1111-111111111111";
    await writeFile(join(first.stateDirectory, "registration-marker"), "keep");
    const record = { schemaVersion: 1, jobId, kind: "deploy", sessionId: first.sessionId,
      projectPath: first.projectPath, networkIdentity: first.networkIdentity, runtimeIdentity: first.runtimeIdentity,
      proofMode: "fast", proofValidityEstablished: false, account: `0x${"4".repeat(64)}`,
      artifact: { path: join(first.projectPath, "artifact.json"), contentHash: "a".repeat(64) }, intent: { initialize: true },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stateDirectory: first.stateDirectory,
      state: "included", submissionAttempted: true };
    await writeFile(join(directory, `${jobId}.json`), JSON.stringify(record));
    await expect(service.reset(first.sessionId)).rejects.toThrow("transaction-journal-unavailable");
    expect(await readFile(join(first.stateDirectory, "registration-marker"), "utf8")).toBe("keep");
    expect((await service.status(first.sessionId)).sessionId).toBe(first.sessionId);
  });
  it("resets only the selected MCP store and returns a fresh session", async () => {
    const { create, options } = await fixture(); const service = create(); const first = await service.open(options);
    const source = join(options.projectPath, "source.nr"); await writeFile(source, "contract source");
    const otherNetwork = join(options.projectPath, ".aztec-mcp", "sessions", "other-network"); await mkdir(otherNetwork); await writeFile(join(otherNetwork, "keep"), "keep");
    await writeFile(join(first.stateDirectory, "registration-marker"), "old registration");
    const reset = await service.reset(first.sessionId); expect(reset.sessionId).not.toBe(first.sessionId); expect(reset.state).toBe("ready");
    await expect(readFile(join(first.stateDirectory, "registration-marker"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(source, "utf8")).toBe("contract source"); expect(await readFile(join(otherNetwork, "keep"), "utf8")).toBe("keep");
    await expect(service.accounts(first.sessionId)).rejects.toThrow("stale-session"); expect(await service.accounts(reset.sessionId)).toHaveLength(3);
  });
  it("invalidates ordinary calls after same-height replacement and recovers only through reset", async () => {
    const { create, options, root } = await fixture(); const service = create(); const first = await service.open(options);
    const path = join(root, "node-info.json"); const info = JSON.parse(await readFile(path, "utf8")); info.blockHash = `0x${"2".repeat(64)}`; await writeFile(path, JSON.stringify(info));
    await expect(service.accounts(first.sessionId)).rejects.toThrow("stale-session");
    expect((await service.status(first.sessionId)).state).toBe("invalidated");
    expect((await service.open(options)).state).toBe("invalidated");
    const reset = await service.reset(first.sessionId); expect(reset.state).toBe("ready"); expect(reset.environment.chain.anchor?.blockHash).toBe(info.blockHash);
  });
  it("detects persisted chain regression before reopening the wallet", async () => {
    const { create, options, root } = await fixture(); const firstService = create(); const first = await firstService.open(options); await firstService.close(first.sessionId);
    const path = join(root, "node-info.json"); const info = JSON.parse(await readFile(path, "utf8")); info.blockNumber = 3; await writeFile(path, JSON.stringify(info));
    const nextService = create(); const invalid = await nextService.open(options);
    expect(invalid.state).toBe("invalidated"); expect(invalid.environment.walletInitializations).toBe(0);
    expect((await nextService.reset(invalid.sessionId)).state).toBe("ready");
  });
});
