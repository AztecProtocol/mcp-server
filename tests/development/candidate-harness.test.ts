import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close(error => error ? reject(error) : resolve());
  })));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(linger = false) {
  const root = await mkdtemp(join(tmpdir(), "mcp-candidate-harness-"));
  roots.push(root);
  await mkdir(join(root, "bin"));
  await mkdir(join(root, "internal-bin"));
  await writeFile(join(root, "package.json"), "{}");
  await writeFile(join(root, "versions"), `node: ${process.versions.node}\nnoir: 1.0.0-rc.3\n`);
  await writeFile(join(root, "bin/aztec"), '#!/bin/sh\nprintf "6.0.0-rc.3\\n"\n', { mode: 0o755 });
  await writeFile(join(root, "internal-bin/nargo"), '#!/bin/sh\nprintf "nargo version = 1.0.0-rc.3\\n"\n', { mode: 0o755 });
  const packages: Record<string, Record<string, string>> = {
    "@aztec-labs/aztec": { ".": "./index.js" },
    "@aztec-labs/cli": { ".": "./index.js" },
    "@aztec-labs/aztec.js": { "./node": "./index.js", "./contracts": "./index.js" },
    "@aztec-labs/wallets": { "./embedded": "./index.js" },
    "@aztec-labs/accounts": { "./testing": "./index.js" },
    "@aztec-labs/pxe": { "./config": "./index.js" },
    "@aztec-labs/foundation": { "./json-rpc": "./index.js" },
    ...Object.fromEntries(["bb.js", "noir-types", "noir-acvm_js", "noir-noirc_abi", "l1-artifacts"].map(name => [
      `@aztec-foundation/${name}`, { ".": "./index.js" },
    ])),
  };
  for (const [name, exports] of Object.entries(packages)) {
    const directory = join(root, "node_modules", name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({
      name, type: "module", exports,
      version: name.startsWith("@aztec-foundation/") ? "6.0.0-rc.6" : "6.0.0-rc.3",
    }));
    await writeFile(join(directory, "index.js"), "export {};\n");
  }
  await writeFile(join(root, "node_modules/@aztec-labs/aztec.js/index.js"), `
    export function createAztecNodeClient(url, { fetch: transport }) {
      return { async getNodeInfo() {
        const { response } = await transport(url, { jsonrpc: '2.0', id: 1, method: 'node_getNodeInfo', params: [] });
        return response.result;
      } };
    }
  `);
  await writeFile(join(root, "node_modules/@aztec-labs/foundation/index.js"), "export const jsonStringify = JSON.stringify;\n");
  const walletEvents = join(root, "wallet-events.json");
  await writeFile(join(root, "node_modules/@aztec-labs/wallets/index.js"), `
    import { writeFile } from 'node:fs/promises';
    export const EmbeddedWallet = {
      async create(node, options) {
        if (options.pxe.proverEnabled !== false || options.ephemeral !== true) throw new Error('Explicit fast ephemeral mode is required');
        console.log('SDK output must remain outside the result JSON');
        if (${linger}) setInterval(() => {}, 100);
        await writeFile(${JSON.stringify(walletEvents)}, JSON.stringify({ options, stopped: false }));
        return { async stop() {
          await writeFile(${JSON.stringify(walletEvents)}, JSON.stringify({ options, stopped: true }));
        } };
      }
    };
  `);
  return { root, walletEvents };
}

async function nodeServer(realProofs: boolean) {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.setHeader("x-aztec-packageVersion", "observed-node-build");
    response.setHeader("x-aztec-l2CircuitsVkTreeRoot", "0x1234");
    response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {
      nodeVersion: "observed-node-build", l1ChainId: 31337, rollupVersion: 123,
      l1ContractAddresses: { rollupAddress: "0x0000000000000000000000000000000000000001" },
      realProofs,
    } }));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP fixture server");
  return `http://127.0.0.1:${address.port}`;
}

async function run(root: string, nodeUrl: string, timeoutMs = 10000) {
  return new Promise<{ exitCode: number; report: any }>((resolveResult, reject) => {
    execFile(process.execPath, [
      resolve("scripts/validate-development-candidate.mjs"),
      "--installation-root", root, "--node-executable", process.execPath,
      "--node-url", nodeUrl, "--timeout-ms", String(timeoutMs),
    ], { timeout: 20000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error && typeof error.code !== "number") return reject(error);
      try {
        resolveResult({ exitCode: error?.code ?? 0, report: JSON.parse(stdout) });
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

describe("candidate harness subprocess evidence", () => {
  it("loads public exports, explicitly disables proving, and observes wallet and worker shutdown without promotion", async () => {
    const { root, walletEvents } = await fixture();
    const { report, exitCode } = await run(root, await nodeServer(false));
    expect(exitCode).toBe(0);
    expect(report.status).toBe("candidate-passed");
    expect(report.productionSupported).toBe(false);
    expect(report.installation.supported).toBe(false);
    expect(report.evidence.modules.every((entry: { loaded: boolean }) => entry.loaded)).toBe(true);
    expect(report.evidence.node.nodeVersion).toBe("observed-node-build");
    expect(report.evidence.node.componentHeaders.l2CircuitsVkTreeRoot).toBe("0x1234");
    expect(report.evidence.wallet).toEqual({ created: true, stopped: true });
    expect(report.shutdown).toMatchObject({ naturalExit: true, completed: true, timedOut: false, exitCode: 0 });
    expect(report.logs.stdoutBytes).toBeGreaterThan(0);
    expect(JSON.parse(await readFile(walletEvents, "utf8"))).toEqual({
      options: { ephemeral: true, pxe: { proverEnabled: false } }, stopped: true,
    });
  });

  it("rejects a node requiring real proofs before creating a wallet", async () => {
    const { root, walletEvents } = await fixture();
    const { report, exitCode } = await run(root, await nodeServer(true));
    expect(exitCode).toBe(1);
    expect(report.status).toBe("candidate-failed");
    expect(report.evidence.error).toContain("realProofs=false");
    expect(report.evidence.wallet.created).toBe(false);
    await expect(readFile(walletEvents)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not count stop returning as clean shutdown when the worker still owns resources", async () => {
    const { root } = await fixture(true);
    const { report, exitCode } = await run(root, await nodeServer(false), 1000);
    expect(exitCode).toBe(1);
    expect(report.status).toBe("candidate-failed");
    expect(report.evidence.wallet.stopped).toBe(true);
    expect(report.shutdown).toMatchObject({ naturalExit: false, completed: true, timedOut: true, signal: "SIGKILL" });
  });
});
