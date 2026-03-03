/**
 * Repository sync tool - clones and updates Aztec repositories
 */

import { existsSync } from "fs";
import { join } from "path";
import { AZTEC_REPOS, getAztecRepos, DEFAULT_AZTEC_VERSION, RepoConfig } from "../repos/config.js";
import { cloneRepo, getReposStatus, getNoirCommitFromAztec, REPOS_DIR, Logger } from "../utils/git.js";
import { writeSyncMetadata, readSyncMetadata, SyncMetadata } from "../utils/sync-metadata.js";

export interface SyncResult {
  success: boolean;
  message: string;
  version: string;
  repos: {
    name: string;
    status: string;
    commit?: string;
  }[];
}

/**
 * Sync all repositories (clone if missing, update if exists)
 * Syncs aztec-packages first to determine the correct Noir version
 */
export async function syncRepos(options: {
  force?: boolean;
  repos?: string[];
  version?: string;
  log?: Logger;
}): Promise<SyncResult> {
  const { force = false, repos: repoNames, version, log } = options;

  // Get repos configured for the specified version
  const configuredRepos = version ? getAztecRepos(version) : AZTEC_REPOS;
  const effectiveVersion = version || DEFAULT_AZTEC_VERSION;

  // Filter repos if specific ones requested
  let reposToSync = repoNames
    ? configuredRepos.filter((r) => repoNames.includes(r.name))
    : configuredRepos;

  if (reposToSync.length === 0) {
    return {
      success: false,
      message: "No repositories matched the specified names",
      version: effectiveVersion,
      repos: [],
    };
  }

  // Generate synthetic repo configs from sparsePathOverrides
  const syntheticRepos: RepoConfig[] = [];
  for (const repo of reposToSync) {
    if (repo.sparsePathOverrides) {
      for (const override of repo.sparsePathOverrides) {
        syntheticRepos.push({
          name: `${repo.name}-docs`,
          url: repo.url,
          branch: override.branch,
          sparse: override.paths,
          description: `${repo.description} (docs from ${override.branch})`,
        });
      }
    }
  }

  // Include synthetic repos in total count
  const totalRepos = reposToSync.length + syntheticRepos.length;
  log?.(`Starting sync: ${totalRepos} repos, version=${effectiveVersion}, force=${force}`, "info");

  const results: SyncResult["repos"] = [];

  async function syncRepo(
    config: RepoConfig,
    index: number,
    total: number,
    statusTransform?: (s: string) => string,
  ): Promise<void> {
    log?.(`Syncing ${index}/${total}: ${config.name}`, "info");
    try {
      const status = log ? await cloneRepo(config, force, log) : await cloneRepo(config, force);
      results.push({ name: config.name, status: statusTransform ? statusTransform(status) : status });
    } catch (error) {
      log?.(`${config.name}: Failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      results.push({
        name: config.name,
        status: `Error: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  // Clone aztec-packages first (blocking - needed to determine Noir version)
  const aztecPackages = reposToSync.find((r) => r.name === "aztec-packages");
  let nextIndex = 1;
  if (aztecPackages) {
    await syncRepo(aztecPackages, nextIndex++, totalRepos);
  }

  // Get the Noir commit from aztec-packages (if available)
  const noirCommit = await getNoirCommitFromAztec();
  if (noirCommit) {
    log?.(`Resolved Noir commit from aztec-packages: ${noirCommit.substring(0, 7)}`, "info");
  }

  // Build list of all remaining repos to clone in parallel
  const parallelBatch: { config: RepoConfig; index: number; statusTransform?: (s: string) => string }[] = [];

  const noirRepos = reposToSync.filter((r) => r.url.includes("noir-lang"));
  const otherRepos = reposToSync.filter(
    (r) => r.name !== "aztec-packages" && !r.url.includes("noir-lang")
  );

  for (const config of noirRepos) {
    const useAztecCommit = config.name === "noir" && noirCommit;
    const noirConfig: RepoConfig = useAztecCommit
      ? { ...config, commit: noirCommit, branch: undefined }
      : config;
    parallelBatch.push({
      config: noirConfig,
      index: nextIndex++,
      statusTransform: useAztecCommit ? (s) => s.replace("(commit", "(commit from aztec-packages") : undefined,
    });
  }

  for (const config of otherRepos) {
    parallelBatch.push({ config, index: nextIndex++ });
  }

  for (const config of syntheticRepos) {
    parallelBatch.push({ config, index: nextIndex++ });
  }

  // Clone all remaining repos in parallel
  await Promise.all(
    parallelBatch.map((item) => syncRepo(item.config, item.index, totalRepos, item.statusTransform))
  );

  // Warn if versioned docs paths don't exist after clone
  for (const repo of syntheticRepos) {
    const result = results.find((r) => r.name === repo.name);
    if (!result || result.status.toLowerCase().includes("error")) continue;

    for (const sparsePath of repo.sparse || []) {
      if (!sparsePath.includes(effectiveVersion)) continue;
      const fullPath = join(REPOS_DIR, repo.name, sparsePath);
      if (!existsSync(fullPath)) {
        result.status += `. Note: docs not found for ${effectiveVersion} in aztec-packages`;
        break;
      }
    }
  }

  const allSuccess = results.every(
    (r) => !r.status.toLowerCase().includes("error")
  );

  log?.(`Sync complete: ${results.length} repos, ${allSuccess ? "all succeeded" : "some failed"}`, "info");

  if (allSuccess && !repoNames) {
    try {
      writeSyncMetadata(effectiveVersion);
    } catch {
      // Non-fatal: don't fail the sync if metadata write fails
    }
  }

  return {
    success: allSuccess,
    message: allSuccess
      ? `Successfully synced ${results.length} repositories to ${REPOS_DIR}`
      : "Some repositories failed to sync",
    version: effectiveVersion,
    repos: results,
  };
}

/**
 * Get status of all configured repositories
 */
export async function getStatus(): Promise<{
  reposDir: string;
  repos: {
    name: string;
    description: string;
    cloned: boolean;
    commit?: string;
  }[];
  syncMetadata: SyncMetadata | null;
}> {
  const statusMap = await getReposStatus(AZTEC_REPOS);

  const repos = AZTEC_REPOS.map((config) => {
    const status = statusMap.get(config.name);
    return {
      name: config.name,
      description: config.description,
      cloned: status?.cloned || false,
      commit: status?.commit,
    };
  });

  return {
    reposDir: REPOS_DIR,
    repos,
    syncMetadata: readSyncMetadata(),
  };
}
