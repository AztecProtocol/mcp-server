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
    const semanticResults = await docsgptClient.search(
      `Aztec error: ${query}`,
      3
    );

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
