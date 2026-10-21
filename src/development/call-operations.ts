import { AbiValidationError, validateFunctionArguments, type FunctionAbi } from "./abi.js";
import { loadRegisteredContract } from "./contract-operations.js";
import { validateCallInput, type ContractCallInput, type ContractCallResult } from "./contracts.js";
import type { RuntimeContext, registerRuntimeOperation } from "./runtime-worker.js";

export const CALL_ERROR_MESSAGES: Record<string, string> = {
  "invalid-abi-arguments": "Arguments do not match the selected function ABI; check exact integer ranges, address encoding, and array/struct shapes.",
  "invalid-account": "Select a valid account registered in this session wallet.",
  "invalid-function": "Select a unique supported function from the registered artifact; initializers and internal-only functions cannot be called here.",
  "invalid-view": "Views require a utility function or an ABI function marked static.",
  "invalid-minimum-block": "minimumBlock must be a nonnegative safe integer.",
  "freshness-unavailable": "The node has not reached the requested block or its canonical block identity changed; no fresh result is available.",
};
function fail(code: string): never { throw Object.assign(new Error(CALL_ERROR_MESSAGES[code]), { code }); }

export async function prepareFunctionArguments(context: RuntimeContext, abi: Pick<FunctionAbi, "parameters">, values: unknown): Promise<unknown[]> {
  const normalized = validateFunctionArguments(abi, values);
  if (normalized.aztecAddresses.length) {
    const { AztecAddress } = await context.loadModule("@aztec-labs/aztec.js/addresses");
    for (const value of normalized.aztecAddresses) {
      try { if (!await AztecAddress.fromStringUnsafe(value).isValid()) throw new Error(); }
      catch { throw new AbiValidationError("args", "an Aztec address does not represent a valid address"); }
    }
  }
  return normalized.args;
}
export async function resolveCallAccount(context: RuntimeContext, value: string): Promise<any> {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) fail("invalid-account");
  const { AztecAddress } = await context.loadModule("@aztec-labs/aztec.js/addresses");
  let account: any;
  try { account = AztecAddress.fromStringUnsafe(value); if (!await account.isValid()) fail("invalid-account"); }
  catch { return fail("invalid-account"); }
  const available = await context.wallet.getAccounts();
  if (!available.some((entry: any) => entry.item.toString() === account.toString())) fail("invalid-account");
  return account;
}
export async function selectCallFunction(context: RuntimeContext, artifact: any, name: string): Promise<FunctionAbi> {
  const { getAllFunctionAbis } = await context.loadModule("@aztec-labs/stdlib/abi");
  const matches = getAllFunctionAbis(artifact).filter((abi: FunctionAbi) => abi.name === name);
  if (matches.length !== 1 || matches[0].isOnlySelf || matches[0].isInitializer || !["public", "private", "utility"].includes(matches[0].functionType)) fail("invalid-function");
  return matches[0];
}
export function contractAssertion(error: unknown, abi: FunctionAbi): string | undefined {
  const message = error instanceof Error ? error.message : "";
  return Object.values(abi.errorTypes ?? {}).filter(value => value.error_kind === "string" && value.string && value.string.length <= 256)
    .map(value => value.string!).sort((a, b) => b.length - a.length).find(value => message.includes(value))?.replace(/[\x00-\x1f\x7f]/g, " ");
}
function decodedResult(value: unknown): unknown {
  const json = JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
  if (json === undefined || json.length > 1024 * 1024) throw new Error("Result cannot be represented within the response limit");
  return JSON.parse(json);
}

export async function executeCall(input: ContractCallInput, context: RuntimeContext, operation: "simulate" | "view"): Promise<ContractCallResult> {
  validateCallInput(input);
  const loaded = await loadRegisteredContract(context, input.address);
  const abi = await selectCallFunction(context, loaded.artifact, input.functionName);
  if (operation === "view" && abi.functionType !== "utility" && abi.isStatic !== true) fail("invalid-view");
  const args = await prepareFunctionArguments(context, abi, input.args);
  const account = await resolveCallAccount(context, input.account);
  const before = await context.node.getBlockNumber();
  if (input.minimumBlock !== undefined && before < input.minimumBlock) fail("freshness-unavailable");
  const blockBefore = await context.node.getBlockData(before);
  if (!blockBefore) fail("freshness-unavailable");
  const blockHash = blockBefore.blockHash.toString();
  const output: ContractCallResult = {
    operation, status: "failed", address: loaded.address.toString(), functionName: abi.name, functionType: abi.functionType!, artifact: loaded.association.artifact,
    accountScope: [account.toString()], result: null, dataStatus: "unavailable", observedBlock: before, observedThroughBlock: before, observedAt: new Date().toISOString(),
    freshness: { cached: false, status: "unavailable", exactExecutionBlock: false, minimumBlock: input.minimumBlock },
    chainTransactionSubmitted: false, proofMode: context.proofMode ?? "fast", proofValidityEstablished: false,
  };
  let simulated: any;
  try {
    const { Contract } = await context.loadModule("@aztec-labs/aztec.js/contracts");
    const contract = await Contract.at(loaded.address, loaded.artifact, context.wallet);
    simulated = await contract.methods[abi.name](...args).simulate({ from: account, includeMetadata: true });
  } catch (error) {
    const assertion = contractAssertion(error, abi);
    output.error = { code: "simulation-failed", phase: "simulation", message: assertion ? `Contract assertion failed: ${assertion}` : "Simulation failed; check account scope, available notes, contract preconditions, and node connectivity.", contractAssertion: assertion };
    return output;
  }
  // The public result omits its exact anchor block. Report a conservative synchronization
  // lower bound and observation interval, and reject a changed canonical starting block.
  try {
    const after = await context.node.getBlockNumber(); const blockAfter = await context.node.getBlockData(before);
    output.observedThroughBlock = after; output.observedAt = new Date().toISOString();
    if (after < before || !blockAfter || blockAfter.blockHash.toString() !== blockHash) throw new Error("Chain changed");
    output.freshness = { cached: false, status: "sdk-synchronized", synchronizedThroughBlock: before, blockHash, exactExecutionBlock: false, minimumBlock: input.minimumBlock };
  } catch {
    output.error = { code: "freshness-unavailable", phase: "verification", message: CALL_ERROR_MESSAGES["freshness-unavailable"] }; return output;
  }
  if (simulated?.result === undefined && (abi.returnTypes?.length ?? 0) > 0) {
    output.error = { code: "result-unavailable", phase: "verification", message: "The function did not return its expected value. Unavailable private data is not a zero balance." }; return output;
  }
  try { output.result = simulated?.result === undefined ? null : decodedResult(simulated.result); }
  catch { output.error = { code: "result-unavailable", phase: "verification", message: "The result could not be decoded into a bounded JSON response." }; return output; }
  output.dataStatus = simulated?.result === undefined ? "no-return" : "available"; output.status = "succeeded";
  return output;
}
export function installCallOperations(register: typeof registerRuntimeOperation): void {
  register("contract-simulate", (input, context) => executeCall(input, context, "simulate"));
  register("contract-view", (input, context) => executeCall(input, context, "view"));
}
