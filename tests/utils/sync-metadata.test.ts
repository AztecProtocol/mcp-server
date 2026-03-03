import { describe, it, expect, vi, beforeEach } from "vitest";

const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();

vi.mock("fs", () => ({
  readFileSync: (...args: any[]) => mockReadFileSync(...args),
  writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
}));

vi.mock("../../src/utils/git.js", () => ({
  REPOS_DIR: "/fake/repos",
}));

vi.mock("../../src/version.js", () => ({
  MCP_VERSION: "2.0.0",
}));

import {
  getMetadataPath,
  writeSyncMetadata,
  readSyncMetadata,
  needsResync,
} from "../../src/utils/sync-metadata.js";

beforeEach(() => {
  vi.clearAllMocks();
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
    expect(path).toBe("/fake/repos/.sync-metadata.json");

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

describe("needsResync", () => {
  it("returns null when no metadata file exists", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    expect(needsResync()).toBeNull();
  });

  it("returns null when version matches", () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        mcpVersion: "2.0.0",
        syncedAt: "2025-01-01T00:00:00.000Z",
        aztecVersion: "v1.0.0",
      })
    );

    expect(needsResync()).toBeNull();
  });

  it("returns stale metadata when version mismatches", () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        mcpVersion: "1.5.0",
        syncedAt: "2025-01-01T00:00:00.000Z",
        aztecVersion: "v1.0.0",
      })
    );

    const result = needsResync();
    expect(result).toEqual({
      mcpVersion: "1.5.0",
      syncedAt: "2025-01-01T00:00:00.000Z",
      aztecVersion: "v1.0.0",
    });
  });
});
