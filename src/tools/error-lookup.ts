/**
 * Error lookup tool — diagnose any Aztec error by message, code, or hex signature.
 *
 * Enhanced: when the static catalog + dynamic parsers produce no matches,
 * falls back to semantic search via DocsGPT for broader documentation context.
 */

import { lookupError } from "../utils/error-lookup.js";
import type { ErrorLookupResult } from "../utils/error-lookup.js";
import type { DocsGPTClient } from "../backends/docsgpt-client.js";
import type { SemanticSearchResult } from "../backends/docsgpt-client.js";

export interface ErrorLookupToolResult {
  success: boolean;
  result: ErrorLookupResult;
  semanticResults?: SemanticSearchResult[];
  message: string;
}

export async function lookupAztecError(
  options: {
    query: string;
    category?: string;
    maxResults?: number;
  },
  docsgptClient?: DocsGPTClient | null
): Promise<ErrorLookupToolResult> {
  const { query, category, maxResults = 10 } = options;

  const result = lookupError(query, { category, maxResults });

  const totalMatches = result.catalogMatches.length + result.codeMatches.length;

  // If static lookup found results, return them directly
  if (totalMatches > 0) {
    return {
      success: true,
      result,
      message: `Found ${result.catalogMatches.length} known error(s) and ${result.codeMatches.length} code reference(s) for "${query}"`,
    };
  }

  // Semantic fallback: search docs for error context when catalog misses
  if (docsgptClient) {
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
          message: `No exact error match found for "${query}". Showing relevant documentation.`,
        };
      }
    } catch (err) {
      // Surface the DocsGPT failure so callers can distinguish "no docs exist"
      // from "the semantic backend is broken/misconfigured".
      const detail = err instanceof Error ? err.message : String(err);
      return {
        success: true,
        result,
        message:
          `No exact error match found for "${query}". ` +
          `Semantic documentation search also failed: ${detail}`,
      };
    }
  }

  return {
    success: true,
    result,
    message: `No matches found for "${query}". Try a different error message, code, or hex signature.`,
  };
}
