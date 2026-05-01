/**
 * Error lookup tool — diagnose any Aztec error by message, code, or hex signature.
 *
 * Enhanced: when the static catalog + dynamic parsers produce no matches,
 * falls back to semantic search via DocsGPT for broader documentation context.
 */

import { lookupError } from "../utils/error-lookup.js";
import type { ErrorLookupResult } from "../utils/error-lookup.js";
import { DocsGPTClientError } from "../backends/docsgpt-client.js";
import type { DocsGPTClient } from "../backends/docsgpt-client.js";
import type { SemanticSearchResult } from "../backends/docsgpt-client.js";
import { checkVersionGate, formatMismatchMessage } from "../utils/version-check.js";

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

  const totalMatches = result.catalogMatches.length + result.codeMatches.length;

  // Static catalog hit: return immediately, semantic call not needed.
  if (totalMatches > 0) {
    return {
      success: true,
      result,
      semanticHealth: "skipped",
      message: `Found ${result.catalogMatches.length} known error(s) and ${result.codeMatches.length} code reference(s) for "${query}"`,
    };
  }

  // No static match. Try semantic fallback if a client exists.
  if (!docsgptClient) {
    return {
      success: true,
      result,
      semanticHealth: "skipped",
      message: `No matches found for "${query}". Try a different error message, code, or hex signature.`,
    };
  }

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
          `No exact error match found for "${query}", and the semantic fallback was blocked by a version mismatch.\n\n` +
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
        message: `No exact error match found for "${query}". Showing relevant documentation.`,
      };
    }

    return {
      success: true,
      result,
      semanticHealth: "no_results",
      message: `No matches found for "${query}". Try a different error message, code, or hex signature.`,
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
      message:
        `No exact error match found for "${query}", and ${userFacing}.`,
    };
  }
}
