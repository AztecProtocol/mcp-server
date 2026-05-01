import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/utils/error-lookup.js", () => ({
  lookupError: vi.fn(),
}));

vi.mock("../../src/utils/git.js", () => ({
  isRepoCloned: vi.fn(),
  getRepoTag: vi.fn(),
}));

vi.mock("../../src/repos/config.js", () => ({
  getRepoNames: vi.fn(() => ["aztec-packages"]),
  DEFAULT_AZTEC_VERSION: "v4.2.0",
}));

vi.mock("../../src/backends/docsgpt-client.js", () => ({
  DocsGPTClient: vi.fn(),
  DocsGPTClientError: class extends Error {
    statusCode?: number;
    constructor(msg: string, statusCode?: number) {
      super(msg);
      this.name = "DocsGPTClientError";
      this.statusCode = statusCode;
    }
  },
}));

import { lookupAztecError } from "../../src/tools/error-lookup.js";
import { lookupError } from "../../src/utils/error-lookup.js";
import { getRepoTag } from "../../src/utils/git.js";
import { DocsGPTClientError } from "../../src/backends/docsgpt-client.js";
import { _resetVersionCache } from "../../src/utils/version-check.js";

const mockLookupError = vi.mocked(lookupError);
const mockGetRepoTag = vi.mocked(getRepoTag);

function makeClient(overrides: { search?: any; getCorpusVersion?: any } = {}): any {
  return {
    baseUrl: "https://test.example.com",
    search: overrides.search ?? vi.fn().mockResolvedValue([]),
    getCorpusVersion:
      overrides.getCorpusVersion ??
      vi.fn().mockResolvedValue({ aztec_corpus_version: "v4.2.0" }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetRepoTag.mockResolvedValue("v4.2.0");
  _resetVersionCache();
  // Default: empty static catalog so we exercise the semantic-fallback path.
  mockLookupError.mockReturnValue({
    query: "",
    catalogMatches: [],
    codeMatches: [],
  });
});

describe("lookupAztecError — static catalog hits", () => {
  it("returns immediately with semanticHealth='skipped' when catalog matches", async () => {
    mockLookupError.mockReturnValue({
      query: "boom",
      catalogMatches: [
        {
          entry: {
            id: "x",
            name: "BoomError",
            patterns: ["boom"],
            cause: "c",
            fix: "f",
            category: "contract",
            source: "s",
          },
          matchType: "exact-name",
          score: 100,
        },
      ],
      codeMatches: [],
    });

    const client = makeClient();
    const result = await lookupAztecError({ query: "boom" }, client);

    expect(result.success).toBe(true);
    expect(result.semanticHealth).toBe("skipped");
    expect(result.semanticResults).toBeUndefined();
    expect(client.search).not.toHaveBeenCalled();
    expect(client.getCorpusVersion).not.toHaveBeenCalled();
  });
});

describe("lookupAztecError — semantic fallback", () => {
  it("calls semantic search when catalog is empty and client present", async () => {
    const client = makeClient({
      search: vi.fn().mockResolvedValue([
        { text: "doc", title: "T", source: "S" },
      ]),
    });

    const result = await lookupAztecError({ query: "obscure" }, client);
    expect(result.semanticHealth).toBe("ok");
    expect(result.semanticResults).toHaveLength(1);
    expect(client.search).toHaveBeenCalledWith("Aztec error: obscure", 3);
  });

  it("returns semanticHealth='no_results' when semantic returns []", async () => {
    const client = makeClient({
      search: vi.fn().mockResolvedValue([]),
    });
    const result = await lookupAztecError({ query: "obscure" }, client);
    expect(result.semanticHealth).toBe("no_results");
    expect(result.semanticResults).toBeUndefined();
  });

  it("returns semanticHealth='skipped' when no client", async () => {
    const result = await lookupAztecError({ query: "obscure" }, null);
    expect(result.semanticHealth).toBe("skipped");
  });
});

describe("lookupAztecError — semantic failure (sanitized message)", () => {
  it("sets semanticHealth='failed' and returns sanitized message on 401", async () => {
    const client = makeClient({
      search: vi.fn().mockRejectedValue(new DocsGPTClientError("Invalid API key.", 401)),
    });

    const result = await lookupAztecError({ query: "x" }, client);
    expect(result.semanticHealth).toBe("failed");
    // Sanitized: should mention API key remediation, NOT the verbatim upstream string.
    expect(result.message).toContain("API key is invalid");
    expect(result.message).toContain("/mcp-key");
    // Crucially, the raw upstream message must NOT leak (we don't want
    // the user to see backend implementation details).
    expect(result.message).not.toContain("DocsGPTClientError");
  });

  it("sets semanticHealth='failed' and uses generic-unavailable message on network error", async () => {
    const client = makeClient({
      search: vi.fn().mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:7091")),
    });

    const result = await lookupAztecError({ query: "x" }, client);
    expect(result.semanticHealth).toBe("failed");
    expect(result.message).toContain("currently unavailable");
    expect(result.message).not.toContain("ECONNREFUSED");
    expect(result.message).not.toContain("127.0.0.1");
  });
});

describe("lookupAztecError — version-mismatch gate", () => {
  it("blocks semantic fallback when local clone diverges from corpus", async () => {
    mockGetRepoTag.mockResolvedValue("v4.1.0");
    const client = makeClient({
      search: vi.fn().mockResolvedValue([{ text: "x", title: "x", source: "x" }]),
      getCorpusVersion: vi.fn().mockResolvedValue({ aztec_corpus_version: "v4.2.0" }),
    });

    const result = await lookupAztecError({ query: "obscure" }, client);
    expect(result.semanticHealth).toBe("version_mismatch");
    expect(result.versionMismatch).toEqual({ localVersion: "v4.1.0", corpusVersion: "v4.2.0" });
    expect(client.search).not.toHaveBeenCalled();
    expect(result.message).toContain("version mismatch");
  });

  it("override: allowVersionMismatch=true bypasses the gate", async () => {
    mockGetRepoTag.mockResolvedValue("v4.1.0");
    const client = makeClient({
      search: vi.fn().mockResolvedValue([
        { text: "x", title: "x", source: "x" },
      ]),
      getCorpusVersion: vi.fn().mockResolvedValue({ aztec_corpus_version: "v4.2.0" }),
    });

    const result = await lookupAztecError(
      { query: "obscure", allowVersionMismatch: true },
      client
    );
    expect(result.semanticHealth).toBe("ok");
    expect(client.search).toHaveBeenCalled();
  });

  it("does NOT consult the version gate when the static catalog already matched", async () => {
    mockGetRepoTag.mockResolvedValue("v4.1.0");
    mockLookupError.mockReturnValue({
      query: "boom",
      catalogMatches: [
        {
          entry: {
            id: "x",
            name: "BoomError",
            patterns: ["boom"],
            cause: "c",
            fix: "f",
            category: "contract",
            source: "s",
          },
          matchType: "exact-name",
          score: 100,
        },
      ],
      codeMatches: [],
    });

    const client = makeClient({
      getCorpusVersion: vi.fn().mockResolvedValue({ aztec_corpus_version: "v4.2.0" }),
    });

    const result = await lookupAztecError({ query: "boom" }, client);
    expect(result.semanticHealth).toBe("skipped");
    expect(client.getCorpusVersion).not.toHaveBeenCalled();
  });
});
