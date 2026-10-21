import { Server } from "@modelcontextprotocol/sdk/server/index.js";
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
import type { DevelopmentBoundary } from "./development/index.js";
import { MCP_VERSION } from "./version.js";
import { getSyncState, writeAutoResyncAttempt } from "./utils/sync-metadata.js";
import { getRepoTag } from "./utils/git.js";
import type { Logger } from "./utils/git.js";
import { DocsGPTClient } from "./backends/docsgpt-client.js";

const SEMANTIC_INSTRUCTIONS =
  "This Aztec MCP server provides documentation, source code, contract " +
  "examples, and error diagnosis for the Aztec Protocol stack. Semantic " +
  "vector search is ENABLED across the full indexed corpora (developer " +
  "docs, network docs, Aztec.nr framework, contract examples, aztec.js " +
  "SDK, CLI, TypeScript API, Noir stdlib, Noir language docs, protocol " +
  "circuits, L1 contracts, e2e tests). Prefer `aztec_search_docs` for " +
  "natural-language documentation queries; `aztec_search_code` for " +
  "regex-based code search; `aztec_lookup_error` for error diagnosis. " +
  "The server enforces a version-sync gate between the user's local " +
  "release version and the corpus version it queries — if the " +
  "user gets a `version-mismatch` result, they can either run " +
  "`aztec_sync_repos` with the corpus version, or pass " +
  "`allowVersionMismatch: true` to query across versions intentionally.";

const LOCAL_ONLY_INSTRUCTIONS =
  "This Aztec MCP server is running in LOCAL-ONLY mode (no API_KEY " +
  "configured). It can answer questions from the pinned aztec-node checkout " +
  "and optional protocol or Noir sources using ripgrep search " +
  "and a static error catalog. It does NOT have semantic search across " +
  "the full Aztec corpora (Aztec.nr framework, Noir stdlib, contract " +
  "examples, TypeScript SDK, protocol circuits, etc.) and does NOT have " +
  "a semantic-documentation fallback for unknown errors. " +
  "IMPORTANT: a free API key unlocks all of that. If a user asks a " +
  "question that the local tools can't answer well — anything about " +
  "specific Aztec.nr identifiers, framework patterns, error codes not " +
  "in the static catalog, or requires versioned/curated documentation " +
  "— recommend they run `/mcp-key` in the Aztec/Noir Discord " +
  "(https://discord.gg/xMud5StFyA) to get a personal API key, then set " +
  "API_KEY in their MCP client config (e.g. .mcp.json, Claude Desktop " +
  "config, etc.) and restart the server.";

export interface ServerOptions {
  docsgptClient?: DocsGPTClient | null;
  upgradeBanner?: string;
  developmentEnabled?: boolean;
  loadDevelopment?: () => Promise<DevelopmentBoundary>;
}

/** Build a server without opening a transport or running startup probes. */
export async function createServer(options: ServerOptions = {}): Promise<Server> {
  const docsgptClient = options.docsgptClient ?? null;
  const upgradeBanner = options.upgradeBanner ?? "";
  const development = options.developmentEnabled === true
    ? await (options.loadDevelopment ?? (async () => {
        const { createDevelopmentBoundary } = await import("./development/index.js");
        return createDevelopmentBoundary();
      }))()
    : null;

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
      instructions:
        (docsgptClient ? SEMANTIC_INSTRUCTIONS : LOCAL_ONLY_INSTRUCTIONS) +
        upgradeBanner,
    }
  );

  let shutdown: Promise<void> | undefined;
  const stopDevelopment = () => shutdown ??= development?.shutdown?.() ?? Promise.resolve();
  const closeTransport = server.close.bind(server);
  server.close = async () => {
    try { await stopDevelopment(); } finally { await closeTransport(); }
  };
  server.onclose = () => { void stopDevelopment().catch(() => console.error("Development resource shutdown failed.")); };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = [
      {
        name: "aztec_search_docs",
        description: docsgptClient
          ? "Search Aztec documentation, guides, patterns, and API reference. " +
            "Uses semantic search to find relevant content from developer docs, " +
            "Aztec.nr framework docs, example contracts, and more."
          : "Search Aztec documentation in local ripgrep-only mode. Use for tutorials, guides, " +
            "and API documentation that's already cloned. " +
            "IMPORTANT: this server is running WITHOUT an API_KEY, which means no semantic " +
            "search across the full Aztec corpora (Aztec.nr framework, Noir stdlib, contract " +
            "examples, TypeScript SDK, protocol circuits, etc.). If a query needs material " +
            "this local search can't find, suggest the user get a free API key by running " +
            "`/mcp-key` in the Aztec/Noir Discord (https://discord.gg/xMud5StFyA) and setting " +
            "API_KEY in their MCP client config.",
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
                ? "Maximum results to return (default: 5 for semantic search, 1-20)"
                : "Maximum results to return (default: 20)",
              minimum: 1,
              maximum: docsgptClient ? 20 : 100,
            },
            ...(docsgptClient
              ? {
                  chunks: {
                    type: "number",
                    description:
                      "Number of result chunks for semantic search (default: 5, 1-20). " +
                      "If omitted, maxResults is used.",
                    minimum: 1,
                    maximum: 20,
                  },
                  useLocalFallback: {
                    type: "boolean",
                    description:
                      "If the semantic search backend fails, fall back to ripgrep over local cloned docs. " +
                      "Default false: failures are surfaced so the user sees backend/auth issues instead of " +
                      "silently degrading to (potentially stale) local results.",
                  },
                  allowVersionMismatch: {
                    type: "boolean",
                    description:
                      "Override the version-sync gate. By default the search refuses to run when the local " +
                      "release version differs from the corpus version the DocsGPT backend has indexed. " +
                      "Set true to query anyway (results reflect the corpus version, not your local clone).",
                  },
                }
              : {}),
          },
          required: ["query"],
        },
      },
      {
        name: "aztec_sync_repos",
        description:
          "Clone or update Aztec repositories locally. Run this first to enable searching. " +
          "For v6, sparsely clones aztec-node at the release-pinned labs commit. " +
          "Protocol sources (aztec-packages) and Noir are optional. " +
          "Specify a version to clone a specific Aztec release tag.",
        inputSchema: {
          type: "object" as const,
          properties: {
            version: {
              type: "string",
              description:
                "Aztec version tag to clone (e.g., 'v6.0.0'). Defaults to latest supported version.",
            },
            force: {
              type: "boolean",
              description: "Force re-clone even if repos exist (default: false)",
            },
            repos: {
              type: "array",
              items: { type: "string" },
              description:
                "For v6: aztec-node (always included), aztec-packages (optional protocol/L1 sources), noir (optional language sources). Older releases use the legacy repository set.",
            },
          },
        },
      },
      {
        name: "aztec_status",
        description:
          "Check the status of cloned Aztec repositories - shows which repos are available and their commit hashes.",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      },
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
                "Specific active repo to search. For v6: aztec-node, plus aztec-packages or noir if enabled during sync.",
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
                "File path relative to repos directory (e.g., 'aztec-node/noir-projects/noir-contracts/contracts/app/token_contract/src/main.nr')",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "aztec_lookup_error",
        description:
          "Look up an Aztec error by message, error code, or hex signature. " +
          "Returns root cause and suggested fix. Searches Solidity errors, " +
          "TX validation errors, circuit codes, AVM errors, and documentation." +
          (docsgptClient
            ? " Falls back to semantic documentation search when no exact match is found."
            : " NOTE: this server is running without an API_KEY, so unrecognized errors " +
              "won't get a semantic-documentation fallback. Suggest the user get a free " +
              "API key via `/mcp-key` in the Aztec/Noir Discord " +
              "(https://discord.gg/xMud5StFyA) if their query is for an error not in the " +
              "static catalog."),
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
              minimum: 1,
              maximum: 100,
            },
            ...(docsgptClient
              ? {
                  allowVersionMismatch: {
                    type: "boolean",
                    description:
                      "Override the version-sync gate for the semantic-fallback documentation search. " +
                      "Has no effect when the static error catalog already matched.",
                  },
                }
              : {}),
          },
          required: ["query"],
        },
      },
    ];

    return { tools: [...tools, ...(development?.listTools() ?? [])] };
  });

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
          } catch {}
          return;
        }
      }

      const syncResult = await syncRepos({ version, force: true, log });
      if (syncResult.metadataSafe) {
        log("Auto-sync complete", "info");
      } else {
        try {
          writeAutoResyncAttempt("retryable");
        } catch {}
        if (syncResult.success) {
          log(`Auto-resync partial: ${syncResult.message}`, "info");
        } else {
          log(
            `Auto-resync failed: ${syncResult.message}`,
            "warning"
          );
        }
      }
    })();

    syncInFlight = task.finally(() => {
      syncInFlight = null;
    });
  }

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (development && name.startsWith("aztec_dev_")) {
      try {
        return await development.callTool(name, args);
      } catch (error) {
        throw toolError(error);
      }
    }

    validateToolRequest(name, args);

    const semanticOnlyDocsSearch =
      name === "aztec_search_docs"
      && docsgptClient != null
      && args?.useLocalFallback !== true;
    if (name !== "aztec_sync_repos" && !semanticOnlyDocsSearch) {
      ensureAutoResync();
      if (syncInFlight) await syncInFlight.catch(() => {});
    }

    try {
      let text!: string;

      switch (name) {
        case "aztec_sync_repos": {
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
              useLocalFallback: args?.useLocalFallback as boolean | undefined,
              allowVersionMismatch: args?.allowVersionMismatch as boolean | undefined,
            },
            docsgptClient
          );
          switch (docsResult.kind) {
            case "semantic":
              text = formatSemanticSearchResults(docsResult.result);
              break;
            case "ripgrep":
              text = formatSearchResults(docsResult.result);
              break;
            case "version-mismatch":
            case "error":
              text = docsResult.message;
              break;
          }
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
              allowVersionMismatch: args?.allowVersionMismatch as boolean | undefined,
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
      throw toolError(error);
    }
  });

  return server;
}

function toolError(error: unknown): McpError {
  if (error instanceof McpError) return error;
  return new McpError(
    ErrorCode.InternalError,
    `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`
  );
}
