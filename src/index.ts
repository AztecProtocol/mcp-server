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

const server = new Server(
  {
    name: "aztec-mcp",
    version: "1.0.0",
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

/**
 * Handle tool calls
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "aztec_sync_repos": {
        const log = (message: string, level: string = "info") => {
          server.sendLoggingMessage({
            level: level as "info" | "debug" | "warning" | "error",
            logger: "aztec-sync",
            data: message,
          });
        };
        const result = await syncRepos({
          version: args?.version as string | undefined,
          force: args?.force as boolean | undefined,
          repos: args?.repos as string[] | undefined,
          log,
        });
        return {
          content: [
            {
              type: "text",
              text: formatSyncResult(result),
            },
          ],
        };
      }

      case "aztec_status": {
        const status = await getStatus();
        return {
          content: [
            {
              type: "text",
              text: formatStatus(status),
            },
          ],
        };
      }

      case "aztec_search_code": {
        if (!args?.query) {
          throw new McpError(ErrorCode.InvalidParams, "query is required");
        }
        const result = searchAztecCode({
          query: args.query as string,
          filePattern: args?.filePattern as string | undefined,
          repo: args?.repo as string | undefined,
          maxResults: args?.maxResults as number | undefined,
        });
        return {
          content: [
            {
              type: "text",
              text: formatSearchResults(result),
            },
          ],
        };
      }

      case "aztec_search_docs": {
        if (!args?.query) {
          throw new McpError(ErrorCode.InvalidParams, "query is required");
        }
        const result = searchAztecDocs({
          query: args.query as string,
          section: args?.section as string | undefined,
          maxResults: args?.maxResults as number | undefined,
        });
        return {
          content: [
            {
              type: "text",
              text: formatSearchResults(result),
            },
          ],
        };
      }

      case "aztec_list_examples": {
        const result = listAztecExamples({
          category: args?.category as string | undefined,
        });
        return {
          content: [
            {
              type: "text",
              text: formatExamplesList(result),
            },
          ],
        };
      }

      case "aztec_read_example": {
        if (!args?.name) {
          throw new McpError(ErrorCode.InvalidParams, "name is required");
        }
        const result = readAztecExample({
          name: args.name as string,
        });
        return {
          content: [
            {
              type: "text",
              text: formatExampleContent(result),
            },
          ],
        };
      }

      case "aztec_read_file": {
        if (!args?.path) {
          throw new McpError(ErrorCode.InvalidParams, "path is required");
        }
        const result = readRepoFile({
          path: args.path as string,
        });
        return {
          content: [
            {
              type: "text",
              text: formatFileContent(result),
            },
          ],
        };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
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
