import { readFile, realpath } from "node:fs/promises";
import type { Jobs } from "./jobs.js";
import { hash, projectProvenance, type ArtifactIdentity } from "./artifacts.js";
import type { ToolchainReport, ToolchainSelection } from "./toolchain.js";
export class FreshnessError extends Error {
  constructor(public readonly code: "invalid-build" | "stale-artifact", message: string) { super(`${code}: ${message}`); this.name = "FreshnessError"; }
}
export interface FreshArtifactOptions {
  jobs: Jobs;
  buildJobId: string;
  artifactPath: string;
  runtime: ToolchainReport;
  projectPath?: string;
}
export interface FreshArtifact {
  artifact: ArtifactIdentity;
  projectPath: string;
  kind: "compile" | "test";
}
export async function assertFreshArtifact(input: FreshArtifactOptions): Promise<FreshArtifact> {
  let build;
  try { build = input.jobs.get(input.buildJobId); } catch { throw new FreshnessError("invalid-build", `Unknown build job: ${input.buildJobId}.`); }
  const result = build.result as {
    projectPath?: string;
    selection?: unknown;
    toolchain?: ToolchainSelection;
    artifacts?: ArtifactIdentity[];
  } | undefined;
  if (build.status !== "completed" || (build.kind !== "compile" && build.kind !== "test") || !result?.projectPath)
    throw new FreshnessError("invalid-build", `Build job ${input.buildJobId} is not a completed compile or test job. Select a successful build.`);
  if (input.projectPath !== undefined && result.projectPath !== input.projectPath)
    throw new FreshnessError("invalid-build", "The build job belongs to a different project. Select a build from this session's canonical project.");
  if (result.toolchain?.installationRoot !== input.runtime.installationRoot || result.toolchain?.nodeExecutable !== input.runtime.runtimeNode.path)
    throw new FreshnessError("invalid-build", "The build was made with a different installation or Node executable. Compile again with this runtime.");
  const stale = () => new FreshnessError("stale-artifact", "The selected artifact or its sources, dependencies, toolchain or options changed. Compile again.");
  const missing = (error: unknown) => { throw ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "") ? stale() : error; };
  const path = await realpath(input.artifactPath).catch(missing);
  const artifact = result.artifacts?.find(a => a.path === path);
  if (!artifact || hash(await readFile(path).catch(missing)) !== artifact.contentHash || await projectProvenance(result.projectPath, input.runtime, result.selection) !== artifact.provenanceHash)
    throw stale();
  return { artifact, projectPath: result.projectPath, kind: build.kind };
}
