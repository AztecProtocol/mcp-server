/**
 * Self-check for outdated installs of @aztec/mcp-server.
 *
 * Why: npx caches packages, and users frequently end up running an old
 * version while assuming `npx @aztec/mcp-server` always pulls the latest.
 * The result is silently-degraded behavior + bug reports against fixes
 * that have already shipped. This module fetches the current latest tag
 * from the npm registry at startup, compares against the running
 * version, and surfaces a warning into both the MCP `instructions`
 * banner (so the LLM tells the user) and `aztec_status` (so a curious
 * user running diagnostics also sees it).
 *
 * Failure modes are silent (registry down, no network, slow response)
 * — the check should never block startup or fail the server. Worst
 * case: no banner, business as usual.
 */

const NPM_REGISTRY_URL = "https://registry.npmjs.org/@aztec/mcp-server/latest";

export interface UpgradeInfo {
  current: string;
  latest: string;
  outdated: boolean;
}

let upgradeInfoCache: UpgradeInfo | null = null;

/**
 * Test-only: reset the module-level upgrade cache between tests.
 */
export function _resetUpgradeCache(): void {
  upgradeInfoCache = null;
}

export function setUpgradeInfo(info: UpgradeInfo | null): void {
  upgradeInfoCache = info;
}

export function getUpgradeInfo(): UpgradeInfo | null {
  return upgradeInfoCache;
}

/**
 * Fetch the latest published version of @aztec/mcp-server from npm.
 * Returns null on any failure (network, timeout, malformed body) —
 * never throws, so callers don't have to wrap in try/catch.
 */
export async function fetchLatestNpmVersion(
  timeoutMs: number = 2000,
  fetchImpl: typeof fetch = fetch
): Promise<string | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  // `unref` (Node-only) prevents this timer from keeping the event
  // loop alive on its own. Critical for short-lived processes and
  // tests where a forgotten timer would block exit. Optional-chained
  // because `setTimeout` in browser-shaped environments returns a
  // primitive number with no `unref` — the optional call is safe.
  (timer as unknown as { unref?: () => void }).unref?.();
  try {
    const resp = await fetchImpl(NPM_REGISTRY_URL, { signal: ctl.signal });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data || typeof data !== "object") return null;
    const v = (data as Record<string, unknown>).version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  } finally {
    // Always clear: the previous implementation only cleared on the
    // success path, leaking the timer when `fetchImpl` rejected
    // (network error, CORS, malformed body) before the timeout
    // fired. Combined with `unref` above this is belt-and-braces.
    clearTimeout(timer);
  }
}

/**
 * Numeric major.minor.patch comparison. Strips a leading ``v`` and
 * any pre-release / build suffix (so ``1.20.0-rc.1`` and ``1.20.0``
 * compare equal — we don't want to flag a stable user as outdated
 * relative to a pre-release on npm).
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const parse = (v: string): number[] => {
    const core = v.replace(/^v/, "").split("-")[0].split("+")[0];
    return core.split(".").map((p) => {
      const n = parseInt(p, 10);
      return Number.isFinite(n) ? n : 0;
    });
  };
  const ma = parse(a);
  const mb = parse(b);
  for (let i = 0; i < Math.max(ma.length, mb.length); i++) {
    const x = ma[i] ?? 0;
    const y = mb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/**
 * High-level entry: fetch + compare + cache. Returns the populated
 * cache entry (also retrievable via ``getUpgradeInfo()``).
 */
export async function checkForUpgrade(
  currentVersion: string,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}
): Promise<UpgradeInfo | null> {
  const latest = await fetchLatestNpmVersion(
    options.timeoutMs,
    options.fetchImpl ?? fetch
  );
  if (!latest) {
    setUpgradeInfo(null);
    return null;
  }
  const info: UpgradeInfo = {
    current: currentVersion,
    latest,
    outdated: compareSemver(currentVersion, latest) < 0,
  };
  setUpgradeInfo(info);
  return info;
}

/**
 * Format the upgrade warning that gets appended to the MCP server
 * instructions banner. The text is consumed by the LLM, not directly
 * by a human, so it explains what the LLM should *do*: tell the user
 * to update. Listed remediation commands match the install paths
 * documented in the README so the LLM can copy-paste them.
 */
export function formatUpgradeBanner(info: UpgradeInfo): string {
  return [
    "",
    "",
    `⚠️  UPDATE AVAILABLE: this MCP server is running v${info.current}, but v${info.latest} is the current release on npm. ` +
      `Tell the user they're on an outdated version, and that bug reports about behavior may already be fixed in the latest release. ` +
      `To upgrade, ensure their MCP client config uses \`@aztec/mcp-server@latest\` so npx fetches the newest:`,
    `  • Claude Desktop / Cursor / Codex: change the args to ` +
      `["-y", "@aztec/mcp-server@latest"] in the MCP server config and restart the client.`,
    `  • Claude Code: \`claude mcp remove aztec-docs && claude mcp add aztec-docs ... -- npx -y @aztec/mcp-server@latest\``,
    `  • If installed globally: \`npm uninstall -g @aztec/mcp-server && npm install -g @aztec/mcp-server@latest\` (or just rely on npx).`,
  ].join("\n");
}

/**
 * Format a one-line upgrade summary suitable for inclusion in the
 * ``aztec_status`` output. Returns the empty string when the install
 * is current (so the formatter can unconditionally include it).
 */
export function formatUpgradeStatusLine(info: UpgradeInfo | null): string {
  if (!info) return "";
  if (!info.outdated) {
    return `npm latest: v${info.latest} (you are up to date)`;
  }
  return (
    `⚠️  UPDATE AVAILABLE: v${info.current} → v${info.latest} on npm. ` +
    `Switch your MCP config to \`@aztec/mcp-server@latest\` and restart the client.`
  );
}
