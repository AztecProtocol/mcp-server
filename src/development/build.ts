import { createServer } from "node:net";
import { access, realpath, readFile, mkdir, writeFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { validateSupportedRuntime, type RuntimeValidator } from "./policy.js";
import { Jobs, JobFailure, runJobProcess, type JobSnapshot } from "./jobs.js";
import { collectArtifacts, projectProvenance, captureProjectProvenance, quarantineArtifacts, type QuarantinedArtifact } from "./artifacts.js";
import type { ToolchainReport } from "./toolchain.js";
export interface BuildArguments {
  operation: "compile" | "test";
  projectPath: string;
  installationRoot: string;
  nodeExecutable: string;
  package?: string;
  testFilter?: string;
  timeoutMs?: number;
}
export interface BuildDiagnostic {
  message: string;
  file?: string;
  line?: number;
  column?: number;
}
export function parseDiagnostics(output: string): BuildDiagnostic[] {
  return output.split("\n").filter(line => /error|warning|bug:|\.nr:\d+/i.test(line)).slice(0, 100).map(message => {
    const location = /(?:-->\s*)?([^\s│]+\.nr):(\d+):(\d+)/.exec(message);
    return { message, ...(location ? { file: location[1], line: Number(location[2]), column: Number(location[3]) } : {}) };
  });
}
export function buildEnvironment(runtime: ToolchainReport): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: [dirname(runtime.runtimeNode.path), join(runtime.installationRoot, "internal-bin"), join(runtime.installationRoot, "bin"), "/usr/bin", "/bin"].join(":"), AZTEC_VERSIONED: "1", NARGO: runtime.compiler.path, BB: join(runtime.installationRoot, "node_modules/@aztec-foundation/bb.js/build", `${process.arch === "x64" ? "amd64" : process.arch}-${process.platform === "darwin" ? "macos" : process.platform}`, "bb") };
  for (const key of ["NODE_OPTIONS", "NODE_PATH", "BB_BINARY_PATH", "NARGO_HOME", "AZTEC_BIN", "AZTEC_NARGO_BIN"])
    delete env[key];
  return env;
}
async function requireFreeOraclePort(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once("error", error => reject(new JobFailure("oracle-port-unavailable", `TXE requires free local port 8081: ${error.message}. Existing services are never stopped.`)));
    server.listen({ host: "127.0.0.1", port: 8081, exclusive: true }, () => server.close(error => error ? reject(error) : resolve()));
  });
}
let oracleInUse = false;
const activeProjects = new Set<string>();
export function parseTestSummary(output: string, selection: {
  package?: string;
  filter?: string;
}) {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, "");
  let passed = 0, failed = 0, parsed = false;
  for (const match of clean.matchAll(/(\d+)\s+tests?\s+passed/gi)) {
    passed += Number(match[1]);
    parsed = true;
  }
  for (const match of clean.matchAll(/(\d+)\s+(?:tests?\s+)?failed/gi)) {
    failed += Number(match[1]);
    parsed = true;
  }
  const tests = [...clean.matchAll(/\[([^\]]+)\]\s+(?:Testing|Test)\s+(.+?)\s*(?:\.\.\.|:)\s*(ok|FAIL(?:ED)?)/gi)].map(match => ({ package: match[1], name: match[2].trim(), status: match[3].toLowerCase() === "ok" ? "passed" : "failed" }));
  return { selection, summaryStatus: parsed ? "parsed" : "unavailable", passed: parsed ? passed : null, failed: parsed ? failed : null, tests };
}
export class BuildService {
  constructor(private readonly validator: RuntimeValidator = validateSupportedRuntime, readonly jobs = new Jobs()) { }
  async start(args: BuildArguments): Promise<JobSnapshot> {
    if (args.operation !== "compile" && args.operation !== "test")
      throw new Error("operation must be compile or test.");
    if (args.testFilter !== undefined && (args.operation !== "test" || !/^[A-Za-z0-9_][A-Za-z0-9_:]*$/.test(args.testFilter)))
      throw new Error("Invalid testFilter; use a test-name substring without flags.");
    if (!isAbsolute(args.projectPath))
      throw new Error("projectPath must be absolute.");
    if (args.package !== undefined && !/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(args.package))
      throw new Error("Invalid package selection.");
    const project = await realpath(args.projectPath);
    await access(join(project, "Nargo.toml"));
    const runtime = await this.validator(args);
    if (!runtime.cli.path || !runtime.compiler.path)
      throw new Error("Selected runtime has no CLI or compiler executable.");
    return this.jobs.start(args.operation, async (context) => {
      if (activeProjects.has(project))
        throw new JobFailure("project-busy", "Another build or test job owns this project.");
      if (args.operation === "test" && oracleInUse)
        throw new JobFailure("oracle-busy", "Another owned TXE test run is already using port 8081.");
      activeProjects.add(project);
      if (args.operation === "test")
        oracleInUse = true;
      try {
        if (args.operation === "test") {
          context.phase("oracle-preflight");
          await requireFreeOraclePort();
        }
        context.phase("fingerprint");
        const options = { operation: "compile", package: args.operation === "compile" ? args.package : undefined };
        const sourceHash = await projectProvenance(project, runtime, options, false);
        const inputsBefore = await captureProjectProvenance(project, runtime, options);
        const before = inputsBefore.hash;
        const receiptPath = join(project, ".aztec-mcp", "build.json");
        let receipt: {
          provenanceHash: string;
          artifacts: Array<{
            path: string;
            contentHash: string;
          }>;
        } | undefined;
        try {
          receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        }
        catch {}
        let hasOutputs = false;
        try {
          hasOutputs = (await readdir(join(project, "target"))).some(name => name.endsWith(".json"));
        }
        catch {}
        const selection = options.package ? ["--package", options.package] : ["--workspace"];
        const existingArtifacts = hasOutputs ? await collectArtifacts(project, before, options.package) : [];
        const matchingArtifacts = receipt?.artifacts && existingArtifacts.length === receipt.artifacts.length && existingArtifacts.every(artifact => receipt!.artifacts.some(saved => saved.path === artifact.path && saved.contentHash === artifact.contentHash));
        let quarantinedArtifacts: QuarantinedArtifact[] = [];
        if (hasOutputs && (receipt?.provenanceHash !== before || !matchingArtifacts)) {
          context.phase("invalidate");
          quarantinedArtifacts = await quarantineArtifacts(project, existingArtifacts);
          for (const artifact of quarantinedArtifacts) context.log(`Preserved previous artifact at ${artifact.path}\n`);
          const refreshed = await runJobProcess(context, runtime.compiler.path!, ["compile", "--force", ...selection], { cwd: project, env: buildEnvironment(runtime) });
          if (refreshed.exitCode !== 0 || refreshed.signal)
            throw new JobFailure("compile-failed", "Aztec compilation failed during invalidation.", { exitCode: refreshed.exitCode, signal: refreshed.signal, diagnostics: parseDiagnostics(refreshed.output) });
        }
        context.phase(args.operation);
        const argv = args.operation === "compile" ? ["compile", ...selection] : ["test", ...(args.package ? ["--package", args.package] : ["--workspace"]), ...(args.testFilter ? [args.testFilter] : [])];
        const result = await runJobProcess(context, runtime.cli.path!, argv, { cwd: project, env: buildEnvironment(runtime) });
        context.signal.throwIfAborted();
        const diagnostics = parseDiagnostics(result.output);
        const tests = args.operation === "test" ? parseTestSummary(result.output, { package: args.package, filter: args.testFilter }) : undefined;
        if (result.exitCode !== 0 || result.signal)
          throw new JobFailure(args.operation === "test" ? "test-failed" : "compile-failed", `Aztec ${args.operation} failed.`, { exitCode: result.exitCode, signal: result.signal, diagnostics, ...(tests ? { tests } : {}) });
        context.phase("artifacts");
        const after = await projectProvenance(project, runtime, options, false);
        if (after !== sourceHash)
          throw new JobFailure("sources-changed", "Build inputs changed during compilation; rebuild before using artifacts.");
        const inputsAfter = await captureProjectProvenance(project, runtime, options);
        const comparableAfter = inputsBefore.unresolvedGitDependencies.length
          ? await captureProjectProvenance(project, runtime, options, new Set(inputsBefore.unresolvedGitDependencies))
          : inputsAfter;
        if (comparableAfter.hash !== before)
          throw new JobFailure("sources-changed", "Cached dependency inputs changed during compilation; rebuild before using artifacts.");
        const provenanceHash = inputsAfter.hash;
        const artifacts = await collectArtifacts(project, provenanceHash, options.package);
        await mkdir(dirname(receiptPath), { recursive: true });
        await writeFile(receiptPath, JSON.stringify({ provenanceHash, artifacts: artifacts.map(({ path, contentHash }) => ({ path, contentHash })) }) + "\n");
        return { projectPath: project, operation: args.operation, selection: options, toolchain: { installationRoot: runtime.installationRoot, nodeExecutable: runtime.runtimeNode.path }, provenanceHash, artifacts, quarantinedArtifacts, diagnostics, exitCode: result.exitCode, ...(tests ? { tests } : {}) };
      }
      finally {
        activeProjects.delete(project);
        if (args.operation === "test")
          oracleInUse = false;
      }
    }, { timeoutMs: args.timeoutMs });
  }
}
