import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, lstat, readFile, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { getSupportedRuntimeProfile, runtimeIdentity } from "./runtime-support.js";

const execute = promisify(execFile);
const TARGET = "6.0.0-rc.6";
const LABS_PACKAGES = ["aztec", "cli", "aztec.js", "wallets", "accounts", "pxe"];
const FOUNDATION_PACKAGES = ["bb.js", "noir-types", "noir-acvm_js", "noir-noirc_abi", "l1-artifacts"];
const PUBLIC_EXPORTS = [
  "@aztec-labs/aztec.js/node", "@aztec-labs/aztec.js/contracts",
  "@aztec-labs/wallets/embedded", "@aztec-labs/accounts/testing", "@aztec-labs/pxe/config",
];

export interface ToolchainSelection {
  installationRoot: string;
  nodeExecutable: string;
}

export interface ToolchainDiagnostic {
  code: string;
  component: string;
  message: string;
  guidance: string;
}

export interface ToolchainReport {
  target: string;
  installationRoot: string;
  supported: boolean;
  runtimeNode: { path: string; version?: string; requiredVersion?: string };
  cli: { path?: string; identity?: string };
  compiler: { path?: string; identity?: string; expectedVersion?: string };
  packages: Array<{
    name: string; version: string; path: string; gitHead?: string;
    engines?: Record<string, string>; foundationDependencies: Record<string, string>;
    resolvedFoundationDependencies: Record<string, { version: string; path: string }>;
  }>;
  publicExports: Array<{ specifier: string; path: string }>;
  provenance: { versionsManifest?: string; lockfileSha256?: string; sourceIdentity: "unverified" };
  diagnostics: ToolchainDiagnostic[];
}

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function installedPath(root: string, path: string): Promise<string> {
  const resolved = await realpath(path);
  if (!contained(root, resolved)) throw new Error("resolves outside the selected installation");
  return resolved;
}

async function dependencyIdentity(root: string, importer: string, name: string) {
  // Inspect the package nearest this importer, including nested npm dependencies.
  // Reading metadata directly avoids depending on an unexported package.json path.
  for (const directory of createRequire(importer).resolve.paths(name) ?? []) {
    if (!contained(root, directory)) continue;
    const candidate = join(directory, name, "package.json");
    try {
      const path = await installedPath(root, candidate);
      const pkg = JSON.parse(await readFile(path, "utf8"));
      if (pkg.name !== name || typeof pkg.version !== "string") throw new Error("Dependency identity is inconsistent.");
      return { version: pkg.version as string, path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error(`${name} is missing from this importer's selected installation.`);
}

function atLeast(actual: string, minimum: string): boolean {
  const a = actual.replace(/^v/, "").split(".").map(Number);
  const b = minimum.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

export async function inspectToolchain(selection: ToolchainSelection): Promise<ToolchainReport> {
  const report: ToolchainReport = {
    target: TARGET, installationRoot: selection.installationRoot, supported: false,
    runtimeNode: { path: selection.nodeExecutable }, cli: {}, compiler: {},
    packages: [], publicExports: [], provenance: { sourceIdentity: "unverified" }, diagnostics: [],
  };
  const diagnostic = (code: string, component: string, message: string, guidance: string) =>
    report.diagnostics.push({ code, component, message, guidance });
  const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

  if (!isAbsolute(selection.installationRoot) || !isAbsolute(selection.nodeExecutable)) {
    diagnostic("invalid-selection", "installation", "Installation and Node paths must be absolute.",
      "Provide installationRoot and nodeExecutable explicitly; PATH and ~ expansion are not used.");
    return report;
  }
  let root: string;
  try {
    root = await realpath(selection.installationRoot);
    report.installationRoot = root;
  } catch (error) {
    diagnostic("missing-installation", "installation", errorText(error), "Select an existing Aztec installation; no tools are installed automatically.");
    return report;
  }

  try {
    const manifest = await readFile(await installedPath(root, join(root, "versions")), "utf8");
    report.provenance.versionsManifest = manifest.slice(0, 8192);
    report.runtimeNode.requiredVersion = /^node:\s*(\d+\.\d+\.\d+)\s*$/m.exec(manifest)?.[1];
    report.compiler.expectedVersion = /^noir:\s*(\S+)\s*$/m.exec(manifest)?.[1];
    if (!report.runtimeNode.requiredVersion) throw new Error("The versions manifest has no supported Node version declaration.");
  } catch (error) {
    diagnostic("missing-runtime-manifest", "versions", errorText(error), "Select a complete installation with its original versions manifest.");
  }
  try {
    const lock = await readFile(await installedPath(root, join(root, "package-lock.json")));
    report.provenance.lockfileSha256 = createHash("sha256").update(lock).digest("hex");
  } catch {}

  let nodeReady = false;
  const runtimeEnv = { ...process.env };
  delete runtimeEnv.NODE_OPTIONS;
  delete runtimeEnv.NODE_PATH;
  try {
    report.runtimeNode.path = await realpath(selection.nodeExecutable);
    const { stdout } = await execute(report.runtimeNode.path, ["--version"], { env: runtimeEnv, timeout: 10000, maxBuffer: 8192 });
    report.runtimeNode.version = stdout.trim();
    if (!/^v\d+\.\d+\.\d+$/.test(stdout.trim())) throw new Error("Selected executable did not report a Node version.");
    const minimum = report.runtimeNode.requiredVersion;
    if (minimum && !atLeast(stdout.trim(), minimum)) {
      diagnostic("incompatible-node", "node", `Node ${stdout.trim()} is below the installation minimum ${minimum}.`, "Select an absolute path to the Node runtime required by this installation.");
    } else if (minimum) nodeReady = true;
  } catch (error) {
    diagnostic("missing-node", "node", errorText(error), "Provide the absolute executable path of the installation's Node runtime.");
  }
  if (nodeReady) {
    try {
      if (await realpath(join(dirname(report.runtimeNode.path), "node")) !== report.runtimeNode.path) {
        throw new Error("The installation's launcher would select a different Node executable.");
      }
    } catch (error) {
      nodeReady = false;
      diagnostic("ambiguous-node-launcher", "node", errorText(error),
        "Select the original executable named node so the installation's CLI launcher uses the same runtime as the worker.");
    }
  }

  for (const name of [...LABS_PACKAGES.map(p => `@aztec-labs/${p}`), ...FOUNDATION_PACKAGES.map(p => `@aztec-foundation/${p}`)]) {
    try {
      const path = await installedPath(root, join(root, "node_modules", name, "package.json"));
      const pkg = JSON.parse(await readFile(path, "utf8"));
      if (pkg.name !== name || typeof pkg.version !== "string") throw new Error("Package identity is missing or inconsistent.");
      const foundationDependencies: Record<string, string> = {};
      for (const [dependency, version] of Object.entries(pkg.dependencies ?? {})) {
        if (dependency.startsWith("@aztec-foundation/") && typeof version === "string") foundationDependencies[dependency] = version;
      }
      report.packages.push({ name, version: pkg.version, path, gitHead: pkg.gitHead, engines: pkg.engines,
        foundationDependencies, resolvedFoundationDependencies: {} });
      if (name.startsWith("@aztec-foundation/") && pkg.version !== TARGET) {
        diagnostic("incompatible-foundation", name, `Found ${pkg.version}; this candidate target requires ${TARGET}.`, "Select a distribution associated with the Foundation rc.6 target; equal Labs/compiler version numbers are not a compatibility rule.");
      }
    } catch (error) {
      diagnostic("missing-package", name, errorText(error), "Select a complete v6 installation containing this package; packages from another installation are never substituted.");
    }
  }

  const labsVersion = report.packages.find(pkg => pkg.name === "@aztec-labs/aztec")?.version;
  for (const pkg of report.packages) {
    if (labsVersion && pkg.name.startsWith("@aztec-labs/") && pkg.version !== labsVersion) {
      diagnostic("incompatible-labs-package", pkg.name, `Found ${pkg.version}, but the selected Labs CLI package is ${labsVersion}.`,
        "Select a complete Labs distribution; its package release number is separate from the Foundation target.");
    }
    for (const [dependency, declared] of Object.entries(pkg.foundationDependencies)) {
      try {
        const resolved = await dependencyIdentity(root, pkg.path, dependency);
        pkg.resolvedFoundationDependencies[dependency] = resolved;
        if (declared !== TARGET || resolved.version !== declared) {
          diagnostic("incompatible-foundation-dependency", pkg.name,
            `${dependency} declares ${declared} and resolves ${resolved.version} at ${resolved.path}; the candidate requires the exact ${TARGET} pin.`,
            "Restore the distribution's pinned Foundation dependencies, including nested packages; matching top-level versions alone is insufficient.");
        }
      } catch (error) {
        diagnostic("missing-foundation-dependency", pkg.name, errorText(error),
          "Restore this package's dependency inside the selected installation; no dependency is borrowed from another installation.");
      }
    }
  }

  const require = createRequire(join(root, "package.json"));
  // Node caches package exports and symlink resolution in-process. Resolve in a fresh
  // selected-Node process so an invalidated preflight cannot reuse stale resolution.
  let resolvedExports: Record<string, { path?: string; error?: string }> | undefined;
  if (nodeReady) {
    try {
      const code = `import {createRequire} from 'node:module';import{join}from'node:path';const r=createRequire(join(process.argv[1],'package.json'));const result={};for(const name of JSON.parse(process.argv[2])){try{result[name]={path:r.resolve(name)}}catch(error){result[name]={error:String(error.message).slice(0,1000)}}}process.stdout.write(JSON.stringify(result));`;
      const { stdout } = await execute(report.runtimeNode.path, ["--input-type=module", "-e", code, root, JSON.stringify(PUBLIC_EXPORTS)], { env: runtimeEnv, timeout: 10000, maxBuffer: 32768 });
      resolvedExports = JSON.parse(stdout);
    } catch (error) {
      diagnostic("export-resolution-failed", "runtime", errorText(error), "Restore the selected Node runtime so public SDK exports can be resolved without executing SDK code.");
    }
  }
  for (const specifier of PUBLIC_EXPORTS) {
    try {
      const resolved = resolvedExports?.[specifier];
      if (resolvedExports && !resolved?.path) throw new Error(resolved?.error ?? "Public export could not be resolved.");
      const path = await installedPath(root, resolved?.path ?? require.resolve(specifier));
      report.publicExports.push({ specifier, path });
    } catch (error) {
      diagnostic("missing-public-export", specifier, errorText(error), "Select an installation exposing the required public SDK entry point.");
    }
  }

  // Pin the wrapper's native tools and Node, and prevent .aztecrc from selecting another release.
  const env = { ...runtimeEnv, PATH: [dirname(report.runtimeNode.path), join(root, "internal-bin"), join(root, "bin"), "/usr/bin", "/bin"].join(":"), AZTEC_VERSIONED: "1" };
  for (const [component, rel, output] of [
    ["compiler", "internal-bin/nargo", report.compiler], ["cli", "bin/aztec", report.cli],
  ] as const) {
    try {
      output.path = await installedPath(root, join(root, rel));
      await access(output.path, constants.X_OK);
      if (component === "cli" && !nodeReady) continue;
      const { stdout } = await execute(output.path, ["--version"], { cwd: root, env, timeout: 15000, maxBuffer: 32768 });
      output.identity = stdout.trim();
      if (!output.identity) throw new Error("Version command returned no identity.");
      if (component === "cli" && labsVersion && output.identity.replace(/^v/, "") !== labsVersion) {
        diagnostic("incompatible-cli", component, `CLI reports ${output.identity}, but its package is ${labsVersion}.`,
          "Restore the CLI launcher from the selected installation.");
      }
      if (component === "compiler" && report.compiler.expectedVersion) {
        const actual = /^nargo version = (\S+)/m.exec(stdout)?.[1];
        if (actual !== report.compiler.expectedVersion.replace(/^v/, "")) {
          diagnostic("incompatible-compiler", component, "Compiler identity does not match the installation manifest.", "Restore the compiler shipped with this installation.");
        }
      }
    } catch (error) {
      diagnostic("missing-tool", component, errorText(error), "Restore the selected installation's executable; no PATH fallback is attempted.");
    }
  }
  report.supported = report.diagnostics.length === 0 && getSupportedRuntimeProfile(runtimeIdentity(report)) !== undefined;
  if (!report.supported) diagnostic("unsupported-runtime", "compatibility", "This exact component tuple has not completed the development acceptance workflow.",
    "Select the recorded supported tuple or use the candidate-validation harness to collect separate acceptance evidence; no release is substituted automatically.");
  return report;
}

export type ToolchainInspector = (selection: ToolchainSelection) => Promise<ToolchainReport>;
interface InspectionCacheEntry { fingerprint: string; report: ToolchainReport }

async function inspectionMetadataFingerprint(selection: ToolchainSelection): Promise<{ fingerprint: string; resolvedPaths: Set<string> } | undefined> {
  const root = selection.installationRoot;
  const paths = new Set<string>();
  const add = (path: string) => {
    paths.add(path);
    for (let parent = dirname(path); contained(root, parent); parent = dirname(parent)) {
      paths.add(parent); if (parent === root) break;
    }
  };
  for (const path of [root, selection.nodeExecutable, join(dirname(selection.nodeExecutable), "node"), join(root, "versions"), join(root, "package.json"), join(root, "package-lock.json"), join(root, "bin/aztec"), join(root, "internal-bin/nargo"), join(root, "node_modules/.bin/aztec")]) add(path);
  // Native/WASM payloads are selected internally by bb.js rather than its exports map.
  const bbRoot = join(root, "node_modules/@aztec-foundation/bb.js");
  for (const platform of ["amd64-linux", "arm64-linux", "amd64-macos", "arm64-macos"]) {
    for (const binary of ["bb", "nodejs_module.node"]) add(join(bbRoot, "build", platform, binary));
  }
  for (const distribution of ["node", "node-cjs"]) add(join(bbRoot, "dest", distribution, "barretenberg_wasm/barretenberg-threads.wasm.gz"));
  const literalTargets = (value: unknown, directory: string) => {
    if (typeof value === "string") {
      if (value.startsWith("./") && !value.includes("*")) add(join(directory, value));
    } else if (value && typeof value === "object") {
      for (const child of Object.values(value)) literalTargets(child, directory);
    }
  };
  const addResolutionCandidates = async (importer: string, dependency: string) => {
    for (const directory of createRequire(importer).resolve.paths(dependency) ?? []) {
      if (!contained(root, directory)) continue;
      const candidate = join(directory, dependency, "package.json"); add(candidate);
      try {
        const nested = JSON.parse(await readFile(candidate, "utf8"));
        literalTargets(nested.exports, dirname(candidate));
        if (typeof nested.main === "string") add(join(dirname(candidate), nested.main));
        return;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return; }
    }
  };
  for (const name of [...LABS_PACKAGES.map(p => `@aztec-labs/${p}`), ...FOUNDATION_PACKAGES.map(p => `@aztec-foundation/${p}`)]) {
    const manifest = join(root, "node_modules", name, "package.json"); add(manifest);
    let pkg: any;
    try { pkg = JSON.parse(await readFile(manifest, "utf8")); } catch { continue; }
    literalTargets(pkg.exports, dirname(manifest));
    // Package bin targets often omit the leading ./ accepted by exports.
    for (const target of typeof pkg.bin === "string" ? [pkg.bin] : Object.values(pkg.bin ?? {})) if (typeof target === "string") add(join(dirname(manifest), target));
    if (typeof pkg.main === "string") add(join(dirname(manifest), pkg.main));
    const canonicalManifest = await realpath(manifest).catch(() => manifest);
    for (const dependency of Object.keys(pkg.dependencies ?? {}).filter(name => name.startsWith("@aztec-foundation/"))) {
      await addResolutionCandidates(canonicalManifest, dependency);
    }
  }
  if (paths.size > 4096) return undefined;
  const resolvedPaths = new Set<string>();
  const identities = await Promise.all([...paths].sort().map(async path => {
    try {
      const entry = await lstat(path, { bigint: true }); const resolved = await realpath(path);
      const target = await stat(path, { bigint: true }); resolvedPaths.add(resolved);
      const identity = (info: typeof target) => [info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs].map(String);
      return [path, resolved, identity(entry), identity(target)];
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return [path, "missing"];
      throw error;
    }
  }));
  return { fingerprint: createHash("sha256").update(JSON.stringify(identities)).digest("hex"), resolvedPaths };
}

export function createCachedToolchainInspector(options: { maxEntries?: number } = {}): ToolchainInspector {
  const maxEntries = options.maxEntries ?? 4;
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 32) throw new Error("maxEntries must be an integer from 1 to 32.");
  const entries = new Map<string, InspectionCacheEntry>();
  return async selection => {
    if (!isAbsolute(selection.installationRoot) || !isAbsolute(selection.nodeExecutable)) return inspectToolchain(selection);
    let canonical: ToolchainSelection;
    try { canonical = { installationRoot: await realpath(selection.installationRoot), nodeExecutable: await realpath(selection.nodeExecutable) }; }
    catch { return inspectToolchain(selection); }
    const key = `${canonical.installationRoot}\0${canonical.nodeExecutable}`;
    const before = await inspectionMetadataFingerprint(canonical).catch(() => undefined);
    const cached = entries.get(key);
    if (before && cached?.fingerprint === before.fingerprint) {
      entries.delete(key); entries.set(key, cached); return structuredClone(cached.report);
    }
    entries.delete(key);
    const report = await inspectToolchain(canonical);
    if (before && report.diagnostics.every(diagnostic => diagnostic.code === "unsupported-runtime")) {
      const after = await inspectionMetadataFingerprint(canonical).catch(() => undefined);
      if (after?.fingerprint === before.fingerprint && report.publicExports.every(entry => after.resolvedPaths.has(entry.path))) {
        entries.set(key, { fingerprint: after.fingerprint, report: structuredClone(report) });
        while (entries.size > maxEntries) entries.delete(entries.keys().next().value!);
      }
    }
    return structuredClone(report);
  };
}
