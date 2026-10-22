import { describe, it, expect } from "vitest";
import { AZTEC_REPOS, getAztecRepos, getRepoConfig, getRepoNames, DEFAULT_AZTEC_VERSION } from "../../src/repos/config.js";

describe("v6 repositories", () => {
  it("defaults to just aztec-node, with protocol and Noir sources optional", () => {
    expect(DEFAULT_AZTEC_VERSION).toBe("v6.0.0");
    expect(AZTEC_REPOS.filter((repo) => !repo.optional).map((repo) => repo.name)).toEqual(["aztec-node"]);
    expect(getRepoNames()).toEqual(["aztec-node", "aztec-packages", "noir"]);
    expect(getRepoConfig("unknown")).toBeUndefined();
  });

  it("resolves the node commit during sync instead of applying an Aztec tag to it", () => {
    const node = getRepoConfig("aztec-node")!;
    expect(node.url).toBe("https://github.com/aztec-labs-eng/aztec-node");
    expect(node.tag).toBeUndefined();
    expect(node.branch).toBeUndefined();
    expect(node.sparse).toContain("noir-projects/noir-contracts");
    expect(node.sparse).toContain("docs/developer_versioned_docs/version-v6.0.0");
    expect(node.sparsePathOverrides).toBeUndefined();
  });

  it("accepts tags without a v prefix while using canonical documentation paths", () => {
    const node = getAztecRepos("6.0.0")[0];
    expect(node.sparse).toContain("docs/developer_versioned_docs/version-v6.0.0");
  });

  it("uses the split protocol layout for optional aztec-packages sources", () => {
    const protocol = getRepoConfig("aztec-packages")!;
    expect(protocol.optional).toBe(true);
    expect(protocol.sparse).toContain("barretenberg/ts/bb.js/src");
    expect(protocol.sparse).not.toContain("yarn-project");
    expect(protocol.sparsePathOverrides).toBeUndefined();
  });
});

describe("legacy versions", () => {
  it("retains the seven-repository layout and documentation overrides", () => {
    const repos = getAztecRepos("v4.3.0");
    expect(repos).toHaveLength(7);
    expect(repos.some((repo) => repo.name === "aztec-node")).toBe(false);
    const packages = repos.find((repo) => repo.name === "aztec-packages")!;
    expect(packages.sparsePathOverrides?.[0].paths).toContain("docs/developer_versioned_docs/version-v4.3.0");
  });

  it("applies custom tags only to versioned Aztec repositories", () => {
    const repos = getAztecRepos("v2.0.0");
    const tagged = repos.filter((repo) => repo.tag);
    expect(tagged).toHaveLength(4);
    expect(tagged.every((repo) => repo.tag === "v2.0.0")).toBe(true);
    expect(repos.filter((repo) => repo.url.includes("noir-lang")).every((repo) => !repo.tag)).toBe(true);
    expect(repos.find((repo) => repo.name === "gregoswap")?.tag).toBeUndefined();
  });
});
