/**
 * Configuration for Aztec repositories to clone and search
 */

export interface RepoConfig {
  /** Unique name for the repo */
  name: string;
  /** Git URL to clone from */
  url: string;
  /** Branch to checkout (defaults to main/master) */
  branch?: string;
  /** Tag to checkout (overrides branch if specified) */
  tag?: string;
  /** Specific commit to checkout (overrides tag and branch) */
  commit?: string;
  /** Sparse checkout paths - if set, only these paths are checked out */
  sparse?: string[];
  /** Description of what this repo contains */
  description: string;
  /** File patterns to search (for categorization) */
  searchPatterns?: {
    code?: string[];
    docs?: string[];
  };
  /** Skip applying the version tag to this repo (clone default branch instead) */
  skipVersionTag?: boolean;
  /** Override specific sparse paths to come from a different branch instead of the tag */
  sparsePathOverrides?: { paths: string[]; branch: string }[];
}

/** Default Aztec version (tag) to use - can be overridden via AZTEC_DEFAULT_VERSION env var */
export const DEFAULT_AZTEC_VERSION = process.env.AZTEC_DEFAULT_VERSION || "v4.0.0-devnet.2-patch.1";

/**
 * Base Aztec repository configurations (without version)
 */
const BASE_REPOS: Omit<RepoConfig, "tag">[] = [
  {
    name: "aztec-packages",
    url: "https://github.com/AztecProtocol/aztec-packages",
    sparse: [
      "noir-projects/aztec-nr",
      "noir-projects/noir-contracts",
      "yarn-project",
      "barretenberg/ts/src",
      "boxes",
      "playground",
    ],
    sparsePathOverrides: [
      {
        paths: [
          "docs/developer_versioned_docs/version-{version}",
          "docs/static/aztec-nr-api/devnet",
          "docs/static/typescript-api/devnet",
        ],
        branch: "next",
      },
    ],
    description: "Main Aztec monorepo - documentation, aztec-nr framework, and reference contracts",
    searchPatterns: {
      code: ["*.nr", "*.ts"],
      docs: ["*.md", "*.mdx"],
    },
  },
  {
    name: "aztec-examples",
    url: "https://github.com/AztecProtocol/aztec-examples",
    description: "Official Aztec contract examples and sample applications",
    searchPatterns: {
      code: ["*.nr", "*.ts"],
      docs: ["*.md"],
    },
  },
  {
    name: "aztec-starter",
    url: "https://github.com/AztecProtocol/aztec-starter",
    description: "Aztec starter template with deployment scripts and TypeScript integration",
    searchPatterns: {
      code: ["*.nr", "*.ts"],
      docs: ["*.md"],
    },
  },
  {
    name: "noir",
    url: "https://github.com/noir-lang/noir",
    branch: "master",
    sparse: [
      "docs",
      "noir_stdlib",
      "tooling",
    ],
    description: "Noir language compiler, standard library, and tooling",
    searchPatterns: {
      code: ["*.nr", "*.rs"],
      docs: ["*.md"],
    },
  },
  {
    name: "noir-examples",
    url: "https://github.com/noir-lang/noir-examples",
    branch: "master",
    description: "Official Noir language examples and tutorials",
    searchPatterns: {
      code: ["*.nr", "*.ts"],
      docs: ["*.md"],
    },
  },
  {
    name: "demo-wallet",
    url: "https://github.com/AztecProtocol/demo-wallet",
    description: "Aztec demo wallet application",
    searchPatterns: {
      code: ["*.nr", "*.ts"],
      docs: ["*.md"],
    },
  },
  {
    name: "gregoswap",
    url: "https://github.com/AztecProtocol/gregoswap",
    skipVersionTag: true,
    description: "Gregoswap - token swap application built on Aztec",
    searchPatterns: {
      code: ["*.nr", "*.ts"],
      docs: ["*.md"],
    },
  }
];

/**
 * Get Aztec repositories configured for a specific version
 * @param version - The Aztec version tag (e.g., "v4.0.0-devnet.2-patch.1")
 */
export function getAztecRepos(version?: string): RepoConfig[] {
  const tag = version || DEFAULT_AZTEC_VERSION;

  return BASE_REPOS.map((repo) => ({
    ...repo,
    // Only apply version tag to Aztec repos that don't opt out
    tag: repo.url.includes("AztecProtocol") && !repo.skipVersionTag ? tag : undefined,
    // Resolve {version} placeholders in sparse path overrides
    sparsePathOverrides: repo.sparsePathOverrides?.map((override) => ({
      ...override,
      paths: override.paths.map((p) => p.replace("{version}", tag)),
    })),
  }));
}

/**
 * Aztec repositories with default version
 */
export const AZTEC_REPOS: RepoConfig[] = getAztecRepos();

/**
 * Get repo config by name
 */
export function getRepoConfig(name: string): RepoConfig | undefined {
  return AZTEC_REPOS.find((repo) => repo.name === name);
}

/**
 * Get all repo names
 */
export function getRepoNames(): string[] {
  return AZTEC_REPOS.map((repo) => repo.name);
}
