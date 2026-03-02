/**
 * Git utilities for cloning and updating repositories
 */

import { simpleGit, SimpleGit } from "simple-git";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { RepoConfig } from "../repos/config.js";

export type Logger = (message: string, level?: "info" | "debug" | "warning" | "error") => void;

/** Base directory for cloned repos */
export const REPOS_DIR = join(
  process.env.AZTEC_MCP_REPOS_DIR || join(homedir(), ".aztec-mcp"),
  "repos"
);

/**
 * Ensure the repos directory exists
 */
export function ensureReposDir(): void {
  mkdirSync(REPOS_DIR, { recursive: true });
}

/**
 * Get the local path for a repository
 */
export function getRepoPath(repoName: string): string {
  return join(REPOS_DIR, repoName);
}

/**
 * Check if a repository is already cloned
 */
export function isRepoCloned(repoName: string): boolean {
  const repoPath = getRepoPath(repoName);
  return existsSync(join(repoPath, ".git"));
}

/**
 * Clone a repository with optional sparse checkout and tag support
 */
export async function cloneRepo(
  config: RepoConfig,
  force: boolean = false,
  log?: Logger
): Promise<string> {
  ensureReposDir();
  const repoPath = getRepoPath(config.name);

  // Check if we need to re-clone due to version mismatch
  const versionMismatch = await needsReclone(config);

  // Remove existing if force is set or version changed
  if ((force || versionMismatch) && existsSync(repoPath)) {
    log?.(`${config.name}: Removing existing clone (force=${force}, versionMismatch=${versionMismatch})`, "debug");
    rmSync(repoPath, { recursive: true, force: true });
  }

  // If already cloned and version matches, just update
  if (isRepoCloned(config.name)) {
    log?.(`${config.name}: Already cloned, updating`, "debug");
    return await updateRepo(config.name, log);
  }

  // Determine ref to checkout: commit > tag > branch
  const ref = config.commit || config.tag || config.branch || "default";
  const refType = config.commit ? "commit" : config.tag ? "tag" : "branch";
  const isSparse = config.sparse && config.sparse.length > 0;

  log?.(`${config.name}: Cloning @ ${ref} (${refType}${isSparse ? ", sparse" : ""})`, "info");

  const progressHandler = log
    ? (data: { method: string; stage: string; progress: number }) => {
        log(`${config.name}: ${data.method} ${data.stage} ${data.progress}%`, "debug");
      }
    : undefined;

  const git: SimpleGit = simpleGit({ progress: progressHandler });

  if (isSparse) {
    // Clone with sparse checkout for large repos
    if (config.commit) {
      // For commits, we need full history to fetch the commit
      await git.clone(config.url, repoPath, [
        "--filter=blob:none",
        "--sparse",
        "--no-checkout",
      ]);

      const repoGit = simpleGit({ baseDir: repoPath, progress: progressHandler });
      await repoGit.raw(["config", "gc.auto", "0"]);
      log?.(`${config.name}: Setting sparse checkout paths: ${config.sparse!.join(", ")}`, "debug");
      await repoGit.raw(["sparse-checkout", "set", ...config.sparse!]);
      log?.(`${config.name}: Fetching commit ${config.commit.substring(0, 7)}`, "info");
      await repoGit.fetch(["origin", config.commit]);
      log?.(`${config.name}: Checking out commit`, "debug");
      await repoGit.checkout(config.commit);
    } else if (config.tag) {
      await git.clone(config.url, repoPath, [
        "--filter=blob:none",
        "--sparse",
        "--no-checkout",
      ]);

      const repoGit = simpleGit({ baseDir: repoPath, progress: progressHandler });
      await repoGit.raw(["config", "gc.auto", "0"]);
      log?.(`${config.name}: Setting sparse checkout paths: ${config.sparse!.join(", ")}`, "debug");
      await repoGit.raw(["sparse-checkout", "set", ...config.sparse!]);
      log?.(`${config.name}: Fetching tag ${config.tag}`, "info");
      await repoGit.fetch(["--depth=1", "origin", `refs/tags/${config.tag}:refs/tags/${config.tag}`]);
      log?.(`${config.name}: Checking out tag`, "debug");
      await repoGit.checkout(config.tag);

      // Apply sparse path overrides from different branches
      if (config.sparsePathOverrides) {
        for (const override of config.sparsePathOverrides) {
          log?.(`${config.name}: Fetching override branch ${override.branch}`, "debug");
          await repoGit.fetch(["--depth=1", "origin", override.branch]);
          try {
            log?.(`${config.name}: Checking out override paths from ${override.branch}: ${override.paths.join(", ")}`, "debug");
            await repoGit.checkout([`origin/${override.branch}`, "--", ...override.paths]);
          } catch (error) {
            const repoBase = config.url.replace(/\.git$/, "");
            const parentDirs = [...new Set(override.paths.map((p) => p.split("/").slice(0, -1).join("/")))];
            const browseLinks = parentDirs.map((d) => `${repoBase}/tree/${override.branch}/${d}`);
            log?.(`${config.name}: sparsePathOverrides failed for branch "${override.branch}"`, "error");
            throw new Error(
              `sparsePathOverrides failed for branch "${override.branch}": could not checkout paths [${override.paths.join(", ")}]. ` +
              `Check the actual folder names at: ${browseLinks.join(" , ")}`,
            );
          }
        }
      }
    } else {
      await git.clone(config.url, repoPath, [
        "--filter=blob:none",
        "--sparse",
        "--depth=1",
        ...(config.branch ? ["-b", config.branch] : []),
      ]);

      const repoGit = simpleGit({ baseDir: repoPath, progress: progressHandler });
      await repoGit.raw(["config", "gc.auto", "0"]);
      log?.(`${config.name}: Setting sparse checkout paths: ${config.sparse!.join(", ")}`, "debug");
      await repoGit.raw(["sparse-checkout", "set", ...config.sparse!]);
    }

    log?.(`${config.name}: Clone complete`, "info");
    return `Cloned ${config.name} @ ${ref} (${refType}, sparse: ${config.sparse!.join(", ")})`;
  } else {
    // Clone for smaller repos
    if (config.commit) {
      // For commits, clone and checkout specific commit
      await git.clone(config.url, repoPath, ["--no-checkout"]);
      const repoGit = simpleGit({ baseDir: repoPath, progress: progressHandler });
      log?.(`${config.name}: Fetching commit ${config.commit.substring(0, 7)}`, "info");
      await repoGit.fetch(["origin", config.commit]);
      log?.(`${config.name}: Checking out commit`, "debug");
      await repoGit.checkout(config.commit);
    } else if (config.tag) {
      // Clone and checkout tag
      await git.clone(config.url, repoPath, ["--no-checkout"]);
      const repoGit = simpleGit({ baseDir: repoPath, progress: progressHandler });
      log?.(`${config.name}: Fetching tag ${config.tag}`, "info");
      await repoGit.fetch(["--depth=1", "origin", `refs/tags/${config.tag}:refs/tags/${config.tag}`]);
      log?.(`${config.name}: Checking out tag`, "debug");
      await repoGit.checkout(config.tag);
    } else {
      await git.clone(config.url, repoPath, [
        "--depth=1",
        ...(config.branch ? ["-b", config.branch] : []),
      ]);
    }

    log?.(`${config.name}: Clone complete`, "info");
    return `Cloned ${config.name} @ ${ref} (${refType})`;
  }
}

/**
 * Update an existing repository
 */
export async function updateRepo(repoName: string, log?: Logger): Promise<string> {
  const repoPath = getRepoPath(repoName);

  if (!isRepoCloned(repoName)) {
    throw new Error(`Repository ${repoName} is not cloned`);
  }

  log?.(`${repoName}: Updating`, "info");
  const git = simpleGit(repoPath);

  try {
    await git.fetch(["--depth=1"]);
    await git.reset(["--hard", "origin/HEAD"]);
    log?.(`${repoName}: Update complete`, "info");
    return `Updated ${repoName}`;
  } catch (error) {
    log?.(`${repoName}: Fetch failed, trying pull`, "warning");
    // If fetch fails, try a simple pull
    try {
      await git.pull();
      log?.(`${repoName}: Pull complete`, "info");
      return `Updated ${repoName}`;
    } catch (pullError) {
      log?.(`${repoName}: Update failed: ${pullError}`, "error");
      return `Failed to update ${repoName}: ${pullError}`;
    }
  }
}

/**
 * Get the current commit hash for a repo
 */
export async function getRepoCommit(repoName: string, full: boolean = false): Promise<string | null> {
  if (!isRepoCloned(repoName)) {
    return null;
  }

  const git = simpleGit(getRepoPath(repoName));
  const log = await git.log(["-1"]);
  const hash = log.latest?.hash;
  if (!hash) return null;
  return full ? hash : hash.substring(0, 7);
}

/**
 * Get the current tag for a repo (if HEAD points to a tag)
 */
export async function getRepoTag(repoName: string): Promise<string | null> {
  const repoPath = getRepoPath(repoName);

  if (!isRepoCloned(repoName)) {
    return null;
  }

  const git = simpleGit(repoPath);

  try {
    // Get tag pointing to HEAD
    const result = await git.raw(["describe", "--tags", "--exact-match", "HEAD"]);
    return result.trim() || null;
  } catch {
    // HEAD is not at a tag
    return null;
  }
}

/**
 * Check if the cloned repo matches the requested config
 * Returns true if re-clone is needed
 */
export async function needsReclone(config: RepoConfig): Promise<boolean> {
  if (!isRepoCloned(config.name)) {
    return true; // Not cloned, need to clone
  }

  // If a specific commit is requested, check if we're at that commit
  if (config.commit) {
    const currentCommit = await getRepoCommit(config.name, true);
    return !currentCommit?.startsWith(config.commit.substring(0, 7));
  }

  // If a tag is requested, check if we're at that tag
  if (config.tag) {
    const currentTag = await getRepoTag(config.name);
    return currentTag !== config.tag;
  }

  // For branches, we don't force re-clone (just update)
  return false;
}

/**
 * Get status of all repos
 */
export async function getReposStatus(
  configs: RepoConfig[]
): Promise<Map<string, { cloned: boolean; commit?: string }>> {
  const status = new Map<string, { cloned: boolean; commit?: string }>();

  for (const config of configs) {
    const cloned = isRepoCloned(config.name);
    const commit = cloned ? (await getRepoCommit(config.name)) || undefined : undefined;
    status.set(config.name, { cloned, commit });
  }

  return status;
}

/**
 * Get the Noir submodule commit from aztec-packages
 * Returns the commit hash that aztec-packages uses for noir
 */
export async function getNoirCommitFromAztec(): Promise<string | null> {
  const aztecPath = getRepoPath("aztec-packages");

  if (!isRepoCloned("aztec-packages")) {
    return null;
  }

  const git = simpleGit(aztecPath);

  try {
    // Get the submodule commit from the git tree
    const result = await git.raw(["ls-tree", "HEAD", "noir/noir-repo"]);
    // Output format: "160000 commit <hash>\tnoir/noir-repo"
    const match = result.match(/^160000\s+commit\s+([a-f0-9]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}
