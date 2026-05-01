/**
 * Search tools for finding content in Aztec repositories
 */

import {
  searchCode as doSearchCode,
  searchDocs as doSearchDocs,
  listExamples as doListExamples,
  findExample,
  readFile,
  SearchResult,
  FileInfo,
} from "../utils/search.js";
import { isRepoCloned } from "../utils/git.js";
import { getRepoNames } from "../repos/config.js";
import { DocsGPTClient, DocsGPTClientError } from "../backends/docsgpt-client.js";
import type { SemanticSearchResult } from "../backends/docsgpt-client.js";
import { checkVersionGate, formatMismatchMessage } from "../utils/version-check.js";

/**
 * Search Aztec code (contracts, TypeScript, etc.)
 */
export function searchAztecCode(options: {
  query: string;
  filePattern?: string;
  repo?: string;
  maxResults?: number;
}): {
  success: boolean;
  results: SearchResult[];
  message: string;
} {
  const { query, filePattern = "*.nr", repo, maxResults = 30 } = options;

  // Check if repos are cloned
  if (repo && !isRepoCloned(repo)) {
    return {
      success: false,
      results: [],
      message: `Repository '${repo}' is not cloned. Run aztec_sync_repos first.`,
    };
  }

  const anyCloned = getRepoNames().some(isRepoCloned);
  if (!anyCloned) {
    return {
      success: false,
      results: [],
      message: "No repositories are cloned. Run aztec_sync_repos first.",
    };
  }

  const results = doSearchCode(query, { filePattern, repo, maxResults });

  return {
    success: true,
    results,
    message:
      results.length > 0
        ? `Found ${results.length} matches`
        : "No matches found",
  };
}

/**
 * Semantic search result shape returned by aztec_search_docs when using DocsGPT.
 */
export interface SemanticSearchToolResult {
  success: boolean;
  results: SemanticSearchResult[];
  message: string;
}

/**
 * Result type for aztec_search_docs.
 *
 * `semantic` — DocsGPT returned results (success path).
 * `ripgrep`  — local search ran (no API key OR `useLocalFallback: true`
 *              after a semantic failure).
 * `version-mismatch` — local clone vs. corpus version diverge and the
 *              caller did NOT pass `allowVersionMismatch: true`. The
 *              caller can re-invoke with the override or sync repos.
 * `error`    — semantic search failed and either fallback was disabled
 *              or fallback also failed. `semanticError` always set;
 *              `fallbackError` set only when both paths failed.
 */
export type DocsSearchResult =
  | { kind: "semantic"; result: SemanticSearchToolResult }
  | { kind: "ripgrep"; result: { success: boolean; results: SearchResult[]; message: string } }
  | { kind: "version-mismatch"; localVersion: string; corpusVersion: string; message: string }
  | { kind: "error"; message: string; semanticError: string; fallbackError?: string };

interface SearchAztecDocsOptions {
  query: string;
  section?: string;
  maxResults?: number;
  chunks?: number;
  /** Opt-in: fall back to ripgrep over local cloned docs when DocsGPT
   *  is unavailable. Default false — silent fallback masks the kind of
   *  config failures users need to see (wrong API_URL, expired key,
   *  backend down). */
  useLocalFallback?: boolean;
  /** Opt-in: search the corpus even if its version doesn't match the
   *  local clone. Default false. */
  allowVersionMismatch?: boolean;
}

/**
 * Search Aztec documentation.
 *
 * When a DocsGPT client is available (API_KEY set), uses semantic vector
 * search. Errors are surfaced — no silent ripgrep fallback unless the
 * caller passes `useLocalFallback: true`.
 */
export async function searchAztecDocs(
  options: SearchAztecDocsOptions,
  client: DocsGPTClient | null
): Promise<DocsSearchResult> {
  // Semantic path
  if (client) {
    const { query, chunks, maxResults, useLocalFallback = false, allowVersionMismatch = false } = options;
    const numChunks = chunks ?? maxResults ?? 5;

    // Version gate. `unknown` results — backend missing /api/version,
    // or AZTEC_CORPUS_VERSION unset — let the search proceed (callers
    // should not be locked out by an older or under-configured backend).
    //
    // When `useLocalFallback: true` the caller has explicitly opted
    // into "use local docs if semantic is unusable" — a version
    // mismatch counts as "unusable" but the local clone is a valid,
    // version-aligned alternative, so fall through to ripgrep instead
    // of refusing. Without `useLocalFallback`, refuse (it's the gate's
    // whole purpose).
    if (!allowVersionMismatch) {
      const gate = await checkVersionGate(client);
      if (gate.kind === "mismatch") {
        if (useLocalFallback) {
          return ripgrepFallback(
            options,
            `corpus version is ${gate.corpusVersion} but local clone is ${gate.localVersion}; ` +
              `using local docs which match your clone. Pass allowVersionMismatch:true to query the corpus anyway.`
          );
        }
        return {
          kind: "version-mismatch",
          localVersion: gate.localVersion,
          corpusVersion: gate.corpusVersion,
          message: formatMismatchMessage(gate.localVersion, gate.corpusVersion),
        };
      }
    }

    try {
      const results = await client.search(query, numChunks);

      return {
        kind: "semantic",
        result: {
          success: true,
          results,
          message:
            results.length > 0
              ? `Found ${results.length} documentation matches`
              : `No documentation matches found for "${query}".`,
        },
      };
    } catch (err) {
      const semanticError = err instanceof DocsGPTClientError ? err.message : String(err);

      if (!useLocalFallback) {
        return {
          kind: "error",
          message:
            `Semantic documentation search failed: ${semanticError}\n\n` +
            `To search local cloned docs instead, retry with \`useLocalFallback: true\`.`,
          semanticError,
        };
      }

      // useLocalFallback === true: try ripgrep, accumulate both errors
      // if it also fails so the user sees the full picture.
      return ripgrepFallback(options, semanticError);
    }
  }

  // No client configured (no API_KEY) — ripgrep is the primary path.
  return ripgrepFallback(options, undefined);
}

function ripgrepFallback(
  options: SearchAztecDocsOptions,
  semanticError: string | undefined
): DocsSearchResult {
  const { query, section, maxResults = 20 } = options;

  if (!isRepoCloned("aztec-packages-docs")) {
    const fallbackError = "aztec-packages-docs is not cloned. Run aztec_sync_repos first to get documentation.";
    if (semanticError !== undefined) {
      return {
        kind: "error",
        message:
          `Both documentation backends are unavailable.\n\n` +
          `Semantic search: ${semanticError}\n` +
          `Local fallback: ${fallbackError}`,
        semanticError,
        fallbackError,
      };
    }
    return {
      kind: "ripgrep",
      result: { success: false, results: [], message: fallbackError },
    };
  }

  const results = doSearchDocs(query, { section, maxResults });

  return {
    kind: "ripgrep",
    result: {
      success: true,
      results,
      message:
        (semanticError !== undefined
          ? `Semantic search failed (${semanticError}); using local docs.\n`
          : "") +
        (results.length > 0
          ? `Found ${results.length} documentation matches`
          : "No documentation matches found"),
    },
  };
}

/**
 * List available Aztec contract examples
 */
export function listAztecExamples(options: { category?: string }): {
  success: boolean;
  examples: FileInfo[];
  message: string;
} {
  const { category } = options;

  const anyCloned = getRepoNames().some(isRepoCloned);
  if (!anyCloned) {
    return {
      success: false,
      examples: [],
      message: "No repositories are cloned. Run aztec_sync_repos first.",
    };
  }

  const examples = doListExamples(category);

  return {
    success: true,
    examples,
    message:
      examples.length > 0
        ? `Found ${examples.length} example contracts`
        : category
          ? `No examples found matching category '${category}'`
          : "No examples found",
  };
}

/**
 * Read an example contract
 */
export function readAztecExample(options: { name: string }): {
  success: boolean;
  example?: FileInfo;
  content?: string;
  message: string;
} {
  const { name } = options;

  const example = findExample(name);

  if (!example) {
    return {
      success: false,
      message: `Example '${name}' not found. Use aztec_list_examples to see available examples.`,
    };
  }

  const content = readFile(example.path);

  if (!content) {
    return {
      success: false,
      example,
      message: `Could not read example file: ${example.path}`,
    };
  }

  return {
    success: true,
    example,
    content,
    message: `Read ${example.name} from ${example.repo}`,
  };
}

/**
 * Read any file from cloned repos
 */
export function readRepoFile(options: { path: string }): {
  success: boolean;
  content?: string;
  message: string;
} {
  const { path } = options;

  const content = readFile(path);

  if (!content) {
    return {
      success: false,
      message: `File not found: ${path}. Make sure the path is relative to the repos directory.`,
    };
  }

  return {
    success: true,
    content,
    message: `Read file: ${path}`,
  };
}
