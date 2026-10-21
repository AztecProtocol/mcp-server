import { expect } from "vitest";
import { readFile } from "node:fs/promises";
import { inspectToolchain } from "../../src/development/toolchain.js";
import { runtimeIdentity } from "../../src/development/policy.js";
export const recordPath = process.env.AZTEC_MCP_CANDIDATE_RECORD;
export async function loadCandidate() {
  const record = JSON.parse(await readFile(recordPath!, "utf8"));
  expect(record.status).toBe("candidate-passed");
  const selection = { installationRoot: record.installation.installationRoot, nodeExecutable: record.installation.runtimeNode.path };
  const report = await inspectToolchain(selection);
  expect(report.diagnostics.filter(d => d.code !== "unsupported-runtime")).toEqual([]);
  expect(runtimeIdentity(report)).toBe(runtimeIdentity(record.installation));
  return { record, selection, report };
}
