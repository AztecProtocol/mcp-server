#!/usr/bin/env node
/**
 * Aztec MCP Server (unified)
 *
 * Provides local access to Aztec documentation, examples, source code,
 * and semantic search through cloned repositories and DocsGPT.
 *
 * Tools:
 *   aztec_search       — Semantic doc search via DocsGPT (requires API_KEY)
 *   aztec_search_code  — Regex code search via ripgrep over cloned repos
 *   aztec_lookup_error — Error diagnosis with semantic fallback
 *   aztec_list_examples, aztec_read_example, aztec_read_file — Repo browsing
 *   aztec_sync_repos, aztec_status — Repo management
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

import {
  syncRepos,
  getStatus,
  searchAztecCode,
  searchAztecDocs,
  listAztecExamples,
  readAztecExample,
  readRepoFile,
  lookupAztecError,
} from "./tools/index.js";
import {
  formatSyncResult,
  formatStatus,
  formatSearchResults,
  formatSemanticSearchResults,
  formatExamplesList,
  formatExampleContent,
  formatFileContent,
  formatErrorLookupResult,
} from "./utils/format.js";
import { MCP_VERSION } from "./version.js";
import { getSyncState, writeAutoResyncAttempt } from "./utils/sync-metadata.js";
import { getRepoTag } from "./utils/git.js";
import type { Logger } from "./utils/git.js";
import { DocsGPTClient } from "./backends/docsgpt-client.js";

// ---------------------------------------------------------------------------
// DocsGPT client — optional, enabled when API_KEY is set
// ---------------------------------------------------------------------------

const docsgptClient = process.env.API_KEY
  ? new DocsGPTClient({
      apiUrl: process.env.API_URL || "http://localhost:7091",
      apiKey: process.env.API_KEY,
      timeout: parseInt(process.env.REQUEST_TIMEOUT || "60000", 10),
    })
  : null;

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new Server(
  {
    name: "aztec-mcp",
    version: MCP_VERSION,
  },
  {
    capabilities: {
      tools: {},
      logging: {},
    },
  }
);

/**
 * Define available tools.
 * aztec_search_docs description changes based on whether DocsGPT is available.
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = [
    // Documentation search — semantic (DocsGPT) when API_KEY is set, ripgrep fallback otherwise
    {
      name: "aztec_search_docs",
      description: docsgptClient
        ? "Search Aztec documentation, guides, patterns, and API reference. " +
          "Uses semantic search to find relevant content from developer docs, " +
          "Aztec.nr framework docs, example contracts, and more."
        : "Search Aztec documentation. Use for finding tutorials, guides, and API documentation.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description: docsgptClient
              ? "Natural language search query about Aztec development"
              : "Documentation search query",
          },
          section: {
            type: "string",
            description: docsgptClient
              ? "Docs section filter (applies to local fallback search only). Examples: tutorials, concepts, developers, reference"
              : "Docs section to search. Examples: tutorials, concepts, developers, reference",
          },
          maxResults: {
            type: "number",
            description: docsgptClient
              ? "Maximum results to return (default: 5 for semantic search, max: 20)"
              : "Maximum results to return (default: 20)",
          },
          ...(docsgptClient
            ? {
                chunks: {
                  type: "number",
                  description:
                    "Number of result chunks for semantic search (default: 5, max: 20). " +
                    "If omitted, maxResults is used.",
                },
              }
            : {}),
        },
        required: ["query"],
      },
    },
    // Repo sync
    {
      name: "aztec_sync_repos",
      description:
        "Clone or update Aztec repositories locally. Run this first to enable searching. " +
        "Clones: aztec-packages (docs, aztec-nr, contracts), aztec-examples, aztec-starter. " +
        "Specify a version to clone a specific Aztec release tag.",
      inputSchema: {
        type: "object" as const,
        properties: {
          version: {
            type: "string",
            description:
              "Aztec version tag to clone (e.g., 'v4.2.0-aztecnr-rc.2'). Defaults to latest supported version.",
          },
          force: {
            type: "boolean",
            description: "Force re-clone even if repos exist (default: false)",
          },
          repos: {
            type: "array",
            items: { type: "string" },
            description:
              "Specific repos to sync. Options: aztec-packages, aztec-examples, aztec-starter",
          },
        },
      },
    },
    // Status
    {
      name: "aztec_status",
      description:
        "Check the status of cloned Aztec repositories - shows which repos are available and their commit hashes.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    // Code search (ripgrep)
    {
      name: "aztec_search_code",
      description:
        "Search Aztec contract code and source files. Supports regex patterns. " +
        "Use for finding function implementations, patterns, and examples.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description: "Search query (supports regex)",
          },
          filePattern: {
            type: "string",
            description:
              "File glob pattern (default: *.nr). Examples: *.ts, *.{nr,ts}",
          },
          repo: {
            type: "string",
            description:
              "Specific repo to search. Options: aztec-packages, aztec-examples, aztec-starter",
          },
          maxResults: {
            type: "number",
            description: "Maximum results to return (default: 30)",
          },
        },
        required: ["query"],
      },
    },
    // Examples
    {
      name: "aztec_list_examples",
      description:
        "List available Aztec contract examples. Returns contract names and paths.",
      inputSchema: {
        type: "object" as const,
        properties: {
          category: {
            type: "string",
            description:
              "Filter by category. Examples: token, nft, defi, escrow, crowdfund",
          },
        },
      },
    },
    {
      name: "aztec_read_example",
      description:
        "Read the source code of an Aztec contract example. Use aztec_list_examples to find available examples.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: {
            type: "string",
            description: "Example contract name (e.g., 'token', 'escrow')",
          },
        },
        required: ["name"],
      },
    },
    // File reading
    {
      name: "aztec_read_file",
      description:
        "Read any file from the cloned repositories by path. Path should be relative to the repos directory.",
      inputSchema: {
        type: "object" as const,
        properties: {
          path: {
            type: "string",
            description:
              "File path relative to repos directory (e.g., 'aztec-packages/docs/docs/tutorials/...')",
          },
        },
        required: ["path"],
      },
    },
    // Error lookup (with semantic fallback)
    {
      name: "aztec_lookup_error",
      description:
        "Look up an Aztec error by message, error code, or hex signature. " +
        "Returns root cause and suggested fix. Searches Solidity errors, " +
        "TX validation errors, circuit codes, AVM errors, and documentation." +
        (docsgptClient
          ? " Falls back to semantic documentation search when no exact match is found."
          : ""),
      inputSchema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description:
              "Error message, numeric error code (e.g., '2002'), or hex signature (e.g., '0xa5b2ba17')",
          },
          category: {
            type: "string",
            description:
              "Filter by error category. Options: contract, circuit, tx-validation, l1, avm, sequencer, operator, general",
          },
          maxResults: {
            type: "number",
            description: "Maximum results to return (default: 10)",
          },
        },
        required: ["query"],
      },
    },
  ];

  return { tools };
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateToolRequest(
  name: string,
  args: Record<string, unknown> | undefined
): void {
  switch (name) {
    case "aztec_sync_repos":
    case "aztec_status":
    case "aztec_list_examples":
      break;
    case "aztec_search_docs":
    case "aztec_search_code":
    case "aztec_lookup_error":
      if (!args?.query)
        throw new McpError(ErrorCode.InvalidParams, "query is required");
      break;
    case "aztec_read_example":
      if (!args?.name)
        throw new McpError(ErrorCode.InvalidParams, "name is required");
      break;
    case "aztec_read_file":
      if (!args?.path)
        throw new McpError(ErrorCode.InvalidParams, "path is required");
      break;
    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Auto-resync
// ---------------------------------------------------------------------------

// Sync lock — prevents concurrent syncs from racing over filesystem paths
let syncInFlight: Promise<void> | null = null;

function createSyncLog(): Logger {
  return (
    message: string,
    level: "info" | "debug" | "warning" | "error" = "info"
  ) => {
    server
      .sendLoggingMessage({
        level,
        logger: "aztec-sync",
        data: message,
      })
      .catch(() => {});
  };
}

function ensureAutoResync(): void {
  // If any sync is already in progress, don't block — let the tool proceed
  // with existing local checkouts.
  if (syncInFlight) return;

  const syncState = getSyncState();
  if (
    syncState.kind !== "needsAutoResync" &&
    syncState.kind !== "legacyUnknownVersion"
  ) {
    return;
  }

  const task = (async () => {
    const log = createSyncLog();

    let version: string | undefined;
    if (syncState.kind === "needsAutoResync") {
      version = syncState.aztecVersion;
      log(`Auto-syncing repos for MCP server v${MCP_VERSION}...`, "info");
    } else {
      // Legacy install — try to detect version from existing checkout
      const detectedTag = await getRepoTag("aztec-packages");
      if (detectedTag) {
        version = detectedTag;
        log(
          `Auto-syncing repos (detected ${detectedTag} from existing checkout)...`,
          "info"
        );
      } else {
        log(
          "Install predates sync metadata. Run aztec_sync_repos to establish tracked state.",
          "warning"
        );
        try {
          writeAutoResyncAttempt("deferred");
        } catch {
          /* non-fatal */
        }
        return;
      }
    }

    const syncResult = await syncRepos({ version, force: true, log });
    if (syncResult.metadataSafe) {
      log("Auto-sync complete", "info");
    } else {
      // Sync failed or metadata could not be persisted — retry after backoff
      try {
        writeAutoResyncAttempt("retryable");
      } catch {
        /* non-fatal */
      }
      if (syncResult.success) {
        log(`Auto-resync partial: ${syncResult.message}`, "info");
      } else {
        log(
          `Auto-resync failed: ${syncResult.message}. Local tools will use existing checkouts.`,
          "warning"
        );
      }
    }
  })();

  // Fire and forget — auto-resync is best-effort background work.
  // Read-only tools proceed immediately with existing local checkouts.
  syncInFlight = task.finally(() => {
    syncInFlight = null;
  });
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Validate tool name and required arguments before any expensive operations
  validateToolRequest(name, args);

  // Auto re-sync if MCP server version changed since last sync.
  // When using DocsGPT, aztec_search_docs doesn't need local repos — skip sync wait.
  const isSemanticDocsSearch = name === "aztec_search_docs" && docsgptClient != null;
  if (name !== "aztec_sync_repos" && !isSemanticDocsSearch) {
    ensureAutoResync();
    if (syncInFlight) await syncInFlight.catch(() => {});
  }

  try {
    let text!: string;

    switch (name) {
      case "aztec_sync_repos": {
        // Wait for any in-flight sync (auto or manual) before starting
        while (syncInFlight) await syncInFlight.catch(() => {});
        const log = createSyncLog();
        const task = syncRepos({
          version: args?.version as string | undefined,
          force: args?.force as boolean | undefined,
          repos: args?.repos as string[] | undefined,
          log,
        });
        syncInFlight = task
          .then(() => {})
          .finally(() => {
            syncInFlight = null;
          });
        const result = await task;
        text = formatSyncResult(result);
        break;
      }

      case "aztec_status": {
        const status = await getStatus();
        text = formatStatus(status);
        break;
      }

      case "aztec_search_docs": {
        const docsResult = await searchAztecDocs(
          {
            query: args!.query as string,
            section: args?.section as string | undefined,
            maxResults: args?.maxResults as number | undefined,
            chunks: args?.chunks as number | undefined,
          },
          docsgptClient
        );
        text =
          docsResult.kind === "semantic"
            ? formatSemanticSearchResults(docsResult.result)
            : formatSearchResults(docsResult.result);
        break;
      }

      case "aztec_search_code": {
        const result = searchAztecCode({
          query: args!.query as string,
          filePattern: args?.filePattern as string | undefined,
          repo: args?.repo as string | undefined,
          maxResults: args?.maxResults as number | undefined,
        });
        text = formatSearchResults(result);
        break;
      }

      case "aztec_list_examples": {
        const result = listAztecExamples({
          category: args?.category as string | undefined,
        });
        text = formatExamplesList(result);
        break;
      }

      case "aztec_read_example": {
        const result = readAztecExample({
          name: args!.name as string,
        });
        text = formatExampleContent(result);
        break;
      }

      case "aztec_read_file": {
        const result = readRepoFile({
          path: args!.path as string,
        });
        text = formatFileContent(result);
        break;
      }

      case "aztec_lookup_error": {
        const result = await lookupAztecError(
          {
            query: args!.query as string,
            category: args?.category as string | undefined,
            maxResults: args?.maxResults as number | undefined,
          },
          docsgptClient
        );
        text = formatErrorLookupResult(result);
        break;
      }
    }

    return {
      content: [{ type: "text", text }],
    };
  } catch (error) {
    if (error instanceof McpError) throw error;

    throw new McpError(
      ErrorCode.InternalError,
      `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
});

// --- Start server ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr (stdout is used for MCP communication)
  const mode = docsgptClient ? "semantic search enabled" : "code search only (set API_KEY for docs)";
  console.error(`Aztec MCP Server started (${mode})`);
}

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
