import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { DocsGPTClient } from "../src/backends/docsgpt-client.js";

const connections: Array<{ client: Client; server: Awaited<ReturnType<typeof createServer>> }> = [];
afterEach(async () => {
  await Promise.all(connections.splice(0).map(async ({ client, server }) => {
    await client.close();
    await server.close();
  }));
});

async function connect(options: Parameters<typeof createServer>[0] = {}) {
  const server = await createServer(options);
  const client = new Client({ name: "protocol-regression", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  connections.push({ client, server });
  return client;
}

describe("existing MCP catalog", () => {
  it.each(["local", "semantic"])("preserves the complete %s catalog", async (mode) => {
    const client = await connect({
      docsgptClient: mode === "semantic"
        ? new DocsGPTClient({ apiUrl: "https://unused.example", apiKey: "fixture" })
        : null,
    });
    const baseline = JSON.parse(readFileSync(new URL(`./fixtures/tool-catalog-${mode}.json`, import.meta.url), "utf8"));
    expect((await client.listTools()).tools).toEqual(baseline);
  });
});

describe("optional development boundary", () => {
  it("validates structured call and deployment inputs before starting wallet work", async () => {
    const client = await connect({ developmentEnabled: true });
    const address = `0x${"1".repeat(64)}`;
    await expect(client.callTool({ name: "aztec_dev_contract", arguments: {
      operation: "view", sessionId: "stale", address, account: address, functionName: "balance", args: "[]",
    } })).rejects.toMatchObject({ code: -32602 });
    await expect(client.callTool({ name: "aztec_dev_contract", arguments: {
      operation: "deploy", sessionId: "stale", buildJobId: "build", artifactPath: "/tmp/fixture.json", account: address, args: [],
    } })).rejects.toMatchObject({ code: -32602 });
    const response = await client.callTool({ name: "aztec_dev_contract", arguments: {
      operation: "view", sessionId: "stale", address, account: address, functionName: "balance", args: [],
    } });
    expect(response.structuredContent).toMatchObject({ error: { code: "stale-session" } });
  });

  it("requires an active session for structured contract registration and inspection", async () => {
    const client = await connect({ developmentEnabled: true });
    expect((await client.listTools()).tools.map(tool => tool.name)).toContain("aztec_dev_contract");
    const args = { sessionId: "stale", address: `0x${"1".repeat(64)}`, artifactPath: "/tmp/fixture.json" };
    for (const [name, operation] of [["aztec_dev_contract", "register"], ["aztec_dev_inspect", "contract"]]) {
      const response = await client.callTool({ name, arguments: { operation, ...args } });
      expect(response.isError).toBe(true);
      expect(response.structuredContent).toMatchObject({ error: { code: "stale-session" } });
    }
  });

  it("awaits development resource shutdown when the MCP server closes", async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const server = await createServer({ developmentEnabled: true, loadDevelopment: async () => ({ listTools: () => [], callTool: async () => ({ content: [] }), shutdown }) });
    await server.close();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("exposes tracked build/job operations without touching repository synchronization", async () => {
    const syncState = vi.spyOn(await import("../src/utils/sync-metadata.js"), "getSyncState");
    const client = await connect({ developmentEnabled: true });
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(expect.arrayContaining(["aztec_dev_build", "aztec_dev_job"]));
    await expect(client.callTool({ name: "aztec_dev_build", arguments: { operation: "compile", projectPath: "." } }))
      .rejects.toMatchObject({ code: -32602 });
    const result = await client.callTool({ name: "aztec_dev_job", arguments: { operation: "status", jobId: "unknown-job" } });
    expect(result.isError).toBe(true);
    expect(syncState).not.toHaveBeenCalled();
  });

  it("offers preflight only when enabled and validates selection before any repository work", async () => {
    const syncState = vi.spyOn(await import("../src/utils/sync-metadata.js"), "getSyncState");
    const client = await connect({ developmentEnabled: true });
    expect((await client.listTools()).tools.map(tool => tool.name)).toContain("aztec_dev_inspect");
    await expect(client.callTool({ name: "aztec_dev_inspect", arguments: { operation: "environment" } }))
      .rejects.toMatchObject({ code: -32602 });
    const result = await client.callTool({ name: "aztec_dev_inspect", arguments: {
      operation: "environment", installationRoot: "/missing-aztec-installation", nodeExecutable: process.execPath,
    } });
    expect(result.structuredContent).toMatchObject({ supported: false, diagnostics: [expect.objectContaining({ code: "missing-installation" })] });
    expect(syncState).not.toHaveBeenCalled();
  });

  it("loads only when explicitly enabled and dispatches without repository or documentation work", async () => {
    const syncState = vi.spyOn(await import("../src/utils/sync-metadata.js"), "getSyncState")
      .mockReturnValue({ kind: "needsAutoResync", aztecVersion: "v6.0.0-rc.6" });
    const sync = vi.spyOn(await import("../src/tools/sync.js"), "syncRepos");
    const docs = new DocsGPTClient({ apiUrl: "https://unused.example", apiKey: "fixture" });
    const backend = vi.spyOn(docs, "getCorpusVersion");
    const loadDevelopment = vi.fn().mockResolvedValue({
      listTools: () => [{ name: "aztec_dev_fixture", inputSchema: { type: "object", properties: {} } }],
      callTool: async (_name: string, args: Record<string, unknown> | undefined) => ({ content: [{ type: "text", text: String(args?.value) }] }),
    });
    const disabled = await connect({ loadDevelopment });
    expect((await disabled.listTools()).tools).toHaveLength(8);
    await expect(disabled.callTool({ name: "aztec_dev_fixture" })).rejects.toMatchObject({ code: -32601 });
    expect(loadDevelopment).not.toHaveBeenCalled();

    const enabled = await connect({ developmentEnabled: true, loadDevelopment, docsgptClient: docs });
    expect((await enabled.listTools()).tools.at(-1)?.name).toBe("aztec_dev_fixture");
    expect(await enabled.callTool({ name: "aztec_dev_fixture", arguments: { value: "isolated" } }))
      .toEqual({ content: [{ type: "text", text: "isolated" }] });
    expect(loadDevelopment).toHaveBeenCalledTimes(1);
    expect(syncState).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
    expect(backend).not.toHaveBeenCalled();
  });
});

describe("existing MCP dispatch", () => {
  it("preserves formatted search results and forwards the original arguments", async () => {
    vi.spyOn(await import("../src/utils/sync-metadata.js"), "getSyncState").mockReturnValue({ kind: "upToDate" });
    const search = vi.spyOn(await import("../src/tools/search.js"), "searchAztecCode").mockReturnValue({
      success: true, message: "Found 1 match.",
      results: [{ file: "aztec-node/token.nr", line: 12, content: "fn transfer() {}", repo: "aztec-node" }],
    });
    const client = await connect();
    const args = { query: "transfer", repo: "aztec-node", filePattern: "*.nr", maxResults: 7 };
    expect(await client.callTool({ name: "aztec_search_code", arguments: args })).toEqual({
      content: [{ type: "text", text: "Found 1 match.\n\n**aztec-node/token.nr:12**\n```\nfn transfer() {}\n```\n" }],
    });
    expect(search).toHaveBeenCalledWith(args);
  });

  it.each([
    ["aztec_search_docs", "query"], ["aztec_search_code", "query"],
    ["aztec_lookup_error", "query"], ["aztec_read_example", "name"], ["aztec_read_file", "path"],
  ])("preserves required-argument errors for %s before synchronization", async (name, field) => {
    const syncState = vi.spyOn(await import("../src/utils/sync-metadata.js"), "getSyncState");
    const client = await connect();
    await expect(client.callTool({ name })).rejects.toMatchObject({
      code: -32602, message: expect.stringContaining(`${field} is required`),
    });
    expect(syncState).not.toHaveBeenCalled();
  });

  it("preserves unknown-tool errors before synchronization", async () => {
    const syncState = vi.spyOn(await import("../src/utils/sync-metadata.js"), "getSyncState");
    const client = await connect();
    await expect(client.callTool({ name: "not_a_tool" })).rejects.toMatchObject({
      code: -32601, message: expect.stringContaining("Unknown tool: not_a_tool"),
    });
    expect(syncState).not.toHaveBeenCalled();
  });

  it("preserves unexpected search failures as MCP internal errors", async () => {
    vi.spyOn(await import("../src/utils/sync-metadata.js"), "getSyncState").mockReturnValue({ kind: "upToDate" });
    vi.spyOn(await import("../src/tools/search.js"), "searchAztecCode").mockImplementation(() => { throw new Error("disk unavailable"); });
    const client = await connect();
    await expect(client.callTool({ name: "aztec_search_code", arguments: { query: "transfer" } }))
      .rejects.toMatchObject({ code: -32603, message: expect.stringContaining("Tool execution failed: disk unavailable") });
  });

  it.each(["error", "version-mismatch"])("preserves documentation %s as a text result and avoids repo synchronization", async (kind) => {
    const syncState = vi.spyOn(await import("../src/utils/sync-metadata.js"), "getSyncState");
    const search = vi.spyOn(await import("../src/tools/search.js"), "searchAztecDocs");
    const message = kind === "error" ? "Semantic documentation search failed." : "Version mismatch.";
    search.mockResolvedValue(kind === "error"
      ? { kind: "error", message, semanticError: "fixture backend unavailable" }
      : { kind: "version-mismatch", message, localVersion: "v5.2.0", corpusVersion: "v6.0.0-rc.6" });
    const docsgptClient = new DocsGPTClient({ apiUrl: "https://unused.example", apiKey: "fixture" });
    const client = await connect({ docsgptClient });
    expect(await client.callTool({ name: "aztec_search_docs", arguments: { query: "transfer" } }))
      .toEqual({ content: [{ type: "text", text: message }] });
    expect(syncState).not.toHaveBeenCalled();
  });
});
