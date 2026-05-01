/**
 * Version-sync gate between the MCP server's local aztec-packages
 * clone and the DocsGPT backend's indexed corpus.
 *
 * Why: an MCP user with a v4.1.0 clone querying a v4.2.0 corpus will
 * get answers from the wrong version of the docs and not realize it.
 * Surfacing the mismatch up front lets them re-sync their clone (or
 * intentionally cross-query with `allowVersionMismatch: true`).
 *
 * Design:
 *   - Per-process, in-memory cache keyed by base URL. 5-minute positive
 *     TTL — short enough that an operator rolling out a new corpus
 *     version sees the new value within minutes; long enough that
 *     repeated tool calls don't pound `/api/version`.
 *   - 30-second negative TTL for transient errors (network blips,
 *     temporary 5xx). Short so a Phase-1-deployed-after-Phase-2 MCP
 *     starts seeing real version data quickly without operator action.
 *   - 404 → `"unknown"` cached at the positive TTL, since an older
 *     docsgpt deployment that doesn't ship the endpoint won't suddenly
 *     start shipping it within seconds.
 */

import { DocsGPTClient, DocsGPTClientError } from "../backends/docsgpt-client.js";
import { DEFAULT_AZTEC_VERSION } from "../repos/config.js";
import { getRepoTag } from "./git.js";

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

/**
 * Strip the leading ``v`` and any pre-release suffix.
 * ``v4.2.0-aztecnr-rc.2`` → ``4.2.0``. ``v4.2.0`` → ``4.2.0``.
 * Used as the equality key. Patch-level differences still compare
 * unequal — we deliberately do NOT collapse to major.minor since
 * docs/APIs can change at the patch level.
 */
export function normalizeVersion(raw: string | null | undefined): string {
  if (!raw) return "";
  let v = raw.trim();
  if (v.startsWith("v")) v = v.slice(1);
  const dash = v.indexOf("-");
  if (dash >= 0) v = v.slice(0, dash);
  return v;
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
 * Determine the local aztec-packages version. Falls back to the
 * package's `DEFAULT_AZTEC_VERSION` when no clone exists yet, so a
 * fresh install can still be gated against the corpus.
 */
export async function getLocalVersion(): Promise<string> {
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
    `Version mismatch: your MCP server's aztec-packages clone is at ${localVersion},`,
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
