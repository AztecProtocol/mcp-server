import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCloneRepo = vi.fn();
const mockGetReposStatus = vi.fn();
const mockGetNoirCommitFromAztec = vi.fn();
const mockWriteSyncMetadata = vi.fn();
const mockStampMetadataMcpVersion = vi.fn();
const mockReadSyncMetadata = vi.fn();
const mockExistsSync = vi.fn();

vi.mock("../../src/repos/config.js", () => ({
  AZTEC_REPOS: [
    {
      name: "aztec-packages",
      url: "https://github.com/AztecProtocol/aztec-packages",
      tag: "v1.0.0",
      sparse: ["noir-projects/aztec-nr", "yarn-project"],
      sparsePathOverrides: [
        {
          paths: ["docs/developer_versioned_docs/version-v1.0.0", "docs/static/api"],
          branch: "next",
        },
      ],
      description: "Main repo",
    },
    {
      name: "aztec-examples",
      url: "https://github.com/AztecProtocol/aztec-examples",
      tag: "v1.0.0",
      description: "Examples",
    },
    {
      name: "noir",
      url: "https://github.com/noir-lang/noir",
      branch: "master",
      description: "Noir compiler",
    },
    {
      name: "noir-examples",
      url: "https://github.com/noir-lang/noir-examples",
      branch: "master",
      description: "Noir examples",
    },
    {
      name: "aztec-starter",
      url: "https://github.com/AztecProtocol/aztec-starter",
      tag: "v1.0.0",
      description: "Starter",
    },
  ],
  getAztecRepos: vi.fn((version: string) => [
    {
      name: "aztec-packages",
      url: "https://github.com/AztecProtocol/aztec-packages",
      tag: version,
      sparsePathOverrides: [
        {
          paths: ["docs/developer_versioned_docs/version-" + version],
          branch: "next",
        },
      ],
      description: "Main repo",
    },
    {
      name: "aztec-examples",
      url: "https://github.com/AztecProtocol/aztec-examples",
      tag: version,
      description: "Examples",
    },
    {
      name: "noir",
      url: "https://github.com/noir-lang/noir",
      branch: "master",
      description: "Noir compiler",
    },
  ]),
  DEFAULT_AZTEC_VERSION: "v1.0.0",
}));

vi.mock("../../src/utils/git.js", () => ({
  cloneRepo: (...args: any[]) => mockCloneRepo(...args),
  getReposStatus: (...args: any[]) => mockGetReposStatus(...args),
  getNoirCommitFromAztec: () => mockGetNoirCommitFromAztec(),
  getRepoPath: (name: string) => `/fake/repos/${name}`,
  REPOS_DIR: "/fake/repos",
}));

vi.mock("../../src/utils/sync-metadata.js", () => ({
  writeSyncMetadata: (...args: any[]) => mockWriteSyncMetadata(...args),
  stampMetadataMcpVersion: (...args: any[]) => mockStampMetadataMcpVersion(...args),
  readSyncMetadata: () => mockReadSyncMetadata(),
}));

vi.mock("fs", () => ({
  existsSync: (...args: any[]) => mockExistsSync(...args),
}));

vi.mock("path", async () => {
  const actual = await vi.importActual<typeof import("path")>("path");
  return actual;
});

import { getAztecRepos } from "../../src/repos/config.js";
import { syncRepos, getStatus } from "../../src/tools/sync.js";

const mockGetAztecRepos = vi.mocked(getAztecRepos);

beforeEach(() => {
  vi.clearAllMocks();
  mockCloneRepo.mockResolvedValue("Cloned");
  mockGetNoirCommitFromAztec.mockResolvedValue(null);
  mockWriteSyncMetadata.mockReset();
  mockExistsSync.mockReturnValue(true);
});

describe("syncRepos", () => {
  it("clones aztec-packages before noir repos and others", async () => {
    const callOrder: string[] = [];
    mockCloneRepo.mockImplementation(async (config: any) => {
      callOrder.push(config.name);
      return `Cloned ${config.name}`;
    });

    await syncRepos({});

    // aztec-packages should be first (blocking clone)
    expect(callOrder[0]).toBe("aztec-packages");
    // noir repos should come after aztec-packages
    const noirIndex = callOrder.indexOf("noir");
    expect(noirIndex).toBeGreaterThan(0);
    // synthetic docs repo should be included
    expect(callOrder).toContain("aztec-packages-docs");
  });

  it("extracts noir commit from aztec-packages and applies it", async () => {
    mockGetNoirCommitFromAztec.mockResolvedValue("abc123deadbeef");

    await syncRepos({});

    // Find the cloneRepo call for "noir"
    const noirCall = mockCloneRepo.mock.calls.find(
      (c: any[]) => c[0].name === "noir"
    );
    expect(noirCall).toBeDefined();
    expect(noirCall![0].commit).toBe("abc123deadbeef");
    expect(noirCall![0].branch).toBeUndefined();
  });

  it("uses AZTEC_REPOS when no version specified", async () => {
    await syncRepos({});

    // Should clone repos from AZTEC_REPOS (5 repos + 1 synthetic docs repo)
    expect(mockCloneRepo).toHaveBeenCalledTimes(6);
    expect(mockGetAztecRepos).not.toHaveBeenCalled();
  });

  it("calls getAztecRepos when version given", async () => {
    await syncRepos({ version: "v2.0.0" });

    expect(mockGetAztecRepos).toHaveBeenCalledWith("v2.0.0");
  });

  it("filters to specific repos when repos option provided", async () => {
    await syncRepos({ repos: ["aztec-packages"] });

    // aztec-packages + synthetic aztec-packages-docs
    expect(mockCloneRepo).toHaveBeenCalledTimes(2);
    expect(mockCloneRepo.mock.calls[0][0].name).toBe("aztec-packages");
    const docsCall = mockCloneRepo.mock.calls.find((c: any[]) => c[0].name === "aztec-packages-docs");
    expect(docsCall).toBeDefined();
    expect(docsCall![0].branch).toBe("next");
    expect(docsCall![0].sparse).toEqual(["docs/developer_versioned_docs/version-v1.0.0", "docs/static/api"]);
  });

  it("returns success:false when no repos match filter", async () => {
    const result = await syncRepos({ repos: ["nonexistent"] });
    expect(result.success).toBe(false);
    expect(result.message).toContain("No repositories matched");
  });

  it("captures cloneRepo errors in status", async () => {
    mockCloneRepo
      .mockResolvedValueOnce("Cloned aztec-packages")
      .mockRejectedValueOnce(new Error("clone failed"))
      .mockResolvedValue("Cloned ok");

    const result = await syncRepos({});

    const failedRepo = result.repos.find((r) =>
      r.status.includes("Error")
    );
    expect(failedRepo).toBeDefined();
  });

  it("success:true only when all repos succeed", async () => {
    mockCloneRepo.mockResolvedValue("Cloned");
    const result = await syncRepos({});
    expect(result.success).toBe(true);
  });

  it("success:false when any repo has error", async () => {
    mockCloneRepo
      .mockResolvedValueOnce("Cloned ok")
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValue("Cloned ok");

    const result = await syncRepos({});
    expect(result.success).toBe(false);
  });

  it("passes force option through", async () => {
    await syncRepos({ force: true, repos: ["aztec-packages"] });

    expect(mockCloneRepo).toHaveBeenCalledWith(
      expect.objectContaining({ name: "aztec-packages" }),
      true
    );
  });

  it("returns metadataSafe:true on full sync success", async () => {
    mockCloneRepo.mockResolvedValue("Cloned");
    const result = await syncRepos({});

    expect(result.metadataSafe).toBe(true);
    expect(mockWriteSyncMetadata).toHaveBeenCalledWith("v1.0.0");
  });

  it("writes sync metadata with custom version on full sync success", async () => {
    mockCloneRepo.mockResolvedValue("Cloned");
    await syncRepos({ version: "v2.0.0" });

    expect(mockWriteSyncMetadata).toHaveBeenCalledWith("v2.0.0");
  });

  it("does not write sync metadata on failure", async () => {
    mockCloneRepo
      .mockResolvedValueOnce("Cloned ok")
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValue("Cloned ok");

    await syncRepos({});

    expect(mockWriteSyncMetadata).not.toHaveBeenCalled();
  });

  it("does not write sync metadata on partial sync", async () => {
    mockCloneRepo.mockResolvedValue("Cloned");
    await syncRepos({ repos: ["aztec-packages"] });

    expect(mockWriteSyncMetadata).not.toHaveBeenCalled();
  });

  it("does not fail sync if metadata write throws but clears metadataSafe and reports it", async () => {
    mockCloneRepo.mockResolvedValue("Cloned");
    mockWriteSyncMetadata.mockImplementation(() => {
      throw new Error("write failed");
    });

    const result = await syncRepos({});
    expect(result.success).toBe(true);
    expect(result.metadataSafe).toBe(false);
    expect(result.message).toContain("failed to persist sync metadata");
  });

  it("warns when versioned docs path does not exist after clone", async () => {
    mockExistsSync.mockReturnValue(false);

    const result = await syncRepos({});

    const docsRepo = result.repos.find((r) => r.name === "aztec-packages-docs");
    expect(docsRepo).toBeDefined();
    expect(docsRepo!.status).toContain("docs not found for v1.0.0");
    // Docs missing is cosmetic — repos are usable, metadata should be written
    expect(result.success).toBe(true);
    expect(result.metadataSafe).toBe(true);
    expect(mockWriteSyncMetadata).toHaveBeenCalledWith("v1.0.0");
  });

  it("provides distinct message when docs missing but clones succeed", async () => {
    mockExistsSync.mockReturnValue(false);

    const result = await syncRepos({});

    expect(result.success).toBe(true);
    expect(result.message).toContain("docs not found for v1.0.0");
    expect(result.message).toContain("version may not exist yet");
    expect(result.message).not.toContain("failed to sync");
  });

  it("does not warn when versioned docs path exists", async () => {
    mockExistsSync.mockReturnValue(true);

    const result = await syncRepos({});

    const docsRepo = result.repos.find((r) => r.name === "aztec-packages-docs");
    expect(docsRepo).toBeDefined();
    expect(docsRepo!.status).not.toContain("docs not found");
  });

  it("aborts when aztec-packages fails with force", async () => {
    mockCloneRepo.mockImplementation(async (config: any) => {
      if (config.name === "aztec-packages") throw new Error("clone failed");
      return "Cloned";
    });

    const result = await syncRepos({ force: true });

    expect(result.success).toBe(false);
    expect(result.metadataSafe).toBe(false);
    expect(result.message).toContain("aztec-packages failed");
    // Should only have attempted aztec-packages, not the rest
    expect(result.repos).toHaveLength(1);
    expect(result.repos[0].name).toBe("aztec-packages");
  });

  it("does not derive noir commit when aztec-packages fails", async () => {
    mockCloneRepo.mockImplementation(async (config: any) => {
      if (config.name === "aztec-packages") throw new Error("clone failed");
      return "Cloned";
    });

    await syncRepos({ force: true });

    expect(mockGetNoirCommitFromAztec).not.toHaveBeenCalled();
  });

  it("aborts when aztec-packages fails with version (no force)", async () => {
    mockCloneRepo.mockImplementation(async (config: any) => {
      if (config.name === "aztec-packages") throw new Error("clone failed");
      return "Cloned";
    });

    const result = await syncRepos({ version: "v2.0.0" });

    expect(result.success).toBe(false);
    expect(result.metadataSafe).toBe(false);
    expect(result.message).toContain("aztec-packages failed");
    expect(result.repos).toHaveLength(1);
  });

  it("continues when aztec-packages fails without force or version", async () => {
    mockCloneRepo.mockImplementation(async (config: any) => {
      if (config.name === "aztec-packages") throw new Error("clone failed");
      return "Cloned";
    });

    const result = await syncRepos({});

    // Should have attempted all repos, not just aztec-packages
    expect(result.repos.length).toBeGreaterThan(1);
    expect(result.success).toBe(false);
    // Should not derive noir commit from failed aztec-packages
    expect(mockGetNoirCommitFromAztec).not.toHaveBeenCalled();
  });

  it("returns metadataSafe:false on partial sync but stamps mcpVersion", async () => {
    mockCloneRepo.mockResolvedValue("Cloned");
    const result = await syncRepos({ repos: ["aztec-packages"] });

    expect(result.success).toBe(true);
    expect(result.metadataSafe).toBe(false);
    expect(mockWriteSyncMetadata).not.toHaveBeenCalled();
    expect(mockStampMetadataMcpVersion).toHaveBeenCalledWith("v1.0.0");
  });

  it("treats explicit full repo list as full sync for metadata", async () => {
    mockCloneRepo.mockResolvedValue("Cloned");
    const allRepoNames = ["aztec-packages", "aztec-examples", "noir", "noir-examples", "aztec-starter"];
    const result = await syncRepos({ repos: allRepoNames });

    expect(result.success).toBe(true);
    expect(result.metadataSafe).toBe(true);
    expect(mockWriteSyncMetadata).toHaveBeenCalledWith("v1.0.0");
  });
});

describe("getStatus", () => {
  it("returns reposDir and repos array", async () => {
    mockGetReposStatus.mockResolvedValue(
      new Map([
        ["aztec-packages", { cloned: true, commit: "abc1234" }],
        ["aztec-examples", { cloned: false }],
        ["noir", { cloned: true, commit: "def5678" }],
        ["noir-examples", { cloned: false }],
        ["aztec-starter", { cloned: false }],
      ])
    );

    const status = await getStatus();
    expect(status.reposDir).toBe("/fake/repos");
    expect(status.repos).toHaveLength(5);
  });

  it("includes description, cloned status, and commit", async () => {
    mockGetReposStatus.mockResolvedValue(
      new Map([
        ["aztec-packages", { cloned: true, commit: "abc1234" }],
        ["aztec-examples", { cloned: false }],
        ["noir", { cloned: false }],
        ["noir-examples", { cloned: false }],
        ["aztec-starter", { cloned: false }],
      ])
    );

    const status = await getStatus();
    const ap = status.repos.find((r) => r.name === "aztec-packages");
    expect(ap?.cloned).toBe(true);
    expect(ap?.commit).toBe("abc1234");
    expect(ap?.description).toBe("Main repo");

    const examples = status.repos.find((r) => r.name === "aztec-examples");
    expect(examples?.cloned).toBe(false);
    expect(examples?.commit).toBeUndefined();
  });

  it("includes syncMetadata when available", async () => {
    mockGetReposStatus.mockResolvedValue(new Map());
    mockReadSyncMetadata.mockReturnValue({
      mcpVersion: "1.5.0",
      syncedAt: "2025-01-01T00:00:00.000Z",
      aztecVersion: "v1.0.0",
    });

    const status = await getStatus();
    expect(status.syncMetadata).toEqual({
      mcpVersion: "1.5.0",
      syncedAt: "2025-01-01T00:00:00.000Z",
      aztecVersion: "v1.0.0",
    });
  });

  it("includes null syncMetadata when no file exists", async () => {
    mockGetReposStatus.mockResolvedValue(new Map());
    mockReadSyncMetadata.mockReturnValue(null);

    const status = await getStatus();
    expect(status.syncMetadata).toBeNull();
  });
});
