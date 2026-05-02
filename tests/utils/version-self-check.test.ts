import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  fetchLatestNpmVersion,
  compareSemver,
  checkForUpgrade,
  getUpgradeInfo,
  setUpgradeInfo,
  formatUpgradeBanner,
  formatUpgradeStatusLine,
  _resetUpgradeCache,
} from "../../src/utils/version-self-check.js";

beforeEach(() => {
  _resetUpgradeCache();
  vi.restoreAllMocks();
});

describe("compareSemver", () => {
  it("compares core major.minor.patch numerically", () => {
    expect(compareSemver("1.2.3", "1.2.4")).toBe(-1);
    expect(compareSemver("1.2.4", "1.2.3")).toBe(1);
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("1.10.0", "1.2.0")).toBe(1); // numeric, not lexicographic
  });

  it("strips leading 'v'", () => {
    expect(compareSemver("v1.20.0", "1.20.0")).toBe(0);
    expect(compareSemver("v1.20.0", "v1.21.0")).toBe(-1);
  });

  it("ignores pre-release and build suffixes", () => {
    expect(compareSemver("1.20.0-rc.1", "1.20.0")).toBe(0);
    expect(compareSemver("1.20.0+build.42", "1.20.0")).toBe(0);
    expect(compareSemver("1.20.0-alpha", "1.20.0-beta")).toBe(0);
  });

  it("handles missing patch component", () => {
    expect(compareSemver("1.20", "1.20.0")).toBe(0);
    expect(compareSemver("1.21", "1.20.99")).toBe(1);
  });

  it("handles non-numeric garbage by treating as 0", () => {
    expect(compareSemver("abc.def.ghi", "0.0.0")).toBe(0);
  });
});

describe("fetchLatestNpmVersion", () => {
  it("returns the version string from a valid registry response", async () => {
    const fakeFetch: any = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ version: "1.99.0" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    expect(await fetchLatestNpmVersion(2000, fakeFetch)).toBe("1.99.0");
    expect(fakeFetch).toHaveBeenCalledWith(
      expect.stringContaining("registry.npmjs.org/@aztec/mcp-server/latest"),
      expect.any(Object)
    );
  });

  it("returns null on non-OK response", async () => {
    const fakeFetch: any = vi
      .fn()
      .mockResolvedValue(new Response("not found", { status: 404 }));
    expect(await fetchLatestNpmVersion(2000, fakeFetch)).toBeNull();
  });

  it("returns null on malformed body", async () => {
    const fakeFetch: any = vi.fn().mockResolvedValue(
      new Response("not json", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      })
    );
    expect(await fetchLatestNpmVersion(2000, fakeFetch)).toBeNull();
  });

  it("returns null on missing version field", async () => {
    const fakeFetch: any = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ name: "@aztec/mcp-server" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    expect(await fetchLatestNpmVersion(2000, fakeFetch)).toBeNull();
  });

  it("returns null on fetch rejection (network error / abort)", async () => {
    const fakeFetch: any = vi
      .fn()
      .mockRejectedValue(new Error("network unreachable"));
    expect(await fetchLatestNpmVersion(2000, fakeFetch)).toBeNull();
  });

  it("never throws, even with garbage rejection types", async () => {
    const fakeFetch: any = vi.fn().mockRejectedValue("just a string");
    await expect(fetchLatestNpmVersion(2000, fakeFetch)).resolves.toBeNull();
  });
});

describe("checkForUpgrade", () => {
  function fetchReturning(version: string | null): any {
    if (version === null) {
      return vi.fn().mockResolvedValue(new Response("nope", { status: 500 }));
    }
    return vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ version }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
  }

  it("populates the cache with outdated=true when running an older version", async () => {
    const info = await checkForUpgrade("1.15.0", { fetchImpl: fetchReturning("1.20.0") });
    expect(info).toEqual({ current: "1.15.0", latest: "1.20.0", outdated: true });
    expect(getUpgradeInfo()).toEqual(info);
  });

  it("populates the cache with outdated=false when up-to-date", async () => {
    const info = await checkForUpgrade("1.20.0", { fetchImpl: fetchReturning("1.20.0") });
    expect(info).toEqual({ current: "1.20.0", latest: "1.20.0", outdated: false });
    expect(getUpgradeInfo()?.outdated).toBe(false);
  });

  it("clears the cache to null on registry failure", async () => {
    setUpgradeInfo({ current: "x", latest: "y", outdated: true });
    const info = await checkForUpgrade("1.20.0", { fetchImpl: fetchReturning(null) });
    expect(info).toBeNull();
    expect(getUpgradeInfo()).toBeNull();
  });

  it("treats user pre-release as equal to stable (does not flag as outdated)", async () => {
    const info = await checkForUpgrade("1.20.0-rc.1", { fetchImpl: fetchReturning("1.20.0") });
    expect(info?.outdated).toBe(false);
  });
});

describe("formatUpgradeBanner", () => {
  it("includes both versions and the @latest pin guidance", () => {
    const banner = formatUpgradeBanner({
      current: "1.15.0",
      latest: "1.20.0",
      outdated: true,
    });
    expect(banner).toContain("v1.15.0");
    expect(banner).toContain("v1.20.0");
    expect(banner).toContain("@aztec/mcp-server@latest");
    expect(banner).toContain("UPDATE AVAILABLE");
    // Surface the install paths the README documents
    expect(banner).toContain("Claude Desktop");
    expect(banner).toContain("Claude Code");
  });
});

describe("formatUpgradeStatusLine", () => {
  it("returns empty string when no upgrade info available (registry check failed)", () => {
    expect(formatUpgradeStatusLine(null)).toBe("");
  });

  it("returns 'up to date' line when current matches latest", () => {
    expect(
      formatUpgradeStatusLine({ current: "1.20.0", latest: "1.20.0", outdated: false })
    ).toContain("up to date");
  });

  it("returns 'UPDATE AVAILABLE' line when outdated", () => {
    const line = formatUpgradeStatusLine({
      current: "1.15.0",
      latest: "1.20.0",
      outdated: true,
    });
    expect(line).toContain("UPDATE AVAILABLE");
    expect(line).toContain("v1.15.0");
    expect(line).toContain("v1.20.0");
    expect(line).toContain("@latest");
  });
});
