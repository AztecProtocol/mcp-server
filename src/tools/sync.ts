/**
 * Repository sync tool - clones and updates Aztec repositories
 */

import { AZTEC_REPOS, getAztecRepos, DEFAULT_AZTEC_VERSION, RepoConfig } from "../repos/config.js";
import { cloneRepo, getReposStatus, getNoirCommitFromAztec, REPOS_DIR, Logger } from "../utils/git.js";

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

  log?.(`Starting sync: ${reposToSync.length} repos, version=${effectiveVersion}, force=${force}`, "info");

  const results: SyncResult["repos"] = [];
  let syncIndex = 0;

  async function syncRepo(config: RepoConfig, statusTransform?: (s: string) => string): Promise<void> {
    syncIndex++;
    log?.(`Syncing ${syncIndex}/${reposToSync.length}: ${config.name}`, "info");
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

  // Sort repos so aztec-packages is cloned first (needed to determine Noir version)
  const aztecPackages = reposToSync.find((r) => r.name === "aztec-packages");
  const noirRepos = reposToSync.filter((r) => r.url.includes("noir-lang"));
  const otherRepos = reposToSync.filter(
    (r) => r.name !== "aztec-packages" && !r.url.includes("noir-lang")
  );

  // Clone aztec-packages first if present
  if (aztecPackages) {
    await syncRepo(aztecPackages);
  }

  // Get the Noir commit from aztec-packages (if available)
  const noirCommit = await getNoirCommitFromAztec();
  if (noirCommit) {
    log?.(`Resolved Noir commit from aztec-packages: ${noirCommit.substring(0, 7)}`, "info");
  }

  // Clone Noir repos with the commit from aztec-packages
  for (const config of noirRepos) {
    const useAztecCommit = config.name === "noir" && noirCommit;
    const noirConfig: RepoConfig = useAztecCommit
      ? { ...config, commit: noirCommit, branch: undefined }
      : config;

    await syncRepo(
      noirConfig,
      useAztecCommit ? (s) => s.replace("(commit", "(commit from aztec-packages") : undefined
    );
  }

  // Clone other repos
  for (const config of otherRepos) {
    await syncRepo(config);
  }

  const allSuccess = results.every(
    (r) => !r.status.toLowerCase().includes("error")
  );

  log?.(`Sync complete: ${results.length} repos, ${allSuccess ? "all succeeded" : "some failed"}`, "info");

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
  };
}
