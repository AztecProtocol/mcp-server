import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/utils/git.js", () => ({
  cloneRepo: vi.fn(), ensureReposDir: vi.fn(), getRepoCommit: vi.fn(),
  getRepoPath: (name: string) => `/fake/repos/${name}`,
  getReposStatus: vi.fn(), getNoirCommitFromAztec: vi.fn(), REPOS_DIR: "/fake/repos",
}));
vi.mock("../../src/utils/release.js", () => ({ resolveReleaseCommits: vi.fn() }));
vi.mock("../../src/utils/sync-metadata.js", () => ({
  beginVersionSync: vi.fn(), readSyncMetadata: vi.fn(), writeSyncMetadata: vi.fn(), stampMetadataMcpVersion: vi.fn(),
}));
vi.mock("../../src/utils/error-lookup.js", () => ({ clearErrorCache: vi.fn() }));
vi.mock("fs", () => ({ existsSync: vi.fn(() => false) }));

import { syncRepos } from "../../src/tools/sync.js";
import { cloneRepo, getRepoCommit } from "../../src/utils/git.js";
import { resolveReleaseCommits } from "../../src/utils/release.js";
import { beginVersionSync, readSyncMetadata, writeSyncMetadata } from "../../src/utils/sync-metadata.js";

const version = "v6.0.0";
const commits = { packagesCommit: "a".repeat(40), nodeCommit: "b".repeat(40), noirCommit: "c".repeat(40) };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(resolveReleaseCommits).mockResolvedValue(commits);
  vi.mocked(cloneRepo).mockResolvedValue("Cloned");
  vi.mocked(readSyncMetadata).mockReturnValue(null);
});

describe("lightweight v6 sync", () => {
  it("clones only the node pinned by the release and records its identity", async () => {
    const result = await syncRepos({});
    expect(resolveReleaseCommits).toHaveBeenCalledWith(version, undefined);
    expect(cloneRepo).toHaveBeenCalledOnce();
    expect(cloneRepo).toHaveBeenCalledWith(expect.objectContaining({
      name: "aztec-node", commit: commits.nodeCommit, tag: undefined, branch: undefined,
    }), false, undefined);
    expect(beginVersionSync).toHaveBeenCalledWith(version, ["aztec-node"]);
    expect(writeSyncMetadata).toHaveBeenCalledWith(version, { "aztec-node": commits.nodeCommit });
    expect(result.success).toBe(true);
    expect(result.metadataSafe).toBe(true);
    expect(result.message).toContain("No exact v6.0.0 documentation snapshot");
  });

  it("adds optional protocol and Noir sources at the same release's commits", async () => {
    const result = await syncRepos({ version, repos: ["aztec-packages", "noir"] });
    expect(result.repos.map((repo) => repo.name)).toEqual(["aztec-node", "aztec-packages", "noir"]);
    expect(writeSyncMetadata).toHaveBeenCalledWith(version, {
      "aztec-node": commits.nodeCommit, "aztec-packages": commits.packagesCommit, noir: commits.noirCommit,
    });
  });

  it("retries requested optional repositories after an interrupted sync", async () => {
    vi.mocked(readSyncMetadata).mockReturnValue({
      mcpVersion: "1.6.0", syncedAt: "", aztecVersion: version,
      pendingVersion: version, pendingRepositories: ["aztec-node", "noir"],
    });
    const result = await syncRepos({ version, force: true });
    expect(result.repos.map((repo) => repo.name)).toEqual(["aztec-node", "noir"]);
    expect(writeSyncMetadata).toHaveBeenCalledWith(version, {
      "aztec-node": commits.nodeCommit, noir: commits.noirCommit,
    });
  });

  it("keeps recovery incomplete if an optional repository fails again", async () => {
    vi.mocked(readSyncMetadata).mockReturnValue({
      mcpVersion: "1.6.0", syncedAt: "", aztecVersion: "v6.0.0-rc.1",
      pendingVersion: version, pendingRepositories: ["aztec-node", "aztec-packages"],
    });
    vi.mocked(cloneRepo).mockResolvedValueOnce("Cloned").mockRejectedValueOnce(new Error("still offline"));
    const result = await syncRepos({ version });
    expect(result.success).toBe(false);
    expect(result.metadataSafe).toBe(false);
    expect(result.repos.map((repo) => repo.name)).toEqual(["aztec-node", "aztec-packages"]);
    expect(writeSyncMetadata).not.toHaveBeenCalled();
  });

  it("rejects unsupported companion repos without downloading anything", async () => {
    const result = await syncRepos({ version, repos: ["aztec-examples"] });
    expect(result.success).toBe(false);
    expect(result.message).toContain("Unsupported repositories");
    expect(resolveReleaseCommits).not.toHaveBeenCalled();
    expect(cloneRepo).not.toHaveBeenCalled();
  });

  it("does not mutate checkouts or metadata when release resolution fails", async () => {
    vi.mocked(resolveReleaseCommits).mockRejectedValue(new Error("no labs gitlink"));
    const result = await syncRepos({ version });
    expect(result.success).toBe(false);
    expect(result.message).toContain("no labs gitlink");
    expect(beginVersionSync).not.toHaveBeenCalled();
    expect(cloneRepo).not.toHaveBeenCalled();
    expect(writeSyncMetadata).not.toHaveBeenCalled();
  });

  it("leaves an incomplete marker and stops when a checkout fails", async () => {
    vi.mocked(cloneRepo).mockRejectedValueOnce(new Error("fetch failed"));
    const result = await syncRepos({ version, repos: ["aztec-packages"] });
    expect(result.success).toBe(false);
    expect(result.metadataSafe).toBe(false);
    expect(beginVersionSync).toHaveBeenCalledWith(version, ["aztec-node", "aztec-packages"]);
    expect(cloneRepo).toHaveBeenCalledOnce();
    expect(writeSyncMetadata).not.toHaveBeenCalled();
  });

  it("does not claim completion after an optional checkout fails", async () => {
    vi.mocked(cloneRepo).mockResolvedValueOnce("Cloned").mockRejectedValueOnce(new Error("fetch failed"));
    const result = await syncRepos({ version, repos: ["aztec-packages"] });
    expect(result.success).toBe(false);
    expect(result.repos).toHaveLength(2);
    expect(writeSyncMetadata).not.toHaveBeenCalled();
  });

  it("refuses to mutate checkouts if the incomplete marker cannot be written", async () => {
    vi.mocked(beginVersionSync).mockImplementation(() => { throw new Error("disk full"); });
    const result = await syncRepos({ version });
    expect(result.success).toBe(false);
    expect(cloneRepo).not.toHaveBeenCalled();
  });

  it("reports a final metadata write failure", async () => {
    vi.mocked(writeSyncMetadata).mockImplementation(() => { throw new Error("disk full"); });
    const result = await syncRepos({ version });
    expect(result.metadataSafe).toBe(false);
    expect(result.message).toContain("failed to persist release metadata");
  });

  it("keeps previously enabled optional sources only when their commits still match", async () => {
    vi.mocked(readSyncMetadata).mockReturnValue({
      mcpVersion: "1.6.0", syncedAt: "", aztecVersion: version,
      repositories: { "aztec-node": commits.nodeCommit, "aztec-packages": commits.packagesCommit, noir: commits.noirCommit },
    });
    vi.mocked(getRepoCommit).mockImplementation(async (name) => name === "aztec-packages" ? commits.packagesCommit : null);
    await syncRepos({ version });
    expect(writeSyncMetadata).toHaveBeenCalledWith(version, {
      "aztec-node": commits.nodeCommit, "aztec-packages": commits.packagesCommit,
    });
  });

  it("drops old optional checkouts from active sources when changing releases", async () => {
    vi.mocked(readSyncMetadata).mockReturnValue({
      mcpVersion: "1.6.0", syncedAt: "", aztecVersion: "v6.0.0-rc.1",
      repositories: { "aztec-node": "old", "aztec-packages": "old" },
    });
    await syncRepos({ version });
    expect(writeSyncMetadata).toHaveBeenCalledWith(version, { "aztec-node": commits.nodeCommit });
  });
});
