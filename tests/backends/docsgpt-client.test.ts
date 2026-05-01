import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { DocsGPTClient, DocsGPTClientError } from "../../src/backends/docsgpt-client.js";

const FETCH = "fetch" as keyof typeof globalThis;

describe("DocsGPTClient.search — chunks clamp", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } })
    );
  });
  afterEach(() => vi.restoreAllMocks());

  function getBody(): any {
    const call = (globalThis.fetch as any).mock.calls[0];
    return JSON.parse(call[1].body);
  }

  it("clamps below the minimum (0 → 1)", async () => {
    const c = new DocsGPTClient({ apiUrl: "https://x", apiKey: "k" });
    await c.search("q", 0);
    expect(getBody().chunks).toBe(1);
  });

  it("clamps negatives (−5 → 1)", async () => {
    const c = new DocsGPTClient({ apiUrl: "https://x", apiKey: "k" });
    await c.search("q", -5);
    expect(getBody().chunks).toBe(1);
  });

  it("clamps above the maximum (100 → 20)", async () => {
    const c = new DocsGPTClient({ apiUrl: "https://x", apiKey: "k" });
    await c.search("q", 100);
    expect(getBody().chunks).toBe(20);
  });

  it("truncates non-integers (3.7 → 3)", async () => {
    const c = new DocsGPTClient({ apiUrl: "https://x", apiKey: "k" });
    await c.search("q", 3.7);
    expect(getBody().chunks).toBe(3);
  });

  it("falls back to default 5 for non-finite values", async () => {
    const c = new DocsGPTClient({ apiUrl: "https://x", apiKey: "k" });
    await c.search("q", NaN);
    expect(getBody().chunks).toBe(5);
  });
});

describe("DocsGPTClient.search — response shape", () => {
  afterEach(() => vi.restoreAllMocks());

  it("throws DocsGPTClientError on non-array 200 response (contract drift)", async () => {
    // Fresh Response per call — bodies can only be consumed once.
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    );
    const c = new DocsGPTClient({ apiUrl: "https://x", apiKey: "k" });
    await expect(c.search("q")).rejects.toBeInstanceOf(DocsGPTClientError);
    await expect(c.search("q")).rejects.toThrow(/Unexpected response shape/);
  });

  it("returns parsed results on 200 array response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([{ text: "t", title: "T", source: "s" }]),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const c = new DocsGPTClient({ apiUrl: "https://x", apiKey: "k" });
    const r = await c.search("q");
    expect(r).toEqual([{ text: "t", title: "T", source: "s" }]);
  });

  it("preserves 401 mapping with a helpful message", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("Unauthorized", { status: 401 })
    );
    const c = new DocsGPTClient({ apiUrl: "https://x", apiKey: "k" });
    try {
      await c.search("q");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DocsGPTClientError);
      expect((err as DocsGPTClientError).statusCode).toBe(401);
      expect((err as DocsGPTClientError).message).toContain("/mcp-key");
    }
  });
});

describe("DocsGPTClient.getCorpusVersion", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns the parsed version object on 200", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ aztec_corpus_version: "v4.2.0", source_count: 12 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const c = new DocsGPTClient({ apiUrl: "https://x", apiKey: "k" });
    const r = await c.getCorpusVersion();
    expect(r).toEqual({ aztec_corpus_version: "v4.2.0", source_count: 12 });
  });

  it("returns null on 404 (older docsgpt deployment without /api/version)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("Not Found", { status: 404 })
    );
    const c = new DocsGPTClient({ apiUrl: "https://x", apiKey: "k" });
    expect(await c.getCorpusVersion()).toBeNull();
  });

  it("throws on malformed body (missing aztec_corpus_version)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ source_count: 12 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const c = new DocsGPTClient({ apiUrl: "https://x", apiKey: "k" });
    await expect(c.getCorpusVersion()).rejects.toThrow(/missing aztec_corpus_version/);
  });

  it("throws on 5xx", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("Internal Server Error", { status: 500 })
    );
    const c = new DocsGPTClient({ apiUrl: "https://x", apiKey: "k" });
    await expect(c.getCorpusVersion()).rejects.toBeInstanceOf(DocsGPTClientError);
  });
});

describe("DocsGPTClient — baseUrl", () => {
  it("strips trailing slashes and exposes baseUrl publicly", () => {
    const c = new DocsGPTClient({ apiUrl: "https://x.example.com///", apiKey: "k" });
    expect(c.baseUrl).toBe("https://x.example.com");
  });
});
