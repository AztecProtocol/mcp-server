import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectToolchain } from "../../src/development/toolchain.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function installation() {
  const root = await mkdtemp(join(tmpdir(), "mcp-toolchain-")); roots.push(root);
  await mkdir(join(root, "internal-bin")); await mkdir(join(root, "bin"));
  await writeFile(join(root, "versions"), `node: ${process.versions.node}\nnoir: 1.0.0-rc.3\n`);
  await writeFile(join(root, "package.json"), '{}');
  await writeFile(join(root, "internal-bin/nargo"), '#!/bin/sh\nprintf "nargo version = 1.0.0-rc.3\\nnoirc version = fixture\\n"\n', { mode: 0o755 });
  await writeFile(join(root, "bin/aztec"), '#!/bin/sh\nprintf "6.0.0-rc.3\\n"\n', { mode: 0o755 });
  const modules: Record<string, Record<string, string>> = {
    "@aztec-labs/aztec": {".": "./index.js"},
    "@aztec-labs/cli": {".": "./index.js"},
    "@aztec-labs/aztec.js": {"./node": "./index.js", "./contracts": "./index.js"},
    "@aztec-labs/wallets": {"./embedded": "./index.js"},
    "@aztec-labs/accounts": {"./testing": "./index.js"},
    "@aztec-labs/pxe": {"./config": "./index.js"},
    "@aztec-foundation/bb.js": {".": "./index.js"},
    "@aztec-foundation/noir-types": {".": "./index.js"},
    "@aztec-foundation/noir-acvm_js": {".": "./index.js"},
    "@aztec-foundation/noir-noirc_abi": {".": "./index.js"},
    "@aztec-foundation/l1-artifacts": {".": "./index.js"},
  };
  for (const [name, exports] of Object.entries(modules)) {
    const dir = join(root, "node_modules", name); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name, version: name.startsWith('@aztec-foundation/') ? '6.0.0-rc.6' : '6.0.0-rc.3', type: 'module', exports }));
    await writeFile(join(dir, "index.js"), 'throw new Error("preflight must not import runtime packages");');
  }
  return root;
}

describe("selected toolchain preflight", () => {
  it("reports separate component identities without promoting a fixture tuple", async () => {
    const root = await installation();
    const report = await inspectToolchain({ installationRoot: root, nodeExecutable: process.execPath });
    expect(report.installationRoot).toBe(root);
    expect(report.runtimeNode.version).toBe(process.version);
    expect(report.compiler.identity).toContain('nargo version = 1.0.0-rc.3');
    expect(report.packages.find(p => p.name === '@aztec-labs/pxe')?.version).toBe('6.0.0-rc.3');
    expect(report.packages.find(p => p.name === '@aztec-foundation/bb.js')?.version).toBe('6.0.0-rc.6');
    expect(report.supported).toBe(false);
    expect(report.diagnostics.map(d => d.code)).toEqual(['unsupported-runtime']);
  });

  it("does not take missing tools or SDK exports from another installation", async () => {
    const root = await installation();
    const other = await installation();
    await rm(join(root, "internal-bin/nargo"));
    await rm(join(root, "node_modules/@aztec-labs/wallets"), { recursive: true });
    await symlink(join(other, "node_modules/@aztec-labs/wallets"), join(root, "node_modules/@aztec-labs/wallets"));
    const report = await inspectToolchain({ installationRoot: root, nodeExecutable: process.execPath });
    expect(report.compiler.identity).toBeUndefined();
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'missing-tool', component: 'compiler' }),
      expect.objectContaining({ code: 'missing-package', component: '@aztec-labs/wallets', message: expect.stringContaining('outside') }),
      expect.objectContaining({ code: 'missing-public-export', component: '@aztec-labs/wallets/embedded' }),
    ]));
  });

  it("rejects a Node below the installation runtime minimum even when SDK engines look permissive", async () => {
    const root = await installation();
    await writeFile(join(root, 'versions'), 'node: 99.0.0\nnoir: 1.0.0-rc.3\n');
    const report = await inspectToolchain({ installationRoot: root, nodeExecutable: process.execPath });
    expect(report.diagnostics).toContainEqual(expect.objectContaining({ code: 'incompatible-node' }));
    expect(report.cli.identity).toBeUndefined();
  });

  it("rejects misleading matching Labs and Foundation version numbers", async () => {
    const root = await installation();
    const file = join(root, 'node_modules/@aztec-foundation/bb.js/package.json');
    await writeFile(file, JSON.stringify({name:'@aztec-foundation/bb.js',version:'6.0.0-rc.3'}));
    const report = await inspectToolchain({ installationRoot: root, nodeExecutable: process.execPath });
    expect(report.diagnostics).toContainEqual(expect.objectContaining({code:'incompatible-foundation',component:'@aztec-foundation/bb.js'}));
    expect(report.supported).toBe(false);
  });

  it("reports missing installations and incomplete public exports without importing SDK code", async () => {
    const missing = await inspectToolchain({ installationRoot: '/does-not-exist/aztec', nodeExecutable: process.execPath });
    expect(missing.diagnostics[0].code).toBe('missing-installation');
    const root = await installation();
    await writeFile(join(root, 'node_modules/@aztec-labs/aztec.js/package.json'), JSON.stringify({name:'@aztec-labs/aztec.js',version:'6.0.0-rc.3',exports:{}}));
    const report = await inspectToolchain({ installationRoot: root, nodeExecutable: process.execPath });
    expect(report.diagnostics).toContainEqual(expect.objectContaining({code:'missing-public-export', component:'@aztec-labs/aztec.js/node'}));
  });

  it("detects a compiler replaced independently of the selected manifest", async () => {
    const root = await installation();
    await writeFile(join(root, 'versions'), `node: ${process.versions.node}\nnoir: 9.9.9\n`);
    const report = await inspectToolchain({ installationRoot: root, nodeExecutable: process.execPath });
    expect(report.diagnostics).toContainEqual(expect.objectContaining({code:'incompatible-compiler'}));
  });

  it("strips inherited Node runtime flags before probing the explicitly selected executable", async () => {
    const root = await installation();
    vi.stubEnv("NODE_OPTIONS", "--this-option-does-not-exist");
    vi.stubEnv("NODE_PATH", "/unrelated/installation/node_modules");
    const report = await inspectToolchain({ installationRoot: root, nodeExecutable: process.execPath });
    expect(report.runtimeNode.version).toBe(process.version);
    expect(report.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["unsupported-runtime"]);
  });

  it("rejects a CLI executable reporting a different version from its selected package", async () => {
    const root = await installation();
    await writeFile(join(root, "bin/aztec"), '#!/bin/sh\nprintf "5.2.0\\n"\n', { mode: 0o755 });
    const report = await inspectToolchain({ installationRoot: root, nodeExecutable: process.execPath });
    expect(report.diagnostics).toContainEqual(expect.objectContaining({ code: "incompatible-cli" }));
  });

  it("does not let a wrapper silently choose another Node when the explicit executable has a nonstandard name", async () => {
    const root = await installation();
    const nodeExecutable = join(root, "custom-node");
    await writeFile(nodeExecutable, `#!/bin/sh\nprintf '${process.version}\\n'\n`, { mode: 0o755 });
    const report = await inspectToolchain({ installationRoot: root, nodeExecutable });
    expect(report.runtimeNode.version).toBe(process.version);
    expect(report.cli.identity).toBeUndefined();
    expect(report.diagnostics).toContainEqual(expect.objectContaining({ code: "ambiguous-node-launcher" }));
  });

  it("rejects mixed Labs package releases independently of the Foundation target", async () => {
    const root = await installation();
    const file = join(root, "node_modules/@aztec-labs/wallets/package.json");
    const pkg = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...pkg, version: "6.0.0-rc.4" }));
    const report = await inspectToolchain({ installationRoot: root, nodeExecutable: process.execPath });
    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      code: "incompatible-labs-package", component: "@aztec-labs/wallets",
    }));
  });

  it("compares declared Foundation dependency pins with the packages the importer resolves", async () => {
    const root = await installation();
    const file = join(root, "node_modules/@aztec-labs/pxe/package.json");
    const pkg = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...pkg, dependencies: { "@aztec-foundation/bb.js": "6.0.0-rc.5" } }));
    const report = await inspectToolchain({ installationRoot: root, nodeExecutable: process.execPath });
    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      code: "incompatible-foundation-dependency", component: "@aztec-labs/pxe",
    }));
  });

  it("detects a conflicting nested Foundation dependency even when the top-level package matches", async () => {
    const root = await installation();
    const file = join(root, "node_modules/@aztec-labs/pxe/package.json");
    const pkg = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...pkg, dependencies: { "@aztec-foundation/bb.js": "6.0.0-rc.6" } }));
    const nested = join(root, "node_modules/@aztec-labs/pxe/node_modules/@aztec-foundation/bb.js");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, "package.json"), JSON.stringify({ name: "@aztec-foundation/bb.js", version: "6.0.0-rc.5" }));
    const report = await inspectToolchain({ installationRoot: root, nodeExecutable: process.execPath });
    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      code: "incompatible-foundation-dependency", component: "@aztec-labs/pxe",
      message: expect.stringContaining("6.0.0-rc.5"),
    }));
  });
});
