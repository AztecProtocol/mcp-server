#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { DocsGPTClient } from "./backends/docsgpt-client.js";
import { MCP_VERSION } from "./version.js";
import { checkForUpgrade, formatUpgradeBanner } from "./utils/version-self-check.js";

// Default points at the public Aztec DocsGPT deployment so the npm
// package "just works" with only API_KEY set. Override via API_URL for
// self-hosted or local backends. The previous default
// (`http://localhost:7091`) sent the user's API key to whatever was
// listening on their loopback port 7091 if API_URL was forgotten.
const DOCSGPT_DEFAULT_URL = "https://aztec.adjacentpossible.dev";

const docsgptClient = process.env.API_KEY
  ? new DocsGPTClient({
      apiUrl: process.env.API_URL || DOCSGPT_DEFAULT_URL,
      apiKey: process.env.API_KEY,
      timeout: parseInt(process.env.REQUEST_TIMEOUT || "60000", 10),
    })
  : null;

// Check npm registry for a newer release and surface an "outdated"
// banner in the instructions if so. Top-level await: blocks startup
// for at most ~2s on the registry round-trip (with internal timeout)
// — runs once per server process, so the cost amortizes immediately.
// Failure modes (no network, registry down, slow response) all return
// null and produce no banner; the server boots normally.
const upgradeInfo = await checkForUpgrade(MCP_VERSION);
const upgradeBanner =
  upgradeInfo && upgradeInfo.outdated ? formatUpgradeBanner(upgradeInfo) : "";

// --- Start server ---

async function main() {
  const server = await createServer({
    docsgptClient,
    upgradeBanner,
    developmentEnabled: process.env.AZTEC_MCP_DEV === "true",
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => { void server.close().catch(() => { console.error("Server shutdown failed."); process.exitCode = 1; }); });
  }

  // Log to stderr (stdout is used for MCP communication)
  const mode = docsgptClient
    ? "semantic search enabled"
    : "local-only mode — set API_KEY to enable semantic search (free key via /mcp-key in https://discord.gg/xMud5StFyA)";
  console.error(`Aztec MCP Server started (${mode})`);
}

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
