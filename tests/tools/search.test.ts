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
  DocsGPTClientError: class extends Error { constructor(msg: string) { super(msg); this.name = "DocsGPTClientError"; } },
}));

vi.mock("../../src/utils/git.js", () => ({
  isRepoCloned: vi.fn(),
}));

vi.mock("../../src/repos/config.js", () => ({
  getRepoNames: vi.fn(() => ["aztec-packages", "aztec-examples", "noir"]),
}));

import {
  searchCode,
  listExamples,
  findExample,
  readFile,
} from "../../src/utils/search.js";
import { isRepoCloned } from "../../src/utils/git.js";
import { getRepoNames } from "../../src/repos/config.js";
import {
  searchAztecCode,
  searchAztecDocs,
  listAztecExamples,
  readAztecExample,
  readRepoFile,
} from "../../src/tools/search.js";

const mockSearchCode = vi.mocked(searchCode);
const mockListExamples = vi.mocked(listExamples);
const mockFindExample = vi.mocked(findExample);
const mockReadFile = vi.mocked(readFile);
const mockIsRepoCloned = vi.mocked(isRepoCloned);
const mockGetRepoNames = vi.mocked(getRepoNames);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetRepoNames.mockReturnValue(["aztec-packages", "aztec-examples", "noir"]);
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

describe("searchAztecDocs", () => {
  it("falls back to ripgrep when no client configured", async () => {
    mockIsRepoCloned.mockReturnValue(false);
    const result = await searchAztecDocs({ query: "tutorial" }, null);
    expect(result.kind).toBe("ripgrep");
    expect(result.result.success).toBe(false);
    expect(result.result.message).toContain("aztec-packages-docs is not cloned");
  });

  it("uses ripgrep when no client and docs are cloned", async () => {
    mockIsRepoCloned.mockReturnValue(true);
    const { searchDocs } = await import("../../src/utils/search.js");
    vi.mocked(searchDocs).mockReturnValue([]);

    const result = await searchAztecDocs({ query: "tutorial", section: "concepts", maxResults: 5 }, null);
    expect(result.kind).toBe("ripgrep");
    expect(result.result.success).toBe(true);
  });

  it("returns semantic results from DocsGPT client", async () => {
    const mockClient = {
      search: vi.fn().mockResolvedValue([
        { text: "content", title: "Tutorial", source: "docs/tutorial.md" },
      ]),
    } as any;

    const result = await searchAztecDocs({ query: "tutorial" }, mockClient);
    expect(result.kind).toBe("semantic");
    if (result.kind === "semantic") {
      expect(result.result.success).toBe(true);
      expect(result.result.results).toHaveLength(1);
      expect(result.result.results[0].title).toBe("Tutorial");
    }
    expect(mockClient.search).toHaveBeenCalledWith("tutorial", 5);
  });

  it("respects chunks parameter", async () => {
    const mockClient = {
      search: vi.fn().mockResolvedValue([]),
    } as any;

    await searchAztecDocs({ query: "test", chunks: 10 }, mockClient);
    expect(mockClient.search).toHaveBeenCalledWith("test", 10);
  });

  it("uses maxResults as fallback for chunks in semantic mode", async () => {
    const mockClient = {
      search: vi.fn().mockResolvedValue([]),
    } as any;

    await searchAztecDocs({ query: "test", maxResults: 8 }, mockClient);
    expect(mockClient.search).toHaveBeenCalledWith("test", 8);
  });

  it("prefers chunks over maxResults when both provided", async () => {
    const mockClient = {
      search: vi.fn().mockResolvedValue([]),
    } as any;

    await searchAztecDocs({ query: "test", chunks: 3, maxResults: 15 }, mockClient);
    expect(mockClient.search).toHaveBeenCalledWith("test", 3);
  });

  it("falls back to ripgrep when client errors and local docs exist", async () => {
    mockIsRepoCloned.mockReturnValue(true);
    const { searchDocs } = await import("../../src/utils/search.js");
    vi.mocked(searchDocs).mockReturnValue([
      { file: "docs/tutorial.md", line: 1, content: "tutorial content", repo: "aztec-packages-docs" },
    ]);

    const mockClient = {
      search: vi.fn().mockRejectedValue(new Error("network error")),
    } as any;

    const result = await searchAztecDocs({ query: "test" }, mockClient);
    expect(result.kind).toBe("ripgrep");
    expect(result.result.success).toBe(true);
    expect(result.result.results).toHaveLength(1);
  });

  it("returns ripgrep not-cloned message when client errors and no local docs", async () => {
    mockIsRepoCloned.mockReturnValue(false);

    const mockClient = {
      search: vi.fn().mockRejectedValue(new Error("network error")),
    } as any;

    const result = await searchAztecDocs({ query: "test" }, mockClient);
    expect(result.kind).toBe("ripgrep");
    expect(result.result.success).toBe(false);
    expect(result.result.message).toContain("aztec-packages-docs is not cloned");
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
