/**
 * Error lookup tool — diagnose any Aztec error by message, code, or hex signature.
 */

import { lookupError } from "../utils/error-lookup.js";
import type { ErrorLookupResult } from "../utils/error-lookup.js";

export function lookupAztecError(options: {
  query: string;
  category?: string;
  maxResults?: number;
}): {
  success: boolean;
  result: ErrorLookupResult;
  message: string;
} {
  const { query, category, maxResults = 10 } = options;

  const result = lookupError(query, { category, maxResults });

  const totalMatches = result.catalogMatches.length + result.codeMatches.length;

  return {
    success: true,
    result,
    message:
      totalMatches > 0
        ? `Found ${result.catalogMatches.length} known error(s) and ${result.codeMatches.length} code reference(s) for "${query}"`
        : `No matches found for "${query}". Try a different error message, code, or hex signature.`,
  };
}
