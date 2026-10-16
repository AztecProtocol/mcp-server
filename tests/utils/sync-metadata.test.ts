import { describe, it, expect, vi, beforeEach } from "vitest";

const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockExistsSync = vi.fn();
const mockReaddirSync = vi.fn();

vi.mock("fs", () => ({
  renameSync: vi.fn(),
  rmSync: vi.fn(),
  readFileSync: (...args: any[]) => mockReadFileSync(...args),
  writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
  existsSync: (...args: any[]) => mockExistsSync(...args),
  readdirSync: (...args: any[]) => mockReaddirSync(...args),
}));

vi.mock("../../src/utils/git.js", () => ({
  REPOS_DIR: "/fake/repos",
}));

vi.mock("../../src/version.js", () => ({
  MCP_VERSION: "2.0.0",
}));

import { renameSync, rmSync } from "fs";

import {
  beginVersionSync,
  getMetadataPath,
  writeSyncMetadata,
  readSyncMetadata,
  getSyncState,
  writeAutoResyncAttempt,
  stampMetadataMcpVersion,
  invalidateSyncStateCache,
} from "../../src/utils/sync-metadata.js";

beforeEach(() => {
  vi.clearAllMocks();
  invalidateSyncStateCache();
});

describe("getMetadataPath", () => {
  it("returns path in REPOS_DIR", () => {
    expect(getMetadataPath()).toBe("/fake/repos/.sync-metadata.json");
  });
});

describe("writeSyncMetadata", () => {
  it("writes JSON with mcpVersion, syncedAt, and aztecVersion", () => {
    writeSyncMetadata("v1.0.0");

    expect(mockWriteFileSync).toHaveBeenCalledOnce();
    const [path, content] = mockWriteFileSync.mock.calls[0];
    expect(path).toBe("/fake/repos/.sync-metadata.json.tmp");

    const parsed = JSON.parse(content);
    expect(parsed.mcpVersion).toBe("2.0.0");
    expect(parsed.aztecVersion).toBe("v1.0.0");
    expect(parsed.syncedAt).toBeDefined();
  });
});

describe("readSyncMetadata", () => {
  it("returns parsed metadata when file exists", () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        mcpVersion: "1.5.0",
        syncedAt: "2025-01-01T00:00:00.000Z",
        aztecVersion: "v1.0.0",
      })
    );

    const result = readSyncMetadata();
    expect(result).toEqual({
      mcpVersion: "1.5.0",
      syncedAt: "2025-01-01T00:00:00.000Z",
      aztecVersion: "v1.0.0",
    });
  });

  it("returns null when file does not exist", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    expect(readSyncMetadata()).toBeNull();
  });

  it("returns null when file contains invalid JSON", () => {
    mockReadFileSync.mockReturnValue("not json");
    expect(readSyncMetadata()).toBeNull();
  });

  it("returns null when JSON lacks mcpVersion", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ foo: "bar" }));
    expect(readSyncMetadata()).toBeNull();
  });
});

describe("writeAutoResyncAttempt", () => {
  it("preserves existing metadata and adds attempt with result", () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        mcpVersion: "1.5.0",
        syncedAt: "2025-01-01T00:00:00.000Z",
        aztecVersion: "v1.0.0",
      })
    );

    writeAutoResyncAttempt("hard_failure");

    expect(mockWriteFileSync).toHaveBeenCalledOnce();
    const parsed = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(parsed.mcpVersion).toBe("1.5.0");
    expect(parsed.aztecVersion).toBe("v1.0.0");
    expect(parsed.autoResyncAttempt).toEqual({
      targetMcpVersion: "2.0.0",
      attemptedAt: expect.any(String),
      result: "hard_failure",
    });
  });

  it("creates minimal metadata when no file exists", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    writeAutoResyncAttempt("retryable");

    expect(mockWriteFileSync).toHaveBeenCalledOnce();
    const parsed = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(parsed.mcpVersion).toBe("unknown");
    expect(parsed.aztecVersion).toBe("");
    expect(parsed.autoResyncAttempt.targetMcpVersion).toBe("2.0.0");
    expect(parsed.autoResyncAttempt.result).toBe("retryable");
  });

  it("stores undefined result when no argument passed", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    writeAutoResyncAttempt();

    const parsed = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(parsed.autoResyncAttempt.result).toBeUndefined();
  });
});

describe("stampMetadataMcpVersion", () => {
  it("updates mcpVersion in existing metadata and clears autoResyncAttempt", () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        mcpVersion: "1.5.0",
        syncedAt: "2025-01-01T00:00:00.000Z",
        aztecVersion: "v1.0.0",
        autoResyncAttempt: {
          targetMcpVersion: "2.0.0",
          attemptedAt: "2025-06-01T00:00:00.000Z",
          result: "retryable",
        },
      })
    );

    stampMetadataMcpVersion("v1.0.0");

    const parsed = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(parsed.mcpVersion).toBe("2.0.0");
    expect(parsed.aztecVersion).toBe("v1.0.0");
    expect(parsed.syncedAt).toBe("2025-01-01T00:00:00.000Z");
    expect(parsed.autoResyncAttempt).toBeUndefined();
  });

  it("creates minimal metadata when no file exists", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    stampMetadataMcpVersion("v2.0.0");

    const parsed = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(parsed.mcpVersion).toBe("2.0.0");
    expect(parsed.aztecVersion).toBe("v2.0.0");
    expect(parsed.syncedAt).toBeDefined();
  });

  it("fills in empty aztecVersion from argument", () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        mcpVersion: "unknown",
        syncedAt: "",
        aztecVersion: "",
      })
    );

    stampMetadataMcpVersion("v3.0.0");

    const parsed = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(parsed.mcpVersion).toBe("2.0.0");
    expect(parsed.aztecVersion).toBe("v3.0.0");
  });

  it("preserves existing aztecVersion when already set", () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        mcpVersion: "1.0.0",
        syncedAt: "2025-01-01T00:00:00.000Z",
        aztecVersion: "v1.0.0",
      })
    );

    stampMetadataMcpVersion("v2.0.0");

    const parsed = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(parsed.aztecVersion).toBe("v1.0.0");
  });
});

describe("getSyncState", () => {
  it("returns noRepos when no metadata and no repos dir", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    mockExistsSync.mockReturnValue(false);

    expect(getSyncState()).toEqual({ kind: "noRepos" });
  });

  it("returns legacyUnknownVersion when no metadata but repos dir has cloned repos", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(["aztec-packages", "noir"]);

    expect(getSyncState()).toEqual({ kind: "legacyUnknownVersion" });
  });

  it("returns noRepos when repos dir exists but is empty (failed initial sync)", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([]);

    expect(getSyncState()).toEqual({ kind: "noRepos" });
  });

  it("returns noRepos when repos dir has only hidden files", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([".sync-metadata.json"]);

    expect(getSyncState()).toEqual({ kind: "noRepos" });
  });

  it("returns upToDate when version matches", () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        mcpVersion: "2.0.0",
        syncedAt: "2025-01-01T00:00:00.000Z",
        aztecVersion: "v1.0.0",
      })
    );

    expect(getSyncState()).toEqual({ kind: "upToDate" });
  });

  it("returns needsAutoResync when version mismatches", () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        mcpVersion: "1.5.0",
        syncedAt: "2025-01-01T00:00:00.000Z",
        aztecVersion: "v1.0.0",
      })
    );

    expect(getSyncState()).toEqual({ kind: "needsAutoResync", aztecVersion: "v1.0.0" });
  });

  it("returns upToDate when hard_failure attempt for this version", () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        mcpVersion: "1.5.0",
        syncedAt: "2025-01-01T00:00:00.000Z",
        aztecVersion: "v1.0.0",
        autoResyncAttempt: {
          targetMcpVersion: "2.0.0",
          attemptedAt: "2025-06-01T00:00:00.000Z",
          result: "hard_failure",
        },
      })
    );

    expect(getSyncState()).toEqual({ kind: "upToDate" });
  });

  it("returns upToDate when old metadata lacks result field (backwards compat)", () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        mcpVersion: "1.5.0",
        syncedAt: "2025-01-01T00:00:00.000Z",
        aztecVersion: "v1.0.0",
        autoResyncAttempt: {
          targetMcpVersion: "2.0.0",
          attemptedAt: "2025-06-01T00:00:00.000Z",
        },
      })
    );

    expect(getSyncState()).toEqual({ kind: "upToDate" });
  });

  it("returns upToDate when deferred attempt for this version", () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        mcpVersion: "1.5.0",
        syncedAt: "2025-01-01T00:00:00.000Z",
        aztecVersion: "v1.0.0",
        autoResyncAttempt: {
          targetMcpVersion: "2.0.0",
          attemptedAt: "2025-06-01T00:00:00.000Z",
          result: "deferred",
        },
      })
    );

    expect(getSyncState()).toEqual({ kind: "upToDate" });
  });

  it("returns upToDate when retryable attempt within 30 minutes", () => {
    const recentTime = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        mcpVersion: "1.5.0",
        syncedAt: "2025-01-01T00:00:00.000Z",
        aztecVersion: "v1.0.0",
        autoResyncAttempt: {
          targetMcpVersion: "2.0.0",
          attemptedAt: recentTime,
          result: "retryable",
        },
      })
    );

    expect(getSyncState()).toEqual({ kind: "upToDate" });
  });

  it("returns needsAutoResync when retryable attempt after 30+ minutes", () => {
    const oldTime = new Date(Date.now() - 31 * 60 * 1000).toISOString(); // 31 min ago
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        mcpVersion: "1.5.0",
        syncedAt: "2025-01-01T00:00:00.000Z",
        aztecVersion: "v1.0.0",
        autoResyncAttempt: {
          targetMcpVersion: "2.0.0",
          attemptedAt: oldTime,
          result: "retryable",
        },
      })
    );

    expect(getSyncState()).toEqual({ kind: "needsAutoResync", aztecVersion: "v1.0.0" });
  });

  it("returns needsAutoResync when attempt was for a different version", () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        mcpVersion: "1.0.0",
        syncedAt: "2025-01-01T00:00:00.000Z",
        aztecVersion: "v1.0.0",
        autoResyncAttempt: {
          targetMcpVersion: "1.5.0",
          attemptedAt: "2025-06-01T00:00:00.000Z",
        },
      })
    );

    expect(getSyncState()).toEqual({ kind: "needsAutoResync", aztecVersion: "v1.0.0" });
  });

  it("returns legacyUnknownVersion when metadata has empty aztecVersion", () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        mcpVersion: "unknown",
        syncedAt: "",
        aztecVersion: "",
      })
    );

    expect(getSyncState()).toEqual({ kind: "legacyUnknownVersion" });
  });
});


describe("split sync recovery", () => {
  it("preserves the previous release while marking an incomplete migration", () => {
    const previous = { mcpVersion: "2.0.0", syncedAt: "old", aztecVersion: "v4.3.0" };
    mockReadFileSync.mockReturnValue(JSON.stringify(previous));
    beginVersionSync("v6.0.0-rc.6", ["aztec-node", "noir"]);
    const pending = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(pending).toEqual({ ...previous, pendingVersion: "v6.0.0-rc.6", pendingRepositories: ["aztec-node", "noir"] });
    mockReadFileSync.mockReturnValue(JSON.stringify(pending));
    expect(getSyncState()).toEqual({ kind: "needsAutoResync", aztecVersion: "v6.0.0-rc.6" });
  });

  it("replaces pending state with the completed release and exact active commits", () => {
    writeSyncMetadata("v6.0.0-rc.6", { "aztec-node": "a".repeat(40) });
    const saved = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(saved.pendingVersion).toBeUndefined();
    expect(saved.repositories).toEqual({ "aztec-node": "a".repeat(40) });
  });
});


it("does not replace the pending metadata record when the atomic rename fails", () => {
  vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error("rename failed"); });
  expect(() => writeSyncMetadata("v6.0.0-rc.6", { "aztec-node": "a".repeat(40) })).toThrow("rename failed");
  expect(mockWriteFileSync.mock.calls[0][0]).toBe("/fake/repos/.sync-metadata.json.tmp");
  expect(renameSync).toHaveBeenCalledWith("/fake/repos/.sync-metadata.json.tmp", "/fake/repos/.sync-metadata.json");
  expect(rmSync).toHaveBeenCalledWith("/fake/repos/.sync-metadata.json.tmp", { force: true });
});
