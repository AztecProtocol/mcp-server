import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing the module under test
vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
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

import { execFileSync } from "child_process";
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
  getResultPriority,
} from "../../src/utils/search.js";

const mockExecFileSync = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockGlobbySync = vi.mocked(globbySync);
const mockGetRepoPath = vi.mocked(getRepoPath);

// Helper: pull the argv array from the most recent execFileSync call.
function lastRgArgs(): string[] {
  const calls = mockExecFileSync.mock.calls;
  if (calls.length === 0) throw new Error("execFileSync was not called");
  return calls[calls.length - 1][1] as string[];
}

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
      mockExecFileSync.mockReturnValue(
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
      mockExecFileSync.mockReturnValue(
        "/fake/repos/r/a.nr:1:line1\n" +
          "/fake/repos/r/b.nr:2:line2\n" +
          "/fake/repos/r/c.nr:3:line3\n"
      );

      const results = searchCode("test", { maxResults: 2 });
      expect(results).toHaveLength(2);
    });

    it("passes -i flag for case-insensitive search", () => {
      mockExistsSync.mockReturnValue(true);
      mockExecFileSync.mockReturnValue("");

      searchCode("test", { caseSensitive: false });

      expect(lastRgArgs()).toContain("-i");
    });

    it("does not pass -i flag when caseSensitive is true", () => {
      mockExistsSync.mockReturnValue(true);
      mockExecFileSync.mockReturnValue("");

      searchCode("test", { caseSensitive: true });

      expect(lastRgArgs()).not.toContain("-i");
    });

    it("invokes rg with execFileSync (no shell), not the shell-string form", () => {
      mockExistsSync.mockReturnValue(true);
      mockExecFileSync.mockReturnValue("");

      searchCode("transfer");

      const calls = mockExecFileSync.mock.calls;
      expect(calls).toHaveLength(1);
      // Command is the literal "rg", argv comes through as the array.
      expect(calls[0][0]).toBe("rg");
      expect(Array.isArray(calls[0][1])).toBe(true);
    });

    // Regression guards — these are the bug we're actually fixing.
    it("passes a single-extension glob as one argv element", () => {
      mockExistsSync.mockReturnValue(true);
      mockExecFileSync.mockReturnValue("");

      searchCode("foo", { filePattern: "*.nr" });

      const args = lastRgArgs();
      expect(args).toContain("*.nr");
      // The pattern must follow ``-g`` directly — not be split, not be
      // interpolated into another arg.
      const gIdx = args.indexOf("-g");
      expect(gIdx).toBeGreaterThanOrEqual(0);
      expect(args[gIdx + 1]).toBe("*.nr");
    });

    it("passes a brace-alternation glob as one argv element (#6)", () => {
      mockExistsSync.mockReturnValue(true);
      mockExecFileSync.mockReturnValue("");

      // The historical bug: ``*.{nr,ts}`` got brace-expanded by /bin/sh
      // before rg ever saw it, mangling the args. Here we assert it
      // arrives at rg as a single token.
      searchCode("foo", { filePattern: "*.{nr,ts}" });

      const args = lastRgArgs();
      const gIdx = args.indexOf("-g");
      expect(args[gIdx + 1]).toBe("*.{nr,ts}");
      // And not split somewhere in the argv either.
      expect(args).not.toContain("*.nr");
      expect(args).not.toContain("*.ts");
    });

    it("passes the query via -e so a flag-shaped query isn't reparsed", () => {
      mockExistsSync.mockReturnValue(true);
      mockExecFileSync.mockReturnValue("");

      // Query starts with `-` — without `-e`, rg would treat it as a flag.
      searchCode("-g");

      const args = lastRgArgs();
      const eIdx = args.indexOf("-e");
      expect(eIdx).toBeGreaterThanOrEqual(0);
      expect(args[eIdx + 1]).toBe("-g");
      // And the search path is positional after ``--``.
      const dashIdx = args.indexOf("--");
      expect(dashIdx).toBeGreaterThan(eIdx);
      expect(args[dashIdx + 1]).toBeDefined();
    });

    it("preserves regex syntax in the query verbatim (no shell escaping)", () => {
      mockExistsSync.mockReturnValue(true);
      mockExecFileSync.mockReturnValue("");

      searchCode("foo|bar.*baz+");

      const args = lastRgArgs();
      // Without a shell layer, regex chars don't need escaping. They
      // arrive at rg exactly as the caller wrote them.
      expect(args).toContain("foo|bar.*baz+");
    });
  });

  describe("manual fallback", () => {
    it("activates when execFileSync throws", () => {
      mockExistsSync.mockReturnValue(true);
      mockExecFileSync.mockImplementation(() => {
        throw new Error("rg not found");
      });
      mockGlobbySync.mockReturnValue([]);

      const results = searchCode("test");
      expect(results).toEqual([]);
      expect(mockGlobbySync).toHaveBeenCalled();
    });

    it("uses globby to find and search files", () => {
      mockExistsSync.mockReturnValue(true);
      mockExecFileSync.mockImplementation(() => {
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
      mockExecFileSync.mockImplementation(() => {
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
      mockExecFileSync.mockImplementation(() => {
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

    it("passes a brace-alternation glob through to globby unchanged", () => {
      // The manual fallback uses globby (micromatch under the hood),
      // which supports brace expansion natively. Locks in that the
      // pattern transformation (``*.{nr,ts}`` -> ``**/*.{nr,ts}``)
      // doesn't accidentally split or escape the braces.
      mockExistsSync.mockReturnValue(true);
      mockExecFileSync.mockImplementation(() => {
        throw new Error("rg not found");
      });
      mockGlobbySync.mockReturnValue([]);

      searchCode("foo", { filePattern: "*.{nr,ts}" });

      expect(mockGlobbySync).toHaveBeenCalledWith(
        "**/*.{nr,ts}",
        expect.any(Object),
      );
    });
  });
});

describe("searchDocs", () => {
  beforeEach(() => {
    mockGetRepoPath.mockImplementation((name: string) => `/fake/repos/${name}`);
  });

  it("delegates to searchCode with *.{md,mdx} pattern as a single argv element", () => {
    // Sibling regression case for #6: searchDocs uses a brace pattern
    // and was silently broken on the same shell-mangling axis.
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockReturnValue("");

    searchDocs("tutorial");

    const args = lastRgArgs();
    const gIdx = args.indexOf("-g");
    expect(args[gIdx + 1]).toBe("*.{md,mdx}");
  });

  it("narrows path when section exists", () => {
    mockExistsSync.mockReturnValue(true);
    mockGlobbySync.mockReturnValue(["version-v1.0.0"] as any);
    mockExecFileSync.mockReturnValue("");

    searchDocs("tutorial", { section: "tutorials" });

    const args = lastRgArgs();
    expect(args).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "aztec-packages-docs/docs/developer_versioned_docs/version-v1.0.0/tutorials",
        ),
      ]),
    );
  });

  it("falls back to aztec-packages-docs when section doesn't exist", () => {
    // existsSync: first call for section path returns false, second for search path returns true
    mockExistsSync
      .mockReturnValueOnce(false) // section path doesn't exist
      .mockReturnValueOnce(true); // search path exists
    mockExecFileSync.mockReturnValue("");

    searchDocs("tutorial", { section: "nonexistent" });

    const args = lastRgArgs();
    expect(args).toEqual(
      expect.arrayContaining([expect.stringContaining("/fake/repos/aztec-packages-docs")]),
    );
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

describe("getResultPriority", () => {
  it("ranks aztec-nr / yarn-project as highest priority (1)", () => {
    expect(getResultPriority({ repo: "aztec-packages", file: "aztec-packages/yarn-project/aztec.js/src/main.ts", content: "", line: 1 })).toBe(1);
    expect(getResultPriority({ repo: "aztec-packages", file: "aztec-packages/aztec-nr/aztec/src/lib.nr", content: "", line: 1 })).toBe(1);
  });

  it("ranks noir-contracts as priority 2", () => {
    expect(getResultPriority({ repo: "aztec-packages", file: "aztec-packages/noir-projects/noir-contracts/token/src/main.nr", content: "", line: 1 })).toBe(2);
  });

  it("ranks noir_stdlib as priority 3", () => {
    expect(getResultPriority({ repo: "noir", file: "noir/noir_stdlib/src/hash.nr", content: "", line: 1 })).toBe(3);
  });

  it("ranks other aztec-packages and noir paths as priority 4", () => {
    expect(getResultPriority({ repo: "aztec-packages", file: "aztec-packages/boxes/token/src/main.nr", content: "", line: 1 })).toBe(4);
    expect(getResultPriority({ repo: "noir", file: "noir/tooling/nargo/src/lib.rs", content: "", line: 1 })).toBe(4);
  });

  it("ranks example repos as lowest priority (5)", () => {
    expect(getResultPriority({ repo: "aztec-examples", file: "aztec-examples/token/src/main.nr", content: "", line: 1 })).toBe(5);
    expect(getResultPriority({ repo: "aztec-starter", file: "aztec-starter/src/main.nr", content: "", line: 1 })).toBe(5);
    expect(getResultPriority({ repo: "gregoswap", file: "gregoswap/src/main.nr", content: "", line: 1 })).toBe(5);
  });
});

describe("search result sorting", () => {
  it("sorts ripgrep results by source priority", () => {
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockReturnValue(
      "/fake/repos/gregoswap/src/main.nr:1:fn transfer() {\n" +
      "/fake/repos/aztec-packages/yarn-project/aztec.js/src/main.ts:5:fn transfer() {\n" +
      "/fake/repos/aztec-examples/token/src/main.nr:3:fn transfer() {\n" +
      "/fake/repos/aztec-packages/noir-projects/noir-contracts/token/src/main.nr:10:fn transfer() {\n" +
      "/fake/repos/noir/noir_stdlib/src/hash.nr:7:fn transfer() {\n"
    );

    const results = searchCode("transfer");
    expect(results[0].repo).toBe("aztec-packages");
    expect(results[0].file).toContain("yarn-project");
    expect(results[1].repo).toBe("aztec-packages");
    expect(results[1].file).toContain("noir-contracts");
    expect(results[2].repo).toBe("noir");
    expect(results[2].file).toContain("noir_stdlib");
    expect(results[3].repo).toBe("gregoswap");
    expect(results[4].repo).toBe("aztec-examples");
  });

  it("sorts manual search results by source priority", () => {
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockImplementation(() => { throw new Error("rg not found"); });
    mockGlobbySync.mockReturnValue([
      "/fake/repos/aztec-starter/src/main.nr",
      "/fake/repos/aztec-packages/yarn-project/aztec.js/src/lib.nr",
    ]);
    mockReadFileSync
      .mockReturnValueOnce("fn transfer() {" as any)
      .mockReturnValueOnce("fn transfer() {" as any);

    const results = searchCode("transfer");
    expect(results).toHaveLength(2);
    expect(results[0].repo).toBe("aztec-packages");
    expect(results[1].repo).toBe("aztec-starter");
  });

  it("applies sorting before maxResults limit", () => {
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockReturnValue(
      "/fake/repos/gregoswap/src/a.nr:1:match\n" +
      "/fake/repos/aztec-examples/src/b.nr:2:match\n" +
      "/fake/repos/aztec-packages/yarn-project/c.nr:3:match\n"
    );

    const results = searchCode("match", { maxResults: 2 });
    expect(results).toHaveLength(2);
    // SDK result should be kept even though it appeared last in raw output
    expect(results[0].repo).toBe("aztec-packages");
  });
});
