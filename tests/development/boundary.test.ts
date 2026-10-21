import { afterEach, expect, it } from "vitest";
import { createDevelopmentBoundary } from "../../src/development/index.js";

const boundary = createDevelopmentBoundary();
afterEach(async () => { await boundary.shutdown?.(); });

it("rejects an optional initializer name with the wrong type before session lookup", async () => {
  await expect(boundary.callTool("aztec_dev_contract", {
    operation: "deploy", sessionId: "stale", buildJobId: "build", artifactPath: "/tmp/contract.json",
    account: `0x${"1".repeat(64)}`, args: [], initialize: true, initializerName: 42,
  })).rejects.toMatchObject({ code: -32602 });
});

const address = `0x${"1".repeat(64)}`;
const call = { sessionId: "stale", address, account: address, functionName: "balance", args: [] };
const selectedSession = { sessionId: "stale", projectPath: "/tmp/project", installationRoot: "/tmp/aztec", nodeExecutable: "/usr/bin/node", nodeUrl: "http://localhost:8080" };

it.each([
  { minimumBlock: "2" }, { minimumBlock: -1 }, { minimumBlock: 1.5 },
  { args: {} }, { account: null }, { extra: true },
])("rejects malformed view arguments %j before session lookup", async patch => {
  await expect(boundary.callTool("aztec_dev_contract", { operation: "view", ...call, ...patch }))
    .rejects.toMatchObject({ code: -32602 });
});

it.each([
  { backend: "NativeUnixSocket", crsPath: "/tmp/crs", threads: "2" },
  { backend: "NativeUnixSocket", crsPath: "/tmp/crs", threads: 17 },
  { backend: "NativeUnixSocket", crsPath: "/tmp/crs", unexpected: true },
  { backend: "NativeUnixSocket" },
  { backend: "other", crsPath: "/tmp/crs" },
  [], null,
])("validates nested proving options %j before changing sessions", async proving => {
  await expect(boundary.callTool("aztec_dev_session", { operation: "switch", ...selectedSession, proofMode: "real", proving }))
    .rejects.toMatchObject({ code: -32602 });
});

it.each([0, 1800001, 1.5, "1000"])("applies the timeout limit %j to every job-producing operation", async timeoutMs => {
  const requests: Array<[string, Record<string, unknown>]> = [
    ["aztec_dev_contract", { operation: "send", ...call }],
    ["aztec_dev_contract", { operation: "deploy", sessionId: "stale", buildJobId: "build", artifactPath: "/tmp/contract.json", account: address, args: [], initialize: false }],
    ["aztec_dev_build", { operation: "compile", projectPath: "/tmp/project", installationRoot: "/tmp/aztec", nodeExecutable: "/usr/bin/node" }],
    ["aztec_dev_build", { operation: "test", projectPath: "/tmp/project", installationRoot: "/tmp/aztec", nodeExecutable: "/usr/bin/node" }],
  ];
  for (const [name, args] of requests) {
    await expect(boundary.callTool(name, { ...args, timeoutMs })).rejects.toMatchObject({ code: -32602 });
  }
});

it("accepts valid optional arguments and preserves service errors", async () => {
  for (const timeoutMs of [1, 1800000]) {
    const result = await boundary.callTool("aztec_dev_contract", { operation: "send", ...call, timeoutMs });
    expect(result.structuredContent).toMatchObject({ error: { code: "stale-session" } });
  }
  const result = await boundary.callTool("aztec_dev_session", {
    operation: "switch", ...selectedSession, proofMode: "real",
    proving: { backend: "NativeUnixSocket", crsPath: "/tmp/crs", threads: 2 },
  });
  expect(result.structuredContent).toMatchObject({ error: { code: "stale-session" } });
});

it("rejects unknown tools, operations, and arguments with protocol errors", async () => {
  await expect(boundary.callTool("unknown", {})).rejects.toMatchObject({ code: -32601 });
  await expect(boundary.callTool("aztec_dev_job", { operation: "unknown" })).rejects.toMatchObject({ code: -32602 });
  await expect(boundary.callTool("aztec_dev_job", { operation: "toString" })).rejects.toMatchObject({ code: -32602 });
  await expect(boundary.callTool("aztec_dev_job", { operation: "status" })).rejects.toMatchObject({ code: -32602 });
  await expect(boundary.callTool("aztec_dev_job", { operation: "status", jobId: "job", offset: 0 })).rejects.toMatchObject({ code: -32602 });
});
