/**
 * Formatting utilities for MCP tool responses
 */

import { isRepoError, type SyncResult } from "../tools/sync.js";
import type { SearchResult, FileInfo } from "./search.js";
import type { SyncMetadata } from "./sync-metadata.js";
import type { ErrorLookupResult } from "./error-lookup.js";
import type { SemanticSearchToolResult } from "../tools/search.js";
import type { ErrorLookupToolResult } from "../tools/error-lookup.js";
import { MCP_VERSION } from "../version.js";
import {
  formatUpgradeStatusLine,
  getUpgradeInfo,
} from "./version-self-check.js";

export function formatSyncResult(result: SyncResult): string {
  const lines = [
    result.success ? "✓ Sync completed" : "⚠ Sync completed with errors",
    "",
    `Version: ${result.version}`,
    result.message,
    "",
    "Repositories:",
  ];

  for (const repo of result.repos) {
    const icon = isRepoError(repo) ? "✗" : "✓";
    lines.push(`  ${icon} ${repo.name}: ${repo.status}`);
  }

  return lines.join("\n");
}

export function formatStatus(status: {
  reposDir: string;
  repos: {
    name: string;
    description: string;
    cloned: boolean;
    commit?: string;
  }[];
  syncMetadata?: SyncMetadata | null;
}): string {
  const lines = [
    "Aztec MCP Server Status",
    "",
    // Live version read from package.json at module load (see
    // ``src/version.ts``). The previous implementation pulled this
    // from sync metadata, which was the version that ran the LAST
    // sync — stale across upgrades that didn't touch the clones.
    `MCP server version: ${MCP_VERSION}`,
  ];

  // npm-latest comparison done at boot (``checkForUpgrade`` in
  // ``src/index.ts``). Prints either "you are up to date" or an
  // upgrade-available warning. Empty string when the registry check
  // failed at boot, so we stay silent rather than misleading.
  const upgradeLine = formatUpgradeStatusLine(getUpgradeInfo());
  if (upgradeLine) {
    lines.push(upgradeLine);
  }

  lines.push(`Repos directory: ${status.reposDir}`);

  if (status.syncMetadata) {
    lines.push(`Last synced: ${status.syncMetadata.syncedAt}`);
    if (status.syncMetadata.mcpVersion !== MCP_VERSION) {
      // Only mention this when it differs from the live version —
      // otherwise it's just noise that duplicates the line above.
      lines.push(
        `  (last sync ran under MCP server v${status.syncMetadata.mcpVersion} — re-run aztec_sync_repos to refresh metadata)`
      );
    }
    lines.push(`Aztec version: ${status.syncMetadata.aztecVersion}`);
  }

  lines.push("");
  lines.push("Repositories:");

  for (const repo of status.repos) {
    const icon = repo.cloned ? "✓" : "○";
    const commit = repo.commit ? ` (${repo.commit})` : "";
    lines.push(`  ${icon} ${repo.name}${commit}`);
    lines.push(`    ${repo.description}`);
  }

  const clonedCount = status.repos.filter((r) => r.cloned).length;
  if (clonedCount === 0) {
    lines.push("");
    lines.push("No repositories cloned. Run aztec_sync_repos to get started.");
  }

  return lines.join("\n");
}

export function formatSearchResults(result: {
  success: boolean;
  results: SearchResult[];
  message: string;
}): string {
  const lines = [result.message, ""];

  if (!result.success || result.results.length === 0) {
    return lines.join("\n");
  }

  for (const match of result.results) {
    lines.push(`**${match.file}:${match.line}**`);
    lines.push("```");
    lines.push(match.content);
    lines.push("```");
    lines.push("");
  }

  return lines.join("\n");
}

export function formatExamplesList(result: {
  success: boolean;
  examples: FileInfo[];
  message: string;
}): string {
  const lines = [result.message, ""];

  if (!result.success || result.examples.length === 0) {
    return lines.join("\n");
  }

  // Group by repo
  const byRepo = new Map<string, FileInfo[]>();
  for (const example of result.examples) {
    if (!byRepo.has(example.repo)) {
      byRepo.set(example.repo, []);
    }
    byRepo.get(example.repo)!.push(example);
  }

  for (const [repo, examples] of byRepo) {
    lines.push(`**${repo}:**`);
    for (const example of examples) {
      lines.push(`  - ${example.name}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function formatExampleContent(result: {
  success: boolean;
  example?: FileInfo;
  content?: string;
  message: string;
}): string {
  if (!result.success || !result.content) {
    return result.message;
  }

  const lines = [
    `**${result.example!.name}** (${result.example!.repo})`,
    `Path: ${result.example!.path}`,
    "",
    "```noir",
    result.content,
    "```",
  ];

  return lines.join("\n");
}

export function formatFileContent(result: {
  success: boolean;
  content?: string;
  message: string;
}): string {
  if (!result.success || !result.content) {
    return result.message;
  }

  return result.content;
}

export function formatErrorLookupResult(result: ErrorLookupToolResult): string {
  const lines = [result.message, ""];

  const { catalogMatches, codeMatches } = result.result;

  if (catalogMatches.length > 0) {
    lines.push("## Known Errors");
    lines.push("");

    for (const m of catalogMatches) {
      const { entry } = m;
      lines.push(`**${entry.name}**`);
      if (entry.errorCode !== undefined) lines.push(`- Code: ${entry.errorCode}`);
      if (entry.hexSignature) lines.push(`- Hex: ${entry.hexSignature}`);
      lines.push(`- Category: ${entry.category}`);
      lines.push(`- Source: ${entry.source}`);
      lines.push(`- Match: ${m.matchType} (score ${m.score})`);
      lines.push(`- **Cause**: ${entry.cause}`);
      lines.push(`- **Fix**: ${entry.fix}`);
      lines.push("");
    }
  }

  if (codeMatches.length > 0) {
    lines.push("## Related Code References");
    lines.push("");

    for (const match of codeMatches) {
      lines.push(`**${match.file}:${match.line}**`);
      lines.push("```");
      lines.push(match.content);
      lines.push("```");
      lines.push("");
    }
  }

  // Semantic fallback results from DocsGPT
  if (result.semanticResults && result.semanticResults.length > 0) {
    lines.push("## Related Documentation");
    lines.push("");

    for (const match of result.semanticResults) {
      if (match.title) {
        lines.push(`**${match.title}**`);
      }
      if (match.source) {
        lines.push(`Source: ${match.source}`);
      }
      lines.push("");
      lines.push(match.text);
      lines.push("");
      lines.push("---");
      lines.push("");
    }
  }

  if (
    catalogMatches.length === 0 &&
    codeMatches.length === 0 &&
    (!result.semanticResults || result.semanticResults.length === 0) &&
    // Don't repeat the "try" hints when the message already explains
    // *why* there are no semantic results (version mismatch / backend
    // failure) — the message field is already descriptive.
    result.semanticHealth !== "version_mismatch" &&
    result.semanticHealth !== "failed"
  ) {
    lines.push("No matching errors found. Try:");
    lines.push("- A numeric error code (e.g., `2002`)");
    lines.push("- A hex signature (e.g., `0xa5b2ba17`)");
    lines.push("- An error message substring (e.g., `insufficient fee`)");
  }

  return lines.join("\n");
}

/**
 * Format semantic search results from DocsGPT.
 */
export function formatSemanticSearchResults(result: SemanticSearchToolResult): string {
  const lines = [result.message, ""];

  if (!result.success || result.results.length === 0) {
    return lines.join("\n");
  }

  for (const match of result.results) {
    if (match.title) {
      lines.push(`**${match.title}**`);
    }
    if (match.source) {
      lines.push(`Source: ${match.source}`);
    }
    lines.push("");
    lines.push(match.text);
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}
