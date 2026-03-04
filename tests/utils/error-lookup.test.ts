import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing the module under test
vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

vi.mock("globby", () => ({
  globbySync: vi.fn(() => []),
}));

vi.mock("../../src/utils/git.js", () => ({
  REPOS_DIR: "/fake/repos",
  getRepoPath: vi.fn((name: string) => `/fake/repos/${name}`),
  isRepoCloned: vi.fn(() => false),
}));

import { existsSync, readFileSync } from "fs";
import {
  parseSolidityErrors,
  parseTxValidationErrors,
  parseDebuggingDoc,
  parseOperatorFaq,
  lookupError,
  clearErrorCache,
} from "../../src/utils/error-lookup.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

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
