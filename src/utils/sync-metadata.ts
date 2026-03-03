import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { REPOS_DIR } from "./git.js";
import { MCP_VERSION } from "../version.js";

export interface SyncMetadata {
  mcpVersion: string;
  syncedAt: string;
  aztecVersion: string;
}

export function getMetadataPath(): string {
  return join(REPOS_DIR, ".sync-metadata.json");
}

export function writeSyncMetadata(aztecVersion: string): void {
  const metadata: SyncMetadata = {
    mcpVersion: MCP_VERSION,
    syncedAt: new Date().toISOString(),
    aztecVersion,
  };
  writeFileSync(getMetadataPath(), JSON.stringify(metadata, null, 2));
}

export function readSyncMetadata(): SyncMetadata | null {
  try {
    const raw = readFileSync(getMetadataPath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.mcpVersion === "string") {
      return parsed as SyncMetadata;
    }
    return null;
  } catch {
    return null;
  }
}

export function needsResync(): SyncMetadata | null {
  const metadata = readSyncMetadata();
  if (!metadata) {
    return null;
  }
  if (metadata.mcpVersion !== MCP_VERSION) {
    return metadata;
  }
  return null;
}
