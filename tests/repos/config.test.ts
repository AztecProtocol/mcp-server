import { describe, it, expect } from "vitest";
import {
  AZTEC_REPOS,
  getAztecRepos,
  getRepoConfig,
  getRepoNames,
  DEFAULT_AZTEC_VERSION,
} from "../../src/repos/config.js";

describe("AZTEC_REPOS", () => {
  it("contains 7 repos, each with name/url/description", () => {
    expect(AZTEC_REPOS).toHaveLength(7);
    for (const repo of AZTEC_REPOS) {
      expect(repo.name).toBeTruthy();
      expect(repo.url).toBeTruthy();
      expect(repo.description).toBeTruthy();
    }
  });

  it("has sparse checkout arrays on aztec-packages and noir", () => {
    const ap = AZTEC_REPOS.find((r) => r.name === "aztec-packages");
    const noir = AZTEC_REPOS.find((r) => r.name === "noir");
    expect(ap?.sparse).toBeInstanceOf(Array);
    expect(ap!.sparse!.length).toBeGreaterThan(0);
    expect(noir?.sparse).toBeInstanceOf(Array);
    expect(noir!.sparse!.length).toBeGreaterThan(0);
  });

  it("aztec-packages has sparsePathOverrides for docs/docs on next branch", () => {
    const ap = AZTEC_REPOS.find((r) => r.name === "aztec-packages");
    expect(ap?.sparse).toContain("docs/docs");
    expect(ap?.sparsePathOverrides).toEqual([
      { paths: ["docs/docs"], branch: "next" },
    ]);
  });

  it('noir and noir-examples have branch: "master"', () => {
    const noir = AZTEC_REPOS.find((r) => r.name === "noir");
    const noirExamples = AZTEC_REPOS.find((r) => r.name === "noir-examples");
    expect(noir?.branch).toBe("master");
    expect(noirExamples?.branch).toBe("master");
  });
});

describe("getAztecRepos", () => {
  it("applies version tag only to AztecProtocol repos", () => {
    const repos = getAztecRepos();
    const aztecProtocolRepos = repos.filter((r) =>
      r.url.includes("AztecProtocol")
    );
    const otherRepos = repos.filter(
      (r) => !r.url.includes("AztecProtocol")
    );

    expect(aztecProtocolRepos).toHaveLength(5);
    for (const repo of aztecProtocolRepos) {
      expect(repo.tag).toBe(DEFAULT_AZTEC_VERSION);
    }

    for (const repo of otherRepos) {
      expect(repo.tag).toBeUndefined();
    }
  });

  it("uses custom version when provided", () => {
    const repos = getAztecRepos("v2.0.0");
    const aztecProtocolRepos = repos.filter((r) =>
      r.url.includes("AztecProtocol")
    );
    for (const repo of aztecProtocolRepos) {
      expect(repo.tag).toBe("v2.0.0");
    }
  });

  it("does not apply tags to noir-lang repos", () => {
    const repos = getAztecRepos("v2.0.0");
    const noirRepos = repos.filter((r) => r.url.includes("noir-lang"));

    expect(noirRepos).toHaveLength(2);

    for (const repo of noirRepos) {
      expect(repo.tag).toBeUndefined();
    }
  });
});

describe("getRepoConfig", () => {
  it("returns correct config for aztec-packages", () => {
    const config = getRepoConfig("aztec-packages");
    expect(config).toBeDefined();
    expect(config!.name).toBe("aztec-packages");
    expect(config!.url).toContain("AztecProtocol");
  });

  it("returns undefined for unknown name", () => {
    expect(getRepoConfig("nonexistent")).toBeUndefined();
  });
});

describe("getRepoNames", () => {
  it("returns all 7 names", () => {
    const names = getRepoNames();
    expect(names).toHaveLength(7);
    expect(names).toContain("aztec-packages");
    expect(names).toContain("noir");
    expect(names).toContain("noir-examples");
    expect(names).toContain("aztec-examples");
    expect(names).toContain("aztec-starter");
    expect(names).toContain("demo-wallet");
    expect(names).toContain("gregoswap");
  });
});
