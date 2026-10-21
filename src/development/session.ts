import { readTransactionRecords, hasUnresolvedSubmission } from "./transaction-journal.js";
import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, readdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeIdentity, validateSupportedRuntime, type RuntimeValidator } from "./policy.js";
import type { ToolchainReport, ToolchainSelection } from "./toolchain.js";
import { validateProvingConfiguration, type ProvingConfiguration, type ValidatedProvingConfiguration } from "./proving.js";
import { validateSupportedNetwork } from "./runtime-support.js";

export interface SessionOpenOptions extends ToolchainSelection { projectPath: string; nodeUrl: string; proofMode?: "fast" | "real"; proving?: ProvingConfiguration }
export interface NetworkIdentity { nodeVersion: string; l1ChainId: number; rollupVersion: number; rollupAddress: string; realProofs: false; l2ProtocolContractsHash?: string; l2CircuitsVkTreeRoot?: string }
export interface SessionAccount { address: string; alias: string }
export interface ProofTelemetry {
  guardInstalled: boolean; realProofRequests: number; realProofCompletions: number;
  blockedRealProofRequests: number; realProofDurationMs: number;
  asyncBackendRequests: number; asyncBackendInitializations: number;
  srsInitializationRequests: number;
}
export interface RuntimeProgress { phase: "proving" | "proof-generated" | "proof-failed"; proofTelemetry: ProofTelemetry }
export interface EnvironmentStatus {
  chain: { status: "current" | "replaced"; anchor?: { blockNumber: number; blockHash: string }; reason?: string };
  network: NetworkIdentity; observedAt: string; blockNumber: number; cached: false;
  pxe: { freshness: "unknown"; reason: string }; proofTelemetry: ProofTelemetry; workerPid: number; walletInitializations: number;
}
export interface SessionSnapshot {
  state: "ready" | "invalidated"; invalidationReason?: string;
  sessionId: string; projectPath: string; installationRoot: string; nodeExecutable: string; nodeUrl: string;
  networkIdentity: string; network: NetworkIdentity; runtimeIdentity: string; runtime: ToolchainReport;
  proofMode: "fast" | "real"; proverEnabled: boolean; proving?: ValidatedProvingConfiguration; stateDirectory: string; openedAt: string; environment: EnvironmentStatus;
}
/** Extend only with named, structured operations implemented in the compiled worker. */
export interface RuntimeOperations {
  status: { input: Record<string, never>; output: EnvironmentStatus };
  accounts: { input: Record<string, never>; output: SessionAccount[] };
}
export class SessionError extends Error {
  constructor(public readonly code: string, message: string) { super(`${code}: ${message}`); this.name = "SessionError"; }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } };

class RuntimeWorker {
  readonly child: ChildProcess;
  private sequence = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout; onProgress?: (event: RuntimeProgress) => void }>();
  readonly exited: Promise<void>;
  constructor(node: string, root: string, url: string, private readonly realProving = false) {
    const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_PATH;
    for (const key of ["BB_BINARY_PATH", "BB_WASM_PATH", "BB_WORKING_DIRECTORY", "NARGO_BINARY_PATH", "NARGO_PATH", "ACVM_BINARY_PATH", "ACVM_WORKING_DIRECTORY"]) delete env[key];
    this.child = fork(fileURLToPath(new URL("./runtime-worker.js", import.meta.url)), [root, url], {
      execPath: node, execArgv: ["--experimental-import-meta-resolve"], env, cwd: root, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.child.stdout?.resume(); this.child.stderr?.resume();
    this.child.on("message", (message: any) => {
      const item = this.pending.get(message?.id); if (!item) return;
      if (message.progress) { item.onProgress?.(message.progress); return; }
      clearTimeout(item.timer); this.pending.delete(message.id);
      message.ok ? item.resolve(message.result) : item.reject(new SessionError(message.error?.code ?? "runtime-failed", message.error?.message ?? "Worker operation failed"));
    });
    const fail = () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new SessionError("worker-interrupted", "Runtime worker exited; no operation was replayed.")); } this.pending.clear(); };
    this.child.on("error", fail);
    this.exited = new Promise(resolve => this.child.once("close", () => { fail(); this.kill(); resolve(); }));
  }
  request<T>(operation: string, input: unknown, onProgress?: (event: RuntimeProgress) => void): Promise<T> {
    if (!this.child.connected) return Promise.reject(new SessionError("worker-interrupted", "Runtime worker is unavailable."));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timeoutMs = this.realProving && operation.endsWith("-submit") ? 900000 : 120000;
      const timer = setTimeout(() => { this.pending.delete(id); this.kill(); reject(new SessionError("worker-timeout", `Runtime operation exceeded ${timeoutMs / 1000} seconds; its outcome may require reconciliation.`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, onProgress });
      this.child.send({ id, operation, input }, error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); } });
    });
  }
  private kill(): void {
    if (!this.child.pid) return;
    try { process.platform === "win32" ? this.child.kill("SIGKILL") : process.kill(-this.child.pid, "SIGKILL"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
  async stop(): Promise<void> {
    let forced = false;
    const timer = setTimeout(() => { forced = true; this.kill(); }, 15000);
    try { if (this.child.connected) await this.request("close", {}); } finally { await this.exited; clearTimeout(timer); }
    if (forced) throw new SessionError("worker-shutdown-timeout", "Worker required forced shutdown; persistent state must be checked on reopen.");
  }
}

interface ActiveSession { snapshot: SessionSnapshot; worker: RuntimeWorker; lockPath: string; token: string; retainLock?: boolean }
/** Owns exactly one wallet worker; every request, including lifecycle changes, is ordered. */
export class SessionService {
  private active?: ActiveSession;
  private queue: Promise<unknown> = Promise.resolve();
  private transitioning = false;
  private lifecycleGuard?: (sessionId: string) => void | Promise<void>;
  setLifecycleGuard(guard: (sessionId: string) => void | Promise<void>): void { this.lifecycleGuard = guard; }
  constructor(private readonly validator: RuntimeValidator = validateSupportedRuntime) {}
  private ordered<T>(operation: () => Promise<T>): Promise<T> { const result = this.queue.then(operation); this.queue = result.catch(() => {}); return result; }
  private selected(id: string): ActiveSession {
    if (!this.active || this.active.snapshot.sessionId !== id) throw new SessionError("stale-session", "Open a session and use its current session identifier.");
    return this.active;
  }
  private admitted<T>(operation: () => Promise<T>): Promise<T> {
    if (this.transitioning) return Promise.reject(new SessionError("session-transitioning", "Session lifecycle change is draining existing work; retry with the resulting session identifier."));
    return this.ordered(operation);
  }
  open(options: SessionOpenOptions): Promise<SessionSnapshot> { return this.admitted(() => this.openInternal(options)); }
  private async openInternal(options: SessionOpenOptions): Promise<SessionSnapshot> {
    const proofMode = options.proofMode ?? "fast";
    if (!["fast", "real"].includes(proofMode)) throw new SessionError("unsupported-proof-mode", "Select fast or explicitly configured real proving.");
    if (proofMode === "fast" && options.proving !== undefined) throw new SessionError("invalid-proving-configuration", "Proving configuration requires explicit proofMode: real.");
    if (!isAbsolute(options.projectPath)) throw new SessionError("invalid-project", "Project path must be absolute.");
    const projectPath = await realpath(options.projectPath);
    const installationRoot = await realpath(options.installationRoot);
    const nodeExecutable = await realpath(options.nodeExecutable);
    const proving = proofMode === "real" ? await validateProvingConfiguration(installationRoot, options.proving) : undefined;
    let url: URL; try { url = new URL(options.nodeUrl); } catch { throw new SessionError("invalid-node-url", "Provide an explicit local node URL."); }
    if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new SessionError("invalid-node-url", "Select a loopback HTTP(S) endpoint without credentials, query or fragment.");
    const nodeUrl = url.href;
    if (this.active) {
      const old = this.active.snapshot;
      if (old.projectPath === projectPath && old.installationRoot === installationRoot && old.nodeExecutable === nodeExecutable && old.nodeUrl === nodeUrl && old.proofMode === proofMode && JSON.stringify(old.proving) === JSON.stringify(proving)) {
        if (!this.active.worker.child.connected) {
          await this.lifecycleGuard?.(old.sessionId); await this.closeActive(this.active);
          return this.openInternal(options);
        }
        return this.refresh(this.active);
      }
      throw new SessionError("session-already-open", "Close the active session before selecting another project, installation or network.");
    }
    const runtime = await this.validator({ installationRoot, nodeExecutable });
    const worker = new RuntimeWorker(nodeExecutable, installationRoot, nodeUrl, proofMode === "real");
    let lockPath: string | undefined; const token = randomUUID();
    try {
      await worker.request("configure", { proofMode, proving });
      const network = await worker.request<NetworkIdentity>("probe", { expectedNodeVersion: runtime.packages.find(p => p.name === "@aztec-labs/aztec.js")?.version });
      if (runtime.supported) validateSupportedNetwork(runtimeIdentity(runtime), network);
      const networkIdentity = createHash("sha256").update(JSON.stringify(network)).digest("hex");
      const stateDirectory = join(projectPath, ".aztec-mcp", "sessions", networkIdentity);
      await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
      if (await realpath(stateDirectory) !== stateDirectory) throw new SessionError("invalid-state-directory", "MCP session storage must not contain symlinks.");
      lockPath = join(stateDirectory, "owner.lock");
      await this.acquire(lockPath, token, worker.child.pid!);
      const manifest = join(stateDirectory, "session.json");
      try { const stored = JSON.parse(await readFile(manifest, "utf8")); if (stored.owner !== "aztec-mcp" || stored.projectPath !== projectPath || stored.networkIdentity !== networkIdentity) throw new SessionError("foreign-wallet-store", "Existing state does not belong to this project/network."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await writeFile(manifest, JSON.stringify({ owner: "aztec-mcp", projectPath, networkIdentity }), { mode: 0o600 });
      const environment = await worker.request<EnvironmentStatus>("initialize", { stateDirectory, proofMode, proving });
      const snapshot: SessionSnapshot = { state: environment.chain.status === "replaced" ? "invalidated" : "ready", invalidationReason: environment.chain.reason, sessionId: randomUUID(), projectPath, installationRoot, nodeExecutable, nodeUrl, networkIdentity, network, runtimeIdentity: runtimeIdentity(runtime), runtime, proofMode, proverEnabled: proofMode === "real", proving, stateDirectory, openedAt: new Date().toISOString(), environment };
      const active = { snapshot, worker, lockPath, token, retainLock: false };
      this.active = active;
      void worker.exited.then(() => active.retainLock ? undefined : this.release(lockPath!, token)).catch(() => {});
      return structuredClone(snapshot);
    } catch (error) { await worker.stop().catch(() => {}); if (lockPath) await this.release(lockPath, token); throw error; }
  }
  private async guard<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const guardPath = `${path}.guard`;
    for (let attempt = 0; ; attempt++) {
      try { const file = await open(guardPath, "wx", 0o600); await file.close(); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (attempt >= 200) throw new SessionError("store-in-use", "Wallet ownership is being changed or its recovery guard is abandoned; verify all owners have stopped before clearing the guard.");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    try { return await operation(); } finally { await rm(guardPath); }
  }
  private async acquire(path: string, token: string, workerPid: number): Promise<void> {
    await this.guard(path, async () => {
      try {
        const old = JSON.parse(await readFile(path, "utf8"));
        if (old.owner !== "aztec-mcp" || !Number.isInteger(old.pid) || old.pid <= 0 || alive(old.pid) || !Number.isInteger(old.workerPid) || old.workerPid <= 0 || alive(old.workerPid)) throw new SessionError("store-in-use", "Another process owns this wallet store, or its ownership cannot be safely established.");
        await rm(path);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const file = await open(path, "wx", 0o600);
      try { await file.writeFile(JSON.stringify({ owner: "aztec-mcp", pid: process.pid, workerPid, token })); }
      finally { await file.close(); }
    });
  }
  private async release(path: string, token: string): Promise<void> {
    await this.guard(path, async () => {
      try { const owner = JSON.parse(await readFile(path, "utf8")); if (owner.token === token) await rm(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    });
  }
  private async refresh(active: ActiveSession): Promise<SessionSnapshot> {
    active.snapshot.environment = await active.worker.request("status", {});
    if (active.snapshot.environment.chain.status === "replaced") {
      active.snapshot.state = "invalidated"; active.snapshot.invalidationReason = active.snapshot.environment.chain.reason;
    }
    return structuredClone(active.snapshot);
  }
  status(id: string): Promise<SessionSnapshot> { return this.admitted(() => this.refresh(this.selected(id))); }
  accounts(id: string): Promise<SessionAccount[]> { return this.request(id, "accounts", {}); }
  request<K extends keyof RuntimeOperations>(id: string, operation: K, input: RuntimeOperations[K]["input"], onProgress?: (event: RuntimeProgress) => void): Promise<RuntimeOperations[K]["output"]> {
    return this.admitted(async () => {
      const active = this.selected(id);
      if (active.snapshot.state === "invalidated") throw new SessionError("stale-session", "This session was invalidated by chain replacement; explicitly reset its wallet state.");
      try { return await active.worker.request(operation, input, onProgress); }
      catch (error) {
        if (error instanceof SessionError && ["network-changed", "stale-session"].includes(error.code)) { active.snapshot.state = "invalidated"; active.snapshot.invalidationReason = "Network identity or chain anchor changed; reset wallet state."; }
        throw error;
      }
    });
  }
  private async assertLifecycleReady(active: ActiveSession): Promise<void> {
    await this.lifecycleGuard?.(active.snapshot.sessionId);
    let records;
    try { records = await readTransactionRecords(active.snapshot.stateDirectory); }
    catch { throw new SessionError("transaction-journal-unavailable", "Cannot establish whether this session has unresolved submissions."); }
    const unresolved = records.filter(hasUnresolvedSubmission).map(record => record.jobId);
    if (unresolved.length) throw new SessionError("unresolved-submission", `Reconcile these transaction jobs before changing or resetting the session: ${unresolved.join(", ")}. A dropped/unknown receipt alone does not establish non-submission.`);
  }
  private transition<T>(id: string, operation: (active: ActiveSession) => Promise<T>): Promise<T> {
    if (this.transitioning) return Promise.reject(new SessionError("session-transitioning", "Another lifecycle change is already draining this session."));
    this.transitioning = true;
    return this.ordered(async () => { const active = this.selected(id); await this.assertLifecycleReady(active); return operation(active); }).finally(() => { this.transitioning = false; });
  }
  private async closeActive(active: ActiveSession): Promise<void> {
    active.retainLock = true;
    try { await active.worker.stop(); }
    finally { await this.release(active.lockPath, active.token); if (this.active === active) this.active = undefined; }
  }
  close(id: string): Promise<{ sessionId: string; closed: true; persisted: true }> {
    return this.transition(id, async active => { await this.closeActive(active); return { sessionId: id, closed: true, persisted: true }; });
  }
  switchTo(id: string, options: SessionOpenOptions): Promise<SessionSnapshot> {
    return this.transition(id, async active => { await this.closeActive(active); return this.openInternal(options); });
  }
  reset(id: string): Promise<SessionSnapshot> {
    return this.transition(id, async active => {
      const snapshot = active.snapshot;
      active.retainLock = true;
      try {
        try { const owner = JSON.parse(await readFile(active.lockPath, "utf8")); if (owner.token !== active.token) throw new SessionError("store-in-use", "Another process owns this wallet store."); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") await this.acquire(active.lockPath, active.token, active.worker.child.pid!); else throw error; }
        await active.worker.stop();
        await this.guard(active.lockPath, async () => {
          const directory = snapshot.stateDirectory;
          if (directory !== join(snapshot.projectPath, ".aztec-mcp", "sessions", snapshot.networkIdentity) || await realpath(directory) !== directory) throw new SessionError("invalid-state-directory", "Reset only accepts the selected MCP-owned canonical state directory.");
          const owner = JSON.parse(await readFile(active.lockPath, "utf8"));
          const manifest = JSON.parse(await readFile(join(directory, "session.json"), "utf8"));
          if (owner.token !== active.token || manifest.owner !== "aztec-mcp" || manifest.projectPath !== snapshot.projectPath || manifest.networkIdentity !== snapshot.networkIdentity) throw new SessionError("foreign-wallet-store", "State ownership could not be verified; no reset was performed.");
          for (const name of await readdir(directory)) if (!["owner.lock", "owner.lock.guard"].includes(name)) await rm(join(directory, name), { recursive: true, force: true });
        });
      } finally { await this.release(active.lockPath, active.token); if (this.active === active) this.active = undefined; }
      return this.openInternal({ projectPath: snapshot.projectPath, installationRoot: snapshot.installationRoot, nodeExecutable: snapshot.nodeExecutable, nodeUrl: snapshot.nodeUrl, proofMode: snapshot.proofMode, proving: snapshot.proving ? { backend: snapshot.proving.backend, crsPath: snapshot.proving.crsPath, threads: snapshot.proving.threads } : undefined });
    });
  }
  shutdown(): Promise<void> { return this.ordered(async () => { if (this.active) await this.closeActive(this.active); }); }
}
