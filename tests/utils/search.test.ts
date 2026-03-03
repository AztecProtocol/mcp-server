import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing the module under test
vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock("globby", () => ({
  globbySync: vi.fn(),
}));

vi.mock("../../src/utils/git.js", () => ({
  REPOS_DIR: "/fake/repos",
  getRepoPath: vi.fn((name: string) => `/fake/repos/${name}`),
}));

import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { globbySync } from "globby";
import { getRepoPath } from "../../src/utils/git.js";
import {
  searchCode,
  searchDocs,
  listExamples,
  readFile,
  findExample,
  getFileType,
} from "../../src/utils/search.js";

const mockExecSync = vi.mocked(execSync);
const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockGlobbySync = vi.mocked(globbySync);
const mockGetRepoPath = vi.mocked(getRepoPath);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetRepoPath.mockImplementation((name: string) => `/fake/repos/${name}`);
});

describe("getFileType", () => {
  it('returns "contract" for .nr files', () => {
    expect(getFileType("src/main.nr")).toBe("contract");
  });

  it('returns "test" for .nr files with "test" in path', () => {
    expect(getFileType("tests/test_token.nr")).toBe("test");
    expect(getFileType("src/test/main.nr")).toBe("test");
  });

  it('returns "typescript" for .ts and .tsx files', () => {
    expect(getFileType("index.ts")).toBe("typescript");
    expect(getFileType("component.tsx")).toBe("typescript");
  });

  it('returns "docs" for .md and .mdx files', () => {
    expect(getFileType("README.md")).toBe("docs");
    expect(getFileType("guide.mdx")).toBe("docs");
  });

  it('returns "other" for .json, .toml, and no extension', () => {
    expect(getFileType("config.json")).toBe("other");
    expect(getFileType("Nargo.toml")).toBe("other");
    expect(getFileType("Makefile")).toBe("other");
  });
});

describe("searchCode", () => {
  it("returns [] when searchPath doesn't exist", () => {
    mockExistsSync.mockReturnValue(false);
    const results = searchCode("test");
    expect(results).toEqual([]);
  });

  describe("ripgrep path", () => {
    it("parses rg output correctly", () => {
      mockExistsSync.mockReturnValue(true);
      mockExecSync.mockReturnValue(
        "/fake/repos/aztec-packages/src/main.nr:10:fn main() {\n" +
          "/fake/repos/aztec-packages/src/lib.nr:20:use dep::aztec;\n"
      );

      const results = searchCode("main");
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({
        file: "aztec-packages/src/main.nr",
        line: 10,
        content: "fn main() {",
        repo: "aztec-packages",
      });
      expect(results[1]).toEqual({
        file: "aztec-packages/src/lib.nr",
        line: 20,
        content: "use dep::aztec;",
        repo: "aztec-packages",
      });
    });

    it("respects maxResults", () => {
      mockExistsSync.mockReturnValue(true);
      mockExecSync.mockReturnValue(
        "/fake/repos/r/a.nr:1:line1\n" +
          "/fake/repos/r/b.nr:2:line2\n" +
          "/fake/repos/r/c.nr:3:line3\n"
      );

      const results = searchCode("test", { maxResults: 2 });
      expect(results).toHaveLength(2);
    });

    it("passes -i flag for case-insensitive search", () => {
      mockExistsSync.mockReturnValue(true);
      mockExecSync.mockReturnValue("");

      searchCode("test", { caseSensitive: false });

      const call = mockExecSync.mock.calls[0][0] as string;
      expect(call).toContain("-i");
    });

    it("does not pass -i flag when caseSensitive is true", () => {
      mockExistsSync.mockReturnValue(true);
      mockExecSync.mockReturnValue("");

      searchCode("test", { caseSensitive: true });

      const call = mockExecSync.mock.calls[0][0] as string;
      // The -i flag should not appear in the rg flags
      // The call format is: rg <flags> "<query>" "<path>"
      const flagsPart = call.split('"')[0];
      expect(flagsPart).not.toContain("-i");
    });

    it("escapes shell-dangerous chars while preserving regex chars", () => {
      mockExistsSync.mockReturnValue(true);
      mockExecSync.mockReturnValue("");

      // Regex chars like |, *, + should be preserved
      searchCode("foo|bar.*baz+");
      let call = mockExecSync.mock.calls[0][0] as string;
      expect(call).toContain("foo|bar.*baz+");

      // Shell-dangerous chars should be escaped
      mockExecSync.mockClear();
      searchCode('test"$`\\!');
      call = mockExecSync.mock.calls[0][0] as string;
      expect(call).toContain('\\"');
      expect(call).toContain("\\$");
      expect(call).toContain("\\`");
      expect(call).toContain("\\\\");
      expect(call).toContain("\\!");
    });
  });

  describe("manual fallback", () => {
    it("activates when execSync throws", () => {
      mockExistsSync.mockReturnValue(true);
      mockExecSync.mockImplementation(() => {
        throw new Error("rg not found");
      });
      mockGlobbySync.mockReturnValue([]);

      const results = searchCode("test");
      expect(results).toEqual([]);
      expect(mockGlobbySync).toHaveBeenCalled();
    });

    it("uses globby to find and search files", () => {
      mockExistsSync.mockReturnValue(true);
      mockExecSync.mockImplementation(() => {
        throw new Error("rg not found");
      });
      mockGlobbySync.mockReturnValue(["/fake/repos/myrepo/src/main.nr"]);
      mockReadFileSync.mockReturnValue("line1\nfn test_func() {\nline3" as any);

      const results = searchCode("test_func");
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe("fn test_func() {");
      expect(results[0].line).toBe(2);
    });

    it("handles invalid regex by escaping to literal", () => {
      mockExistsSync.mockReturnValue(true);
      mockExecSync.mockImplementation(() => {
        throw new Error("rg not found");
      });
      mockGlobbySync.mockReturnValue(["/fake/repos/myrepo/src/main.nr"]);
      mockReadFileSync.mockReturnValue("line with [invalid regex" as any);

      // "[invalid regex" is invalid regex - should be escaped to literal
      const results = searchCode("[invalid regex");
      expect(results).toHaveLength(1);
    });

    it("skips unreadable files", () => {
      mockExistsSync.mockReturnValue(true);
      mockExecSync.mockImplementation(() => {
        throw new Error("rg not found");
      });
      mockGlobbySync.mockReturnValue([
        "/fake/repos/myrepo/a.nr",
        "/fake/repos/myrepo/b.nr",
      ]);
      mockReadFileSync
        .mockImplementationOnce(() => {
          throw new Error("EACCES");
        })
        .mockReturnValueOnce("fn test() {" as any);

      const results = searchCode("test");
      expect(results).toHaveLength(1);
      expect(results[0].file).toBe("myrepo/b.nr");
    });
  });
});

describe("searchDocs", () => {
  beforeEach(() => {
    mockGetRepoPath.mockImplementation((name: string) => `/fake/repos/${name}`);
  });

  it("delegates to searchCode with *.{md,mdx} pattern", () => {
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockReturnValue("");

    searchDocs("tutorial");

    const call = mockExecSync.mock.calls[0][0] as string;
    expect(call).toContain("*.{md,mdx}");
  });

  it("narrows path when section exists", () => {
    mockExistsSync.mockReturnValue(true);
    mockGlobbySync.mockReturnValue(["version-v1.0.0"] as any);
    mockExecSync.mockReturnValue("");

    searchDocs("tutorial", { section: "tutorials" });

    const call = mockExecSync.mock.calls[0][0] as string;
    expect(call).toContain("aztec-packages-docs/docs/developer_versioned_docs/version-v1.0.0/tutorials");
  });

  it("falls back to aztec-packages-docs when section doesn't exist", () => {
    // existsSync: first call for section path returns false, second for search path returns true
    mockExistsSync
      .mockReturnValueOnce(false) // section path doesn't exist
      .mockReturnValueOnce(true); // search path exists
    mockExecSync.mockReturnValue("");

    searchDocs("tutorial", { section: "nonexistent" });

    const call = mockExecSync.mock.calls[0][0] as string;
    // Should search in aztec-packages-docs, not the nonexistent section
    expect(call).toContain("/fake/repos/aztec-packages-docs");
  });
});

describe("listExamples", () => {
  beforeEach(() => {
    mockGetRepoPath.mockImplementation((name: string) => `/fake/repos/${name}`);
  });

  it("finds contracts in both aztec-examples and aztec-packages/noir-contracts", () => {
    mockExistsSync.mockReturnValue(true);
    mockGlobbySync
      .mockReturnValueOnce(["/fake/repos/aztec-examples/token/src/main.nr"])
      .mockReturnValueOnce([
        "/fake/repos/aztec-packages/noir-projects/noir-contracts/escrow/src/main.nr",
      ]);

    const results = listExamples();
    expect(results).toHaveLength(2);
    expect(results[0].repo).toBe("aztec-examples");
    expect(results[1].repo).toBe("aztec-packages");
  });

  it("filters by category (case-insensitive)", () => {
    mockExistsSync.mockReturnValue(true);
    mockGlobbySync
      .mockReturnValueOnce(["/fake/repos/aztec-examples/token/src/main.nr"])
      .mockReturnValueOnce([
        "/fake/repos/aztec-packages/noir-projects/noir-contracts/escrow/src/main.nr",
      ]);

    const results = listExamples("TOKEN");
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("token");
  });

  it("returns empty when repo paths don't exist", () => {
    mockExistsSync.mockReturnValue(false);
    const results = listExamples();
    expect(results).toEqual([]);
  });
});

describe("readFile", () => {
  it("reads absolute paths directly", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("file content" as any);

    const result = readFile("/absolute/path/file.nr");
    expect(result).toBe("file content");
    expect(mockReadFileSync).toHaveBeenCalledWith("/absolute/path/file.nr", "utf-8");
  });

  it("prepends REPOS_DIR for relative paths", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("file content" as any);

    const result = readFile("aztec-packages/src/main.nr");
    expect(result).toBe("file content");
    expect(mockReadFileSync).toHaveBeenCalledWith(
      "/fake/repos/aztec-packages/src/main.nr",
      "utf-8"
    );
  });

  it("returns null when file doesn't exist", () => {
    mockExistsSync.mockReturnValue(false);
    const result = readFile("nonexistent.nr");
    expect(result).toBeNull();
  });

  it("returns null when read throws", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => {
      throw new Error("EACCES");
    });

    const result = readFile("some/file.nr");
    expect(result).toBeNull();
  });
});

describe("findExample", () => {
  beforeEach(() => {
    mockGetRepoPath.mockImplementation((name: string) => `/fake/repos/${name}`);
  });

  it("exact name match takes priority over partial match", () => {
    mockExistsSync.mockReturnValue(true);
    mockGlobbySync
      .mockReturnValueOnce([
        "/fake/repos/aztec-examples/token/src/main.nr",
        "/fake/repos/aztec-examples/token_bridge/src/main.nr",
      ])
      .mockReturnValueOnce([]);

    const result = findExample("token");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("token");
  });

  it("returns null when no match", () => {
    mockExistsSync.mockReturnValue(true);
    mockGlobbySync.mockReturnValue([]);

    const result = findExample("nonexistent");
    expect(result).toBeNull();
  });
});
