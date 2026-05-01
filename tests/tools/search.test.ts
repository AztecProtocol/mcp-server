import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/utils/search.js", () => ({
  searchCode: vi.fn(),
  searchDocs: vi.fn(),
  listExamples: vi.fn(),
  findExample: vi.fn(),
  readFile: vi.fn(),
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

vi.mock("../../src/utils/git.js", () => ({
  isRepoCloned: vi.fn(),
  getRepoTag: vi.fn(),
}));

vi.mock("../../src/repos/config.js", () => ({
  getRepoNames: vi.fn(() => ["aztec-packages", "aztec-examples", "noir"]),
  DEFAULT_AZTEC_VERSION: "v4.2.0",
}));

import {
  searchCode,
  listExamples,
  findExample,
  readFile,
} from "../../src/utils/search.js";
import { isRepoCloned, getRepoTag } from "../../src/utils/git.js";
import { getRepoNames } from "../../src/repos/config.js";
import {
  searchAztecCode,
  searchAztecDocs,
  listAztecExamples,
  readAztecExample,
  readRepoFile,
} from "../../src/tools/search.js";
import { _resetVersionCache } from "../../src/utils/version-check.js";

const mockSearchCode = vi.mocked(searchCode);
const mockListExamples = vi.mocked(listExamples);
const mockFindExample = vi.mocked(findExample);
const mockReadFile = vi.mocked(readFile);
const mockIsRepoCloned = vi.mocked(isRepoCloned);
const mockGetRepoNames = vi.mocked(getRepoNames);
const mockGetRepoTag = vi.mocked(getRepoTag);

/**
 * Build a mock DocsGPT client. By default `getCorpusVersion` returns a
 * matching version so the version gate passes silently — individual
 * tests override it to exercise mismatch / error paths.
 */
function makeClient(overrides: {
  search?: any;
  getCorpusVersion?: any;
  baseUrl?: string;
} = {}): any {
  return {
    baseUrl: overrides.baseUrl ?? "https://test.example.com",
    search: overrides.search ?? vi.fn().mockResolvedValue([]),
    getCorpusVersion:
      overrides.getCorpusVersion ??
      vi.fn().mockResolvedValue({ aztec_corpus_version: "v4.2.0", source_count: 12 }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetRepoNames.mockReturnValue(["aztec-packages", "aztec-examples", "noir"]);
  // Default: local clone is at the same version the corpus advertises.
  mockGetRepoTag.mockResolvedValue("v4.2.0");
  _resetVersionCache();
});

describe("searchAztecCode", () => {
  it("returns failure when specific repo not cloned", () => {
    mockIsRepoCloned.mockReturnValue(false);
    const result = searchAztecCode({ query: "test", repo: "aztec-packages" });
    expect(result.success).toBe(false);
    expect(result.message).toContain("not cloned");
  });

  it("returns failure when no repos cloned", () => {
    mockIsRepoCloned.mockReturnValue(false);
    const result = searchAztecCode({ query: "test" });
    expect(result.success).toBe(false);
    expect(result.message).toContain("No repositories are cloned");
  });

  it("delegates to searchCode with correct options", () => {
    mockIsRepoCloned.mockReturnValue(true);
    mockSearchCode.mockReturnValue([
      { file: "f", line: 1, content: "c", repo: "r" },
    ]);

    const result = searchAztecCode({
      query: "test",
      filePattern: "*.ts",
      repo: "aztec-packages",
      maxResults: 10,
    });

    expect(result.success).toBe(true);
    expect(mockSearchCode).toHaveBeenCalledWith("test", {
      filePattern: "*.ts",
      repo: "aztec-packages",
      maxResults: 10,
    });
  });

  it("defaults filePattern to *.nr and maxResults to 30", () => {
    mockIsRepoCloned.mockReturnValue(true);
    mockSearchCode.mockReturnValue([]);

    searchAztecCode({ query: "test" });

    expect(mockSearchCode).toHaveBeenCalledWith("test", {
      filePattern: "*.nr",
      repo: undefined,
      maxResults: 30,
    });
  });
});

describe("searchAztecDocs — no client (ripgrep-only)", () => {
  it("returns ripgrep not-cloned message when no client and no local docs", async () => {
    mockIsRepoCloned.mockReturnValue(false);
    const result = await searchAztecDocs({ query: "tutorial" }, null);
    expect(result.kind).toBe("ripgrep");
    if (result.kind === "ripgrep") {
      expect(result.result.success).toBe(false);
      expect(result.result.message).toContain("aztec-packages-docs is not cloned");
    }
  });

  it("uses ripgrep when no client and docs are cloned", async () => {
    mockIsRepoCloned.mockReturnValue(true);
    const { searchDocs } = await import("../../src/utils/search.js");
    vi.mocked(searchDocs).mockReturnValue([]);

    const result = await searchAztecDocs(
      { query: "tutorial", section: "concepts", maxResults: 5 },
      null
    );
    expect(result.kind).toBe("ripgrep");
    if (result.kind === "ripgrep") expect(result.result.success).toBe(true);
  });
});

describe("searchAztecDocs — semantic happy path", () => {
  it("returns semantic results from DocsGPT client", async () => {
    const client = makeClient({
      search: vi.fn().mockResolvedValue([
        { text: "content", title: "Tutorial", source: "docs/tutorial.md" },
      ]),
    });

    const result = await searchAztecDocs({ query: "tutorial" }, client);
    expect(result.kind).toBe("semantic");
    if (result.kind === "semantic") {
      expect(result.result.success).toBe(true);
      expect(result.result.results).toHaveLength(1);
      expect(result.result.results[0].title).toBe("Tutorial");
    }
    expect(client.search).toHaveBeenCalledWith("tutorial", 5);
  });

  it("respects chunks parameter", async () => {
    const client = makeClient();
    await searchAztecDocs({ query: "test", chunks: 10 }, client);
    expect(client.search).toHaveBeenCalledWith("test", 10);
  });

  it("uses maxResults as fallback for chunks in semantic mode", async () => {
    const client = makeClient();
    await searchAztecDocs({ query: "test", maxResults: 8 }, client);
    expect(client.search).toHaveBeenCalledWith("test", 8);
  });

  it("prefers chunks over maxResults when both provided", async () => {
    const client = makeClient();
    await searchAztecDocs({ query: "test", chunks: 3, maxResults: 15 }, client);
    expect(client.search).toHaveBeenCalledWith("test", 3);
  });
});

describe("searchAztecDocs — error reporting (no silent fallback)", () => {
  it("surfaces semantic failure as `error` kind by default", async () => {
    mockIsRepoCloned.mockReturnValue(true);
    const client = makeClient({
      search: vi.fn().mockRejectedValue(new Error("network error")),
    });

    const result = await searchAztecDocs({ query: "test" }, client);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.semanticError).toContain("network error");
      expect(result.message).toContain("Semantic documentation search failed");
      expect(result.message).toContain("useLocalFallback");
      expect(result.fallbackError).toBeUndefined();
    }
  });

  it("does NOT call the local searchDocs when fallback is disabled (default)", async () => {
    mockIsRepoCloned.mockReturnValue(true);
    const { searchDocs } = await import("../../src/utils/search.js");
    const client = makeClient({
      search: vi.fn().mockRejectedValue(new Error("boom")),
    });

    await searchAztecDocs({ query: "test" }, client);
    expect(vi.mocked(searchDocs)).not.toHaveBeenCalled();
  });
});

describe("searchAztecDocs — useLocalFallback", () => {
  it("falls through to ripgrep when client errors AND useLocalFallback=true AND local docs exist", async () => {
    mockIsRepoCloned.mockReturnValue(true);
    const { searchDocs } = await import("../../src/utils/search.js");
    vi.mocked(searchDocs).mockReturnValue([
      { file: "docs/tutorial.md", line: 1, content: "tutorial content", repo: "aztec-packages-docs" },
    ]);

    const client = makeClient({
      search: vi.fn().mockRejectedValue(new Error("network error")),
    });

    const result = await searchAztecDocs(
      { query: "test", useLocalFallback: true },
      client
    );
    expect(result.kind).toBe("ripgrep");
    if (result.kind === "ripgrep") {
      expect(result.result.success).toBe(true);
      expect(result.result.results).toHaveLength(1);
      expect(result.result.message).toContain("Semantic search failed");
    }
  });

  it("returns compound error when useLocalFallback=true AND both backends fail", async () => {
    mockIsRepoCloned.mockReturnValue(false); // no local docs
    const client = makeClient({
      search: vi.fn().mockRejectedValue(new Error("network error")),
    });

    const result = await searchAztecDocs(
      { query: "test", useLocalFallback: true },
      client
    );
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.semanticError).toContain("network error");
      expect(result.fallbackError).toContain("aztec-packages-docs is not cloned");
      expect(result.message).toContain("Both documentation backends are unavailable");
    }
  });
});

describe("searchAztecDocs — version-sync gate", () => {
  it("blocks semantic call when local clone is at a different version than the corpus", async () => {
    mockGetRepoTag.mockResolvedValue("v4.1.0");
    const client = makeClient({
      search: vi.fn().mockResolvedValue([{ text: "x", title: "x", source: "x" }]),
      getCorpusVersion: vi.fn().mockResolvedValue({ aztec_corpus_version: "v4.2.0" }),
    });

    const result = await searchAztecDocs({ query: "test" }, client);
    expect(result.kind).toBe("version-mismatch");
    if (result.kind === "version-mismatch") {
      expect(result.localVersion).toBe("v4.1.0");
      expect(result.corpusVersion).toBe("v4.2.0");
      expect(result.message).toContain("Version mismatch");
      expect(result.message).toContain("allowVersionMismatch");
    }
    expect(client.search).not.toHaveBeenCalled();
  });

  it("treats `v4.2.0-aztecnr-rc.2` and `v4.2.0` as matching after normalization", async () => {
    mockGetRepoTag.mockResolvedValue("v4.2.0-aztecnr-rc.2");
    const client = makeClient({
      getCorpusVersion: vi.fn().mockResolvedValue({ aztec_corpus_version: "v4.2.0" }),
    });

    const result = await searchAztecDocs({ query: "test" }, client);
    expect(result.kind).toBe("semantic");
  });

  it("on mismatch + useLocalFallback=true, falls through to ripgrep instead of refusing", async () => {
    mockGetRepoTag.mockResolvedValue("v4.1.0");
    mockIsRepoCloned.mockReturnValue(true);
    const { searchDocs } = await import("../../src/utils/search.js");
    vi.mocked(searchDocs).mockReturnValue([
      { file: "docs/x.md", line: 1, content: "local content", repo: "aztec-packages-docs" },
    ]);

    const client = makeClient({
      search: vi.fn().mockResolvedValue([{ text: "x", title: "x", source: "x" }]),
      getCorpusVersion: vi.fn().mockResolvedValue({ aztec_corpus_version: "v4.2.0" }),
    });

    const result = await searchAztecDocs(
      { query: "test", useLocalFallback: true },
      client
    );
    expect(result.kind).toBe("ripgrep");
    if (result.kind === "ripgrep") {
      expect(result.result.success).toBe(true);
      // Message must explain WHY local was used — not just look like a normal local search
      expect(result.result.message).toContain("v4.2.0");
      expect(result.result.message).toContain("v4.1.0");
    }
    // Crucially, the semantic backend is NOT called when we know it's mismatched
    expect(client.search).not.toHaveBeenCalled();
  });

  it("proceeds when allowVersionMismatch=true even on mismatch", async () => {
    mockGetRepoTag.mockResolvedValue("v4.1.0");
    const client = makeClient({
      search: vi.fn().mockResolvedValue([
        { text: "x", title: "x", source: "x" },
      ]),
      getCorpusVersion: vi.fn().mockResolvedValue({ aztec_corpus_version: "v4.2.0" }),
    });

    const result = await searchAztecDocs(
      { query: "test", allowVersionMismatch: true },
      client
    );
    expect(result.kind).toBe("semantic");
    expect(client.search).toHaveBeenCalled();
  });

  it("treats /api/version 404 (older deployment) as `unknown` and proceeds", async () => {
    const client = makeClient({
      // null mimics a 404 response (DocsGPTClient returns null for 404)
      getCorpusVersion: vi.fn().mockResolvedValue(null),
      search: vi.fn().mockResolvedValue([]),
    });

    const result = await searchAztecDocs({ query: "test" }, client);
    expect(result.kind).toBe("semantic");
    expect(client.search).toHaveBeenCalled();
  });

  it("treats /api/version network error as `unknown` and proceeds", async () => {
    const client = makeClient({
      getCorpusVersion: vi.fn().mockRejectedValue(new Error("network error")),
      search: vi.fn().mockResolvedValue([]),
    });

    const result = await searchAztecDocs({ query: "test" }, client);
    expect(result.kind).toBe("semantic");
    expect(client.search).toHaveBeenCalled();
  });

  it("treats `unknown` corpus version (operator hasn't set AZTEC_CORPUS_VERSION) as `unknown`", async () => {
    const client = makeClient({
      getCorpusVersion: vi.fn().mockResolvedValue({ aztec_corpus_version: "unknown" }),
      search: vi.fn().mockResolvedValue([]),
    });

    const result = await searchAztecDocs({ query: "test" }, client);
    expect(result.kind).toBe("semantic");
  });
});

describe("listAztecExamples", () => {
  it("returns failure when no repos cloned", () => {
    mockIsRepoCloned.mockReturnValue(false);
    const result = listAztecExamples({});
    expect(result.success).toBe(false);
    expect(result.message).toContain("No repositories are cloned");
  });

  it("delegates to listExamples", () => {
    mockIsRepoCloned.mockReturnValue(true);
    mockListExamples.mockReturnValue([
      { path: "p", name: "token", repo: "r", type: "contract" },
    ]);

    const result = listAztecExamples({ category: "token" });
    expect(result.success).toBe(true);
    expect(mockListExamples).toHaveBeenCalledWith("token");
    expect(result.examples).toHaveLength(1);
  });
});

describe("readAztecExample", () => {
  it("returns failure when findExample returns null", () => {
    mockFindExample.mockReturnValue(null);
    const result = readAztecExample({ name: "nonexistent" });
    expect(result.success).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("returns failure when readFile returns null", () => {
    mockFindExample.mockReturnValue({
      path: "p",
      name: "token",
      repo: "r",
      type: "contract",
    });
    mockReadFile.mockReturnValue(null);

    const result = readAztecExample({ name: "token" });
    expect(result.success).toBe(false);
    expect(result.message).toContain("Could not read");
  });

  it("returns content on success", () => {
    mockFindExample.mockReturnValue({
      path: "p",
      name: "token",
      repo: "r",
      type: "contract",
    });
    mockReadFile.mockReturnValue("fn main() {}");

    const result = readAztecExample({ name: "token" });
    expect(result.success).toBe(true);
    expect(result.content).toBe("fn main() {}");
  });
});

describe("readRepoFile", () => {
  it("returns failure when readFile returns null", () => {
    mockReadFile.mockReturnValue(null);
    const result = readRepoFile({ path: "nonexistent.nr" });
    expect(result.success).toBe(false);
    expect(result.message).toContain("File not found");
  });

  it("returns content on success", () => {
    mockReadFile.mockReturnValue("file content");
    const result = readRepoFile({ path: "repo/file.nr" });
    expect(result.success).toBe(true);
    expect(result.content).toBe("file content");
  });
});
