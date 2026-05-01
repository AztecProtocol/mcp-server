/**
 * DocsGPT HTTP client for semantic search over Aztec documentation.
 *
 * Ported from the standalone aztec-docs MCP server. Talks to a DocsGPT
 * instance that hosts a vector knowledge base of Aztec developer docs,
 * framework source, example contracts, and more.
 */

export interface SemanticSearchResult {
  text: string;
  title: string;
  source: string;
}

export interface CorpusVersionInfo {
  /** Tag the backend has indexed, or `"unknown"` when the operator
   *  hasn't set ``AZTEC_CORPUS_VERSION``. */
  aztec_corpus_version: string;
  /** Number of public sources the backend is wired to. Informational. */
  source_count?: number;
}

export class DocsGPTClientError extends Error {
  constructor(
    message: string,
    public statusCode?: number
  ) {
    super(message);
    this.name = "DocsGPTClientError";
  }
}

export interface DocsGPTClientConfig {
  apiUrl: string;
  apiKey: string;
  timeout?: number;
}

// Hard bounds on the `chunks` parameter. Mirrors the docsgpt backend's
// own clamp (see application/api/answer/routes/search.py). Values below
// the minimum become 1 silently; values above the max get clipped to 20.
export const CHUNKS_MIN = 1;
export const CHUNKS_MAX = 20;

function clampChunks(raw: number): number {
  if (!Number.isFinite(raw)) return 5;
  const truncated = Math.trunc(raw);
  return Math.min(CHUNKS_MAX, Math.max(CHUNKS_MIN, truncated));
}

export class DocsGPTClient {
  private apiKey: string;
  private timeout: number;
  /** Public so callers (e.g. version-check cache key) can identify the
   *  backend without poking at private state. */
  public readonly baseUrl: string;

  constructor(config: DocsGPTClientConfig) {
    this.baseUrl = config.apiUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.timeout = config.timeout ?? 60_000;
  }

  async search(
    query: string,
    chunks: number = 5
  ): Promise<SemanticSearchResult[]> {
    const body = {
      question: query,
      api_key: this.apiKey,
      chunks: clampChunks(chunks),
    };

    const response = await this.request("POST", "/api/search", body);

    if (response.status === 401) {
      throw new DocsGPTClientError(
        "Invalid API key. Get a new key by running /mcp-key in the Noir Discord.",
        401
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new DocsGPTClientError(
        `DocsGPT returned ${response.status}: ${text || response.statusText}`,
        response.status
      );
    }

    const data = await response.json();

    // Strict shape check: a non-array response was previously swallowed
    // as `[]`, which masked any future contract drift (e.g. a server
    // returning `{results: [...]}` would look like "no matches" forever).
    // Throwing here surfaces the mismatch loudly.
    if (!Array.isArray(data)) {
      throw new DocsGPTClientError(
        "Unexpected response shape from /api/search: expected array",
        response.status
      );
    }

    return data.map((item: Record<string, unknown>) => ({
      text: String(item.text || ""),
      title: String(item.title || ""),
      source: String(item.source || ""),
    }));
  }

  /**
   * Fetch the corpus version this backend is currently serving.
   *
   * Returns ``null`` only when the endpoint is missing (404) — every
   * other failure mode (network, timeout, non-OK status, malformed
   * body) throws ``DocsGPTClientError`` so callers can decide whether
   * to gate or proceed. Older docsgpt deployments without the
   * ``/api/version`` endpoint will 404, in which case the version gate
   * treats this as ``"unknown"`` and lets the search proceed (with a
   * debug log) — see ``utils/version-check.ts``.
   */
  async getCorpusVersion(): Promise<CorpusVersionInfo | null> {
    // POST instead of GET: some auth proxies (Cloudflare Access in
    // particular) gate GET routes while letting POST /api/* through
    // unauthenticated, so POSTing here matches the same path the
    // search endpoint already uses successfully. The docsgpt route
    // accepts both verbs — GET is still available for curl diagnostics.
    //
    // redirect:"manual" is defensive: if POST is gated too (a more
    // restrictive proxy), we don't follow into a login HTML page.
    const response = await this.request("POST", "/api/version", {}, "manual");

    if (response.status === 404 || (response.status >= 300 && response.status < 400)) {
      return null;
    }

    // Some proxies (Cloudflare Access in particular) gate GET routes
    // but not POSTs, returning the same 302 with `type: "opaqueredirect"`
    // when redirect is manual — that surfaces as status 0 in fetch.
    if (response.type === "opaqueredirect" || response.status === 0) {
      return null;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new DocsGPTClientError(
        `DocsGPT /api/version returned ${response.status}: ${text || response.statusText}`,
        response.status
      );
    }

    const data = await response.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new DocsGPTClientError(
        "Unexpected response shape from /api/version: expected object"
      );
    }

    const version = (data as Record<string, unknown>).aztec_corpus_version;
    if (typeof version !== "string") {
      throw new DocsGPTClientError(
        "Unexpected response shape from /api/version: missing aztec_corpus_version"
      );
    }

    const sourceCount = (data as Record<string, unknown>).source_count;
    return {
      aztec_corpus_version: version,
      source_count: typeof sourceCount === "number" ? sourceCount : undefined,
    };
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    redirect: "follow" | "error" | "manual" = "follow"
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    try {
      return await fetch(url, {
        method,
        headers: body != null ? { "Content-Type": "application/json" } : undefined,
        body: body != null ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeout),
        redirect,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "TimeoutError") {
        throw new DocsGPTClientError(
          `Request timed out after ${this.timeout}ms`
        );
      }
      throw new DocsGPTClientError(
        `Failed to connect to DocsGPT at ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
