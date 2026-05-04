import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing the module under test
vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("globby", () => ({
  globbySync: vi.fn(() => []),
}));

vi.mock("../../src/utils/git.js", () => ({
  REPOS_DIR: "/fake/repos",
  getRepoPath: vi.fn((name: string) => `/fake/repos/${name}`),
  isRepoCloned: vi.fn(() => false),
}));

import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import {
  parseSolidityErrors,
  parseTxValidationErrors,
  parseDebuggingDoc,
  parseOperatorFaq,
  lookupError,
  clearErrorCache,
  isUsefulCodeRef,
  isMinifiedShape,
} from "../../src/utils/error-lookup.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockExecFileSync = vi.mocked(execFileSync);

beforeEach(() => {
  vi.clearAllMocks();
  clearErrorCache();
  mockExistsSync.mockReturnValue(false);
});

// ---------------------------------------------------------------------------
// Parser tests
// ---------------------------------------------------------------------------

describe("parseSolidityErrors", () => {
  it("extracts error definitions with hex signatures", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      "error Rollup__InvalidProof(bytes32 expected, bytes32 actual); // 0xa5b2ba17\n" +
      "error Inbox__MsgTooLarge(uint256 size);\n" +
      "error Outbox__AlreadyConsumed(bytes32 msgHash); // 0xdeadbeef\n"
    );

    const entries = parseSolidityErrors("/fake/Errors.sol");

    expect(entries).toHaveLength(3);

    expect(entries[0].name).toBe("Rollup__InvalidProof");
    expect(entries[0].hexSignature).toBe("0xa5b2ba17");
    expect(entries[0].category).toBe("l1");
    expect(entries[0].patterns).toContain("rollup__invalidproof");
    expect(entries[0].patterns).toContain("0xa5b2ba17");

    expect(entries[1].name).toBe("Inbox__MsgTooLarge");
    expect(entries[1].hexSignature).toBeUndefined();

    expect(entries[2].hexSignature).toBe("0xdeadbeef");
  });

  it("returns empty array for missing file", () => {
    mockExistsSync.mockReturnValue(false);
    expect(parseSolidityErrors("/missing.sol")).toEqual([]);
  });
});

describe("parseTxValidationErrors", () => {
  it("extracts TX error constants with messages", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(`
// Gas and fees
export const TX_ERROR_INSUFFICIENT_FEE_PER_GAS = 'Insufficient fee per gas';
export const TX_ERROR_GAS_LIMIT_EXCEEDED = 'Gas limit exceeded';

// Nullifiers
export const TX_ERROR_DUPLICATE_NULLIFIER = 'Duplicate nullifier detected';
`);

    const entries = parseTxValidationErrors("/fake/error_texts.ts");

    expect(entries).toHaveLength(3);

    expect(entries[0].name).toBe("TX_ERROR_INSUFFICIENT_FEE_PER_GAS");
    expect(entries[0].category).toBe("tx-validation");
    expect(entries[0].patterns).toContain("insufficient fee per gas");
    expect(entries[0].fix).toMatch(/fee|gas/i);

    expect(entries[2].name).toBe("TX_ERROR_DUPLICATE_NULLIFIER");
    expect(entries[2].fix).toMatch(/nullifier/i);
  });

  it("returns empty array for missing file", () => {
    mockExistsSync.mockReturnValue(false);
    expect(parseTxValidationErrors("/missing.ts")).toEqual([]);
  });
});

describe("parseDebuggingDoc", () => {
  it("extracts error→solution table rows", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(`---
title: Debugging
---

## Contract Errors

| Error | Solution |
| --- | --- |
| \`Cannot find module\` | Run \`aztec-nargo compile\` first |
| Storage slot collision | Use unique storage slots for each variable |

## Other stuff
Some text here.
`);

    const entries = parseDebuggingDoc("/fake/debugging.md");

    expect(entries).toHaveLength(2);
    expect(entries[0].name).toBe("Cannot find module");
    expect(entries[0].fix).toContain("aztec-nargo compile");
    expect(entries[0].category).toBe("contract");

    expect(entries[1].name).toBe("Storage slot collision");
  });
});

describe("parseOperatorFaq", () => {
  it("extracts FAQ entries with symptom/cause/solution", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(`---
title: Operator FAQ
---

## Overview

Common operator issues.

## Node Sync Issues

### Node fails to sync
**Symptom**: Node is stuck at a specific block height
**Cause**: Peer connectivity issue
**Solution**: Restart the node and check firewall settings

### Database corruption
**Symptom**: Error reading from database
**Cause**: Unclean shutdown
**Solution**: Run database repair command
`);

    const entries = parseOperatorFaq("/fake/operator-faq.md");

    expect(entries).toHaveLength(2);

    expect(entries[0].name).toBe("Node fails to sync");
    expect(entries[0].cause).toBe("Peer connectivity issue");
    expect(entries[0].fix).toContain("Restart the node");
    expect(entries[0].category).toBe("operator");
    expect(entries[0].patterns).toContain("node is stuck at a specific block height");

    expect(entries[1].name).toBe("Database corruption");
  });
});

// ---------------------------------------------------------------------------
// Lookup algorithm tests
// ---------------------------------------------------------------------------

describe("lookupError", () => {
  it("matches circuit errors by numeric code", () => {
    const result = lookupError("2002");
    expect(result.catalogMatches.length).toBeGreaterThan(0);
    expect(result.catalogMatches[0].entry.id).toBe("circuit-2002");
    expect(result.catalogMatches[0].matchType).toBe("exact-code");
    expect(result.catalogMatches[0].score).toBe(100);
  });

  it("matches AVM errors by name", () => {
    const result = lookupError("OutOfGasError");
    expect(result.catalogMatches.length).toBeGreaterThan(0);
    expect(result.catalogMatches[0].entry.id).toBe("avm-out-of-gas");
  });

  it("matches by substring", () => {
    const result = lookupError("insufficient balance");
    expect(result.catalogMatches.length).toBeGreaterThan(0);
    const match = result.catalogMatches.find((m) => m.entry.id === "contract-insufficient-balance");
    expect(match).toBeDefined();
  });

  it("filters by category", () => {
    const result = lookupError("2002", { category: "avm" });
    // circuit-2002 is category "circuit", so it shouldn't match with "avm" filter
    const circuitMatch = result.catalogMatches.find((m) => m.entry.id === "circuit-2002");
    expect(circuitMatch).toBeUndefined();
  });

  it("respects maxResults", () => {
    const result = lookupError("error", { maxResults: 2 });
    expect(result.catalogMatches.length).toBeLessThanOrEqual(2);
  });

  it("matches dynamic Solidity errors by hex signature", () => {
    // Set up a mock Errors.sol file
    mockExistsSync.mockImplementation((p) => {
      return String(p).includes("Errors.sol");
    });
    mockReadFileSync.mockReturnValue(
      `error Rollup__InvalidProof(bytes32 expected, bytes32 actual); // 0xa5b2ba17\n`
    );

    clearErrorCache();
    const result = lookupError("0xa5b2ba17");
    expect(result.catalogMatches.length).toBeGreaterThan(0);
    const match = result.catalogMatches.find((m) => m.entry.hexSignature === "0xa5b2ba17");
    expect(match).toBeDefined();
    expect(match!.matchType).toBe("hex-signature");
  });

  it("matches dynamic TX validation errors", () => {
    mockExistsSync.mockImplementation((p) => {
      return String(p).includes("error_texts.ts");
    });
    mockReadFileSync.mockReturnValue(
      `export const TX_ERROR_INSUFFICIENT_FEE_PER_GAS = 'Insufficient fee per gas';\n`
    );

    clearErrorCache();
    const result = lookupError("insufficient fee");
    const match = result.catalogMatches.find((m) => m.entry.name === "TX_ERROR_INSUFFICIENT_FEE_PER_GAS");
    expect(match).toBeDefined();
  });

  it("returns code matches as fallback when few catalog matches", () => {
    // With no dynamic sources available, searching for something obscure
    // should still return a result object (code matches may be empty if rg fails)
    const result = lookupError("xyzzy_nonexistent_error_12345");
    expect(result).toHaveProperty("catalogMatches");
    expect(result).toHaveProperty("codeMatches");
    expect(result).toHaveProperty("query", "xyzzy_nonexistent_error_12345");
  });

  it("sorts results by score descending", () => {
    const result = lookupError("2002");
    for (let i = 1; i < result.catalogMatches.length; i++) {
      expect(result.catalogMatches[i - 1].score).toBeGreaterThanOrEqual(
        result.catalogMatches[i].score
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Code-reference filter — unit
// ---------------------------------------------------------------------------

describe("isUsefulCodeRef", () => {
  const ok = (file: string, content = "export const FOO = 1;") => ({
    file,
    content,
    repo: "aztec-packages",
    line: 1,
  });

  it("keeps a normal source line", () => {
    expect(isUsefulCodeRef(ok("yarn-project/foo.ts"))).toBe(true);
  });

  it("drops .test.ts files", () => {
    expect(isUsefulCodeRef(ok("yarn-project/foo.test.ts"))).toBe(false);
  });

  it("drops .spec.ts files", () => {
    expect(isUsefulCodeRef(ok("yarn-project/foo.spec.ts"))).toBe(false);
  });

  it("drops .e2e.ts files", () => {
    expect(isUsefulCodeRef(ok("yarn-project/foo.e2e.ts"))).toBe(false);
  });

  it("drops files inside __tests__ directories", () => {
    expect(isUsefulCodeRef(ok("yarn-project/__tests__/foo.ts"))).toBe(false);
  });

  it("drops files inside /test/ and /tests/ directories", () => {
    expect(isUsefulCodeRef(ok("yarn-project/test/foo.ts"))).toBe(false);
    expect(isUsefulCodeRef(ok("yarn-project/tests/foo.ts"))).toBe(false);
  });

  it("drops files inside /e2e/ and /fixtures/ and /mocks/", () => {
    expect(isUsefulCodeRef(ok("yarn-project/e2e/foo.ts"))).toBe(false);
    expect(isUsefulCodeRef(ok("yarn-project/fixtures/foo.ts"))).toBe(false);
    expect(isUsefulCodeRef(ok("yarn-project/mocks/foo.ts"))).toBe(false);
  });

  it("does NOT drop on incidental substrings (latest, contest, attestations, testdata)", () => {
    // The dir regex is segment-bounded — these are real source dirs
    // that incidentally contain ``test``/``latest``/``contest`` as
    // substrings, NOT as full path segments. They must survive.
    expect(isUsefulCodeRef(ok("yarn-project/latest/foo.ts"))).toBe(true);
    expect(isUsefulCodeRef(ok("yarn-project/contest/foo.ts"))).toBe(true);
    expect(isUsefulCodeRef(ok("yarn-project/attestations/foo.ts"))).toBe(true);
    expect(isUsefulCodeRef(ok("yarn-project/testdata/foo.ts"))).toBe(true);
  });

  it("drops paths that begin with a test segment (no leading slash)", () => {
    // Ripgrep returns relative-from-REPOS_DIR paths, but a relative
    // path could in theory start with a test segment if the repo
    // itself is named ``tests`` or similar. The leading-boundary in
    // TEST_DIR_RE handles this; locking it in here.
    expect(isUsefulCodeRef(ok("tests/foo.ts"))).toBe(false);
    expect(isUsefulCodeRef(ok("__tests__/foo.ts"))).toBe(false);
  });

  it("drops minified-shape lines (long pure-hex run)", () => {
    // 600 chars of hex — clearly bytecode.
    const hex = "deadbeef".repeat(75);
    expect(isUsefulCodeRef(ok("yarn-project/foo.ts", hex))).toBe(false);
  });

  it("keeps long regex literals (no continuous hex run)", () => {
    // A regex literal that's long but not hex-shaped.
    const line =
      "const re = /[A-Za-z0-9_]{200}.*([gimsuy]|[A-Z]+){50}/.test(input);";
    expect(isUsefulCodeRef(ok("yarn-project/foo.ts", line))).toBe(true);
  });

  it("keeps short lines that contain hex literals", () => {
    const line = "const sig = 0xdeadbeefcafebabe; // selector";
    expect(isUsefulCodeRef(ok("yarn-project/foo.ts", line))).toBe(true);
  });
});

describe("isMinifiedShape", () => {
  it("returns false for short content", () => {
    expect(isMinifiedShape("a".repeat(399))).toBe(false);
  });

  it("returns true only when a 200+ char hex run is present", () => {
    const hex = "deadbeef".repeat(25); // 200 chars of hex
    const padded = "x".repeat(200) + hex;
    expect(padded.length).toBeGreaterThanOrEqual(400);
    expect(isMinifiedShape(padded)).toBe(true);
  });

  it("returns false when long but no contiguous hex run", () => {
    // 500 chars of mixed alphanumeric, but no 200+ hex run.
    const line = ("aZ0_".repeat(125)).slice(0, 500);
    expect(isMinifiedShape(line)).toBe(false);
  });

  it("returns false for a long generated-looking source line without hex blob", () => {
    // Realistic noisy generated TypeScript: long but full of identifiers,
    // commas, brackets — semantic content a human can still navigate.
    // No 200-char contiguous hex run, so the heuristic must keep it.
    const line =
      "export const TX_ERROR_CODES = { " +
      Array.from({ length: 60 }, (_, i) => `ERR_${i}: 'message ${i}'`).join(", ") +
      " };";
    expect(line.length).toBeGreaterThan(400);
    expect(isMinifiedShape(line)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Code-reference filter — integration via lookupError
// ---------------------------------------------------------------------------

describe("lookupError code-ref over-fetch + filter + cap", () => {
  beforeEach(() => {
    // searchCode (called from lookupError) checks existsSync and shells
    // out to ripgrep via execFileSync — the integration test pipes a
    // synthetic rg stdout through the parser.
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockReset();
  });

  it("survives a top-of-result-set full of tests/minified — keeps deeper real refs", () => {
    // Build a synthetic ripgrep stdout: 5 test files + 1 minified line +
    // 2 real source lines. Pre-filter slice to 5 (the old behaviour)
    // would have produced ZERO useful refs; over-fetch (RAW_CODE_LIMIT
    // = 20) plus filter must surface the two real ones.
    const minified = "deadbeef".repeat(75); // 600 hex chars
    const lines = [
      "/fake/repos/aztec-packages/yarn-project/foo.test.ts:1:test 1",
      "/fake/repos/aztec-packages/yarn-project/__tests__/bar.ts:2:test 2",
      "/fake/repos/aztec-packages/yarn-project/baz.spec.ts:3:test 3",
      "/fake/repos/aztec-packages/yarn-project/qux.e2e.ts:4:test 4",
      "/fake/repos/aztec-packages/yarn-project/mocks/zap.ts:5:test 5",
      `/fake/repos/aztec-packages/yarn-project/abi.ts:6:${minified}`,
      "/fake/repos/aztec-packages/yarn-project/real-one.ts:7:export const REAL = 1;",
      "/fake/repos/aztec-packages/yarn-project/real-two.ts:8:export function realTwo() {}",
    ].join("\n");
    mockExecFileSync.mockReturnValue(lines);

    // Use a query that won't strongly hit the static catalog so the
    // fallback (codeMatches) path is taken.
    const result = lookupError("xyzzy_unknown_query_for_test_only");

    expect(result.codeMatches).toHaveLength(2);
    expect(result.codeMatches.map((m) => m.file)).toEqual([
      "aztec-packages/yarn-project/real-one.ts",
      "aztec-packages/yarn-project/real-two.ts",
    ]);

    // Lock in the over-fetch contract: the raw cap must be wide enough
    // for the filter to have headroom. searchCode passes
    // ``String(maxResults * 2)`` to rg via -m, so RAW_CODE_LIMIT (20)
    // surfaces as ``-m 40`` on the wire.
    const calls = mockExecFileSync.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const args = calls[calls.length - 1][1] as string[];
    const mIdx = args.indexOf("-m");
    expect(mIdx).toBeGreaterThanOrEqual(0);
    expect(args[mIdx + 1]).toBe("40");
  });

  it("caps to 2 even when many useful refs are returned", () => {
    const lines = Array.from({ length: 10 }, (_, i) =>
      `/fake/repos/aztec-packages/yarn-project/foo${i}.ts:${i}:export const F${i} = ${i};`,
    ).join("\n");
    mockExecFileSync.mockReturnValue(lines);

    const result = lookupError("xyzzy_unknown_query_for_test_only_2");

    expect(result.codeMatches).toHaveLength(2);
  });
});
