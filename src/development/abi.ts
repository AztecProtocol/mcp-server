/** The Noir field used by the validated Aztec runtime (BN254 scalar field). */
export const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export interface AbiType {
  kind: string; width?: number; sign?: string; length?: number; type?: AbiType;
  path?: string; fields?: Array<{ name: string; type: AbiType }>;
}
export interface FunctionAbi {
  name: string; parameters: Array<{ name: string; type: AbiType }>;
  functionType?: string; isStatic?: boolean; isOnlySelf?: boolean; isInitializer?: boolean;
  returnTypes?: AbiType[]; errorTypes?: Record<string, { error_kind?: string; string?: string }>;
}
export class AbiValidationError extends Error {
  readonly code = "invalid-abi-arguments";
  constructor(path: string, expectation: string) { super(`${path}: ${expectation}`); this.name = "AbiValidationError"; }
}
function invalid(path: string, expectation: string): never { throw new AbiValidationError(path, expectation); }
function integer(value: unknown, path: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) invalid(path, "use an exact decimal or hexadecimal string for large integers; numbers must be safe integers");
    return BigInt(value);
  }
  if (typeof value !== "string" || value.length > 256 || !/^(?:-?(?:0|[1-9][0-9]*)|0x[0-9a-fA-F]+)$/.test(value)) invalid(path, "expected an integer, decimal string, or 0x hexadecimal string");
  return BigInt(value);
}
/** Validate before the SDK's permissive encoder can coerce booleans or round JSON numbers. */
export function validateFunctionArguments(abi: Pick<FunctionAbi, "parameters">, values: unknown): { args: unknown[]; aztecAddresses: string[] } {
  if (!Array.isArray(values) || values.length !== abi.parameters.length) invalid("args", `expected exactly ${abi.parameters.length} arguments`);
  const aztecAddresses: string[] = []; let visited = 0;
  function normalize(type: AbiType, value: unknown, path: string, depth = 0): unknown {
    if (++visited > 16384 || depth > 32) invalid(path, "argument structure exceeds supported bounds");
    switch (type.kind) {
      case "field": { const n = integer(value, path); if (n < 0n || n >= FIELD_MODULUS) invalid(path, "field must be between zero and the field modulus minus one"); return n; }
      case "integer": {
        if (!Number.isInteger(type.width) || type.width! < 1 || type.width! > 128 || !["signed", "unsigned"].includes(type.sign!)) invalid(path, "unsupported integer ABI");
        const n = integer(value, path); const signed = type.sign === "signed"; const bits = BigInt(type.width! - (signed ? 1 : 0));
        if (n < (signed ? -(1n << bits) : 0n) || n >= (1n << bits)) invalid(path, `value is outside ${signed ? "i" : "u"}${type.width} range`);
        return n;
      }
      case "boolean": if (typeof value !== "boolean") invalid(path, "expected a JSON boolean"); return value;
      case "string":
        if (typeof value !== "string" || !Number.isSafeInteger(type.length) || type.length! < 0 || value.length > type.length! || /[^\x00-\x7f]/.test(value)) invalid(path, `expected an ASCII string of at most ${type.length} bytes`);
        return value;
      case "array":
        if (!Array.isArray(value) || !Number.isSafeInteger(type.length) || type.length! < 0 || value.length !== type.length || !type.type) invalid(path, `expected an array of exactly ${type.length} elements`);
        return value.map((item, index) => normalize(type.type!, item, `${path}[${index}]`, depth + 1));
      case "struct": {
        if (!type.fields || !Array.isArray(type.fields)) invalid(path, "unsupported struct ABI");
        const aztec = type.path?.endsWith("address::AztecAddress"); const eth = type.path?.endsWith("address::EthAddress");
        if (aztec || eth) {
          const length = aztec ? 64 : 40;
          if (typeof value !== "string" || !new RegExp(`^0x[0-9a-fA-F]{${length}}$`).test(value)) invalid(path, `expected a ${length / 2}-byte hexadecimal address`);
          const n = BigInt(value); if (n >= FIELD_MODULUS) invalid(path, "address exceeds the field modulus");
          if (aztec) aztecAddresses.push(value);
          return { inner: n };
        }
        if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(path, "expected an object with exactly the ABI struct fields");
        const fields = type.fields.map(field => field.name);
        if (Object.keys(value).length !== fields.length || fields.some(name => !Object.hasOwn(value, name))) invalid(path, "expected exactly the ABI struct fields, with none missing or extra");
        const result = Object.create(null);
        for (const field of type.fields) result[field.name] = normalize(field.type, (value as Record<string, unknown>)[field.name], `${path}.${field.name.slice(0, 64)}`, depth + 1);
        if (type.path?.endsWith("types::abis::function_selector::FunctionSelector")) return result.inner;
        if (type.path === "std::collections::bounded_vec::BoundedVec") {
          if (!Array.isArray(result.storage) || typeof result.len !== "bigint" || result.len < 0n || result.len > BigInt(result.storage.length)) invalid(path, "bounded vector length exceeds storage capacity");
          const zero = (item: unknown): boolean => item === 0n || item === 0 || item === false || item === "" || (!!item && typeof item === "object" && Object.values(item).every(zero));
          if (!result.storage.slice(Number(result.len)).every(zero)) invalid(path, "unused bounded-vector storage must be zero padded");
          // The SDK accepts a compact array and writes the storage padding and length itself.
          return result.storage.slice(0, Number(result.len));
        }
        return result;
      }
      default: return invalid(path, `unsupported ABI type ${String(type.kind).slice(0, 32)}`);
    }
  }
  return { args: abi.parameters.map((parameter, index) => normalize(parameter.type, values[index], `args[${index}]`)), aztecAddresses };
}
