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
 * Result type for aztec_search_docs — either semantic results (DocsGPT)
 * or ripgrep code-search results (fallback when no API key).
 */
export type DocsSearchResult =
  | { kind: "semantic"; result: SemanticSearchToolResult }
  | { kind: "ripgrep"; result: { success: boolean; results: SearchResult[]; message: string } };

/**
 * Search Aztec documentation.
 *
 * When a DocsGPT client is available (API_KEY set), uses semantic vector
 * search for high-quality natural language results. Otherwise, falls back
 * to the ripgrep-based search over cloned markdown files.
 */
export async function searchAztecDocs(
  options: {
    query: string;
    section?: string;
    maxResults?: number;
    chunks?: number;
  },
  client: DocsGPTClient | null
): Promise<DocsSearchResult> {
  // Semantic path — preferred when DocsGPT is configured
  if (client) {
    const { query, chunks, maxResults } = options;
    const numChunks = Math.min(chunks ?? maxResults ?? 5, 20);

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
    } catch {
      // DocsGPT unavailable — fall through to ripgrep if local docs exist
    }
  }

  // Ripgrep fallback — searches cloned markdown files
  const { query, section, maxResults = 20 } = options;

  if (!isRepoCloned("aztec-packages-docs")) {
    return {
      kind: "ripgrep",
      result: {
        success: false,
        results: [],
        message:
          "aztec-packages-docs is not cloned. Run aztec_sync_repos first to get documentation.",
      },
    };
  }

  const results = doSearchDocs(query, { section, maxResults });

  return {
    kind: "ripgrep",
    result: {
      success: true,
      results,
      message:
        results.length > 0
          ? `Found ${results.length} documentation matches`
          : "No documentation matches found",
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
