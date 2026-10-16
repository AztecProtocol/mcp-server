import type { RepoConfig } from "../repos/config.js";
import { cloneRepo, ensureReposDir, getRepoCommit, type Logger } from "../utils/git.js";
import { getNodeDocsSource } from "../utils/sources.js";
import { resolveReleaseCommits } from "../utils/release.js";
import { beginVersionSync, readSyncMetadata, writeSyncMetadata } from "../utils/sync-metadata.js";
import { clearErrorCache } from "../utils/error-lookup.js";
import type { SyncResult } from "./sync.js";

/** v6 defaults to a single checkout; optional sources join the same release. */
export async function syncSplitRepos(
  options: { version: string; repos?: string[]; force?: boolean; log?: Logger },
  configs: RepoConfig[],
): Promise<SyncResult> {
  const { version, force = false, log } = options;
  const previous = readSyncMetadata();
  const resuming = previous?.pendingVersion?.replace(/^v/, "") === version.replace(/^v/, "");
  const requested = options.repos ?? (resuming ? previous?.pendingRepositories : undefined);
  const result: SyncResult = { success: false, metadataSafe: false, version, message: "", repos: [] };
  const unknown = requested?.filter((name) => !configs.some((config) => config.name === name));
  if (requested?.length === 0 || unknown?.length) {
    result.message = `Unsupported repositories for ${version}: ${unknown?.join(", ") || "empty selection"}. Available: ${configs.map((r) => r.name).join(", ")}`;
    return result;
  }

  const sameVersion = previous?.aztecVersion?.replace(/^v/, "") === version.replace(/^v/, "");
  const selected = configs.filter((config) => !config.optional || requested?.includes(config.name));
  let commits;
  try {
    commits = await resolveReleaseCommits(version, log);
  } catch (error) {
    result.message = `Could not resolve ${version}: ${error instanceof Error ? error.message : String(error)}`;
    return result;
  }

  const expectedCommits: Record<string, string> = {
    "aztec-node": commits.nodeCommit, "aztec-packages": commits.packagesCommit, noir: commits.noirCommit,
  };
  const repositories: Record<string, string> = {};
  if (sameVersion && previous?.repositories) {
    for (const [name, commit] of Object.entries(previous.repositories)) {
      if (expectedCommits[name] === commit && await getRepoCommit(name, true) === commit) {
        repositories[name] = commit;
      }
    }
  }
  try {
    ensureReposDir();
    beginVersionSync(version, selected.map((config) => config.name));
  } catch (error) {
    result.message = `Cannot persist sync intent: ${error instanceof Error ? error.message : String(error)}`;
    return result;
  }
  for (const config of selected) {
    const commit = expectedCommits[config.name];
    try {
      const status = await cloneRepo({ ...config, tag: undefined, branch: undefined, commit }, force, log);
      repositories[config.name] = commit;
      result.repos.push({ name: config.name, status, commit });
    } catch (error) {
      result.repos.push({ name: config.name, status: `Error: ${error instanceof Error ? error.message : String(error)}` });
      result.message = `Sync incomplete: ${config.name} failed; run aztec_sync_repos again`;
      clearErrorCache();
      return result;
    }
  }

  const docsNotice = getNodeDocsSource(version, commits.nodeCommit).notice;
  result.success = true;
  try {
    writeSyncMetadata(version, repositories);
    result.metadataSafe = true;
    result.message = `Synced ${result.repos.length} ${result.repos.length === 1 ? "repository" : "repositories"} for ${version}. ${docsNotice}`;
  } catch {
    result.message = "Repositories synced but failed to persist release metadata; run aztec_sync_repos again before searching.";
  }
  clearErrorCache();
  return result;
}
