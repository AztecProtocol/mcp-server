/**
 * Error lookup tool — diagnose any Aztec error by message, code, or hex signature.
 *
 * Enhanced: when the static catalog + dynamic parsers produce no STRONG
 * matches, falls back to semantic search via DocsGPT for broader
 * documentation context. Weak fuzzy hints (word-overlap, score < 70)
 * no longer suppress the semantic fallback — they would shadow the
 * better answer with a misleading top hit (e.g. "note already nullified"
 * matching "Contract already initialized" with a Jaccard score of 54).
 */

import { lookupError } from "../utils/error-lookup.js";
import type { ErrorLookupResult } from "../utils/error-lookup.js";
import { DocsGPTClientError } from "../backends/docsgpt-client.js";
import type { DocsGPTClient } from "../backends/docsgpt-client.js";
import type { SemanticSearchResult } from "../backends/docsgpt-client.js";
import { checkVersionGate, formatMismatchMessage } from "../utils/version-check.js";

/**
 * Minimum catalog-match score that counts as "strong enough to short-
 * circuit the semantic fallback." Aligned with the score system in
 * ``utils/error-lookup.ts``:
 *   - 100  exact-code / hex-signature
 *   -  95  exact-pattern
 *   -  70-80 substring
 *   -  50-65 word-overlap (Jaccard)
 *
 * Threshold of 70 keeps every "real" match type and excludes only the
 * Jaccard fuzzy band, which is exactly the noise floor we want to fall
 * through past.
 */
const STRONG_MATCH_THRESHOLD = 70;

/**
 * A line is "path-shaped" if it looks like a filesystem path rather
 * than a code/docs line. Strips a leading markdown heading marker so
 * ``# aztec-nr/.../foo.nr`` is recognized as path-shaped just like
 * the bare ``aztec-nr/.../foo.nr``. Path-shaped means: contains ``/``
 * and has no whitespace. Real signature lines (``pub fn foo(...)``,
 * ``struct Bar { ... }``, ``pub use a::b;``) always have whitespace,
 * so they never trip this predicate.
 */
function lineIsPathShaped(line: string): boolean {
  const cleaned = line.replace(/^#+\s*/, "").trim();
  return cleaned.length > 0 && cleaned.includes("/") && !/\s/.test(cleaned);
}

/**
 * Drop semantic chunks whose body is empty or just the file path.
 *
 * Why this exists client-side even though docsgpt's ``/api/search``
 * has its own equivalent guard: defense-in-depth. The MCP server is
 * shipped to end users on whatever DocsGPT instance ``API_URL``
 * points at — that backend may not have the latest filter applied,
 * may be a self-hosted fork, or may reintroduce the bug in a future
 * regression. Filtering on this side keeps the MCP UX safe regardless.
 *
 * Mirrors the Python helper in ``application/api/answer/routes/search.py``
 * (``_is_empty_apiref_chunk``) — same content-shape predicate.
 *
 * The predicate is deliberately metadata-free. An earlier draft used
 * ``match.source`` / ``match.title`` as a "heading-equivalent" set
 * to strip a rendered file heading before checking the rest, but
 * docsgpt's ``/api/search`` rewrites ``source`` to a public URL via
 * ``_aztec_source_url`` — so the heading string never matches the
 * post-rewrite source field. The shape-only check below works
 * regardless of metadata transformations.
 */
function isUsefulSemanticChunk(match: SemanticSearchResult): boolean {
  const text = (match.text ?? "").trim();
  if (!text) return false;

  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return false;

  // All non-empty lines are path-shaped → no real API content.
  if (lines.every(lineIsPathShaped)) return false;

  return true;
}

export type SemanticHealth =
  | "ok" // semantic returned results
  | "no_results" // semantic ran cleanly, returned empty
  | "skipped" // no client OR static-catalog hit so semantic wasn't tried
  | "version_mismatch" // version gate blocked the semantic call
  | "failed"; // semantic backend errored

export interface ErrorLookupToolResult {
  /** Whether the static catalog lookup itself ran. Independent of
   *  whether the semantic fallback succeeded — see ``semanticHealth``
   *  for that signal. */
  success: boolean;
  result: ErrorLookupResult;
  semanticResults?: SemanticSearchResult[];
  semanticHealth: SemanticHealth;
  /** Set when the version gate blocked the semantic call. Surfaced so
   *  the caller can render the mismatch and the override hint. */
  versionMismatch?: { localVersion: string; corpusVersion: string };
  message: string;
}

export async function lookupAztecError(
  options: {
    query: string;
    category?: string;
    maxResults?: number;
    /** Opt-in: query the corpus even if its version doesn't match the
     *  local clone. Default false. Mirrors the same flag on
     *  ``aztec_search_docs``. */
    allowVersionMismatch?: boolean;
  },
  docsgptClient?: DocsGPTClient | null
): Promise<ErrorLookupToolResult> {
  const { query, category, maxResults = 10, allowVersionMismatch = false } = options;

  const result = lookupError(query, { category, maxResults });

  const hasStrongCatalogMatch = result.catalogMatches.some(
    (m) => m.score >= STRONG_MATCH_THRESHOLD
  );
  const hasCodeMatch = result.codeMatches.length > 0;
  const hasAnyCatalogMatch = result.catalogMatches.length > 0;

  // When the caller passed an explicit ``category`` filter and the
  // catalog produced any in-category match (even a weak one), keep
  // the pre-PR short-circuit: falling through to a category-agnostic
  // semantic search would surface out-of-scope docs and confuse the
  // user who explicitly narrowed the request. The semantic backend
  // doesn't honor the same category taxonomy, so respecting the
  // filter means trusting the catalog at face value.
  const hasCategoryFilteredHit = !!category && hasAnyCatalogMatch;

  const hasStrongMatch =
    hasStrongCatalogMatch || hasCodeMatch || hasCategoryFilteredHit;

  // Strong static hit: return immediately, semantic call not needed.
  // Weak fuzzy hits (word-overlap only, no category filter) fall
  // through to the semantic path below — they remain in
  // ``result.catalogMatches`` so the formatter can still render them
  // as low-confidence hints, but they no longer suppress the
  // semantic-fallback signal that produces the actually-useful answer.
  if (hasStrongMatch) {
    return {
      success: true,
      result,
      semanticHealth: "skipped",
      message: `Found ${result.catalogMatches.length} known error(s) and ${result.codeMatches.length} code reference(s) for "${query}"`,
    };
  }

  const weakHintsCount = result.catalogMatches.length;

  // Below the strong-match threshold (or zero matches). Try semantic
  // fallback if a client exists; otherwise return the weak hints
  // (if any) with a "skipped" health.
  if (!docsgptClient) {
    return {
      success: true,
      result,
      semanticHealth: "skipped",
      message:
        weakHintsCount > 0
          ? `No strong match for "${query}" — only ${weakHintsCount} low-confidence fuzzy hint(s) (word-overlap). Set API_KEY to enable semantic-documentation fallback (get a free key by running /mcp-key in the Aztec/Noir Discord: https://discord.gg/xMud5StFyA). Or try a different error message, code, or hex signature.`
          : `No matches found for "${query}". Try a different error message, code, or hex signature.`,
    };
  }

  // ``preface`` describes the static-catalog state; the semantic-result
  // branch appends what semantic produced. Keeps phrasing accurate when
  // weak fuzzy hints exist alongside the semantic results.
  const preface =
    weakHintsCount > 0
      ? `No strong static match for "${query}" — ${weakHintsCount} low-confidence fuzzy hint(s) shown below.`
      : `No exact error match found for "${query}".`;

  // Version gate before invoking semantic. Mirrors aztec_search_docs.
  if (!allowVersionMismatch) {
    const gate = await checkVersionGate(docsgptClient);
    if (gate.kind === "mismatch") {
      return {
        success: true,
        result,
        semanticHealth: "version_mismatch",
        versionMismatch: { localVersion: gate.localVersion, corpusVersion: gate.corpusVersion },
        message:
          `${preface} The semantic fallback was blocked by a version mismatch.\n\n` +
          formatMismatchMessage(gate.localVersion, gate.corpusVersion),
      };
    }
  }

  try {
    const rawResults = await docsgptClient.search(
      `Aztec error: ${query}`,
      3
    );

    // Filter content-thin / path-only chunks. If the server-side guard
    // is in place these will be empty already, but defense-in-depth
    // protects against older docsgpt deployments and any future
    // regression in the apiref ingest. "Returned 3 chunks but all
    // were just file paths" is functionally equivalent to "returned
    // nothing useful" and we report it as such.
    const semanticResults = rawResults.filter(isUsefulSemanticChunk);

    if (semanticResults.length > 0) {
      return {
        success: true,
        result,
        semanticResults,
        semanticHealth: "ok",
        message: `${preface} Showing relevant documentation.`,
      };
    }

    return {
      success: true,
      result,
      semanticHealth: "no_results",
      message:
        weakHintsCount > 0
          ? `${preface} Semantic search also returned no relevant documentation.`
          : `No matches found for "${query}". Try a different error message, code, or hex signature.`,
    };
  } catch (err) {
    // Sanitize: don't echo the raw upstream error string to the user.
    // Distinguish auth issues (actionable) from generic failures
    // (operational, not the user's problem to fix). The full detail
    // lives in stderr logs for the operator.
    let userFacing: string;
    if (err instanceof DocsGPTClientError && err.statusCode === 401) {
      userFacing =
        "the API key is invalid (run /mcp-key in the Noir Discord for a new one)";
    } else {
      userFacing = "the semantic documentation backend is currently unavailable";
    }

    if (process.env.DEBUG) {
      console.error(
        `[error-lookup] semantic fallback failed:`,
        err instanceof Error ? err.stack ?? err.message : err
      );
    }

    return {
      success: true,
      result,
      semanticHealth: "failed",
      message: `${preface} The semantic fallback was unavailable: ${userFacing}.`,
    };
  }
}
