/**
 * Formatting utilities for MCP tool responses
 */

import type { SyncResult } from "../tools/sync.js";
import type { SearchResult, FileInfo } from "./search.js";
import type { SyncMetadata } from "./sync-metadata.js";

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
    const icon = repo.status.toLowerCase().includes("error") ? "✗" : "✓";
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
    `Repos directory: ${status.reposDir}`,
  ];

  if (status.syncMetadata) {
    lines.push(`Last synced: ${status.syncMetadata.syncedAt}`);
    lines.push(`MCP server version: ${status.syncMetadata.mcpVersion}`);
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
