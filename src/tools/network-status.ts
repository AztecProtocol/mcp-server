/**
 * Local Aztec network / sandbox status probes for MCP agents.
 *
 * Complements `aztec_status` (which reports cloned repo state) by checking
 * whether a local sandbox/node/PXE/L1 RPC is actually reachable and usable.
 */

export type ProbeErrorCode =
  | "unreachable"
  | "timeout"
  | "http_error"
  | "invalid_json"
  | "rpc_error"
  | "method_not_found"
  | "empty_response";

export type EndpointRole = "pxe" | "node" | "l1" | "custom";

export interface EndpointProbeResult {
  role: EndpointRole;
  url: string;
  reachable: boolean;
  latencyMs: number | null;
  httpStatus: number | null;
  errorCode: ProbeErrorCode | null;
  errorMessage: string | null;
  /** Best-effort identity / version fields from the target. */
  details: Record<string, unknown>;
}

export interface NetworkStatusResult {
  overall: "ready" | "degraded" | "down";
  checkedAt: string;
  timeoutMs: number;
  endpoints: EndpointProbeResult[];
  /** Agent-branchable summary of what to do next. */
  taxonomy: {
    ready: string[];
    degraded: string[];
    down: string[];
  };
  notes: string[];
}

export interface ProbeOptions {
  /** Explicit endpoint URLs. When empty, defaults are used. */
  urls?: string[];
  /** Roles aligned with urls (same length). Defaults inferred from port. */
  roles?: EndpointRole[];
  timeoutMs?: number;
  /** Inject for tests. */
  fetchImpl?: typeof fetch;
}

/** Default local Aztec sandbox endpoints (common aztec.js / sandbox layout). */
export const DEFAULT_ENDPOINTS: { role: EndpointRole; url: string }[] = [
  { role: "pxe", url: "http://127.0.0.1:8080" },
  { role: "node", url: "http://127.0.0.1:8081" },
  { role: "l1", url: "http://127.0.0.1:8545" },
];

function inferRole(url: string): EndpointRole {
  try {
    const u = new URL(url);
    if (u.port === "8080") return "pxe";
    if (u.port === "8081") return "node";
    if (u.port === "8545") return "l1";
  } catch {
    /* ignore */
  }
  return "custom";
}

async function jsonRpc(
  fetchImpl: typeof fetch,
  url: string,
  method: string,
  params: unknown[] = [],
  timeoutMs: number
): Promise<{
  ok: boolean;
  httpStatus: number | null;
  latencyMs: number;
  result?: unknown;
  errorCode: ProbeErrorCode | null;
  errorMessage: string | null;
}> {
  const started = performance.now();
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Math.round(performance.now() - started);
    const httpStatus = res.status;
    if (!res.ok) {
      return {
        ok: false,
        httpStatus,
        latencyMs,
        errorCode: "http_error",
        errorMessage: `HTTP ${res.status} ${res.statusText}`,
      };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return {
        ok: false,
        httpStatus,
        latencyMs,
        errorCode: "invalid_json",
        errorMessage: "Response was not valid JSON",
      };
    }
    if (
      body &&
      typeof body === "object" &&
      "error" in body &&
      (body as { error?: unknown }).error
    ) {
      const err = (body as { error: { code?: number; message?: string } })
        .error;
      const msg = err?.message ?? JSON.stringify(err);
      const code =
        typeof err?.code === "number" && err.code === -32601
          ? "method_not_found"
          : "rpc_error";
      return {
        ok: false,
        httpStatus,
        latencyMs,
        errorCode: code,
        errorMessage: msg,
      };
    }
    if (
      body &&
      typeof body === "object" &&
      "result" in body
    ) {
      return {
        ok: true,
        httpStatus,
        latencyMs,
        result: (body as { result: unknown }).result,
        errorCode: null,
        errorMessage: null,
      };
    }
    return {
      ok: false,
      httpStatus,
      latencyMs,
      errorCode: "empty_response",
      errorMessage: "JSON-RPC response missing result",
    };
  } catch (e) {
    const latencyMs = Math.round(performance.now() - started);
    const message = e instanceof Error ? e.message : String(e);
    const isTimeout =
      (e instanceof Error && e.name === "TimeoutError") ||
      /timeout|aborted/i.test(message);
    return {
      ok: false,
      httpStatus: null,
      latencyMs,
      errorCode: isTimeout ? "timeout" : "unreachable",
      errorMessage: message,
    };
  }
}

/**
 * Probe a single endpoint with role-appropriate methods.
 * Falls through a small method list so mixed stacks still surface something useful.
 */
export async function probeEndpoint(
  role: EndpointRole,
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch
): Promise<EndpointProbeResult> {
  const details: Record<string, unknown> = {};

  // Method candidates by role (first success wins for "reachable").
  const methods: { method: string; params?: unknown[]; label: string }[] =
    role === "l1"
      ? [
          { method: "eth_chainId", label: "chainId" },
          { method: "eth_blockNumber", label: "blockNumber" },
          { method: "web3_clientVersion", label: "clientVersion" },
        ]
      : role === "pxe"
        ? [
            // Aztec PXE / node JSON-RPC surfaces evolve; try several.
            { method: "pxe_getNodeInfo", label: "pxe_getNodeInfo" },
            { method: "node_getNodeInfo", label: "node_getNodeInfo" },
            { method: "getNodeInfo", label: "getNodeInfo" },
            { method: "eth_chainId", label: "chainId" },
          ]
        : [
            { method: "node_getNodeInfo", label: "node_getNodeInfo" },
            { method: "getNodeInfo", label: "getNodeInfo" },
            { method: "pxe_getNodeInfo", label: "pxe_getNodeInfo" },
            { method: "eth_blockNumber", label: "blockNumber" },
            { method: "eth_chainId", label: "chainId" },
          ];

  let last: Awaited<ReturnType<typeof jsonRpc>> | null = null;
  for (const candidate of methods) {
    const res = await jsonRpc(
      fetchImpl,
      url,
      candidate.method,
      candidate.params ?? [],
      timeoutMs
    );
    last = res;
    if (res.ok) {
      details[candidate.label] = res.result;
      details.methodUsed = candidate.method;
      return {
        role,
        url,
        reachable: true,
        latencyMs: res.latencyMs,
        httpStatus: res.httpStatus,
        errorCode: null,
        errorMessage: null,
        details,
      };
    }
    // method_not_found → try next; hard network errors → stop early
    if (
      res.errorCode === "unreachable" ||
      res.errorCode === "timeout" ||
      res.errorCode === "http_error"
    ) {
      break;
    }
    details[`attempt_${candidate.method}`] = {
      errorCode: res.errorCode,
      errorMessage: res.errorMessage,
    };
  }

  return {
    role,
    url,
    reachable: false,
    latencyMs: last?.latencyMs ?? null,
    httpStatus: last?.httpStatus ?? null,
    errorCode: last?.errorCode ?? "unreachable",
    errorMessage: last?.errorMessage ?? "No probe methods succeeded",
    details,
  };
}

export async function checkNetworkStatus(
  options: ProbeOptions = {}
): Promise<NetworkStatusResult> {
  const timeoutMs = Math.max(200, Math.min(options.timeoutMs ?? 3000, 30_000));
  const fetchImpl = options.fetchImpl ?? fetch;

  let endpoints: { role: EndpointRole; url: string }[];
  if (options.urls && options.urls.length > 0) {
    endpoints = options.urls.map((url, i) => ({
      url,
      role: options.roles?.[i] ?? inferRole(url),
    }));
  } else {
    endpoints = DEFAULT_ENDPOINTS.map((e) => ({ ...e }));
  }

  const results: EndpointProbeResult[] = [];
  for (const ep of endpoints) {
    results.push(await probeEndpoint(ep.role, ep.url, timeoutMs, fetchImpl));
  }

  const ready = results.filter((r) => r.reachable).map((r) => `${r.role}:${r.url}`);
  const down = results
    .filter((r) => !r.reachable)
    .map((r) => `${r.role}:${r.url} (${r.errorCode})`);

  let overall: NetworkStatusResult["overall"];
  if (ready.length === results.length) overall = "ready";
  else if (ready.length === 0) overall = "down";
  else overall = "degraded";

  const notes: string[] = [
    "aztec_network_status probes live RPC endpoints; aztec_status reports cloned repos only.",
    "Defaults: PXE :8080, node :8081, L1 :8545 — override with urls[] for custom stacks.",
  ];
  if (overall === "down") {
    notes.push(
      "Nothing reachable. Is the Aztec sandbox running? Try `aztec start --sandbox` (or your local compose stack)."
    );
  } else if (overall === "degraded") {
    notes.push(
      "Partial reachability — agents should treat missing roles as unavailable and avoid calls that depend on them."
    );
  }

  return {
    overall,
    checkedAt: new Date().toISOString(),
    timeoutMs,
    endpoints: results,
    taxonomy: { ready, degraded: overall === "degraded" ? down : [], down: overall === "down" ? down : overall === "degraded" ? [] : down },
    notes,
  };
}

export function formatNetworkStatus(result: NetworkStatusResult): string {
  const lines = [
    `Aztec local network status: ${result.overall.toUpperCase()}`,
    `Checked at: ${result.checkedAt}`,
    `Timeout: ${result.timeoutMs}ms`,
    "",
    "Endpoints:",
  ];
  for (const ep of result.endpoints) {
    const icon = ep.reachable ? "✓" : "✗";
    const lat = ep.latencyMs != null ? `${ep.latencyMs}ms` : "n/a";
    if (ep.reachable) {
      lines.push(`  ${icon} [${ep.role}] ${ep.url} — reachable (${lat})`);
      if (ep.details.methodUsed) {
        lines.push(`      method: ${ep.details.methodUsed}`);
      }
      for (const [k, v] of Object.entries(ep.details)) {
        if (k === "methodUsed" || k.startsWith("attempt_")) continue;
        const rendered =
          typeof v === "string" || typeof v === "number" || typeof v === "boolean"
            ? String(v)
            : JSON.stringify(v);
        lines.push(`      ${k}: ${rendered}`);
      }
    } else {
      lines.push(
        `  ${icon} [${ep.role}] ${ep.url} — ${ep.errorCode ?? "error"} (${lat})`
      );
      if (ep.errorMessage) lines.push(`      ${ep.errorMessage}`);
    }
  }
  lines.push("");
  lines.push("Agent taxonomy:");
  lines.push(`  ready: ${result.taxonomy.ready.join(", ") || "(none)"}`);
  lines.push(`  down: ${result.taxonomy.down.join(", ") || result.taxonomy.degraded.join(", ") || "(none)"}`);
  lines.push("");
  for (const n of result.notes) lines.push(`Note: ${n}`);
  lines.push("");
  lines.push("JSON:");
  lines.push(JSON.stringify(result, null, 2));
  return lines.join("\n");
}
