import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock simple-git
const mockGitInstance = {
  clone: vi.fn(),
  fetch: vi.fn(),
  reset: vi.fn(),
  pull: vi.fn(),
  log: vi.fn(),
  raw: vi.fn(),
  checkout: vi.fn(),
  listRemote: vi.fn(),
};

vi.mock("simple-git", () => ({
  simpleGit: vi.fn(() => mockGitInstance),
}));

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  renameSync: vi.fn(),
}));

vi.mock("os", () => ({
  homedir: vi.fn(() => "/home/testuser"),
}));

// Set REPOS_DIR before importing
process.env.AZTEC_MCP_REPOS_DIR = "/tmp/test-repos";

import { simpleGit } from "simple-git";
import { existsSync, mkdirSync, rmSync, renameSync } from "fs";
import {
  REPOS_DIR,
  ensureReposDir,
  getRepoPath,
  isRepoCloned,
  cloneRepo,
  updateRepo,
  getRepoCommit,
  getRepoTag,
  needsReclone,
  getReposStatus,
  getNoirCommitFromAztec,
} from "../../src/utils/git.js";
import type { RepoConfig } from "../../src/repos/config.js";

const mockExistsSync = vi.mocked(existsSync);
const mockMkdirSync = vi.mocked(mkdirSync);
const mockRmSync = vi.mocked(rmSync);
const mockRenameSync = vi.mocked(renameSync);
const mockSimpleGit = vi.mocked(simpleGit);

beforeEach(() => {
  vi.clearAllMocks();
  // Default: simpleGit returns our mock instance (with or without path arg)
  mockSimpleGit.mockReturnValue(mockGitInstance as any);
});

describe("REPOS_DIR", () => {
  it("is a string ending with /repos", () => {
    expect(REPOS_DIR).toMatch(/\/repos$/);
  });
});

describe("ensureReposDir", () => {
  it("calls mkdirSync with recursive", () => {
    ensureReposDir();
    expect(mockMkdirSync).toHaveBeenCalledWith(REPOS_DIR, { recursive: true });
  });
});

describe("getRepoPath", () => {
  it("returns REPOS_DIR/name", () => {
    expect(getRepoPath("aztec-packages")).toBe(`${REPOS_DIR}/aztec-packages`);
  });
});

describe("isRepoCloned", () => {
  it("checks for .git dir existence", () => {
    mockExistsSync.mockReturnValue(true);
    expect(isRepoCloned("aztec-packages")).toBe(true);
    expect(mockExistsSync).toHaveBeenCalledWith(
      `${REPOS_DIR}/aztec-packages/.git`
    );
  });

  it("returns false when .git doesn't exist", () => {
    mockExistsSync.mockReturnValue(false);
    expect(isRepoCloned("aztec-packages")).toBe(false);
  });
});

describe("cloneRepo", () => {
  const sparseConfig: RepoConfig = {
    name: "aztec-packages",
    url: "https://github.com/AztecProtocol/aztec-packages",
    tag: "v1.0.0",
    sparse: ["docs", "noir-projects"],
    description: "test",
  };

  const nonSparseConfig: RepoConfig = {
    name: "aztec-examples",
    url: "https://github.com/AztecProtocol/aztec-examples",
    tag: "v1.0.0",
    description: "test",
  };

  const branchConfig: RepoConfig = {
    name: "noir",
    url: "https://github.com/noir-lang/noir",
    branch: "master",
    sparse: ["docs", "noir_stdlib"],
    description: "test",
  };

  it("sparse + tag: clones with sparse flags, sets sparse-checkout, fetches tag, checks out", async () => {
    // Not cloned
    mockExistsSync.mockReturnValue(false);
    mockGitInstance.clone.mockResolvedValue(undefined);
    mockGitInstance.raw.mockResolvedValue(undefined);
    mockGitInstance.fetch.mockResolvedValue(undefined);
    mockGitInstance.checkout.mockResolvedValue(undefined);

    const result = await cloneRepo(sparseConfig);
    expect(result).toContain("Cloned aztec-packages");
    expect(result).toContain("tag");
    expect(result).toContain("sparse");

    expect(mockGitInstance.clone).toHaveBeenCalledWith(
      sparseConfig.url,
      expect.stringContaining("aztec-packages"),
      expect.arrayContaining(["--filter=blob:none", "--sparse", "--no-checkout"])
    );
    expect(mockGitInstance.raw).toHaveBeenCalledWith(["config", "gc.auto", "0"]);
    expect(mockGitInstance.raw).toHaveBeenCalledWith([
      "sparse-checkout",
      "set",
      "--skip-checks",
      "docs",
      "noir-projects",
    ]);
    expect(mockGitInstance.fetch).toHaveBeenCalledWith([
      "--depth=1",
      "origin",
      "refs/tags/v1.0.0:refs/tags/v1.0.0",
    ]);
    expect(mockGitInstance.checkout).toHaveBeenCalledWith("v1.0.0");
  });

  it("sparse + tag: falls back to alternate v-prefix on fetch failure", async () => {
    const noVConfig: RepoConfig = {
      ...sparseConfig,
      tag: "1.0.0", // no v prefix
    };
    mockExistsSync.mockReturnValue(false);
    mockGitInstance.clone.mockResolvedValue(undefined);
    mockGitInstance.raw.mockResolvedValue(undefined);
    // First fetch (without v) fails, second (with v) succeeds
    mockGitInstance.fetch
      .mockRejectedValueOnce(new Error("not found"))
      .mockResolvedValueOnce(undefined);
    mockGitInstance.checkout.mockResolvedValue(undefined);

    const result = await cloneRepo(noVConfig);
    expect(result).toContain("Cloned aztec-packages");

    // First attempt: refs/tags/1.0.0
    expect(mockGitInstance.fetch).toHaveBeenCalledWith([
      "--depth=1", "origin", "refs/tags/1.0.0:refs/tags/1.0.0",
    ]);
    // Fallback: refs/tags/v1.0.0
    expect(mockGitInstance.fetch).toHaveBeenCalledWith([
      "--depth=1", "origin", "refs/tags/v1.0.0:refs/tags/v1.0.0",
    ]);
    // Checkout uses the resolved tag name
    expect(mockGitInstance.checkout).toHaveBeenCalledWith("v1.0.0");
  });

  it("sparse + commit: clones with sparse flags, fetches commit", async () => {
    const commitConfig: RepoConfig = {
      ...sparseConfig,
      tag: undefined,
      commit: "abc123def",
    };
    mockExistsSync.mockReturnValue(false);
    mockGitInstance.clone.mockResolvedValue(undefined);
    mockGitInstance.raw.mockResolvedValue(undefined);
    mockGitInstance.fetch.mockResolvedValue(undefined);
    mockGitInstance.checkout.mockResolvedValue(undefined);

    const result = await cloneRepo(commitConfig);
    expect(result).toContain("commit");

    expect(mockGitInstance.clone).toHaveBeenCalledWith(
      commitConfig.url,
      expect.any(String),
      expect.arrayContaining(["--filter=blob:none", "--sparse", "--no-checkout"])
    );
    expect(mockGitInstance.raw).toHaveBeenCalledWith(["config", "gc.auto", "0"]);
    expect(mockGitInstance.fetch).toHaveBeenCalledWith(["origin", "abc123def"]);
    expect(mockGitInstance.checkout).toHaveBeenCalledWith("abc123def");
  });

  it("sparse + branch: clones with depth=1 and -b flag", async () => {
    mockExistsSync.mockReturnValue(false);
    mockGitInstance.clone.mockResolvedValue(undefined);
    mockGitInstance.raw.mockResolvedValue(undefined);

    await cloneRepo(branchConfig);

    expect(mockGitInstance.clone).toHaveBeenCalledWith(
      branchConfig.url,
      expect.any(String),
      expect.arrayContaining(["--filter=blob:none", "--sparse", "--depth=1", "-b", "master"])
    );
    expect(mockGitInstance.raw).toHaveBeenCalledWith(["config", "gc.auto", "0"]);
  });

  it("non-sparse + tag: clones without sparse-checkout", async () => {
    mockExistsSync.mockReturnValue(false);
    mockGitInstance.clone.mockResolvedValue(undefined);
    mockGitInstance.fetch.mockResolvedValue(undefined);
    mockGitInstance.checkout.mockResolvedValue(undefined);

    await cloneRepo(nonSparseConfig);

    expect(mockGitInstance.clone).toHaveBeenCalledWith(
      nonSparseConfig.url,
      expect.any(String),
      ["--no-checkout"]
    );
    // Should NOT call sparse-checkout set
    const rawCalls = mockGitInstance.raw.mock.calls;
    const sparseCheckoutCalls = rawCalls.filter(
      (c: any[]) => Array.isArray(c[0]) && c[0][0] === "sparse-checkout"
    );
    expect(sparseCheckoutCalls).toHaveLength(0);
  });

  it("non-sparse + tag: falls back to stripping v-prefix on fetch failure", async () => {
    const vConfig: RepoConfig = {
      ...nonSparseConfig,
      tag: "v2.0.0",
    };
    mockExistsSync.mockReturnValue(false);
    mockGitInstance.clone.mockResolvedValue(undefined);
    // First fetch (with v) fails, second (without v) succeeds
    mockGitInstance.fetch
      .mockRejectedValueOnce(new Error("not found"))
      .mockResolvedValueOnce(undefined);
    mockGitInstance.checkout.mockResolvedValue(undefined);

    await cloneRepo(vConfig);

    expect(mockGitInstance.fetch).toHaveBeenCalledWith([
      "--depth=1", "origin", "refs/tags/v2.0.0:refs/tags/v2.0.0",
    ]);
    expect(mockGitInstance.fetch).toHaveBeenCalledWith([
      "--depth=1", "origin", "refs/tags/2.0.0:refs/tags/2.0.0",
    ]);
    expect(mockGitInstance.checkout).toHaveBeenCalledWith("2.0.0");
  });

  it("non-sparse + tag: falls back to incremental tag when matchLatestIncrementalTag is set", async () => {
    const incrementalConfig: RepoConfig = {
      name: "demo-wallet",
      url: "https://github.com/AztecProtocol/demo-wallet",
      tag: "v4.2.0-aztecnr-rc.2",
      matchLatestIncrementalTag: true,
      description: "test",
    };
    mockExistsSync.mockReturnValue(false);
    mockGitInstance.clone.mockResolvedValue(undefined);
    // Both exact and v-prefix alternate fail
    mockGitInstance.fetch
      .mockRejectedValueOnce(new Error("not found"))  // v4.2.0-aztecnr-rc.2
      .mockRejectedValueOnce(new Error("not found"))  // 4.2.0-aztecnr-rc.2
      .mockResolvedValueOnce(undefined);               // resolved incremental tag
    mockGitInstance.checkout.mockResolvedValue(undefined);
    // ls-remote returns incremental tags
    mockGitInstance.listRemote.mockResolvedValueOnce(
      "abc123\trefs/tags/4.2.0-aztecnr-rc.2-0\n" +
      "def456\trefs/tags/4.2.0-aztecnr-rc.2-1\n" +
      "ghi789\trefs/tags/4.2.0-aztecnr-rc.2-2\n"
    );

    await cloneRepo(incrementalConfig);

    // Should have tried ls-remote and picked the highest
    expect(mockGitInstance.listRemote).toHaveBeenCalled();
    expect(mockGitInstance.fetch).toHaveBeenCalledWith([
      "--depth=1", "origin",
      "refs/tags/4.2.0-aztecnr-rc.2-2:refs/tags/4.2.0-aztecnr-rc.2-2",
    ]);
    expect(mockGitInstance.checkout).toHaveBeenCalledWith("4.2.0-aztecnr-rc.2-2");
  });

  it("non-sparse + tag: throws when all tag strategies fail without matchLatestIncrementalTag", async () => {
    const noFallbackConfig: RepoConfig = {
      ...nonSparseConfig,
      tag: "v99.0.0",
    };
    mockExistsSync.mockReturnValue(false);
    mockGitInstance.clone.mockResolvedValue(undefined);
    mockGitInstance.fetch
      .mockRejectedValueOnce(new Error("not found"))
      .mockRejectedValueOnce(new Error("not found"));

    await expect(cloneRepo(noFallbackConfig)).rejects.toThrow("not found");
  });

  it("force=true clones to temp dir then swaps", async () => {
    // existsSync calls:
    // 1) needsReclone -> isRepoCloned(.git) -> false (needs reclone)
    // 2) existsSync(repoPath) for needsForceReclone -> true (repo exists)
    // 3) existsSync(repoPath) before swap -> true (old checkout exists)
    mockExistsSync
      .mockReturnValueOnce(false) // needsReclone -> isRepoCloned -> not at right version
      .mockReturnValueOnce(true)  // existsSync(repoPath) -> repo exists, so needsForceReclone=true
      .mockReturnValueOnce(true); // existsSync(repoPath) before swap -> old checkout exists

    mockGitInstance.clone.mockResolvedValue(undefined);
    mockGitInstance.raw.mockResolvedValue(undefined);
    mockGitInstance.fetch.mockResolvedValue(undefined);
    mockGitInstance.checkout.mockResolvedValue(undefined);

    await cloneRepo(sparseConfig, true);

    // Clone goes to .tmp path
    expect(mockGitInstance.clone).toHaveBeenCalledWith(
      sparseConfig.url,
      expect.stringContaining("aztec-packages.tmp"),
      expect.any(Array)
    );
    // On success: move old to .old backup, rename temp into place, delete backup
    expect(mockRenameSync).toHaveBeenCalledWith(
      expect.stringMatching(/aztec-packages$/),
      expect.stringContaining("aztec-packages.old")
    );
    expect(mockRenameSync).toHaveBeenCalledWith(
      expect.stringContaining("aztec-packages.tmp"),
      expect.stringMatching(/aztec-packages$/)
    );
    expect(mockRmSync).toHaveBeenCalledWith(
      expect.stringContaining("aztec-packages.old"),
      { recursive: true, force: true }
    );
  });

  it("clone failure preserves existing repo", async () => {
    mockExistsSync
      .mockReturnValueOnce(false) // needsReclone -> isRepoCloned -> needs reclone
      .mockReturnValueOnce(true); // existsSync(repoPath) -> repo exists

    mockGitInstance.clone.mockRejectedValue(new Error("network error"));

    await expect(cloneRepo(sparseConfig, true)).rejects.toThrow("network error");

    // Only the temp dir is cleaned up, not the original
    expect(mockRmSync).toHaveBeenCalledWith(
      expect.stringContaining("aztec-packages.tmp"),
      { recursive: true, force: true }
    );
    // Original repo not deleted, rename not called
    expect(mockRmSync).not.toHaveBeenCalledWith(
      expect.stringMatching(/aztec-packages$/),
      expect.anything()
    );
    expect(mockRenameSync).not.toHaveBeenCalled();
  });

  it("stale temp dir is cleaned before clone", async () => {
    mockExistsSync
      .mockReturnValueOnce(false) // needsReclone -> isRepoCloned -> needs reclone
      .mockReturnValueOnce(true)  // existsSync(repoPath) -> repo exists
      .mockReturnValueOnce(true); // existsSync(repoPath) before swap -> old checkout exists

    mockGitInstance.clone.mockResolvedValue(undefined);
    mockGitInstance.raw.mockResolvedValue(undefined);
    mockGitInstance.fetch.mockResolvedValue(undefined);
    mockGitInstance.checkout.mockResolvedValue(undefined);

    await cloneRepo(sparseConfig, true);

    // First rmSync call cleans stale temp, before clone
    const rmCalls = mockRmSync.mock.calls;
    const staleTempCleanup = rmCalls.find(
      (c) => typeof c[0] === "string" && c[0].endsWith(".tmp")
    );
    expect(staleTempCleanup).toBeDefined();

    // Clone still proceeds to .tmp
    expect(mockGitInstance.clone).toHaveBeenCalledWith(
      sparseConfig.url,
      expect.stringContaining("aztec-packages.tmp"),
      expect.any(Array)
    );
  });

  it("version mismatch uses safe re-clone via temp dir", async () => {
    // Config with a tag that doesn't match what's cloned
    const mismatchConfig: RepoConfig = {
      name: "aztec-packages",
      url: "https://github.com/AztecProtocol/aztec-packages",
      tag: "v2.0.0",
      sparse: ["docs"],
      description: "test",
    };

    // needsReclone calls: isRepoCloned(.git), then getRepoTag which also calls isRepoCloned(.git)
    mockExistsSync.mockReturnValueOnce(true);  // needsReclone -> isRepoCloned -> true (cloned)
    mockExistsSync.mockReturnValueOnce(true);  // getRepoTag -> isRepoCloned -> true
    mockGitInstance.raw.mockResolvedValueOnce("v1.0.0\n"); // getRepoTag -> v1.0.0 (mismatch!)
    mockExistsSync.mockReturnValueOnce(true);  // existsSync(repoPath) -> repo exists
    mockExistsSync.mockReturnValueOnce(true);  // existsSync(repoPath) before swap -> exists

    mockGitInstance.clone.mockResolvedValue(undefined);
    mockGitInstance.raw.mockResolvedValue(undefined);
    mockGitInstance.fetch.mockResolvedValue(undefined);
    mockGitInstance.checkout.mockResolvedValue(undefined);

    await cloneRepo(mismatchConfig);

    // Should clone to .tmp path (safe re-clone, not destructive)
    expect(mockGitInstance.clone).toHaveBeenCalledWith(
      mismatchConfig.url,
      expect.stringContaining("aztec-packages.tmp"),
      expect.any(Array)
    );
    // Should swap on success
    expect(mockRenameSync).toHaveBeenCalled();
  });

  it("already cloned + version match skips update for tag-pinned repos", async () => {
    // needsReclone: isRepoCloned returns true, tag matches
    mockExistsSync.mockReturnValue(true);
    // getRepoTag needs git.raw to return the tag
    mockGitInstance.raw.mockResolvedValue("v1.0.0\n");

    const result = await cloneRepo(sparseConfig);
    expect(result).toContain("already at v1.0.0");
    // Should NOT call fetch/reset (updateRepo not invoked)
    expect(mockGitInstance.fetch).not.toHaveBeenCalled();
    expect(mockGitInstance.reset).not.toHaveBeenCalled();
  });
});

describe("updateRepo", () => {
  it("throws when repo not cloned", async () => {
    mockExistsSync.mockReturnValue(false);
    await expect(updateRepo("nonexistent")).rejects.toThrow("not cloned");
  });

  it("fetches + resets on success", async () => {
    mockExistsSync.mockReturnValue(true);
    mockGitInstance.fetch.mockResolvedValue(undefined);
    mockGitInstance.reset.mockResolvedValue(undefined);

    const result = await updateRepo("aztec-packages");
    expect(result).toBe("Updated aztec-packages");
    expect(mockGitInstance.fetch).toHaveBeenCalledWith(["--depth=1"]);
    expect(mockGitInstance.reset).toHaveBeenCalledWith(["--hard", "origin/HEAD"]);
  });

  it("falls back to pull on fetch/reset failure", async () => {
    mockExistsSync.mockReturnValue(true);
    mockGitInstance.fetch.mockRejectedValue(new Error("fetch failed"));
    mockGitInstance.pull.mockResolvedValue(undefined);

    const result = await updateRepo("aztec-packages");
    expect(result).toBe("Updated aztec-packages");
    expect(mockGitInstance.pull).toHaveBeenCalled();
  });

  it("returns failure message when both fetch and pull fail", async () => {
    mockExistsSync.mockReturnValue(true);
    mockGitInstance.fetch.mockRejectedValue(new Error("fetch failed"));
    mockGitInstance.pull.mockRejectedValue(new Error("pull failed"));

    const result = await updateRepo("aztec-packages");
    expect(result).toContain("Failed to update");
  });
});

describe("getRepoCommit", () => {
  it("returns null when not cloned", async () => {
    mockExistsSync.mockReturnValue(false);
    const result = await getRepoCommit("nonexistent");
    expect(result).toBeNull();
  });

  it("returns short (7 char) hash by default", async () => {
    mockExistsSync.mockReturnValue(true);
    mockGitInstance.log.mockResolvedValue({
      latest: { hash: "abc123def456789" },
    });

    const result = await getRepoCommit("aztec-packages");
    expect(result).toBe("abc123d");
    expect(result).toHaveLength(7);
  });

  it("returns full hash when full=true", async () => {
    mockExistsSync.mockReturnValue(true);
    mockGitInstance.log.mockResolvedValue({
      latest: { hash: "abc123def456789" },
    });

    const result = await getRepoCommit("aztec-packages", true);
    expect(result).toBe("abc123def456789");
  });
});

describe("getRepoTag", () => {
  it("returns tag string when HEAD is at a tag", async () => {
    mockExistsSync.mockReturnValue(true);
    mockGitInstance.raw.mockResolvedValue("v1.0.0\n");

    const result = await getRepoTag("aztec-packages");
    expect(result).toBe("v1.0.0");
  });

  it("returns null when not cloned", async () => {
    mockExistsSync.mockReturnValue(false);
    const result = await getRepoTag("nonexistent");
    expect(result).toBeNull();
  });

  it("returns null when HEAD is not at a tag", async () => {
    mockExistsSync.mockReturnValue(true);
    mockGitInstance.raw.mockRejectedValue(new Error("no tag"));

    const result = await getRepoTag("aztec-packages");
    expect(result).toBeNull();
  });
});

describe("needsReclone", () => {
  it("returns true when not cloned", async () => {
    mockExistsSync.mockReturnValue(false);
    const result = await needsReclone({
      name: "test",
      url: "test",
      description: "test",
    });
    expect(result).toBe(true);
  });

  it("returns true when commit doesn't match", async () => {
    mockExistsSync.mockReturnValue(true);
    mockGitInstance.log.mockResolvedValue({
      latest: { hash: "different_commit_hash" },
    });

    const result = await needsReclone({
      name: "test",
      url: "test",
      commit: "abc1234",
      description: "test",
    });
    expect(result).toBe(true);
  });

  it("returns true when tag doesn't match", async () => {
    mockExistsSync.mockReturnValue(true);
    mockGitInstance.raw.mockResolvedValue("v1.0.0\n");

    const result = await needsReclone({
      name: "test",
      url: "test",
      tag: "v2.0.0",
      description: "test",
    });
    expect(result).toBe(true);
  });

  it("returns false when tag matches via v-prefix alternate", async () => {
    mockExistsSync.mockReturnValue(true);
    // Repo is checked out at "v1.0.0" but config requests "1.0.0" (no v)
    mockGitInstance.raw.mockResolvedValue("v1.0.0\n");

    const result = await needsReclone({
      name: "test",
      url: "test",
      tag: "1.0.0",
      description: "test",
    });
    expect(result).toBe(false);
  });

  it("returns false when tag matches via v-prefix stripped", async () => {
    mockExistsSync.mockReturnValue(true);
    // Repo is checked out at "1.0.0" but config requests "v1.0.0"
    mockGitInstance.raw.mockResolvedValue("1.0.0\n");

    const result = await needsReclone({
      name: "test",
      url: "test",
      tag: "v1.0.0",
      description: "test",
    });
    expect(result).toBe(false);
  });

  it("returns false when current tag is an incremental variant and matchLatestIncrementalTag is set", async () => {
    mockExistsSync.mockReturnValue(true);
    // Repo is checked out at "4.2.0-aztecnr-rc.2-2" but config requests "v4.2.0-aztecnr-rc.2"
    mockGitInstance.raw.mockResolvedValue("4.2.0-aztecnr-rc.2-2\n");

    const result = await needsReclone({
      name: "test",
      url: "test",
      tag: "v4.2.0-aztecnr-rc.2",
      matchLatestIncrementalTag: true,
      description: "test",
    });
    expect(result).toBe(false);
  });

  it("returns true when current tag is an incremental variant but matchLatestIncrementalTag is not set", async () => {
    mockExistsSync.mockReturnValue(true);
    mockGitInstance.raw.mockResolvedValue("4.2.0-aztecnr-rc.2-2\n");

    const result = await needsReclone({
      name: "test",
      url: "test",
      tag: "v4.2.0-aztecnr-rc.2",
      description: "test",
    });
    expect(result).toBe(true);
  });

  it("returns false for branch-only config when cloned", async () => {
    mockExistsSync.mockReturnValue(true);

    const result = await needsReclone({
      name: "test",
      url: "test",
      branch: "master",
      description: "test",
    });
    expect(result).toBe(false);
  });
});

describe("getReposStatus", () => {
  it("maps configs to cloned/commit status", async () => {
    mockExistsSync.mockReturnValue(true);
    mockGitInstance.log.mockResolvedValue({
      latest: { hash: "abc123def456789" },
    });

    const configs: RepoConfig[] = [
      { name: "repo1", url: "url1", description: "d1" },
      { name: "repo2", url: "url2", description: "d2" },
    ];

    const status = await getReposStatus(configs);
    expect(status.get("repo1")).toEqual({ cloned: true, commit: "abc123d" });
    expect(status.get("repo2")).toEqual({ cloned: true, commit: "abc123d" });
  });
});

describe("getNoirCommitFromAztec", () => {
  it("parses ls-tree output", async () => {
    mockExistsSync.mockReturnValue(true);
    mockGitInstance.raw.mockResolvedValue(
      "160000 commit abc123def456789\tnoir/noir-repo\n"
    );

    const result = await getNoirCommitFromAztec();
    expect(result).toBe("abc123def456789");
  });

  it("returns null when not cloned", async () => {
    mockExistsSync.mockReturnValue(false);
    const result = await getNoirCommitFromAztec();
    expect(result).toBeNull();
  });

  it("returns null when parse fails", async () => {
    mockExistsSync.mockReturnValue(true);
    mockGitInstance.raw.mockResolvedValue("unexpected output format");

    const result = await getNoirCommitFromAztec();
    expect(result).toBeNull();
  });

  it("returns null when git command throws", async () => {
    mockExistsSync.mockReturnValue(true);
    mockGitInstance.raw.mockRejectedValue(new Error("git error"));

    const result = await getNoirCommitFromAztec();
    expect(result).toBeNull();
  });
});
