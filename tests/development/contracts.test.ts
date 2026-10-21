import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectContract, registerContract, loadRegisteredContract } from "../../src/development/contract-operations.js";
import type { RuntimeContext } from "../../src/development/runtime-worker.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const address = `0x${"1".padStart(64, "0")}`;
const classId = "0xabc";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mcp-contract-")); roots.push(root);
  const artifactPath = join(root, "token.json");
  await writeFile(artifactPath, JSON.stringify({ name: "Token", classId }));
  const registered = new Set<string>();
  const register = vi.fn(async () => { registered.add(address); });
  const instance = { currentContractClassId: classId, originalContractClassId: classId };
  const context: RuntimeContext = {
    stateDirectory: root,
    network: { nodeVersion: "fixture", l1ChainId: 31337, rollupVersion: 1, rollupAddress: "0x1", realProofs: false },
    node: { getBlockNumber: async () => 7, getContract: vi.fn(async (value: { toString(): string }) => value.toString() === address ? instance : undefined) },
    wallet: {
      registerContract: register,
      getContractMetadata: async (value: { toString(): string }) => ({ instance: registered.has(value.toString()) ? instance : undefined, initializationStatus: "initialized" }),
      getContractClassMetadata: async () => ({ isArtifactRegistered: registered.has(address), isContractClassPubliclyRegistered: true }),
    },
    loadModule: async (name: string) => {
      if (name.endsWith("/addresses")) return { AztecAddress: { fromStringUnsafe: (value: string) => ({ toString: () => value, isValid: async () => true }) } };
      if (name.endsWith("/abi")) return {
        loadContractArtifact: (value: unknown) => value,
        contractArtifactToBuffer: (value: unknown) => Buffer.from(JSON.stringify(value)),
        contractArtifactFromBuffer: (value: Buffer) => JSON.parse(value.toString()),
      };
      if (name.endsWith("/contract")) return { getContractClassFromArtifact: async (artifact: { classId: string }) => ({ id: artifact.classId }) };
      throw new Error(`Unexpected module: ${name}`);
    },
  };
  return { context, artifactPath, register };
}

describe("contract artifact association", () => {
  it("validates, persists and reuses an unchanged registration", async () => {
    const { context, artifactPath, register } = await fixture();
    const initial = await inspectContract({ address, artifactPath }, context);
    expect(initial.problems).toEqual(["missing-registration"]);
    expect((await registerContract({ address, artifactPath }, context)).reused).toBe(false);
    expect((await registerContract({ address, artifactPath }, { ...context })).reused).toBe(true);
    expect(register).toHaveBeenCalledTimes(1);
    const inspected = await inspectContract({ address }, context);
    expect(inspected.ready).toBe(true);
    expect(inspected.node).toMatchObject({ observedBlock: 7, currentClassId: classId, blockPinned: true });
    expect(inspected.artifact?.contentHash).toBe(createHash("sha256").update(await readFile(artifactPath)).digest("hex"));
  });

  it("rejects class mismatch before mutating the wallet", async () => {
    const { context, artifactPath, register } = await fixture();
    await writeFile(artifactPath, JSON.stringify({ name: "Different", classId: "0xdef" }));
    await expect(registerContract({ address, artifactPath }, context)).rejects.toMatchObject({ code: "artifact-mismatch" });
    expect(register).not.toHaveBeenCalled();
    expect((await inspectContract({ address, artifactPath }, context)).problems).toContain("artifact-mismatch");
  });

  it("keeps the registered immutable artifact when the source is rebuilt", async () => {
    const { context, artifactPath, register } = await fixture();
    const initial = await registerContract({ address, artifactPath }, context);
    await writeFile(artifactPath, JSON.stringify({ name: "Rebuilt", classId: "0xdef" }));
    await expect(registerContract({ address, artifactPath }, context)).rejects.toMatchObject({ code: "artifact-changed" });
    expect(register).toHaveBeenCalledTimes(1);
    const inspection = await inspectContract({ address }, context);
    expect(inspection.problems).toEqual(["artifact-changed", "artifact-mismatch"]);
    expect(inspection.association?.artifact.classId).toBe(inspection.node.currentClassId);
    const loaded = await loadRegisteredContract(context, address);
    expect(loaded.association.artifact.contentHash).toBe(initial.artifact.contentHash);
    expect(loaded.artifact.name).toBe("Token");
    expect(loaded.artifact.classId).toBe(classId);
  });

  it("distinguishes an unknown deployment from an unavailable artifact", async () => {
    const { context, artifactPath, register } = await fixture();
    const unknown = `0x${"2".padStart(64, "0")}`;
    await expect(registerContract({ address: unknown, artifactPath }, context)).rejects.toMatchObject({ code: "unknown-deployment" });
    expect((await inspectContract({ address: unknown, artifactPath }, context)).problems).toContain("unknown-deployment");
    await rm(artifactPath);
    expect((await inspectContract({ address, artifactPath }, context)).problems).toContain("artifact-unavailable");
    expect(register).not.toHaveBeenCalled();
  });
});
