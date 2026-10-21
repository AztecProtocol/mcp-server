import { expect, it } from "vitest";
import { cp, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildService } from "../../src/development/build.js";
import { ReleaseService } from "../../src/development/release.js";
import { loadCandidate, recordPath } from "./candidate.js";
it.skipIf(!recordPath)("packages a real compiled contract into a script that bash parses", async () => {
  const { selection, report } = await loadCandidate();
  const service = new BuildService(async () => report);
  const root = await realpath(await mkdtemp(join(tmpdir(), "mcp-release-live-")));
  try {
    const projectPath = join(root, "project");
    await cp(new URL("../fixtures/development/private-token", import.meta.url), projectPath, { recursive: true });
    const job = await service.start({ ...selection, projectPath, operation: "compile", timeoutMs: 180000 });
    const built = await service.jobs.wait(job.id);
    expect(built.status).toBe("completed");
    const artifact = (built.result as { artifacts: Array<{ path: string; contractName?: string }> }).artifacts.find(a => a.contractName === "DevelopmentToken");
    expect(artifact).toBeDefined();
    const outputDirectory = join(root, "release");
    const packaged = await new ReleaseService(async () => report, service.jobs).package({
      buildJobId: job.id, artifactPath: artifact!.path, ...selection, outputDirectory,
      args: ["1000", "0x" + "11".repeat(32)], initialize: true, account: "alice", fee: { method: "fee_juice" }, nodeUrl: "https://node.example",
    });
    expect(Object.keys(packaged.files).sort()).toEqual(["checklist", "manifest", "script"]);
    for (const file of Object.values(packaged.files)) expect((await stat(file)).isFile()).toBe(true);
    const syntax = spawnSync("bash", ["-n", packaged.files.script], { encoding: "utf8" });
    expect({ status: syntax.status, stderr: syntax.stderr }).toEqual({ status: 0, stderr: "" });
    expect(packaged.manifest.toolchain.cli.path.endsWith("/aztec-wallet")).toBe(true);
    expect((await stat(packaged.manifest.toolchain.cli.path)).isFile()).toBe(true);
  }
  finally {
    await service.jobs.close();
    await rm(root, { recursive: true, force: true });
  }
}, 600000);
