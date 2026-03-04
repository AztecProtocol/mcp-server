/**
 * Search utilities for finding content in cloned repositories
 */

import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join, relative, extname } from "path";
import { globbySync } from "globby";
import { REPOS_DIR, getRepoPath } from "./git.js";

export interface SearchResult {
  file: string;
  line?: number;
  content: string;
  repo: string;
}

export interface FileInfo {
  path: string;
  name: string;
  repo: string;
  type: "contract" | "test" | "typescript" | "docs" | "other";
}

/**
 * Search code using ripgrep (falls back to manual search if rg not available)
 */
export function searchCode(
  query: string,
  options: {
    filePattern?: string;
    repo?: string;
    maxResults?: number;
    caseSensitive?: boolean;
  } = {}
): SearchResult[] {
  const { filePattern = "*.nr", repo, maxResults = 50, caseSensitive = false } = options;

  const searchPath = repo ? getRepoPath(repo) : REPOS_DIR;

  if (!existsSync(searchPath)) {
    return [];
  }

  try {
    // Try ripgrep first (fast)
    const rgFlags = [
      caseSensitive ? "" : "-i",
      "-n", // line numbers
      "--no-heading",
      "-g",
      filePattern,
      "-m",
      String(maxResults * 2), // Get more, then trim
    ]
      .filter(Boolean)
      .join(" ");

    const result = execSync(`rg ${rgFlags} "${escapeShell(query)}" "${searchPath}"`, {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30000,
    });

    return parseRgOutput(result, maxResults);
  } catch (error) {
    // Ripgrep not found or no matches, fall back to manual search
    return manualSearch(query, searchPath, filePattern, maxResults, caseSensitive);
  }
}

/**
 * Search documentation files
 */
export function searchDocs(
  query: string,
  options: {
    section?: string;
    maxResults?: number;
  } = {}
): SearchResult[] {
  const { section, maxResults = 30 } = options;

  // Search versioned docs under developer_versioned_docs, narrowing by section if possible
  let repo: string | undefined;
  const versionedDocsGlob = join(REPOS_DIR, "aztec-packages-docs", "docs", "developer_versioned_docs");
  const versionDirs = existsSync(versionedDocsGlob) ? globbySync("version-*", { cwd: versionedDocsGlob, onlyDirectories: true }) : [];
  const versionDir = versionDirs[0];

  if (section && versionDir) {
    const sectionPath = join(versionedDocsGlob, versionDir, section);
    if (existsSync(sectionPath)) {
      repo = `aztec-packages-docs/docs/developer_versioned_docs/${versionDir}/${section}`;
    }
  }

  if (!repo && versionDir) {
    repo = `aztec-packages-docs/docs/developer_versioned_docs/${versionDir}`;
  }

  return searchCode(query, {
    filePattern: "*.{md,mdx}",
    repo: repo || "aztec-packages-docs",
    maxResults,
  });
}

/**
 * List example contracts
 */
export function listExamples(category?: string): FileInfo[] {
  const examples: FileInfo[] = [];

  // Search in aztec-examples
  const examplesPath = getRepoPath("aztec-examples");
  if (existsSync(examplesPath)) {
    const contracts = findContracts(examplesPath, "aztec-examples");
    examples.push(...contracts);
  }

  // Search in aztec-packages noir-contracts
  const noirContractsPath = join(
    getRepoPath("aztec-packages"),
    "noir-projects",
    "noir-contracts"
  );
  if (existsSync(noirContractsPath)) {
    const contracts = findContracts(noirContractsPath, "aztec-packages");
    examples.push(...contracts);
  }

  // Filter by category if specified
  if (category) {
    const lowerCategory = category.toLowerCase();
    return examples.filter(
      (e) =>
        e.name.toLowerCase().includes(lowerCategory) ||
        e.path.toLowerCase().includes(lowerCategory)
    );
  }

  return examples;
}

/**
 * Read a specific file
 */
export function readFile(filePath: string): string | null {
  // Handle relative paths from repos dir
  const fullPath = filePath.startsWith("/") ? filePath : join(REPOS_DIR, filePath);

  if (!existsSync(fullPath)) {
    return null;
  }

  try {
    return readFileSync(fullPath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Find an example contract by name
 */
export function findExample(name: string): FileInfo | null {
  const examples = listExamples();
  const lowerName = name.toLowerCase();

  // Exact match first
  let match = examples.find((e) => e.name.toLowerCase() === lowerName);

  // Partial match
  if (!match) {
    match = examples.find(
      (e) =>
        e.name.toLowerCase().includes(lowerName) ||
        e.path.toLowerCase().includes(lowerName)
    );
  }

  return match || null;
}

/**
 * Get numeric priority for a search result (lower = higher priority).
 * SDK sources rank above example apps.
 */
export function getResultPriority(result: SearchResult): number {
  const { repo, file } = result;

  if (repo === "aztec-packages") {
    if (/\baztec-nr\b/.test(file) || /\byarn-project\b/.test(file)) return 1;
    if (/\bnoir-contracts\b/.test(file)) return 2;
    // Other aztec-packages paths (boxes, playground, etc.)
    return 4;
  }

  if (repo === "noir") {
    if (/\bnoir_stdlib\b/.test(file)) return 3;
    return 4;
  }

  // Example apps / community repos
  return 5;
}

// --- Helper functions ---

/**
 * Escape a string for safe use inside double quotes in a shell command.
 * Preserves regex syntax (|, *, +, etc.) while preventing shell injection.
 */
function escapeShell(str: string): string {
  return str.replace(/["$`\\!]/g, "\\$&");
}

function parseRgOutput(output: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  const lines = output.split("\n").filter(Boolean);

  for (const line of lines) {
    // Format: /path/to/file:linenum:content
    const match = line.match(/^(.+?):(\d+):(.*)$/);
    if (match) {
      const [, filePath, lineNum, content] = match;
      const relativePath = relative(REPOS_DIR, filePath);
      const repoPart = relativePath.split("/")[0];

      results.push({
        file: relativePath,
        line: parseInt(lineNum, 10),
        content: content.trim(),
        repo: repoPart,
      });
    }
  }

  results.sort((a, b) => getResultPriority(a) - getResultPriority(b));
  return results.slice(0, maxResults);
}

function manualSearch(
  query: string,
  searchPath: string,
  filePattern: string,
  maxResults: number,
  caseSensitive: boolean
): SearchResult[] {
  const results: SearchResult[] = [];
  const pattern = filePattern.replace("*.", "**/*.");

  try {
    const files = globbySync(pattern, {
      cwd: searchPath,
      absolute: true,
      ignore: ["**/node_modules/**", "**/.git/**"],
    });

    let searchRegex: RegExp;
    try {
      searchRegex = new RegExp(query, caseSensitive ? "g" : "gi");
    } catch {
      searchRegex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "g" : "gi");
    }

    for (const file of files) {
      try {
        const content = readFileSync(file, "utf-8");
        const lines = content.split("\n");

        for (let i = 0; i < lines.length; i++) {
          if (searchRegex.test(lines[i])) {
            const relativePath = relative(REPOS_DIR, file);
            const repoPart = relativePath.split("/")[0];

            results.push({
              file: relativePath,
              line: i + 1,
              content: lines[i].trim(),
              repo: repoPart,
            });
          }

          // Reset regex lastIndex for global flag
          searchRegex.lastIndex = 0;
        }
      } catch {
        // Skip files that can't be read
      }
    }
  } catch {
    // Globby error, return empty
  }

  results.sort((a, b) => getResultPriority(a) - getResultPriority(b));
  return results.slice(0, maxResults);
}

function findContracts(basePath: string, repoName: string): FileInfo[] {
  const contracts: FileInfo[] = [];

  try {
    const files = globbySync("**/src/main.nr", {
      cwd: basePath,
      absolute: true,
      ignore: ["**/node_modules/**", "**/.git/**"],
    });

    for (const file of files) {
      const relativePath = relative(REPOS_DIR, file);
      // Extract contract name from path (usually parent directory)
      const parts = relativePath.split("/");
      const srcIndex = parts.indexOf("src");
      const name = srcIndex > 0 ? parts[srcIndex - 1] : parts[parts.length - 2];

      contracts.push({
        path: relativePath,
        name,
        repo: repoName,
        type: "contract",
      });
    }
  } catch {
    // Ignore errors
  }

  return contracts;
}

/**
 * Get file type from path
 */
export function getFileType(
  filePath: string
): "contract" | "test" | "typescript" | "docs" | "other" {
  const ext = extname(filePath).toLowerCase();
  const lowerPath = filePath.toLowerCase();

  if (ext === ".nr") {
    if (lowerPath.includes("test")) return "test";
    return "contract";
  }
  if (ext === ".ts" || ext === ".tsx") return "typescript";
  if (ext === ".md" || ext === ".mdx") return "docs";

  return "other";
}
