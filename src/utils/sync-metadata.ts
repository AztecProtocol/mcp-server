import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { REPOS_DIR } from "./git.js";
import { MCP_VERSION } from "../version.js";

export interface SyncMetadata {
  mcpVersion: string;
  syncedAt: string;
  aztecVersion: string;
  autoResyncAttempt?: {
    targetMcpVersion: string;
    attemptedAt: string;
    result?: "deferred" | "retryable" | "hard_failure";
  };
}

export type SyncState =
  | { kind: "upToDate" }
  | { kind: "needsAutoResync"; aztecVersion: string }
  | { kind: "legacyUnknownVersion" }
  | { kind: "noRepos" };

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

/**
 * Record a failed auto-resync attempt so we don't retry on every request.
 * Preserves existing metadata fields; creates minimal metadata if none exists.
 */
export function writeAutoResyncAttempt(
  result?: "deferred" | "retryable" | "hard_failure",
): void {
  const existing = readSyncMetadata();
  const metadata: SyncMetadata = existing ?? {
    mcpVersion: "unknown",
    syncedAt: "",
    aztecVersion: "",
  };
  metadata.autoResyncAttempt = {
    targetMcpVersion: MCP_VERSION,
    attemptedAt: new Date().toISOString(),
    result,
  };
  writeFileSync(getMetadataPath(), JSON.stringify(metadata, null, 2));
}

/**
 * Update just the mcpVersion in existing metadata (or create minimal metadata).
 * Used after partial syncs so the install is not mistaken for a legacy or
 * stale-version install that needs a full auto-resync.
 */
export function stampMetadataMcpVersion(aztecVersion: string): void {
  const existing = readSyncMetadata();
  const metadata: SyncMetadata = existing ?? {
    mcpVersion: MCP_VERSION,
    syncedAt: new Date().toISOString(),
    aztecVersion,
  };
  metadata.mcpVersion = MCP_VERSION;
  if (!metadata.aztecVersion) {
    metadata.aztecVersion = aztecVersion;
  }
  delete metadata.autoResyncAttempt;
  writeFileSync(getMetadataPath(), JSON.stringify(metadata, null, 2));
}

/**
 * Determine whether auto-resync is needed based on persisted metadata.
 *
 * States:
 * - noRepos: fresh install, no repos dir exists
 * - legacyUnknownVersion: repos exist but no metadata (pre-metadata install),
 *   or metadata exists with unknown aztecVersion from a prior failed attempt
 * - needsAutoResync: metadata version doesn't match current MCP version
 * - upToDate: versions match, or auto-resync already attempted for this version
 */
export function getSyncState(): SyncState {
  const metadata = readSyncMetadata();
  if (!metadata) {
    if (!existsSync(REPOS_DIR)) return { kind: "noRepos" };
    // A failed initial sync can leave REPOS_DIR empty — treat that as noRepos
    // rather than legacyUnknownVersion (which would trigger auto-resync and
    // then writeAutoResyncAttempt, permanently suppressing retries).
    try {
      const hasRepos = readdirSync(REPOS_DIR).some((e) => !e.startsWith("."));
      return hasRepos ? { kind: "legacyUnknownVersion" } : { kind: "noRepos" };
    } catch {
      return { kind: "noRepos" };
    }
  }
  if (metadata.mcpVersion === MCP_VERSION) {
    return { kind: "upToDate" };
  }
  // Version mismatch — already attempted auto-resync for this MCP version?
  if (metadata.autoResyncAttempt?.targetMcpVersion === MCP_VERSION) {
    const attempt = metadata.autoResyncAttempt;
    // Retryable failures back off for 30 minutes then allow a retry
    if (attempt.result === "retryable") {
      const elapsed = Date.now() - new Date(attempt.attemptedAt).getTime();
      if (elapsed < 30 * 60 * 1000) {
        return { kind: "upToDate" };
      }
      // Backoff expired — fall through to needsAutoResync
    } else {
      // hard_failure, deferred, or undefined (backwards compat) — permanent suppress
      return { kind: "upToDate" };
    }
  }
  // Version mismatch with unknown aztec version — treat as legacy
  if (!metadata.aztecVersion) {
    return { kind: "legacyUnknownVersion" };
  }
  return { kind: "needsAutoResync", aztecVersion: metadata.aztecVersion };
}
