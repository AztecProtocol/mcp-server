import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "timed-out";
export interface JobSnapshot {
  id: string;
  kind: string;
  status: JobStatus;
  phase: string;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  evidence?: Record<string, unknown>;
  result?: unknown;
  error?: {
    message: string;
    code?: string;
    details?: unknown;
  };
}
export interface JobContext {
  id: string;
  record(evidence: Record<string, unknown>): void;
  signal: AbortSignal;
  log(text: string): void;
  phase(name: string): void;
}
interface RecordEntry {
  snapshot: JobSnapshot;
  controller: AbortController;
  text: string;
  dropped: number;
  done: Promise<void>;
}
export class JobFailure extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) { super(message); }
}
export class Jobs {
  private entries = new Map<string, RecordEntry>();
  constructor(private readonly maxLogBytes = 1024 * 1024, private readonly maxJobs = 100) { }
  start(kind: string, task: (context: JobContext) => Promise<unknown>, options: {
    timeoutMs?: number;
  } = {}): JobSnapshot {
    const timeoutMs = options.timeoutMs ?? 300000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1800000)
      throw new Error("timeoutMs must be an integer between 1 and 1800000.");
    if (this.entries.size >= this.maxJobs) {
      const terminal = [...this.entries].find(([, e]) => e.snapshot.finishedAt);
      if (!terminal)
        throw new Error("Job capacity reached; finish or cancel existing jobs.");
      this.entries.delete(terminal[0]);
    }
    const id = randomUUID();
    const entry: RecordEntry = { snapshot: { id, kind, status: "queued", phase: "queued", queuedAt: new Date().toISOString() }, controller: new AbortController(), text: "", dropped: 0, done: Promise.resolve() };
    this.entries.set(id, entry);
    entry.done = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
      const started = Date.now();
      entry.snapshot.startedAt = new Date(started).toISOString();
      entry.snapshot.status = "running";
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; entry.controller.abort(); }, timeoutMs);
      const context: JobContext = {
        id,
        record: evidence => { entry.snapshot.evidence = structuredClone({ ...entry.snapshot.evidence, ...evidence }); },
        signal: entry.controller.signal,
        phase: name => { entry.snapshot.phase = name; },
        log: text => {
          const bytes = Buffer.from(entry.text + text);
          const excess = Math.max(0, bytes.length - this.maxLogBytes);
          entry.dropped += excess;
          entry.text = bytes.subarray(excess).toString("utf8");
        },
      };
      try {
        entry.controller.signal.throwIfAborted();
        entry.snapshot.result = await task(context);
        entry.controller.signal.throwIfAborted();
        entry.snapshot.status = "completed";
      }
      catch (error) {
        entry.snapshot.status = timedOut ? "timed-out" : entry.controller.signal.aborted ? "cancelled" : "failed";
        entry.snapshot.error = { message: error instanceof Error ? error.message : String(error), ...(error instanceof JobFailure ? { code: error.code, details: error.details } : {}) };
      }
      finally {
        clearTimeout(timer);
        entry.snapshot.finishedAt = new Date().toISOString();
        entry.snapshot.durationMs = Date.now() - started;
      }
    });
    return this.get(id);
  }
  private entry(id: string): RecordEntry { const e = this.entries.get(id); if (!e)
    throw new Error(`Unknown job: ${id}`); return e; }
  get(id: string): JobSnapshot { return structuredClone(this.entry(id).snapshot); }
  logs(id: string, options: {
    offset?: number;
  } = {}): {
    text: string;
    offset: number;
    nextOffset: number;
    truncated: boolean;
  } {
    const e = this.entry(id);
    const bytes = Buffer.from(e.text);
    const offset = Math.max(options.offset ?? 0, e.dropped);
    return { text: bytes.subarray(offset - e.dropped).toString("utf8"), offset, nextOffset: e.dropped + bytes.length, truncated: (options.offset ?? 0) < e.dropped };
  }
  cancel(id: string): JobSnapshot { const e = this.entry(id); if (!e.snapshot.finishedAt)
    e.controller.abort(); return this.get(id); }
  async wait(id: string): Promise<JobSnapshot> { await this.entry(id).done; return this.get(id); }
  async close(): Promise<void> { for (const e of this.entries.values())
    if (!e.snapshot.finishedAt)
      e.controller.abort(); await Promise.all([...this.entries.values()].map(e => e.done)); }
}
export async function runJobProcess(context: JobContext, command: string, args: string[], options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  output: string;
}> {
  context.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => { if (!child.pid)
      return; try {
      process.platform === "win32" ? child.kill(signal) : process.kill(-child.pid, signal);
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH")
        context.log(`Process cleanup: ${String(error)}\n`);
    } };
    const stop = () => { kill("SIGTERM"); escalation ??= setTimeout(() => kill("SIGKILL"), 500); };
    const log = (chunk: Buffer) => { const text = chunk.toString(); context.log(text); output = (output + text).slice(-1024 * 1024); };
    child.stdout.on("data", log);
    child.stderr.on("data", log);
    context.signal.addEventListener("abort", stop, { once: true });
    child.once("error", error => { context.signal.removeEventListener("abort", stop); if (escalation)
      clearTimeout(escalation); reject(new JobFailure("process-start-failed", error.message)); });
    child.once("exit", stop);
    child.once("close", (exitCode, signal) => {
      context.signal.removeEventListener("abort", stop);
      if (escalation)
        clearTimeout(escalation);
      // A shell wrapper may exit before its owned oracle; terminate any survivors.
      kill("SIGKILL");
      resolve({ exitCode, signal, output });
    });
    if (context.signal.aborted)
      stop();
  });
}
