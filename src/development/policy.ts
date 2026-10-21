import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { createCachedToolchainInspector } from "./toolchain.js";
import type { ToolchainReport, ToolchainSelection } from "./toolchain.js";
import { getSupportedRuntimeProfile, runtimeIdentity } from "./runtime-support.js";
export { runtimeIdentity } from "./runtime-support.js";

export type RuntimeValidator = (selection: ToolchainSelection) => Promise<ToolchainReport>;

const cachedProductionInspection = createCachedToolchainInspector();

export const validateSupportedRuntime: RuntimeValidator = async selection => {
  const report = await cachedProductionInspection(selection);
  const failures = report.diagnostics.filter(d => d.code !== "unsupported-runtime");
  if (failures.length || !getSupportedRuntimeProfile(runtimeIdentity(report))) {
    throw new McpError(ErrorCode.InvalidParams, "unsupported-runtime: selected toolchain has not passed the complete development acceptance workflow.", { diagnostics: report.diagnostics });
  }
  return report;
};


/** Integration-only dependency injection: never exposed as an MCP option or environment bypass. */
export function createCandidateRuntimeValidator(expectedRuntimeIdentity: string): RuntimeValidator {
  if (!/^[a-f0-9]{64}$/.test(expectedRuntimeIdentity)) throw new Error("Supply the exact recorded candidate runtime identity.");
  const inspect = createCachedToolchainInspector();
  return async selection => {
    const report = await inspect(selection);
    if (report.diagnostics.some(diagnostic => diagnostic.code !== "unsupported-runtime") || runtimeIdentity(report) !== expectedRuntimeIdentity) {
      throw new McpError(ErrorCode.InvalidParams, "unsupported-runtime: candidate validation requires the exact recorded component tuple.", { diagnostics: report.diagnostics });
    }
    return report;
  };
}
