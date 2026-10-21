import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BN254_SCALAR_FIELD_MODULUS, validateFunctionArguments, type AbiType } from "../../src/development/abi.js";
import { executeCall } from "../../src/development/call-operations.js";
import { registerContract } from "../../src/development/contract-operations.js";
import type { RuntimeContext } from "../../src/development/runtime-worker.js";

const arg = (type: AbiType, value: unknown) => validateFunctionArguments({ parameters: [{ name: "value", type }] }, [value]).args[0];
const address = `0x${"1".padStart(64, "0")}`;
const alice = `0x${"2".padStart(64, "0")}`;
const bob = `0x${"3".padStart(64, "0")}`;
const addressType = { kind: "struct", path: "aztec::protocol_types::address::aztec_address::AztecAddress", fields: [{ name: "inner", type: { kind: "field" } }] };

describe("strict ABI inputs", () => {
  it("preserves large exact integers and enforces signed/unsigned bounds", () => {
    expect(arg({ kind: "integer", width: 128, sign: "unsigned" }, "340282366920938463463374607431768211455")).toBe((1n << 128n) - 1n);
    expect(arg({ kind: "integer", width: 8, sign: "signed" }, "-128")).toBe(-128n);
    expect(arg({ kind: "integer", width: 8, sign: "unsigned" }, "0xff")).toBe(255n);
    for (const value of [256, -1, Number.MAX_SAFE_INTEGER + 1, 1.5, true, "1e2", " 1", "01"]) expect(() => arg({ kind: "integer", width: 8, sign: "unsigned" }, value)).toThrow("args[0]");
    expect(() => arg({ kind: "integer", width: 8, sign: "signed" }, -129)).toThrow("i8");
  });
  it("rejects out-of-range fields, coerced booleans, malformed addresses and strings", () => {
    expect(arg({ kind: "field" }, (BN254_SCALAR_FIELD_MODULUS - 1n).toString())).toBe(BN254_SCALAR_FIELD_MODULUS - 1n);
    for (const value of [BN254_SCALAR_FIELD_MODULUS.toString(), -1, true]) expect(() => arg({ kind: "field" }, value)).toThrow();
    for (const value of ["false", 0, {}, null]) expect(() => arg({ kind: "boolean" }, value)).toThrow("JSON boolean");
    expect(arg(addressType, alice)).toEqual({ inner: 2n });
    expect(() => arg(addressType, "0x2")).toThrow("32-byte");
    expect(() => arg(addressType, `0x${"f".repeat(64)}`)).toThrow("modulus");
    expect(() => arg({ kind: "string", length: 2 }, "abc")).toThrow("ASCII");
    expect(() => arg({ kind: "string", length: 2 }, "é")).toThrow("ASCII");
  });
  it("normalizes function selectors and bounded vectors for the SDK without discarding nonzero padding", () => {
    const selector = { kind: "struct", path: "aztec::protocol_types::abis::function_selector::FunctionSelector", fields: [{ name: "inner", type: { kind: "integer", sign: "unsigned", width: 32 } }] };
    expect(arg(selector, { inner: "0xff" })).toBe(255n);
    const vector = { kind: "struct", path: "std::collections::bounded_vec::BoundedVec", fields: [{ name: "storage", type: { kind: "array", length: 3, type: { kind: "field" } } }, { name: "len", type: { kind: "integer", sign: "unsigned", width: 32 } }] };
    expect(arg(vector, { storage: [7, 0, 0], len: 1 })).toEqual([7n]);
    expect(() => arg(vector, { storage: [7, 8, 0], len: 1 })).toThrow("zero padded");
    expect(() => arg(vector, { storage: [7, 8, 0], len: 4 })).toThrow("capacity");
  });
  it("requires exact argument, array and nested struct shapes", () => {
    const type = { kind: "struct", fields: [{ name: "flags", type: { kind: "array", length: 2, type: { kind: "boolean" } } }] };
    expect(arg(type, { flags: [true, false] })).toEqual({ flags: [true, false] });
    for (const value of [{ flags: [true] }, { flags: [true, false], extra: 1 }, {}, { flags: [true, "false"] }]) expect(() => arg(type, value)).toThrow();
    expect(() => validateFunctionArguments({ parameters: [] }, [1])).toThrow("exactly 0");
  });
});

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mcp-calls-")); roots.push(root);
  const artifactPath = join(root, "token.json");
  const privateView = { name: "balance", functionType: "utility", parameters: [{ name: "owner", type: addressType }], returnTypes: [{ kind: "integer", width: 128, sign: "unsigned" }] };
  const publicView = { name: "public_balance", functionType: "public", isStatic: true, parameters: [], returnTypes: [{ kind: "field" }] };
  const transfer = { name: "transfer", functionType: "private", parameters: [{ name: "amount", type: { kind: "integer", width: 128, sign: "unsigned" } }], returnTypes: [], errorTypes: { "1": { error_kind: "string", string: "Balance too low" } } };
  await writeFile(artifactPath, JSON.stringify({ name: "Token", classId: "class1", functions: [privateView, transfer], nonDispatchPublicFunctions: [publicView] }));
  let registered = false; let hash = "block7";
  const calls = vi.fn(async (name: string, args: unknown[], options: any) => {
    if (name === "transfer") throw new Error("SDK trace: Balance too low; secret material must not leak");
    return { result: name === "balance" ? options.from.toString() === alice ? 333n : 0n : 99n, privateOffchainData: "must not leak" };
  });
  const instance = { currentContractClassId: "class1", originalContractClassId: "class1" };
  const context: RuntimeContext = {
    stateDirectory: root, network: { nodeVersion: "fixture", l1ChainId: 31337, rollupVersion: 1, rollupAddress: "0x1", realProofs: false },
    node: { getBlockNumber: async () => 7, getBlockData: async () => ({ blockHash: hash }), getContract: async () => instance },
    wallet: {
      getAccounts: async () => [{ item: alice }, { item: bob }], registerContract: async () => { registered = true; },
      getContractMetadata: async () => ({ instance: registered ? instance : undefined }),
      getContractClassMetadata: async () => ({ isArtifactRegistered: registered, isContractClassPubliclyRegistered: true }),
    },
    loadModule: async name => {
      if (name.endsWith("/addresses")) return { AztecAddress: { fromStringUnsafe: (value: string) => ({ toString: () => value, isValid: async () => true }) } };
      if (name.endsWith("/abi")) return { loadContractArtifact: (value: unknown) => value, contractArtifactFromBuffer: (value: unknown) => value, contractArtifactToBuffer: (value: unknown) => value, getAllFunctionAbis: (artifact: any) => [...artifact.functions, ...artifact.nonDispatchPublicFunctions] };
      if (name.endsWith("/contract")) return { getContractClassFromArtifact: async () => ({ id: "class1" }) };
      if (name.endsWith("/contracts")) return { Contract: { at: async () => ({ methods: Object.fromEntries(["balance", "public_balance", "transfer"].map(name => [name, (...args: unknown[]) => ({ simulate: (options: unknown) => calls(name, args, options) })])) }) } };
      throw new Error(`Unexpected module ${name}`);
    },
  };
  await registerContract({ address, artifactPath }, context);
  const input = { address, functionName: "balance", args: [alice], account: alice };
  return { context, input, calls, replaceChain: () => { hash = "replacement"; } };
}

describe("account-scoped calls", () => {
  it("returns private results per account and public signatures from dispatch metadata", async () => {
    const { context, input, calls } = await fixture();
    const first = await executeCall({ ...input, minimumBlock: 7 }, context, "view");
    expect(first).toMatchObject({ status: "succeeded", result: "333", dataStatus: "available", accountScope: [alice], chainTransactionSubmitted: false, proofValidityEstablished: false, freshness: { synchronizedThroughBlock: 7, exactExecutionBlock: false } });
    const scoped = await executeCall({ ...input, account: bob }, context, "view"); expect(scoped.result).toBe("0"); expect(scoped.dataStatus).toBe("available");
    expect((await executeCall({ ...input, functionName: "public_balance", args: [] }, context, "view")).result).toBe("99");
    expect(calls.mock.calls[0][2]).toMatchObject({ includeMetadata: true }); expect(calls.mock.calls[0][2]).not.toHaveProperty("additionalScopes");
    expect(JSON.stringify(first)).not.toContain("must not leak");
  });
  it("distinguishes simulation failure and unavailable return from a returned zero", async () => {
    const { context, input, calls } = await fixture();
    const failed = await executeCall({ ...input, functionName: "transfer", args: [999] }, context, "simulate");
    expect(failed).toMatchObject({ status: "failed", result: null, dataStatus: "unavailable", chainTransactionSubmitted: false, error: { code: "simulation-failed", contractAssertion: "Balance too low" } });
    expect(JSON.stringify(failed)).not.toContain("secret material");
    calls.mockResolvedValueOnce({ result: undefined } as any);
    expect(await executeCall(input, context, "view")).toMatchObject({ status: "failed", dataStatus: "unavailable", error: { code: "result-unavailable" } });
  });
  it("rejects invalid scopes, functions, ABI values and unsupported stateful views before execution", async () => {
    const { context, input, calls } = await fixture();
    await expect(executeCall({ ...input, account: address }, context, "view")).rejects.toMatchObject({ code: "invalid-account" });
    await expect(executeCall({ ...input, functionName: "nope" }, context, "view")).rejects.toMatchObject({ code: "invalid-function" });
    await expect(executeCall({ ...input, functionName: "transfer", args: [1] }, context, "view")).rejects.toMatchObject({ code: "invalid-view" });
    await expect(executeCall({ ...input, args: [true] }, context, "view")).rejects.toMatchObject({ code: "invalid-abi-arguments" });
    expect(calls).not.toHaveBeenCalled();
  });
  it("rejects an unmet minimum block and never uses a result after chain replacement", async () => {
    const { context, input, calls, replaceChain } = await fixture();
    await expect(executeCall({ ...input, minimumBlock: 8 }, context, "view")).rejects.toMatchObject({ code: "freshness-unavailable" });
    expect(calls).not.toHaveBeenCalled();
    calls.mockImplementationOnce(async () => { replaceChain(); return { result: 42n } as any; });
    expect(await executeCall(input, context, "view")).toMatchObject({ status: "failed", dataStatus: "unavailable", result: null, error: { code: "freshness-unavailable" } });
  });
});
