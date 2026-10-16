import { DocsGPTClient, DocsGPTClientError } from "../backends/docsgpt-client.js";
import { DEFAULT_AZTEC_VERSION } from "../repos/config.js";
import { getSourceMetadata } from "./sources.js";
import { getRepoCommit, getRepoTag } from "./git.js";

export type VersionGateResult =
  | { kind: "match"; localVersion: string; corpusVersion: string }
  | { kind: "mismatch"; localVersion: string; corpusVersion: string }
  | { kind: "unknown"; reason: string };

interface CachedEntry {
  value: string | null; // null = endpoint not available (404)
  cachedAt: number;
  positive: boolean;
}

const POSITIVE_TTL_MS = 5 * 60_000;
const NEGATIVE_TTL_MS = 30_000;

const cache = new Map<string, CachedEntry>();

/** Test-only: clear the in-memory cache between unit tests. */
export function _resetVersionCache(): void {
  cache.clear();
}

/** Normalize the optional v prefix, preserving release-candidate identity. */
export function normalizeVersion(raw: string | null | undefined): string {
  return (raw ?? "").trim().replace(/^v/, "");
}

/**
 * Fetch the corpus version, with TTL cache. Returns `null` only when
 * the endpoint 404s (older deployment); throws `DocsGPTClientError` for
 * other failure modes.
 */
async function fetchCorpusVersionCached(client: DocsGPTClient): Promise<string | null> {
  const key = client.baseUrl;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached) {
    const ttl = cached.positive ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
    if (now - cached.cachedAt < ttl) {
      return cached.value;
    }
  }

  try {
    const info = await client.getCorpusVersion();
    const value = info?.aztec_corpus_version ?? null;
    cache.set(key, { value, cachedAt: now, positive: true });
    return value;
  } catch (err) {
    cache.set(key, { value: null, cachedAt: now, positive: false });
    throw err;
  }
}

/**
 * Determine the recorded split release or legacy aztec-packages tag. Falls back to the
 * package's `DEFAULT_AZTEC_VERSION` when no clone exists yet, so a
 * fresh install can still be gated against the corpus.
 */
export async function getLocalVersion(): Promise<string> {
  const metadata = getSourceMetadata();
  const nodeCommit = metadata?.repositories?.["aztec-node"];
  if (nodeCommit) {
    if (await getRepoCommit("aztec-node", true) !== nodeCommit) {
      throw new Error("aztec-node does not match the recorded release. Run aztec_sync_repos again.");
    }
    return metadata.aztecVersion;
  }
  const tag = await getRepoTag("aztec-packages");
  return tag ?? DEFAULT_AZTEC_VERSION;
}

/**
 * Compute the version gate. Errors fetching `/api/version` resolve to
 * ``unknown`` — we never block search on transient backend issues; the
 * caller's existing error path handles those when the search itself
 * actually fails.
 */
export async function checkVersionGate(
  client: DocsGPTClient
): Promise<VersionGateResult> {
  const localVersion = await getLocalVersion();

  let corpusVersion: string | null;
  try {
    corpusVersion = await fetchCorpusVersionCached(client);
  } catch (err) {
    const detail = err instanceof DocsGPTClientError ? err.message : String(err);
    return {
      kind: "unknown",
      reason: `could not reach /api/version (${detail})`,
    };
  }

  if (corpusVersion === null) {
    return { kind: "unknown", reason: "/api/version not implemented by this backend" };
  }

  if (corpusVersion === "unknown" || corpusVersion === "") {
    return { kind: "unknown", reason: "backend has no AZTEC_CORPUS_VERSION configured" };
  }

  if (normalizeVersion(localVersion) === normalizeVersion(corpusVersion)) {
    return { kind: "match", localVersion, corpusVersion };
  }

  return { kind: "mismatch", localVersion, corpusVersion };
}

/**
 * Format a user-facing message for a mismatch. Designed to be embedded
 * in a tool result so the calling client (Cursor / Claude Desktop /
 * etc.) renders it inline. Names both versions and gives concrete
 * remediation.
 */
export function formatMismatchMessage(
  localVersion: string,
  corpusVersion: string
): string {
  return [
    `Version mismatch: your MCP server's local release is ${localVersion},`,
    `but the DocsGPT corpus is indexed at ${corpusVersion}.`,
    ``,
    `Querying across versions can return docs that don't apply to the code on your machine.`,
    ``,
    `To fix, choose one:`,
    `  • Run \`aztec_sync_repos\` with \`version: ${corpusVersion}\` to align your clone`,
    `    with the corpus.`,
    `  • Pass \`allowVersionMismatch: true\` to this tool call to query anyway`,
    `    (results will reflect the corpus version, not your local clone).`,
  ].join("\n");
}
