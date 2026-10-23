import { describe, expect, it, vi } from "vitest";
import {
  checkNetworkStatus,
  formatNetworkStatus,
  probeEndpoint,
} from "../src/tools/network-status.js";

function jsonRpcOk(result: unknown) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function jsonRpcErr(code: number, message: string) {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code, message } }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

describe("probeEndpoint", () => {
  it("marks L1 reachable on eth_chainId success", async () => {
    const fetchImpl = vi.fn(async () => jsonRpcOk("0x7a69"));
    const res = await probeEndpoint(
      "l1",
      "http://127.0.0.1:8545",
      1000,
      fetchImpl as unknown as typeof fetch
    );
    expect(res.reachable).toBe(true);
    expect(res.details.chainId).toBe("0x7a69");
    expect(res.errorCode).toBeNull();
  });

  it("falls through method_not_found to a later method", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRpcErr(-32601, "Method not found"))
      .mockResolvedValueOnce(jsonRpcOk({ nodeVersion: "1.2.3" }));
    const res = await probeEndpoint(
      "pxe",
      "http://127.0.0.1:8080",
      1000,
      fetchImpl as unknown as typeof fetch
    );
    expect(res.reachable).toBe(true);
    expect(res.details.methodUsed).toBeTruthy();
  });

  it("classifies network failure as unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const res = await probeEndpoint(
      "node",
      "http://127.0.0.1:8081",
      1000,
      fetchImpl as unknown as typeof fetch
    );
    expect(res.reachable).toBe(false);
    expect(res.errorCode).toBe("unreachable");
  });
});

describe("checkNetworkStatus", () => {
  it("reports ready when all defaults succeed", async () => {
    const fetchImpl = vi.fn(async () => jsonRpcOk("0x1"));
    const status = await checkNetworkStatus({
      timeoutMs: 500,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(status.overall).toBe("ready");
    expect(status.endpoints).toHaveLength(3);
    expect(status.taxonomy.ready).toHaveLength(3);
    const text = formatNetworkStatus(status);
    expect(text).toContain("READY");
    expect(text).toContain("JSON:");
  });

  it("reports down when nothing answers", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("ECONNREFUSED");
    });
    const status = await checkNetworkStatus({
      urls: ["http://127.0.0.1:19999"],
      timeoutMs: 200,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(status.overall).toBe("down");
    expect(status.taxonomy.down.length).toBeGreaterThan(0);
  });

  it("reports degraded on partial success", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("8080")) return jsonRpcOk({ ok: true });
      throw new TypeError("down");
    });
    const status = await checkNetworkStatus({
      urls: ["http://127.0.0.1:8080", "http://127.0.0.1:8081"],
      roles: ["pxe", "node"],
      timeoutMs: 500,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(status.overall).toBe("degraded");
  });
});
