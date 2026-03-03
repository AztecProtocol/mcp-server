import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/utils/search.js", () => ({
  searchCode: vi.fn(),
  searchDocs: vi.fn(),
  listExamples: vi.fn(),
  findExample: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock("../../src/utils/git.js", () => ({
  isRepoCloned: vi.fn(),
}));

vi.mock("../../src/repos/config.js", () => ({
  getRepoNames: vi.fn(() => ["aztec-packages", "aztec-examples", "noir"]),
}));

import {
  searchCode,
  searchDocs,
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
const mockSearchDocs = vi.mocked(searchDocs);
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
  it("returns failure when aztec-packages-docs not cloned", () => {
    mockIsRepoCloned.mockReturnValue(false);
    const result = searchAztecDocs({ query: "tutorial" });
    expect(result.success).toBe(false);
    expect(result.message).toContain("aztec-packages-docs is not cloned");
  });

  it("delegates to searchDocs with correct options", () => {
    mockIsRepoCloned.mockReturnValue(true);
    mockSearchDocs.mockReturnValue([]);

    searchAztecDocs({ query: "tutorial", section: "concepts", maxResults: 5 });

    expect(mockSearchDocs).toHaveBeenCalledWith("tutorial", {
      section: "concepts",
      maxResults: 5,
    });
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
