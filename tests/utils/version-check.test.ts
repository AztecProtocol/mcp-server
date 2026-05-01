import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/utils/git.js", () => ({
  getRepoTag: vi.fn(),
}));

vi.mock("../../src/repos/config.js", () => ({
  DEFAULT_AZTEC_VERSION: "v4.2.0",
}));

import {
  normalizeVersion,
  checkVersionGate,
  formatMismatchMessage,
  getLocalVersion,
  _resetVersionCache,
} from "../../src/utils/version-check.js";
import { getRepoTag } from "../../src/utils/git.js";

const mockGetRepoTag = vi.mocked(getRepoTag);

function makeClient(getCorpusVersion: any, baseUrl = "https://test.example.com"): any {
  return { baseUrl, getCorpusVersion };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetVersionCache();
});

describe("normalizeVersion", () => {
  it("strips leading v", () => {
    expect(normalizeVersion("v4.2.0")).toBe("4.2.0");
  });

  it("strips pre-release suffix", () => {
    expect(normalizeVersion("v4.2.0-aztecnr-rc.2")).toBe("4.2.0");
    expect(normalizeVersion("4.2.0-beta")).toBe("4.2.0");
  });

  it("returns empty string for null/empty", () => {
    expect(normalizeVersion(null)).toBe("");
    expect(normalizeVersion("")).toBe("");
    expect(normalizeVersion(undefined)).toBe("");
  });

  it("treats `v4.2.0-aztecnr-rc.2` and `v4.2.0` as equivalent", () => {
    expect(normalizeVersion("v4.2.0-aztecnr-rc.2")).toBe(
      normalizeVersion("v4.2.0")
    );
  });

  it("does NOT collapse patch differences (4.2.1 vs 4.2.0)", () => {
    expect(normalizeVersion("v4.2.1")).not.toBe(normalizeVersion("v4.2.0"));
  });
});

describe("getLocalVersion", () => {
  it("returns the cloned tag when available", async () => {
    mockGetRepoTag.mockResolvedValue("v4.2.0-aztecnr-rc.2");
    expect(await getLocalVersion()).toBe("v4.2.0-aztecnr-rc.2");
  });

  it("falls back to DEFAULT_AZTEC_VERSION when no clone", async () => {
    mockGetRepoTag.mockResolvedValue(null);
    expect(await getLocalVersion()).toBe("v4.2.0");
  });
});

describe("checkVersionGate", () => {
  beforeEach(() => {
    mockGetRepoTag.mockResolvedValue("v4.2.0");
  });

  it("returns 'match' when versions normalize equal", async () => {
    const client = makeClient(
      vi.fn().mockResolvedValue({ aztec_corpus_version: "v4.2.0" })
    );
    const result = await checkVersionGate(client);
    expect(result.kind).toBe("match");
  });

  it("returns 'mismatch' when normalized versions differ", async () => {
    mockGetRepoTag.mockResolvedValue("v4.1.0");
    const client = makeClient(
      vi.fn().mockResolvedValue({ aztec_corpus_version: "v4.2.0" })
    );
    const result = await checkVersionGate(client);
    expect(result.kind).toBe("mismatch");
    if (result.kind === "mismatch") {
      expect(result.localVersion).toBe("v4.1.0");
      expect(result.corpusVersion).toBe("v4.2.0");
    }
  });

  it("returns 'unknown' when /api/version 404s (older deployment)", async () => {
    const client = makeClient(vi.fn().mockResolvedValue(null));
    const result = await checkVersionGate(client);
    expect(result.kind).toBe("unknown");
  });

  it("returns 'unknown' when corpus reports literal 'unknown'", async () => {
    const client = makeClient(
      vi.fn().mockResolvedValue({ aztec_corpus_version: "unknown" })
    );
    const result = await checkVersionGate(client);
    expect(result.kind).toBe("unknown");
  });

  it("returns 'unknown' when fetch throws (transient backend failure)", async () => {
    const client = makeClient(
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED"))
    );
    const result = await checkVersionGate(client);
    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") {
      expect(result.reason).toContain("could not reach");
    }
  });

  it("caches a successful response and reuses within TTL", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ aztec_corpus_version: "v4.2.0" });
    const client = makeClient(fetchSpy);

    await checkVersionGate(client);
    await checkVersionGate(client);
    await checkVersionGate(client);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("uses a separate cache slot per baseUrl", async () => {
    const a = makeClient(
      vi.fn().mockResolvedValue({ aztec_corpus_version: "v4.2.0" }),
      "https://a.example.com"
    );
    const b = makeClient(
      vi.fn().mockResolvedValue({ aztec_corpus_version: "v4.3.0" }),
      "https://b.example.com"
    );

    expect((await checkVersionGate(a)).kind).toBe("match");
    expect((await checkVersionGate(b)).kind).toBe("mismatch");
    // Both clients were called: cache didn't bleed across hosts.
    expect(a.getCorpusVersion).toHaveBeenCalledTimes(1);
    expect(b.getCorpusVersion).toHaveBeenCalledTimes(1);
  });
});

describe("formatMismatchMessage", () => {
  it("names both versions and the override flag", () => {
    const msg = formatMismatchMessage("v4.1.0", "v4.2.0");
    expect(msg).toContain("v4.1.0");
    expect(msg).toContain("v4.2.0");
    expect(msg).toContain("allowVersionMismatch");
    expect(msg).toContain("aztec_sync_repos");
  });
});
