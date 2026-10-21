import { createHash } from "node:crypto";
import type { ToolchainReport } from "./toolchain.js";

export interface NodeCompatibilityProfile {
  readonly nodeVersion: string;
  readonly l1ChainId: number;
  readonly rollupVersion: number;
  readonly realProofs: false;
  readonly l2ProtocolContractsHash: string;
  readonly l2CircuitsVkTreeRoot: string;
}
export interface SupportedRuntimeProfile {
  readonly runtimeIdentity: string;
  readonly network: NodeCompatibilityProfile;
}
type ObservedNetwork = { [Key in keyof NodeCompatibilityProfile]?: unknown } & { rollupAddress?: unknown };

export const CANDIDATE_RUNTIME_PROFILE: SupportedRuntimeProfile = Object.freeze({
  runtimeIdentity: "a37420cea954f5b910d9c6315b6e14a7870bc636f6f5d6dfe90002d7fc36fb68",
  network: Object.freeze({
    nodeVersion: "6.0.0-rc.3", l1ChainId: 31337, rollupVersion: 2267645166, realProofs: false,
    l2ProtocolContractsHash: "0x0f54271c52865841a77aaa66036eed901aff22fdce9f08e123ec8b205c9854d7",
    l2CircuitsVkTreeRoot: "0x13eeb174d4119b221a22721853261759f57a65a57e864ad78b840b23cde69e02",
  }),
});

const SUPPORTED_RUNTIME_PROFILES: readonly SupportedRuntimeProfile[] = Object.freeze([CANDIDATE_RUNTIME_PROFILE]);

export function runtimeIdentity(report: ToolchainReport): string {
  return createHash("sha256").update(JSON.stringify({
    target: report.target,
    node: report.runtimeNode.version,
    cli: report.cli.identity,
    compiler: report.compiler.identity,
    packages: report.packages.map(({ name, version }) => ({ name, version })).sort((a, b) => a.name.localeCompare(b.name)),
    lockfile: report.provenance.lockfileSha256,
  })).digest("hex");
}

export function getSupportedRuntimeProfile(identity: string): SupportedRuntimeProfile | undefined {
  return SUPPORTED_RUNTIME_PROFILES.find(profile => profile.runtimeIdentity === identity);
}

function canonicalField(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) return undefined;
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

export function networkProfileMismatches(expected: NodeCompatibilityProfile, observed: ObservedNetwork): (keyof NodeCompatibilityProfile)[] {
  const mismatches: (keyof NodeCompatibilityProfile)[] = [];
  for (const field of ["nodeVersion", "l1ChainId", "rollupVersion", "realProofs"] as const) {
    if (observed[field] !== expected[field]) mismatches.push(field);
  }
  for (const field of ["l2ProtocolContractsHash", "l2CircuitsVkTreeRoot"] as const) {
    const actual = canonicalField(observed[field]);
    if (!actual || actual !== canonicalField(expected[field])) mismatches.push(field);
  }
  return mismatches;
}

export class RuntimeSupportError extends Error {
  constructor(readonly code: "unsupported-runtime" | "incompatible-node", message: string, readonly components: readonly string[] = []) {
    super(`${code}: ${message}`); this.name = "RuntimeSupportError";
  }
}

export function validateSupportedNetwork(identity: string, observed: ObservedNetwork): SupportedRuntimeProfile {
  const profile = getSupportedRuntimeProfile(identity);
  if (!profile) throw new RuntimeSupportError("unsupported-runtime", "The selected component tuple has not completed development acceptance.");
  const mismatches = networkProfileMismatches(profile.network, observed);
  if (mismatches.length) throw new RuntimeSupportError("incompatible-node", `The node differs from the accepted runtime profile: ${mismatches.join(", ")}.`, mismatches);
  return profile;
}
