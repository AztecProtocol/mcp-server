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

export class DocsGPTClient {
  private baseUrl: string;
  private apiKey: string;
  private timeout: number;

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
      chunks,
    };

    const url = `${this.baseUrl}/api/search`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeout),
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

    if (!Array.isArray(data)) {
      return [];
    }

    return data.map((item: Record<string, unknown>) => ({
      text: String(item.text || ""),
      title: String(item.title || ""),
      source: String(item.source || ""),
    }));
  }
}
