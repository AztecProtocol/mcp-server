import { expect, it } from "vitest";
import { cp, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildService } from "../../src/development/build.js";
import { inspectToolchain } from "../../src/development/toolchain.js";
import { runtimeIdentity } from "../../src/development/policy.js";
const recordPath = process.env.AZTEC_MCP_CANDIDATE_RECORD;
it.skipIf(!recordPath)("compiles a real contract and runs passing/failing TXE assertions", async () => {
  const record = JSON.parse(await readFile(recordPath!, "utf8"));
  expect(record.status).toBe("candidate-passed");
  const selection = { installationRoot: record.installation.installationRoot, nodeExecutable: record.installation.runtimeNode.path };
  const report = await inspectToolchain(selection);
  expect(report.diagnostics.filter(d => d.code !== "unsupported-runtime")).toEqual([]);
  expect(runtimeIdentity(report)).toBe(runtimeIdentity(record.installation));
  const service = new BuildService(async () => report);
  const project = await mkdtemp(join(tmpdir(), "mcp-build-live-"));
  await cp(new URL("../fixtures/development/counter", import.meta.url), project, { recursive: true });
  const args = { ...selection, projectPath: project, operation: "compile" as const, timeoutMs: 180000 };
  const evidence: unknown[] = [];
  async function run(options: Parameters<typeof service.start>[0]) {
    const job = await service.start(options);
    const result = await service.jobs.wait(job.id);
    evidence.push({ result, logs: service.jobs.logs(job.id) });
    return result;
  }
  try {
    const built = await run(args);
    expect(built.status).toBe("completed");
    expect(built.result).toMatchObject({ artifacts: [{ contractName: "Counter" }] });
    const warm = await run(args);
    expect(warm.status).toBe("completed");
    expect(service.jobs.logs(warm.id).text).toContain("skipping compilation");
    const contract = join(project, "counter_contract/src/main.nr");
    const original = await readFile(contract, "utf8");
    await writeFile(contract, original + "\nnot valid noir !!!\n");
    expect((await run(args)).error?.code).toBe("compile-failed");
    await writeFile(contract, original);
    const testArgs = { ...args, operation: "test" as const, package: "counter_test", testFilter: "test_constructor" };
    const passed = await run(testArgs);
    expect(passed.status).toBe("completed");
    expect(passed.result).toMatchObject({ tests: { passed: 1, failed: 0 } });
    const testFile = join(project, "counter_test/src/lib.nr");
    const tests = await readFile(testFile, "utf8");
    await writeFile(testFile, tests.replace("assert_eq(counter, initial_value);", "assert_eq(counter, initial_value + 1);"));
    const failed = await run(testArgs);
    expect(failed.error).toMatchObject({ code: "test-failed", details: { tests: { failed: 1 } } });
  }
  finally {
    await service.jobs.close();
    if (process.env.AZTEC_MCP_BUILD_EVIDENCE)
      await writeFile(process.env.AZTEC_MCP_BUILD_EVIDENCE, JSON.stringify({ selection, project, evidence }, null, 2));
    await rm(project, { recursive: true, force: true });
  }
}, 600000);
