#!/usr/bin/env node
/**
 * Aztec MCP Server
 *
 * An MCP server that provides local access to Aztec documentation,
 * examples, and source code through cloned repositories.
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
} from "./tools/index.js";
import {
  formatSyncResult,
  formatStatus,
  formatSearchResults,
  formatExamplesList,
  formatExampleContent,
  formatFileContent,
} from "./utils/format.js";
import { MCP_VERSION } from "./version.js";
import { getSyncState, writeAutoResyncAttempt } from "./utils/sync-metadata.js";
import { getRepoTag } from "./utils/git.js";

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
 * Define available tools
 */
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "aztec_sync_repos",
      description:
        "Clone or update Aztec repositories locally. Run this first to enable searching. " +
        "Clones: aztec-packages (docs, aztec-nr, contracts), aztec-examples, aztec-starter. " +
        "Specify a version to clone a specific Aztec release tag.",
      inputSchema: {
        type: "object",
        properties: {
          version: {
            type: "string",
            description:
              "Aztec version tag to clone (e.g., 'v3.0.0-devnet.6-patch.1'). Defaults to latest supported version.",
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
    {
      name: "aztec_status",
      description:
        "Check the status of cloned Aztec repositories - shows which repos are available and their commit hashes.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "aztec_search_code",
      description:
        "Search Aztec contract code and source files. Supports regex patterns. " +
        "Use for finding function implementations, patterns, and examples.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query (supports regex)",
          },
          filePattern: {
            type: "string",
            description: "File glob pattern (default: *.nr). Examples: *.ts, *.{nr,ts}",
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
    {
      name: "aztec_search_docs",
      description:
        "Search Aztec documentation. Use for finding tutorials, guides, and API documentation.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Documentation search query",
          },
          section: {
            type: "string",
            description:
              "Docs section to search. Examples: tutorials, concepts, developers, reference",
          },
          maxResults: {
            type: "number",
            description: "Maximum results to return (default: 20)",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "aztec_list_examples",
      description:
        "List available Aztec contract examples. Returns contract names and paths.",
      inputSchema: {
        type: "object",
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
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Example contract name (e.g., 'token', 'escrow')",
          },
        },
        required: ["name"],
      },
    },
    {
      name: "aztec_read_file",
      description:
        "Read any file from the cloned repositories by path. Path should be relative to the repos directory.",
      inputSchema: {
        type: "object",
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
  ],
}));

function validateToolRequest(name: string, args: Record<string, unknown> | undefined): void {
  switch (name) {
    case "aztec_sync_repos":
    case "aztec_status":
    case "aztec_list_examples":
      break;
    case "aztec_search_code":
    case "aztec_search_docs":
      if (!args?.query) throw new McpError(ErrorCode.InvalidParams, "query is required");
      break;
    case "aztec_read_example":
      if (!args?.name) throw new McpError(ErrorCode.InvalidParams, "name is required");
      break;
    case "aztec_read_file":
      if (!args?.path) throw new McpError(ErrorCode.InvalidParams, "path is required");
      break;
    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }
}

// Sync lock — prevents concurrent syncs from racing over filesystem paths
let syncInFlight: Promise<void> | null = null;

function createSyncLog() {
  return (message: string, level: string = "info") => {
    server.sendLoggingMessage({
      level: level as "info" | "debug" | "warning" | "error",
      logger: "aztec-sync",
      data: message,
    }).catch(() => {});
  };
}

function ensureAutoResync(): void {
  // If any sync is already in progress, don't block — let the tool proceed
  // with existing local checkouts.
  if (syncInFlight) return;

  const syncState = getSyncState();
  if (syncState.kind !== "needsAutoResync" && syncState.kind !== "legacyUnknownVersion") {
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
        log(`Auto-syncing repos (detected ${detectedTag} from existing checkout)...`, "info");
      } else {
        log("Install predates sync metadata. Run aztec_sync_repos to establish tracked state.", "warning");
        try { writeAutoResyncAttempt("deferred"); } catch { /* non-fatal */ }
        return;
      }
    }

    const syncResult = await syncRepos({ version, force: true, log });
    if (syncResult.metadataSafe) {
      log("Auto-sync complete", "info");
    } else if (syncResult.success) {
      // Repos synced but metadata could not be persisted — retry later
      try { writeAutoResyncAttempt("retryable"); } catch { /* non-fatal */ }
      log(`Auto-resync partial: ${syncResult.message}`, "info");
    } else {
      // Sync failed (network error, aztec-packages abort, etc.) — retry after backoff
      try { writeAutoResyncAttempt("retryable"); } catch { /* non-fatal */ }
      log(`Auto-resync failed: ${syncResult.message}. Local tools will use existing checkouts.`, "warning");
    }
  })();

  // Fire and forget — auto-resync is best-effort background work.
  // Read-only tools proceed immediately with existing local checkouts.
  syncInFlight = task.finally(() => { syncInFlight = null; });
}

/**
 * Handle tool calls
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Validate tool name and required arguments before any expensive operations
  validateToolRequest(name, args);

  // Auto re-sync if MCP server version changed since last sync.
  // ensureAutoResync() starts the sync (fire-and-forget) — we then wait for any
  // in-flight sync to finish so read-only tools don't race against filesystem mutations.
  if (name !== "aztec_sync_repos") {
    ensureAutoResync();
    if (syncInFlight) await syncInFlight.catch(() => {});
  }

  try {
    let text: string;

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
        syncInFlight = task.then(() => {}).finally(() => { syncInFlight = null; });
        const result = await task;
        text = formatSyncResult(result);
        break;
      }

      case "aztec_status": {
        const status = await getStatus();
        text = formatStatus(status);
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

      case "aztec_search_docs": {
        const result = searchAztecDocs({
          query: args!.query as string,
          section: args?.section as string | undefined,
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

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
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
  console.error("Aztec MCP Server started");
}

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
