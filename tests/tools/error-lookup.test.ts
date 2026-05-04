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

/**
 * Helper for building catalog match objects with a configurable score.
 * Lets a test simulate the various confidence bands from
 * ``utils/error-lookup.ts``: exact-code/hex (100), exact-pattern (95),
 * substring (70-80), word-overlap (50-65).
 */
function catalogHit(score: number, name = "MatchingError", matchType: any = "substring") {
  return {
    entry: {
      id: name.toLowerCase(),
      name,
      patterns: [name.toLowerCase()],
      cause: "c",
      fix: "f",
      category: "contract" as const,
      source: "s",
    },
    matchType,
    score,
  };
}

describe("lookupAztecError — static catalog hits", () => {
  it("returns immediately with semanticHealth='skipped' when catalog matches", async () => {
    mockLookupError.mockReturnValue({
      query: "boom",
      catalogMatches: [catalogHit(100, "BoomError", "exact-name")],
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

  it("short-circuits at the threshold boundary (score === 70)", async () => {
    mockLookupError.mockReturnValue({
      query: "boundary",
      catalogMatches: [catalogHit(70, "EdgeMatch", "substring")],
      codeMatches: [],
    });
    const client = makeClient({ search: vi.fn() });
    const result = await lookupAztecError({ query: "boundary" }, client);
    expect(result.semanticHealth).toBe("skipped");
    expect(client.search).not.toHaveBeenCalled();
  });

  it("short-circuits when there's only a codeMatch (ripgrep over cloned source)", async () => {
    mockLookupError.mockReturnValue({
      query: "RpgRet",
      catalogMatches: [],
      codeMatches: [
        { file: "f.sol", line: 1, content: "x", repo: "aztec-packages" },
      ],
    });
    const client = makeClient({ search: vi.fn() });
    const result = await lookupAztecError({ query: "RpgRet" }, client);
    expect(result.semanticHealth).toBe("skipped");
    expect(client.search).not.toHaveBeenCalled();
  });
});

describe("lookupAztecError — weak fuzzy matches DO NOT suppress semantic fallback", () => {
  /**
   * Regression for the "note already nullified" → "Contract already
   * initialized" misfire reported in the v1.20.0 dogfood test. The
   * Jaccard word-overlap matcher returned a score-54 hit on an
   * unrelated catalog entry, and the early-return in lookupAztecError
   * suppressed the semantic-documentation fallback that would have
   * returned the actually-relevant chunks.
   */
  it("falls through to semantic when catalog has only word-overlap hits (score < 70)", async () => {
    mockLookupError.mockReturnValue({
      query: "note already nullified",
      catalogMatches: [
        catalogHit(54, "Contract already initialized", "word-overlap"),
      ],
      codeMatches: [],
    });

    const client = makeClient({
      search: vi.fn().mockResolvedValue([
        { text: "Notes are nullified by...", title: "Note Lifecycle", source: "docs/notes.md" },
      ]),
    });

    const result = await lookupAztecError({ query: "note already nullified" }, client);
    expect(result.semanticHealth).toBe("ok");
    expect(result.semanticResults).toHaveLength(1);
    expect(client.search).toHaveBeenCalledWith("Aztec error: note already nullified", 3);
    // The weak hint stays in the result so the formatter can still render
    // it as a low-confidence cue — it just no longer shadows the semantic answer.
    expect(result.result.catalogMatches).toHaveLength(1);
    expect(result.result.catalogMatches[0].score).toBe(54);
    // Message acknowledges the weak hint instead of pretending nothing matched.
    expect(result.message).toContain("low-confidence");
  });

  it("does not suppress semantic fallback for a mix of weak hints (max score 65)", async () => {
    mockLookupError.mockReturnValue({
      query: "x",
      catalogMatches: [
        catalogHit(65, "WeakA", "word-overlap"),
        catalogHit(50, "WeakB", "word-overlap"),
      ],
      codeMatches: [],
    });
    const client = makeClient({
      search: vi.fn().mockResolvedValue([
        { text: "doc", title: "T", source: "S" },
      ]),
    });
    const result = await lookupAztecError({ query: "x" }, client);
    expect(result.semanticHealth).toBe("ok");
    expect(client.search).toHaveBeenCalled();
  });

  it("with no client and only weak catalog hints, returns 'skipped' but message names the weak-hint situation", async () => {
    mockLookupError.mockReturnValue({
      query: "x",
      catalogMatches: [catalogHit(54, "Weak", "word-overlap")],
      codeMatches: [],
    });
    const result = await lookupAztecError({ query: "x" }, null);
    expect(result.semanticHealth).toBe("skipped");
    expect(result.message).toContain("low-confidence");
    expect(result.message).toContain("API_KEY");
  });

  it("with weak hints and semantic returning empty, message acknowledges both signals", async () => {
    mockLookupError.mockReturnValue({
      query: "x",
      catalogMatches: [catalogHit(54, "Weak", "word-overlap")],
      codeMatches: [],
    });
    const client = makeClient({ search: vi.fn().mockResolvedValue([]) });
    const result = await lookupAztecError({ query: "x" }, client);
    expect(result.semanticHealth).toBe("no_results");
    expect(result.message).toContain("low-confidence");
    expect(result.message).toMatch(/no relevant documentation|Semantic search/i);
  });

  it("weak-only + version-mismatch: gate blocks semantic, weak hint preserved, message names mismatch", async () => {
    mockGetRepoTag.mockResolvedValue("v4.1.0");
    mockLookupError.mockReturnValue({
      query: "x",
      catalogMatches: [catalogHit(54, "Weak", "word-overlap")],
      codeMatches: [],
    });
    const client = makeClient({
      search: vi.fn().mockResolvedValue([{ text: "doc", title: "T", source: "S" }]),
      getCorpusVersion: vi.fn().mockResolvedValue({ aztec_corpus_version: "v4.2.0" }),
    });
    const result = await lookupAztecError({ query: "x" }, client);
    expect(result.semanticHealth).toBe("version_mismatch");
    expect(client.search).not.toHaveBeenCalled();
    // Weak hint preserved so the formatter can still render it
    expect(result.result.catalogMatches).toHaveLength(1);
    // Message names BOTH the weak-hint situation AND the version mismatch
    expect(result.message).toContain("low-confidence");
    expect(result.message).toContain("v4.1.0");
    expect(result.message).toContain("v4.2.0");
  });

  it("weak-only + allowVersionMismatch=true: gate skipped, semantic runs", async () => {
    mockGetRepoTag.mockResolvedValue("v4.1.0");
    mockLookupError.mockReturnValue({
      query: "x",
      catalogMatches: [catalogHit(54, "Weak", "word-overlap")],
      codeMatches: [],
    });
    const client = makeClient({
      search: vi.fn().mockResolvedValue([{ text: "doc", title: "T", source: "S" }]),
      getCorpusVersion: vi.fn().mockResolvedValue({ aztec_corpus_version: "v4.2.0" }),
    });
    const result = await lookupAztecError(
      { query: "x", allowVersionMismatch: true },
      client
    );
    expect(result.semanticHealth).toBe("ok");
    expect(client.getCorpusVersion).not.toHaveBeenCalled();
    expect(client.search).toHaveBeenCalledWith("Aztec error: x", 3);
  });

  it("category filter + weak-only: short-circuits (does NOT fall through to category-agnostic semantic)", async () => {
    mockLookupError.mockReturnValue({
      query: "x",
      catalogMatches: [catalogHit(54, "WeakInCategory", "word-overlap")],
      codeMatches: [],
    });
    const client = makeClient({
      search: vi.fn().mockResolvedValue([{ text: "doc", title: "T", source: "S" }]),
    });
    const result = await lookupAztecError({ query: "x", category: "circuit" }, client);
    // Category filter is authoritative — falling through to a
    // category-agnostic semantic search would surface out-of-scope docs.
    expect(result.semanticHealth).toBe("skipped");
    expect(client.search).not.toHaveBeenCalled();
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

describe("lookupAztecError — content-thin chunk filter", () => {
  /**
   * Defense-in-depth filter: even if docsgpt's `/api/search` regresses
   * and starts returning path-only / empty-body apiref chunks,
   * `isUsefulSemanticChunk` drops them before they're surfaced to the
   * LLM consumer. Mirrors the server-side
   * `_is_empty_apiref_chunk` helper.
   */
  function chunk(text: string, source = "aztec-nr/aztec/src/foo.nr") {
    return { text, title: "foo.nr", source };
  }

  it("treats raw output of all path-only chunks as 'no_results'", async () => {
    const client = makeClient({
      search: vi.fn().mockResolvedValue([
        chunk("\n\naztec-nr/aztec/src/context/note_existence_request.nr\n\n",
              "aztec-nr/aztec/src/context/note_existence_request.nr"),
        chunk("\n\naztec-nr/aztec/src/note/hinted_note.nr\n",
              "aztec-nr/aztec/src/note/hinted_note.nr"),
      ]),
    });
    const result = await lookupAztecError({ query: "obscure" }, client);
    expect(result.semanticHealth).toBe("no_results");
    expect(result.semanticResults).toBeUndefined();
  });

  it("keeps mixed results when at least one chunk has substantive body", async () => {
    const client = makeClient({
      search: vi.fn().mockResolvedValue([
        chunk("\n\naztec-nr/aztec/src/empty.nr\n",
              "aztec-nr/aztec/src/empty.nr"),
        chunk(
          "# aztec-nr/aztec/src/hash.nr\npub fn poseidon(input: [Field; N]) -> Field",
          "aztec-nr/aztec/src/hash.nr"
        ),
        chunk("\n\naztec-nr/aztec/src/utils.nr\n",
              "aztec-nr/aztec/src/utils.nr"),
      ]),
    });
    const result = await lookupAztecError({ query: "poseidon" }, client);
    expect(result.semanticHealth).toBe("ok");
    expect(result.semanticResults).toHaveLength(1);
    expect(result.semanticResults![0].text).toContain("poseidon");
  });
});

describe("lookupAztecError — weak catalog suppression when semantic is useful", () => {
  /**
   * The user-reported "bogus result still appears" failure mode: weak
   * catalog hits visible alongside semantic results lets the LLM
   * consumer anchor on the wrong answer. When semantic returned
   * useful (post-filter) chunks, the weak catalog is now suppressed
   * from the rendered output entirely (still present in
   * `result.catalogMatches` for programmatic consumers).
   *
   * This tests the data-shape that the formatter consumes; the
   * formatter test (`tests/utils/format.test.ts`) verifies the
   * suppression actually happens at render time.
   */
  it("returns semanticHealth='ok' with weak catalog still in result.catalogMatches", async () => {
    mockLookupError.mockReturnValue({
      query: "note already nullified",
      catalogMatches: [
        catalogHit(54, "Contract already initialized", "word-overlap"),
      ],
      codeMatches: [],
    });

    const client = makeClient({
      search: vi.fn().mockResolvedValue([
        {
          text: "Notes in Aztec are nullified by emitting a nullifier...",
          title: "Note Lifecycle",
          source: "docs/notes.md",
        },
      ]),
    });

    const result = await lookupAztecError(
      { query: "note already nullified" },
      client
    );
    expect(result.semanticHealth).toBe("ok");
    expect(result.semanticResults).toHaveLength(1);
    // The weak catalog hit is preserved in the data — the formatter
    // is responsible for hiding it. Programmatic consumers can still
    // see all signals.
    expect(result.result.catalogMatches).toHaveLength(1);
    expect(result.result.catalogMatches[0].score).toBe(54);
  });

  it("when semantic is filtered out (all path-only) AND catalog is weak, keeps catalog", async () => {
    mockLookupError.mockReturnValue({
      query: "note already nullified",
      catalogMatches: [
        catalogHit(54, "Contract already initialized", "word-overlap"),
      ],
      codeMatches: [],
    });

    const client = makeClient({
      search: vi.fn().mockResolvedValue([
        // Path-only chunks that the filter will drop
        { text: "\n\naztec-nr/aztec/src/foo.nr\n",
          title: "foo.nr",
          source: "aztec-nr/aztec/src/foo.nr" },
      ]),
    });

    const result = await lookupAztecError(
      { query: "note already nullified" },
      client
    );
    // semantic returned empty (after filter) → no_results
    expect(result.semanticHealth).toBe("no_results");
    // Weak catalog stays in the result so the user has *some* signal
    expect(result.result.catalogMatches).toHaveLength(1);
    expect(result.message).toContain("low-confidence");
    expect(result.message).toMatch(/no relevant documentation|Semantic search/i);
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
      search: vi.fn().mockResolvedValue([{ text: "Some prose body content here.", title: "T", source: "x" }]),
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
        { text: "Some prose body content here.", title: "T", source: "x" },
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
