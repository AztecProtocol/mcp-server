import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rename } from "node:fs/promises";
import { join, resolve, relative, basename } from "node:path";
import type { ToolchainReport } from "./toolchain.js";
const ignored = new Set(["target", "node_modules", ".git", ".aztec-mcp"]);
export interface ArtifactIdentity {
  path: string;
  contentHash: string;
  provenanceHash: string;
  contractName?: string;
}
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
/** Follow local manifest dependencies and hash source/manifest contents, never incremental output. */
export async function projectProvenance(project: string, runtime: ToolchainReport, options: unknown, includeGitDependencies = true): Promise<string> {
  return (await fingerprintProject(project, runtime, options, includeGitDependencies)).hash;
}
export interface ProjectProvenanceSnapshot { hash: string; unresolvedGitDependencies: string[] }
/** Capture missing cache roots so first-time compiler downloads can be distinguished from changed inputs. */
export function captureProjectProvenance(project: string, runtime: ToolchainReport, options: unknown, treatAsUnresolved: ReadonlySet<string> = new Set()): Promise<ProjectProvenanceSnapshot> {
  return fingerprintProject(project, runtime, options, true, treatAsUnresolved);
}
async function fingerprintProject(project: string, runtime: ToolchainReport, options: unknown, includeGitDependencies: boolean, treatAsUnresolved: ReadonlySet<string> = new Set()): Promise<ProjectProvenanceSnapshot> {
  const unresolvedGitDependencies = new Set<string>();
  const visited = new Set<string>();
  const files: Array<[
    string,
    string
  ]> = [];
  async function walk(directory: string): Promise<void> {
    const canonical = await realpath(directory);
    if (visited.has(canonical))
      return;
    visited.add(canonical);
    for (const entry of (await readdir(canonical, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(canonical, entry.name);
      if (entry.isDirectory() && !ignored.has(entry.name))
        await walk(path);
      else if (entry.isFile() && (entry.name.endsWith(".nr") || ["Nargo.toml", "Nargo.lock", ".aztecrc"].includes(entry.name))) {
        const content = await readFile(path);
        files.push([relative(project, path), hash(content)]);
        if (entry.name === "Nargo.toml") {
          for (const match of content.toString().matchAll(/\bpath\s*=\s*["']([^"']+)["']/g))
            await walk(resolve(canonical, match[1]));
          if (includeGitDependencies)
            for (const table of content.toString().matchAll(/\{([^}]*\bgit\s*=[^}]*)\}/g)) {
              const git = /\bgit\s*=\s*["']([^"']+)["']/.exec(table[1])?.[1];
              const tag = /\btag\s*=\s*["']([^"']+)["']/.exec(table[1])?.[1];
              const subdirectory = /\bdirectory\s*=\s*["']([^"']+)["']/.exec(table[1])?.[1] ?? "";
              if (!git || !tag)
                throw new Error("Git build dependencies must use an explicit tag.");
              const url = new URL(git);
              const cached = join(homedir(), "nargo", url.hostname, url.pathname.replace(/^\//, ""), tag, subdirectory);
              if (treatAsUnresolved.has(cached)) {
                unresolvedGitDependencies.add(cached); files.push([cached, "not-yet-resolved"]); continue;
              }
              try {
                await walk(cached);
              }
              catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                  throw error;
                unresolvedGitDependencies.add(cached);
                files.push([cached, "not-yet-resolved"]);
              }
            }
        }
      }
      else if (entry.isSymbolicLink())
        throw new Error(`Symbolic links in build inputs are unsupported: ${path}`);
    }
  }
  await walk(project);
  return { hash: hash(JSON.stringify({ files: files.sort(([a], [b]) => a.localeCompare(b)), compiler: runtime.compiler.identity, cli: runtime.cli.identity, node: runtime.runtimeNode.version, packages: runtime.packages.map(p => [p.name, p.version]), lock: runtime.provenance.lockfileSha256, options })), unresolvedGitDependencies: [...unresolvedGitDependencies] };
}
export async function collectArtifacts(project: string, provenanceHash: string, packageName?: string): Promise<ArtifactIdentity[]> {
  let names: string[];
  try {
    names = await readdir(join(project, "target"));
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return [];
    throw error;
  }
  const artifacts: ArtifactIdentity[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json"))
      continue;
    const path = join(project, "target", name);
    if (await realpath(path) !== path) throw new Error("Build artifacts must not contain symlinks.");
    const content = await readFile(path);
    try {
      const artifact = JSON.parse(content.toString());
      if (!Array.isArray(artifact.functions))
        continue;
      if (packageName && name !== `${packageName}.json` && name !== `${packageName}-${artifact.name}.json`)
        continue;
      artifacts.push({ path, contentHash: hash(content), provenanceHash, contractName: typeof artifact.name === "string" ? artifact.name : basename(name, ".json") });
    }
    catch {}
  }
  return artifacts;
}

export interface QuarantinedArtifact { originalPath: string; path: string; contentHash: string }
/** Keep obsolete compiler outputs recoverable without certifying them as outputs of a new build. */
export async function quarantineArtifacts(project: string, artifacts: readonly ArtifactIdentity[]): Promise<QuarantinedArtifact[]> {
  if (!artifacts.length) return [];
  const directory = join(project, ".aztec-mcp", "build-artifacts", randomUUID());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await realpath(directory) !== directory) throw new Error("Build artifact quarantine must not contain symlinks.");
  const result: QuarantinedArtifact[] = [];
  for (const artifact of artifacts) {
    if (await realpath(artifact.path) !== artifact.path || hash(await readFile(artifact.path)) !== artifact.contentHash) {
      throw new Error("Build artifacts changed during invalidation; retry the build.");
    }
    const path = join(directory, basename(artifact.path));
    await rename(artifact.path, path);
    result.push({ originalPath: artifact.path, path, contentHash: artifact.contentHash });
  }
  return result;
}
