import { describe, expect, it } from "vitest";
import {
  CANDIDATE_RUNTIME_PROFILE,
  getSupportedRuntimeProfile,
  networkProfileMismatches,
  validateSupportedNetwork,
} from "../../src/development/runtime-support.js";

const expected = CANDIDATE_RUNTIME_PROFILE.network;

describe("runtime and node compatibility profiles", () => {
  it("accepts only the exact tuple promoted by the complete acceptance workflow", () => {
    expect(getSupportedRuntimeProfile(CANDIDATE_RUNTIME_PROFILE.runtimeIdentity)).toEqual(CANDIDATE_RUNTIME_PROFILE);
    expect(validateSupportedNetwork(CANDIDATE_RUNTIME_PROFILE.runtimeIdentity, expected)).toEqual(CANDIDATE_RUNTIME_PROFILE);
  });

  it("rejects unrecognized component tuples regardless of a matching node", () => {
    expect(getSupportedRuntimeProfile("f".repeat(64))).toBeUndefined();
    expect(() => validateSupportedNetwork("f".repeat(64), expected)).toThrow(/unsupported-runtime/);
  });

  it("matches protocol identity without pinning a particular rollup deployment address", () => {
    expect(networkProfileMismatches(expected, { ...expected, rollupAddress: `0x${"1".repeat(40)}` })).toEqual([]);
    expect(networkProfileMismatches(expected, { ...expected, rollupAddress: `0x${"2".repeat(40)}` })).toEqual([]);
  });

  it("normalizes equivalent field hex encodings without reducing or truncating their values", () => {
    expect(networkProfileMismatches(expected, {
      ...expected,
      l2ProtocolContractsHash: `0x${expected.l2ProtocolContractsHash.slice(2).replace(/^0+/, "").toUpperCase()}`,
      l2CircuitsVkTreeRoot: `0x${expected.l2CircuitsVkTreeRoot.slice(2).toUpperCase()}`,
    })).toEqual([]);
    expect(networkProfileMismatches(expected, { ...expected, l2ProtocolContractsHash: `0x1${expected.l2ProtocolContractsHash.slice(2)}` }))
      .toEqual(["l2ProtocolContractsHash"]);
  });

  it.each([
    ["nodeVersion", "6.0.0-rc.4"], ["l1ChainId", 1], ["rollupVersion", 2267645167],
    ["realProofs", true], ["l2ProtocolContractsHash", `0x${"1".repeat(64)}`],
    ["l2CircuitsVkTreeRoot", `0x${"2".repeat(64)}`],
  ])("rejects a different %s even when SDK versions match", (field, value) => {
    expect(networkProfileMismatches(expected, { ...expected, [field as string]: value })).toEqual([field]);
  });

  it.each([undefined, "", "0x", "-1", "1234", " 0x1234", "0xxyz", 1])("rejects malformed or missing protocol hash %s", value => {
    expect(networkProfileMismatches(expected, { ...expected, l2ProtocolContractsHash: value })).toEqual(["l2ProtocolContractsHash"]);
  });

  it("does not coerce chain configuration or proof requirements", () => {
    expect(networkProfileMismatches(expected, { ...expected, l1ChainId: "31337", realProofs: "false" })).toEqual(["l1ChainId", "realProofs"]);
  });
});
