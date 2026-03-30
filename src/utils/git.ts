/**
 * Git utilities for cloning and updating repositories
 */

import { simpleGit, SimpleGit } from "simple-git";
import { existsSync, mkdirSync, rmSync, renameSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { RepoConfig } from "../repos/config.js";

export type Logger = (message: string, level?: "info" | "debug" | "warning" | "error") => void;

/**
 * Get the alternate v-prefix variant of a tag.
 * "v1.0.0" → "1.0.0", "1.0.0" → "v1.0.0"
 */
function alternateTagName(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : `v${tag}`;
}

/**
 * Find the latest incremental tag matching a base version via ls-remote.
 * e.g., for base "4.2.0-rc.1" finds the highest "4.2.0-rc.1-N" tag.
 * Tries both with and without v-prefix.
 */
async function findLatestIncrementalTag(
  repoUrl: string,
  baseTag: string,
  log?: Logger,
  repoName?: string,
): Promise<string | null> {
  const git = simpleGit();
  const bare = baseTag.startsWith("v") ? baseTag.slice(1) : baseTag;
  const candidates = [`${bare}-*`, `v${bare}-*`];

  for (const pattern of candidates) {
    try {
      const result = await git.listRemote(["--tags", repoUrl, `refs/tags/${pattern}`]);
      if (!result.trim()) continue;

      const tags = result
        .trim()
        .split("\n")
        .map((line) => {
          const match = line.match(/refs\/tags\/(.+)$/);
          return match ? match[1] : null;
        })
        .filter((t): t is string => t !== null)
        .sort((a, b) => {
          const numA = parseInt(a.match(/-(\d+)$/)?.[1] || "0", 10);
          const numB = parseInt(b.match(/-(\d+)$/)?.[1] || "0", 10);
          return numB - numA;
        });

      if (tags.length > 0) {
        log?.(`${repoName}: Found incremental tags: ${tags.join(", ")}`, "debug");
        return tags[0];
      }
    } catch {
      // pattern didn't match, try next
    }
  }
  return null;
}

/**
 * Fetch a tag from origin, trying the alternate v-prefix variant on failure.
 * If matchLatestIncrementalTag is set on the config, also tries finding
 * the latest incremental tag (e.g., "4.2.0-rc.1-2" for "4.2.0-rc.1").
 * Returns the resolved tag name that was successfully fetched.
 */
async function fetchTag(
  repoGit: SimpleGit,
  tag: string,
  log?: Logger,
  repoName?: string,
  config?: RepoConfig,
): Promise<string> {
  const fetchArgs = (t: string): string[] => ["--depth=1", "origin", `refs/tags/${t}:refs/tags/${t}`];
  try {
    log?.(`${repoName}: Fetching tag ${tag}`, "info");
    await repoGit.fetch(fetchArgs(tag));
    return tag;
  } catch {
    const alt = alternateTagName(tag);
    try {
      log?.(`${repoName}: Tag "${tag}" not found, trying "${alt}"`, "info");
      await repoGit.fetch(fetchArgs(alt));
      return alt;
    } catch {
      if (!config?.matchLatestIncrementalTag) throw new Error(`Tag "${tag}" not found (also tried "${alt}")`);
    }
  }

  // Incremental tag fallback: find latest tag matching baseVersion-N
  log?.(`${repoName}: Exact tags not found, searching for incremental tags matching "${tag}"`, "info");
  const resolved = await findLatestIncrementalTag(config!.url, tag, log, repoName);
  if (!resolved) throw new Error(`No tags found matching "${tag}" or its variants`);

  log?.(`${repoName}: Using incremental tag "${resolved}"`, "info");
  await repoGit.fetch(fetchArgs(resolved));
  return resolved;
}

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
  const needsForceReclone = (force || versionMismatch) && existsSync(repoPath);

  // If already cloned and version matches, skip or update
  if (!needsForceReclone && isRepoCloned(config.name)) {
    if (config.tag || config.commit) {
      log?.(`${config.name}: Already cloned at correct ${config.tag ? "tag" : "commit"}, skipping`, "debug");
      return `${config.name} already at ${config.commit || config.tag}`;
    }
    log?.(`${config.name}: Already cloned, updating`, "debug");
    return await updateRepo(config.name, log);
  }

  // Clone to a temp dir when replacing an existing repo, so failure leaves the old repo intact
  const clonePath = needsForceReclone ? repoPath + ".tmp" : repoPath;

  if (needsForceReclone) {
    log?.(`${config.name}: Safe re-clone (force=${force}, versionMismatch=${versionMismatch})`, "debug");
    // Clean up stale temp dir from any previous failed attempt
    rmSync(clonePath, { recursive: true, force: true });
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

  try {
    if (isSparse) {
      // Clone with sparse checkout for large repos
      if (config.commit) {
        // For commits, we need full history to fetch the commit
        await git.clone(config.url, clonePath, [
          "--filter=blob:none",
          "--sparse",
          "--no-checkout",
        ]);

        const repoGit = simpleGit({ baseDir: clonePath, progress: progressHandler });
        await repoGit.raw(["config", "gc.auto", "0"]);
        log?.(`${config.name}: Setting sparse checkout paths: ${config.sparse!.join(", ")}`, "debug");
        await repoGit.raw(["sparse-checkout", "set", "--skip-checks", ...config.sparse!]);
        log?.(`${config.name}: Fetching commit ${config.commit.substring(0, 7)}`, "info");
        await repoGit.fetch(["origin", config.commit]);
        log?.(`${config.name}: Checking out commit`, "debug");
        await repoGit.checkout(config.commit);
      } else if (config.tag) {
        await git.clone(config.url, clonePath, [
          "--filter=blob:none",
          "--sparse",
          "--no-checkout",
        ]);

        const repoGit = simpleGit({ baseDir: clonePath, progress: progressHandler });
        await repoGit.raw(["config", "gc.auto", "0"]);
        log?.(`${config.name}: Setting sparse checkout paths: ${config.sparse!.join(", ")}`, "debug");
        await repoGit.raw(["sparse-checkout", "set", "--skip-checks", ...config.sparse!]);
        const resolvedTag = await fetchTag(repoGit, config.tag, log, config.name, config);
        log?.(`${config.name}: Checking out tag`, "debug");
        await repoGit.checkout(resolvedTag);
      } else {
        await git.clone(config.url, clonePath, [
          "--filter=blob:none",
          "--sparse",
          "--depth=1",
          ...(config.branch ? ["-b", config.branch] : []),
        ]);

        const repoGit = simpleGit({ baseDir: clonePath, progress: progressHandler });
        await repoGit.raw(["config", "gc.auto", "0"]);
        log?.(`${config.name}: Setting sparse checkout paths: ${config.sparse!.join(", ")}`, "debug");
        await repoGit.raw(["sparse-checkout", "set", "--skip-checks", ...config.sparse!]);
      }
    } else {
      // Clone for smaller repos
      if (config.commit) {
        // For commits, clone and checkout specific commit
        await git.clone(config.url, clonePath, ["--no-checkout"]);
        const repoGit = simpleGit({ baseDir: clonePath, progress: progressHandler });
        log?.(`${config.name}: Fetching commit ${config.commit.substring(0, 7)}`, "info");
        await repoGit.fetch(["origin", config.commit]);
        log?.(`${config.name}: Checking out commit`, "debug");
        await repoGit.checkout(config.commit);
      } else if (config.tag) {
        // Clone and checkout tag
        await git.clone(config.url, clonePath, ["--no-checkout"]);
        const repoGit = simpleGit({ baseDir: clonePath, progress: progressHandler });
        const resolvedTag = await fetchTag(repoGit, config.tag, log, config.name, config);
        log?.(`${config.name}: Checking out tag`, "debug");
        await repoGit.checkout(resolvedTag);
      } else {
        await git.clone(config.url, clonePath, [
          "--depth=1",
          ...(config.branch ? ["-b", config.branch] : []),
        ]);
      }
    }
  } catch (error) {
    // On failure: clean up temp dir, leave original repo intact
    if (needsForceReclone) {
      rmSync(clonePath, { recursive: true, force: true });
    }
    throw error;
  }

  // On success: atomic swap — move old out, move new in, then delete old.
  // If the new rename fails, restore old from backup so the repo stays available.
  if (needsForceReclone) {
    const backupPath = repoPath + ".old";
    rmSync(backupPath, { recursive: true, force: true });
    if (existsSync(repoPath)) {
      renameSync(repoPath, backupPath);
    }
    try {
      renameSync(clonePath, repoPath);
    } catch (swapError) {
      // Restore old checkout so the repo isn't left unavailable
      if (existsSync(backupPath)) {
        try { renameSync(backupPath, repoPath); } catch { /* best-effort restore */ }
      }
      rmSync(clonePath, { recursive: true, force: true });
      throw swapError;
    }
    rmSync(backupPath, { recursive: true, force: true });
  }

  log?.(`${config.name}: Clone complete`, "info");
  const sparseLabel = isSparse ? `, sparse: ${config.sparse!.join(", ")}` : "";
  return `Cloned ${config.name} @ ${ref} (${refType}${sparseLabel})`;
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

  // If a tag is requested, check if we're at that tag (v-prefix insensitive)
  if (config.tag) {
    const currentTag = await getRepoTag(config.name);
    if (currentTag === null) return true;
    if (currentTag === config.tag || currentTag === alternateTagName(config.tag)) return false;
    // For incremental tags (e.g., "4.2.0-rc.1-2"), check if the current tag
    // is a versioned variant of the requested tag
    if (config.matchLatestIncrementalTag) {
      const bare = config.tag.startsWith("v") ? config.tag.slice(1) : config.tag;
      const currentBare = currentTag.startsWith("v") ? currentTag.slice(1) : currentTag;
      if (currentBare.startsWith(bare + "-")) return false;
    }
    return true;
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
