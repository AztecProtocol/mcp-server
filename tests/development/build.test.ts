import { afterEach, expect, it, vi } from "vitest";
import * as os from "node:os";
vi.mock("node:os", async importOriginal => { const actual = await importOriginal<typeof import("node:os")>(); return { ...actual, homedir: vi.fn(actual.homedir) }; });
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildService } from "../../src/development/build.js";
import type { ToolchainReport } from "../../src/development/toolchain.js";
const dirs: string[] = [];
const services: BuildService[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(services.splice(0).map(s => s.jobs.close())); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
async function fixture(script: string) {
  const root = await mkdtemp(join(tmpdir(), "mcp-build-"));
  dirs.push(root);
  await mkdir(join(root, "src"));
  await mkdir(join(root, "bin"));
  await writeFile(join(root, "Nargo.toml"), '[package]\nname="fixture"\ntype="contract"\n');
  await writeFile(join(root, "src/main.nr"), "contract Fixture {}\n");
  const cli = join(root, "bin/aztec");
  await writeFile(cli, `#!${process.execPath}\n${script}`, { mode: 0o755 });
  const report: ToolchainReport = { target: "fixture", installationRoot: root, supported: false, runtimeNode: { path: process.execPath, version: process.version }, cli: { path: cli, identity: "fixture" }, compiler: { path: cli, identity: "fixture" }, packages: [], publicExports: [], provenance: { sourceIdentity: "unverified" }, diagnostics: [] };
  const service = new BuildService(async () => report);
  services.push(service);
  const args = { operation: "compile" as const, projectPath: root, installationRoot: root, nodeExecutable: process.execPath };
  return { root, service, args };
}
it("tracks a build and gives artifacts source-sensitive identities while preserving target outputs", async () => {
  const { root, service, args } = await fixture(`const fs=require('fs');fs.mkdirSync('target',{recursive:true});fs.writeFileSync('target/fixture.json',JSON.stringify({name:'Fixture',functions:[]}));console.log('Compilation complete!');`);
  const started = await service.start(args);
  expect(started.status).toBe("queued");
  const first = await service.jobs.wait(started.id);
  expect(first.status).toBe("completed");
  const firstResult = first.result as {
    artifacts: Array<{
      provenanceHash: string;
    }>;
  };
  expect(firstResult.artifacts).toHaveLength(1);
  await writeFile(join(root, "target/keep.incremental"), "retained");
  await writeFile(join(root, "src/main.nr"), "contract Fixture { }\n");
  const next = await service.jobs.wait((await service.start(args)).id);
  expect((next.result as typeof firstResult).artifacts[0].provenanceHash).not.toBe(firstResult.artifacts[0].provenanceHash);
  expect(await readFile(join(root, "target/keep.incremental"), "utf8")).toBe("retained");
  expect(service.jobs.logs(started.id).text).toContain("Compilation complete!");
});
it("does not treat success text as success when the process exits nonzero", async () => {
  const { service, args } = await fixture(`console.log('Compilation complete!');console.error('error: src/main.nr:3:7 invalid type');process.exit(2);`);
  const result = await service.jobs.wait((await service.start(args)).id);
  expect(result.status).toBe("failed");
  expect(result.error).toMatchObject({ code: "compile-failed", details: { exitCode: 2, diagnostics: [{ file: "src/main.nr", line: 3, column: 7, message: expect.any(String) }] } });
});
it("times out a live process and retains bounded logs", async () => {
  const { service, args } = await fixture(`console.log('x'.repeat(2*1024*1024));setInterval(()=>{},1000);`);
  const result = await service.jobs.wait((await service.start({ ...args, timeoutMs: 100 })).id);
  expect(result.status).toBe("timed-out");
  expect(Buffer.byteLength(service.jobs.logs(result.id).text)).toBeLessThanOrEqual(1024 * 1024 + 3);
});
it("cancels the owned process group and keeps retrieved results readable", async () => {
  const { root, service, args } = await fixture(`const fs=require('fs');const {spawn}=require('child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync('child.pid',String(child.pid));setInterval(()=>{},1000);`);
  const job = await service.start(args);
  let pid = 0;
  for (let i = 0; i < 100; i++) {
    try {
      pid = Number(await readFile(join(root, "child.pid"), "utf8"));
      break;
    }
    catch {
      await new Promise(r => setTimeout(r, 10));
    }
  }
  expect(pid).toBeGreaterThan(0);
  service.jobs.cancel(job.id);
  expect((await service.jobs.wait(job.id)).status).toBe("cancelled");
  expect(service.jobs.get(job.id).status).toBe("cancelled");
  // On Linux a reaped or zombie child is no longer executing; inspect state without signalling other processes.
  try {
    expect((await readFile(`/proc/${pid}/stat`, "utf8")).split(" ")[2]).toBe("Z");
  }
  catch (error) {
    expect(["ENOENT", "ESRCH"]).toContain((error as NodeJS.ErrnoException).code);
  }
});
it("refuses invalid package flags and rejects incompatible runtimes before spawn", async () => {
  const { service, args } = await fixture(`throw new Error('must not execute');`);
  await expect(service.start({ ...args, package: "--workspace" })).rejects.toThrow("Invalid package");
  const denied = new BuildService(async () => { throw new Error("unsupported-runtime"); });
  services.push(denied);
  await expect(denied.start(args)).rejects.toThrow("unsupported-runtime");
});
it("changes artifact provenance for local dependency edits", async () => {
  const { root, service, args } = await fixture(`const fs=require('fs');fs.mkdirSync('target',{recursive:true});fs.writeFileSync('target/fixture.json',JSON.stringify({name:'Fixture',functions:[]}));`);
  const dep = await mkdtemp(join(tmpdir(), "mcp-dependency-"));
  dirs.push(dep);
  await writeFile(join(dep, "lib.nr"), "global A=1;\n");
  await writeFile(join(root, "Nargo.toml"), `[dependencies]\nlib = { path = "${dep}" }\n`);
  const first = await service.jobs.wait((await service.start(args)).id);
  await writeFile(join(dep, "lib.nr"), "global A=2;\n");
  const next = await service.jobs.wait((await service.start(args)).id);
  expect((first.result as {
    provenanceHash: string;
  }).provenanceHash).not.toBe((next.result as {
    provenanceHash: string;
  }).provenanceHash);
});
it("fails if sources change while compiling", async () => {
  const { service, args } = await fixture(`require('fs').appendFileSync('src/main.nr','changed');`);
  expect((await service.jobs.wait((await service.start(args)).id)).error?.code).toBe("sources-changed");
});
it("runs selected TXE tests through aztec test and reports their summary", async () => {
  const { service, args } = await fixture(`console.log(JSON.stringify(process.argv.slice(2)));console.log('[fixture] Testing test_transfer ... ok');console.log('1 test passed');`);
  const result = await service.jobs.wait((await service.start({ ...args, operation: "test", package: "fixture", testFilter: "test_transfer" })).id);
  expect(result.status).toBe("completed");
  expect(result.result).toMatchObject({ tests: { summaryStatus: "parsed", passed: 1, failed: 0, selection: { package: "fixture", filter: "test_transfer" } } });
  expect(service.jobs.logs(result.id).text).toContain('["test","--package","fixture","test_transfer"]');
});
it("refuses an occupied oracle port and leaves its owner running", async () => {
  const { createServer } = await import("node:net");
  const borrowed = createServer();
  await new Promise<void>(resolve => borrowed.listen(8081, "127.0.0.1", resolve));
  try {
    const { service, args } = await fixture(`throw new Error('must not start');`);
    const result = await service.jobs.wait((await service.start({ ...args, operation: "test" })).id);
    expect(result.error?.code).toBe("oracle-port-unavailable");
    expect(borrowed.listening).toBe(true);
  }
  finally {
    await new Promise<void>((resolve, reject) => borrowed.close(error => error ? reject(error) : resolve()));
  }
});
it("retains a failed test summary and reports unavailable summaries honestly", async () => {
  const failed = await fixture(`console.log('[fixture] Testing broken ... FAILED');console.log('0 tests passed');console.log('1 test failed');process.exit(1);`);
  const result = await failed.service.jobs.wait((await failed.service.start({ ...failed.args, operation: "test" })).id);
  expect(result.error).toMatchObject({ code: "test-failed", details: { tests: { passed: 0, failed: 1, summaryStatus: "parsed", tests: [{ name: "broken", status: "failed" }] } } });
  const unknown = await fixture(`console.log('unrecognized summary');`);
  const unparsed = await unknown.service.jobs.wait((await unknown.service.start({ ...unknown.args, operation: "test" })).id);
  expect(unparsed.result).toMatchObject({ tests: { summaryStatus: "unavailable", passed: null, failed: null } });
});
it("cleans descendant pipes after an oracle wrapper exits and reports startup failure", async () => {
  const { service, args } = await fixture(`require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});console.error('oracle startup failed');process.exit(3);`);
  const result = await service.jobs.wait((await service.start({ ...args, operation: "test", timeoutMs: 3000 })).id);
  expect(result.status).toBe("failed");
  expect(result.error).toMatchObject({ code: "test-failed", details: { exitCode: 3 } });
  expect(result.durationMs).toBeLessThan(3000);
});
it("rejects test filters that could be interpreted as flags", async () => {
  const { service, args } = await fixture("");
  await expect(service.start({ ...args, operation: "test", testFilter: "--oracle-resolver" })).rejects.toThrow("Invalid testFilter");
});
it("does not certify a removed contract's leftover artifact with a fresh build", async () => {
  const { root, service, args } = await fixture(`const fs=require('fs');fs.mkdirSync('target',{recursive:true});const name=fs.readFileSync('src/main.nr','utf8').match(/contract (\\w+)/)[1];fs.writeFileSync('target/fixture-'+name+'.json',JSON.stringify({name,functions:[]}));`);
  const first = await service.jobs.wait((await service.start(args)).id);
  expect(first.status).toBe("completed");
  const previous = await readFile(join(root, "target/fixture-Fixture.json"), "utf8");
  await writeFile(join(root, "target/notes.json"), JSON.stringify({ notes: "keep this unrelated output" }));
  await writeFile(join(root, "src/main.nr"), "contract Renamed {}\n");
  const next = await service.jobs.wait((await service.start(args)).id);
  expect(next.status).toBe("completed");
  expect((next.result as {artifacts:Array<{contractName:string}>}).artifacts.map(artifact=>artifact.contractName)).toEqual(["Renamed"]);
  expect(await readFile(join(root, "target/notes.json"), "utf8")).toContain("keep this unrelated output");
  const quarantined = (next.result as {quarantinedArtifacts:Array<{path:string}>}).quarantinedArtifacts;
  expect(quarantined).toHaveLength(1);
  expect(await readFile(quarantined[0].path, "utf8")).toBe(previous);
  const warm = await service.jobs.wait((await service.start(args)).id);
  expect((warm.result as {quarantinedArtifacts:unknown[]}).quarantinedArtifacts).toEqual([]);
});
it("does not attest or quarantine another package with a shared name prefix", async () => {
  const { root, service, args } = await fixture(`const fs=require('fs');fs.mkdirSync('target',{recursive:true});fs.writeFileSync('target/fixture-Fixture.json',JSON.stringify({name:'Fixture',functions:[]}));`);
  await mkdir(join(root, "target"));
  const other = join(root, "target/fixture-extra-Other.json");
  await writeFile(other, JSON.stringify({name:"Other",functions:[]}));
  const result = await service.jobs.wait((await service.start({...args, package:"fixture"})).id);
  expect(result.status).toBe("completed");
  expect((result.result as {artifacts:Array<{contractName:string}>}).artifacts.map(artifact=>artifact.contractName)).toEqual(["Fixture"]);
  expect(await readFile(other, "utf8")).toContain("Other");
});

async function cachedDependencyFixture(initiallyPresent: boolean, changeExisting: boolean) {
  const home = await mkdtemp(join(tmpdir(), "mcp-dependency-home-")); dirs.push(home);
  vi.mocked(os.homedir).mockReturnValue(home);
  const dependency = join(home, "nargo", "example.invalid", "library", "v1");
  if (initiallyPresent) { await mkdir(dependency, { recursive: true }); await writeFile(join(dependency, "lib.nr"), "global VALUE=1;\n"); }
  const { root, service, args } = await fixture(`const fs=require('fs');const dependency=${JSON.stringify(dependency)};fs.mkdirSync('target',{recursive:true});fs.writeFileSync('target/fixture-Fixture.json',JSON.stringify({name:'Fixture',functions:[]}));fs.mkdirSync(dependency,{recursive:true});fs.writeFileSync(require('path').join(dependency,'lib.nr'),${JSON.stringify(changeExisting ? "global VALUE=2;\n" : "global VALUE=1;\n")});`);
  await writeFile(join(root, "Nargo.toml"), '[package]\nname="fixture"\ntype="contract"\n[dependencies]\nlib = { git = "https://example.invalid/library", tag = "v1" }\n');
  return { root, service, args, dependency, home };
}
it("rejects a cached Git dependency changed during compilation", async () => {
  const { root, service, args } = await cachedDependencyFixture(true, true);
  const result = await service.jobs.wait((await service.start(args)).id);
  expect(result.status).toBe("failed"); expect(result.error?.code).toBe("sources-changed");
  await expect(readFile(join(root, ".aztec-mcp/build.json"))).rejects.toMatchObject({code:"ENOENT"});
});
it("accepts a first dependency download and checks its bytes on subsequent builds", async () => {
  const { service, args } = await cachedDependencyFixture(false, false);
  const first = await service.jobs.wait((await service.start(args)).id);
  expect(first.status).toBe("completed");
  const warm = await service.jobs.wait((await service.start(args)).id);
  expect(warm.status).toBe("completed");
  expect((warm.result as {provenanceHash:string}).provenanceHash).toBe((first.result as {provenanceHash:string}).provenanceHash);
});
it("does not let a first download hide changes to another cached dependency", async () => {
  const { root, service, args, home } = await cachedDependencyFixture(false, false);
  const existing = join(home, "nargo", "example.invalid", "existing", "v1");
  await mkdir(existing, { recursive: true }); await writeFile(join(existing, "lib.nr"), "global EXISTING=1;\n");
  const manifest = join(root, "Nargo.toml");
  await writeFile(manifest, (await readFile(manifest, "utf8")) + 'existing = { git = "https://example.invalid/existing", tag = "v1" }\n');
  const cli = join(root, "bin/aztec");
  await writeFile(cli, (await readFile(cli, "utf8")) + `require('fs').writeFileSync(${JSON.stringify(join(existing, "lib.nr"))},'global EXISTING=2;');`);
  const result = await service.jobs.wait((await service.start(args)).id);
  expect(result.status).toBe("failed"); expect(result.error?.code).toBe("sources-changed");
});
