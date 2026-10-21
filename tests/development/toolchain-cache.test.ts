import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCachedToolchainInspector, inspectToolchain } from "../../src/development/toolchain.js";
import { createCandidateRuntimeValidator, runtimeIdentity } from "../../src/development/policy.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "toolchain-cache-")); roots.push(parent);
  const root = join(parent, "installation"); await mkdir(join(root, "bin"), { recursive: true }); await mkdir(join(root, "internal-bin"));
  await writeFile(join(root, "versions"), `node: ${process.versions.node}\nnoir: 1.0.0-rc.3\n`);
  await writeFile(join(root, "package.json"), "{}"); await writeFile(join(root, "probe-count"), "");
  await writeFile(join(root, "internal-bin/nargo"), `#!/bin/sh\nprintf x >> '${root}/probe-count'\nprintf 'nargo version = 1.0.0-rc.3\\nnoirc version = cache fixture\\n'\n`, { mode: 0o755 });
  await writeFile(join(root, "bin/aztec"), "#!/bin/sh\nprintf '6.0.0-rc.3\\n'\n", { mode: 0o755 });
  const packages: Record<string, Record<string, string>> = {
    "@aztec-labs/aztec": { ".": "./index.js" }, "@aztec-labs/cli": { ".": "./index.js" },
    "@aztec-labs/aztec.js": { "./node": "./index.js", "./contracts": "./index.js" },
    "@aztec-labs/wallets": { "./embedded": "./index.js" }, "@aztec-labs/accounts": { "./testing": "./index.js" }, "@aztec-labs/pxe": { "./config": "./index.js" },
    ...Object.fromEntries(["bb.js", "noir-types", "noir-acvm_js", "noir-noirc_abi", "l1-artifacts"].map(name => [`@aztec-foundation/${name}`, { ".": "./index.js" }])),
  };
  for (const [name, exports] of Object.entries(packages)) {
    const directory = join(root, "node_modules", name); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({ name, type: "module", version: name.startsWith("@aztec-foundation/") ? "6.0.0-rc.6" : "6.0.0-rc.3", exports,
      ...(name === "@aztec-labs/pxe" ? { dependencies: { "@aztec-foundation/bb.js": "6.0.0-rc.6" } } : {}) }));
    await writeFile(join(directory, "index.js"), "throw Error('Do not import SDK during preflight');");
  }
  return { root, parent, selection: { installationRoot: root, nodeExecutable: process.execPath }, probes: async () => (await readFile(join(root, "probe-count"), "utf8")).length };
}

describe("bounded preflight cache", () => {
  it("reuses canonical selections and returns independent report copies", async () => {
    const { root, parent, selection, probes } = await fixture(); const inspect = createCachedToolchainInspector();
    const first = await inspect(selection); expect(first.diagnostics.map(d => d.code)).toEqual(["unsupported-runtime"]);
    first.packages[0].version = "mutated by caller"; first.diagnostics.length = 0;
    const alias = join(parent, "alias"); await symlink(root, alias);
    const warm = await inspect({ ...selection, installationRoot: alias });
    expect(warm.packages[0].version).toBe("6.0.0-rc.3"); expect(warm.diagnostics).toHaveLength(1); expect(await probes()).toBe(1);
  });
  it("invalidates same-size manifest edits even when mtime is restored, and does not cache failures", async () => {
    const { root, selection, probes } = await fixture(); const inspect = createCachedToolchainInspector(); await inspect(selection);
    const path = join(root, "node_modules/@aztec-labs/wallets/package.json"); const before = await stat(path);
    const text = await readFile(path, "utf8"); await writeFile(path, text.replace("6.0.0-rc.3", "6.0.0-rc.4")); await utimes(path, before.atime, before.mtime);
    const changed = await inspect(selection); expect(changed.diagnostics.some(d => d.code === "incompatible-labs-package")).toBe(true); expect(await probes()).toBe(2);
    await inspect(selection); expect(await probes()).toBe(3);
  });
  it("freshly resolves retargeted export symlinks rather than using Node's module-resolution cache", async () => {
    const { root, selection, probes } = await fixture(); const inspect = createCachedToolchainInspector();
    const directory = join(root, "node_modules/@aztec-labs/wallets"); const entry = join(directory, "index.js");
    await writeFile(join(directory, "first.js"), "export const x=1"); await writeFile(join(directory, "other.js"), "export const x=2");
    await rm(entry); await symlink("first.js", entry); const first = await inspect(selection);
    const metadata = await stat(directory); await rm(entry); await symlink("other.js", entry); await utimes(directory, metadata.atime, metadata.mtime);
    const next = await inspect(selection);
    expect(first.publicExports.find(p => p.specifier.includes("wallets"))?.path).toBe(join(directory, "first.js"));
    expect(next.publicExports.find(p => p.specifier.includes("wallets"))?.path).toBe(join(directory, "other.js")); expect(await probes()).toBe(2);
  });
  it("detects newly nearer dependency manifests and changed executable identities", async () => {
    const { root, selection, probes } = await fixture(); const inspect = createCachedToolchainInspector(); await inspect(selection);
    const nested = join(root, "node_modules/@aztec-labs/pxe/node_modules/@aztec-foundation/bb.js"); await mkdir(nested, { recursive: true });
    await writeFile(join(nested, "package.json"), JSON.stringify({ name: "@aztec-foundation/bb.js", version: "6.0.0-rc.5" }));
    expect((await inspect(selection)).diagnostics.some(d => d.code === "incompatible-foundation-dependency")).toBe(true); expect(await probes()).toBe(2);
    await rm(join(root, "node_modules/@aztec-labs/pxe/node_modules"), { recursive: true }); await inspect(selection);
    const cli = join(root, "bin/aztec"); const previous = await stat(cli); await writeFile(cli, "#!/bin/sh\nprintf '5.2.0\\n'\n"); await utimes(cli, previous.atime, previous.mtime);
    expect((await inspect(selection)).diagnostics.some(d => d.code === "incompatible-cli")).toBe(true); expect(await probes()).toBe(4);
  });
  it("invalidates native prover payload changes without executing the prover", async () => {
    const { root, selection, probes } = await fixture(); const inspect = createCachedToolchainInspector();
    const directory = join(root, "node_modules/@aztec-foundation/bb.js/build/amd64-linux");
    await mkdir(directory, { recursive: true }); const binary = join(directory, "bb");
    await writeFile(binary, "native payload first"); await inspect(selection);
    const metadata = await stat(binary); await writeFile(binary, "native payload other"); await utimes(binary, metadata.atime, metadata.mtime);
    await inspect(selection); expect(await probes()).toBe(2);
  });
  it("watches optional lockfile creation and evicts least recently used entries", async () => {
    const a = await fixture(), b = await fixture(), c = await fixture(); const inspect = createCachedToolchainInspector({ maxEntries: 2 });
    await inspect(a.selection); await writeFile(join(a.root, "package-lock.json"), "{}"); expect((await inspect(a.selection)).provenance.lockfileSha256).toBeDefined();
    await inspect(b.selection); await inspect(a.selection); await inspect(c.selection); await inspect(b.selection);
    expect(await a.probes()).toBe(2); expect(await b.probes()).toBe(2); expect(await c.probes()).toBe(1);
  });
  it("constrains cached candidate validation to the recorded tuple", async () => {
    const { root, selection, probes } = await fixture(); const report = await inspectToolchain(selection);
    const validate = createCandidateRuntimeValidator(runtimeIdentity(report));
    await validate(selection); await validate(selection); expect(await probes()).toBe(2);
    await writeFile(join(root, "package-lock.json"), "{}");
    await expect(validate(selection)).rejects.toThrow("exact recorded component tuple");
    expect(() => createCandidateRuntimeValidator("anything" )).toThrow("exact recorded");
  });
});
