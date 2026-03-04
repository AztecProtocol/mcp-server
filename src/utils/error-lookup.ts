/**
 * Error lookup utilities — dynamic parsers and matching algorithm.
 *
 * Parsers extract ErrorEntry[] from cloned source files at query time.
 * Results are cached for the session (parse once, reuse thereafter).
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { REPOS_DIR } from "./git.js";
import { searchCode } from "./search.js";
import type { SearchResult } from "./search.js";
import type { ErrorEntry, ErrorCategory } from "../data/error-catalog.js";
import { STATIC_ERROR_CATALOG } from "../data/error-catalog.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ErrorMatch {
  entry: ErrorEntry;
  matchType: "exact-code" | "hex-signature" | "exact-pattern" | "substring" | "word-overlap";
  score: number;
}

export interface ErrorLookupResult {
  catalogMatches: ErrorMatch[];
  codeMatches: SearchResult[];
  query: string;
}

// ---------------------------------------------------------------------------
// Session-level cache for parsed entries
// ---------------------------------------------------------------------------

let cachedDynamic: ErrorEntry[] | null = null;

export function clearErrorCache(): void {
  cachedDynamic = null;
}

// ---------------------------------------------------------------------------
// Dynamic parsers
// ---------------------------------------------------------------------------

function safeRead(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Parse Errors.sol for Solidity custom error definitions.
 * Format: `error Module__Name(type param); // 0xhexhash`
 */
export function parseSolidityErrors(filePath: string): ErrorEntry[] {
  const content = safeRead(filePath);
  if (!content) return [];

  const entries: ErrorEntry[] = [];
  const errorRegex = /^\s*error\s+(\w+)\(([^)]*)\);\s*(?:\/\/\s*(0x[0-9a-fA-F]+))?/gm;

  let match: RegExpExecArray | null;
  while ((match = errorRegex.exec(content)) !== null) {
    const [, fullName, , hexSig] = match;
    const parts = fullName.split("__");
    const module = parts.length > 1 ? parts[0] : "Unknown";
    const shortName = parts.length > 1 ? parts.slice(1).join("__") : fullName;

    // Build human-readable cause from the name
    const readable = shortName.replace(/([A-Z])/g, " $1").trim();

    const entry: ErrorEntry = {
      id: `l1-${fullName}`,
      name: fullName,
      category: "l1",
      patterns: [fullName.toLowerCase(), shortName.toLowerCase()],
      cause: `L1 ${module} error: ${readable}.`,
      fix: `Check L1 logs for ${module} errors. Inspect the transaction on the L1 block explorer for revert details.`,
      source: "Errors.sol",
    };

    if (hexSig) {
      entry.hexSignature = hexSig.toLowerCase();
      entry.patterns.push(hexSig.toLowerCase());
    }

    entries.push(entry);
  }

  return entries;
}

/**
 * Parse error_texts.ts for TX validation error constants.
 * Format: `export const TX_ERROR_FOO = 'Human readable message';`
 */
export function parseTxValidationErrors(filePath: string): ErrorEntry[] {
  const content = safeRead(filePath);
  if (!content) return [];

  const entries: ErrorEntry[] = [];
  const constRegex = /export\s+const\s+(TX_ERROR_\w+)\s*=\s*['"`]([^'"`]+)['"`]/g;

  // Extract section comments for categorization
  const lines = content.split("\n");
  let currentSection = "general";

  const sectionMap = new Map<number, string>();
  for (let i = 0; i < lines.length; i++) {
    const sectionMatch = lines[i].match(/\/\/\s*(.+)/);
    if (sectionMatch && !lines[i].includes("export")) {
      currentSection = sectionMatch[1].trim().toLowerCase();
      sectionMap.set(i, currentSection);
    }
  }

  let m: RegExpExecArray | null;
  while ((m = constRegex.exec(content)) !== null) {
    const [, constName, message] = m;

    // Find the section this constant belongs to
    const lineNum = content.substring(0, m.index).split("\n").length - 1;
    let section = "general";
    for (const [sLine, sName] of sectionMap) {
      if (sLine <= lineNum) section = sName;
    }

    entries.push({
      id: `tx-${constName}`,
      name: constName,
      category: "tx-validation",
      patterns: [constName.toLowerCase(), message.toLowerCase()],
      cause: message,
      fix: inferTxValidationFix(constName, section),
      source: "error_texts.ts",
    });
  }

  return entries;
}

function inferTxValidationFix(constName: string, section: string): string {
  const name = constName.toLowerCase();
  if (name.includes("fee") || name.includes("gas") || section.includes("gas")) {
    return "Increase the fee or gas limit in your transaction request.";
  }
  if (name.includes("nullifier") || section.includes("nullifier")) {
    return "Check for duplicate nullifiers. The note may have already been consumed.";
  }
  if (name.includes("proof") || section.includes("proof")) {
    return "Re-generate the proof. Ensure the proving system version matches the network.";
  }
  if (name.includes("size") || section.includes("size")) {
    return "Reduce the transaction size. Split into multiple smaller transactions if needed.";
  }
  if (name.includes("block") || name.includes("header") || section.includes("block")) {
    return "The transaction may reference a stale block. Retry with a fresh simulation.";
  }
  return "Review the transaction parameters and retry.";
}

/**
 * Parse debugging.md for error→solution tables.
 * Expects markdown table rows: `| error message | solution |`
 */
export function parseDebuggingDoc(filePath: string): ErrorEntry[] {
  const content = safeRead(filePath);
  if (!content) return [];

  const entries: ErrorEntry[] = [];
  const lines = content.split("\n");

  let inTable = false;
  let headerSkipped = false;
  let tableCategory: ErrorCategory = "general";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Detect section headers for categorization
    if (line.startsWith("##")) {
      const heading = line.replace(/^#+\s*/, "").toLowerCase();
      if (heading.includes("sequencer")) tableCategory = "sequencer";
      else if (heading.includes("contract")) tableCategory = "contract";
      else tableCategory = "general";
      inTable = false;
      headerSkipped = false;
    }

    // Detect table start (header row)
    if (line.startsWith("|") && line.includes("|") && !inTable) {
      inTable = true;
      headerSkipped = false;
      continue;
    }

    // Skip separator row
    if (inTable && !headerSkipped && line.match(/^\|[\s-|]+\|$/)) {
      headerSkipped = true;
      continue;
    }

    // Parse table data rows
    if (inTable && headerSkipped && line.startsWith("|")) {
      const cells = line
        .split("|")
        .map((c) => c.trim())
        .filter((c) => c.length > 0);

      if (cells.length >= 2) {
        const errorMsg = cells[0].replace(/`/g, "").trim();
        const solution = cells[1].trim();

        if (errorMsg && solution) {
          entries.push({
            id: `debug-${createHash("md5").update(errorMsg).digest("hex").slice(0, 8)}`,
            name: errorMsg,
            category: tableCategory,
            patterns: [errorMsg.toLowerCase()],
            cause: errorMsg,
            fix: solution,
            source: "debugging.md",
          });
        }
      }
    }

    // End of table
    if (inTable && headerSkipped && !line.startsWith("|") && line.length > 0) {
      inTable = false;
      headerSkipped = false;
    }
  }

  return entries;
}

/**
 * Parse operator-faq.md for error headings and their solutions.
 * Format: `### Issue Title` followed by **Symptom**: / **Cause**: / **Solution**:
 */
export function parseOperatorFaq(filePath: string): ErrorEntry[] {
  const content = safeRead(filePath);
  if (!content) return [];

  const entries: ErrorEntry[] = [];
  const lines = content.split("\n");

  let currentTitle = "";
  let symptom = "";
  let cause = "";
  let fix = "";

  function flush() {
    if (currentTitle && (cause || symptom)) {
      entries.push({
        id: `op-${createHash("md5").update(currentTitle).digest("hex").slice(0, 8)}`,
        name: currentTitle,
        category: "operator",
        patterns: [
          currentTitle.toLowerCase(),
          ...(symptom ? [symptom.toLowerCase()] : []),
        ],
        cause: cause || symptom || currentTitle,
        fix: fix || "See the operator FAQ documentation for detailed steps.",
        source: "operator-faq.md",
      });
    }
    currentTitle = "";
    symptom = "";
    cause = "";
    fix = "";
  }

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("### ")) {
      flush();
      currentTitle = trimmed.replace(/^###\s*/, "");
      continue;
    }

    const symptomMatch = trimmed.match(/^\*\*Symptom\*\*:\s*(.*)/);
    if (symptomMatch) {
      symptom = symptomMatch[1];
      continue;
    }

    const causeMatch = trimmed.match(/^\*\*Cause\*\*:\s*(.*)/);
    if (causeMatch) {
      cause = causeMatch[1];
      continue;
    }

    const fixMatch = trimmed.match(/^\*\*Solutions?\*\*:\s*(.*)/);
    if (fixMatch) {
      fix = fixMatch[1];
      continue;
    }
  }

  flush();
  return entries;
}

// ---------------------------------------------------------------------------
// Collect all entries (static + dynamic)
// ---------------------------------------------------------------------------

function getDynamicEntries(): ErrorEntry[] {
  if (cachedDynamic) return cachedDynamic;

  const entries: ErrorEntry[] = [];

  // Solidity errors
  const errorsPath = join(REPOS_DIR, "aztec-packages", "l1-contracts", "src", "core", "libraries", "Errors.sol");
  entries.push(...parseSolidityErrors(errorsPath));

  // TX validation errors — search a few known locations
  const txErrorPaths = [
    join(REPOS_DIR, "aztec-packages", "yarn-project", "stdlib", "src", "tx", "validator", "error_texts.ts"),
    join(REPOS_DIR, "aztec-packages", "yarn-project", "circuit-types", "src", "tx", "validator", "error_texts.ts"),
  ];
  for (const p of txErrorPaths) {
    const parsed = parseTxValidationErrors(p);
    if (parsed.length > 0) {
      entries.push(...parsed);
      break;
    }
  }

  // Debugging doc (lives in aztec-packages-docs, cloned from `next` branch)
  const debugPaths = [
    join(REPOS_DIR, "aztec-packages-docs", "docs", "docs-developers", "docs", "aztec-nr", "debugging.md"),
    join(REPOS_DIR, "aztec-packages", "docs", "docs-developers", "docs", "aztec-nr", "debugging.md"),
  ];
  for (const p of debugPaths) {
    const parsed = parseDebuggingDoc(p);
    if (parsed.length > 0) {
      entries.push(...parsed);
      break;
    }
  }

  // Operator FAQ (lives in aztec-packages-docs, cloned from `next` branch)
  const faqPaths = [
    join(REPOS_DIR, "aztec-packages-docs", "docs", "docs-operate", "operators", "operator-faq.md"),
    join(REPOS_DIR, "aztec-packages", "docs", "docs-operate", "operators", "operator-faq.md"),
  ];
  for (const p of faqPaths) {
    const parsed = parseOperatorFaq(p);
    if (parsed.length > 0) {
      entries.push(...parsed);
      break;
    }
  }

  cachedDynamic = entries;
  return entries;
}

function getAllEntries(): ErrorEntry[] {
  return [...STATIC_ERROR_CATALOG, ...getDynamicEntries()];
}

// ---------------------------------------------------------------------------
// Matching algorithm
// ---------------------------------------------------------------------------

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1)
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const w of a) {
    if (b.has(w)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

function matchEntry(entry: ErrorEntry, query: string, queryLower: string, queryTokens: Set<string>): ErrorMatch | null {
  // 1. Exact error code match
  if (entry.errorCode !== undefined && /^\d+$/.test(query) && entry.errorCode === parseInt(query, 10)) {
    return { entry, matchType: "exact-code", score: 100 };
  }

  // 2. Hex signature match
  if (entry.hexSignature && queryLower.startsWith("0x") && entry.hexSignature === queryLower) {
    return { entry, matchType: "hex-signature", score: 100 };
  }

  // 3. Exact pattern match
  for (const pattern of entry.patterns) {
    if (pattern === queryLower) {
      return { entry, matchType: "exact-pattern", score: 95 };
    }
  }

  // 4. Substring match
  for (const pattern of entry.patterns) {
    if (pattern.includes(queryLower)) {
      return { entry, matchType: "substring", score: 80 };
    }
    if (queryLower.includes(pattern) && pattern.length > 3) {
      return { entry, matchType: "substring", score: 70 };
    }
  }

  // 5. Word overlap (Jaccard)
  let bestJaccard = 0;
  for (const pattern of entry.patterns) {
    const patternTokens = tokenize(pattern);
    const j = jaccard(queryTokens, patternTokens);
    if (j > bestJaccard) bestJaccard = j;
  }
  // Also check name
  const nameJ = jaccard(queryTokens, tokenize(entry.name));
  if (nameJ > bestJaccard) bestJaccard = nameJ;

  if (bestJaccard >= 0.25) {
    const score = Math.round(50 + bestJaccard * 15);
    return { entry, matchType: "word-overlap", score: Math.min(score, 65) };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main lookup function
// ---------------------------------------------------------------------------

export function lookupError(
  query: string,
  options: { category?: string; maxResults?: number } = {}
): ErrorLookupResult {
  const { category, maxResults = 10 } = options;
  const queryLower = query.toLowerCase().trim();
  const queryTokens = tokenize(query);

  const allEntries = getAllEntries();
  const matches: ErrorMatch[] = [];

  for (const entry of allEntries) {
    // Category filter
    if (category && entry.category !== category) continue;

    const m = matchEntry(entry, query.trim(), queryLower, queryTokens);
    if (m) matches.push(m);
  }

  // Sort by score descending
  matches.sort((a, b) => b.score - a.score);
  const catalogMatches = matches.slice(0, maxResults);

  // Fallback: if fewer than 3 catalog matches, search code
  let codeMatches: SearchResult[] = [];
  if (catalogMatches.length < 3) {
    try {
      codeMatches = searchCode(query, {
        filePattern: "*.ts",
        repo: "aztec-packages",
        maxResults: Math.min(maxResults, 5),
      });
    } catch {
      // Repos may not be cloned — that's fine
    }
  }

  return { catalogMatches, codeMatches, query };
}
