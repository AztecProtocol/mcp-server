/**
 * Tool registry - exports all MCP tools
 */

export { syncRepos, getStatus } from "./sync.js";
export {
  searchAztecCode,
  searchAztecDocs,
  listAztecExamples,
  readAztecExample,
  readRepoFile,
  type DocsSearchResult,
  type SemanticSearchToolResult,
} from "./search.js";
export { lookupAztecError } from "./error-lookup.js";
