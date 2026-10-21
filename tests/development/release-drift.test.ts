import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { renderDeployScript, type ReleaseManifest } from "../../src/development/release.js";
import { loadCandidate, recordPath } from "./candidate.js";
const COMMANDS_FILE = "cmds/index.js";
const PROGRAM_FILE = "bin/index.js";
const FEES_FILE = "utils/options/fees.js";
const OPTIONS_FILE = "utils/options/options.js";
const HELPER_FLAGS: Record<string, { helper: string; file: string }> = {
  "--args": { helper: "createArgsOption(", file: OPTIONS_FILE },
  "--from": { helper: "createAccountOption(", file: OPTIONS_FILE },
  "--alias": { helper: "createAliasOption(", file: OPTIONS_FILE },
  "--payment": { helper: "CLIFeeArgs.getOptions()", file: FEES_FILE },
};
const DEPLOY_FLAGS = ["--init", "--no-init", "--wait-for-status", "--json"];
const PROGRAM_FLAGS = ["--node-url"];
const manifest = (initialize: boolean): ReleaseManifest => ({
  schemaVersion: 1, generatedAt: "2026-10-21T12:00:00.000Z",
  build: { jobId: "job", kind: "compile", projectPath: "/work/project", provenanceHash: "p" },
  artifact: { path: "/work/project/artifact.json", sha256: "0123456789abcdef".repeat(4), contractName: "Token" },
  deployment: { args: ["1000"], initialize, initializerName: "constructor", account: "alice", contractAlias: "token", nodeUrl: "https://node.example" },
  fee: { method: "fee_juice" },
  toolchain: { installationRoot: "/opt/aztec", nodeExecutable: "/opt/node", runtimeIdentity: "r", cli: { path: "/opt/aztec/bin/aztec-wallet" } },
});
const emittedFlags = [...new Set([true, false].flatMap(initialize => renderDeployScript(manifest(initialize)).match(/(?<=\s)--[a-z][a-z-]*/g) ?? []))].sort();
const commandBlock = (source: string, name: string): string => {
  const start = source.indexOf(`program.command('${name}')`);
  expect(start, `command ${name}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("program.command(", start + 1);
  expect(end, `end of command ${name}`).toBeGreaterThan(start);
  return source.slice(start, end);
};
const declares = (source: string, flag: string) => new RegExp(`${flag}(?![a-z-])`).test(source);
it.skipIf(!recordPath)("finds every command and flag of the release script in the installed wallet", async () => {
  const { selection } = await loadCandidate();
  const files: Record<string, string> = Object.fromEntries(await Promise.all([COMMANDS_FILE, PROGRAM_FILE, FEES_FILE, OPTIONS_FILE].map(async file =>
    [file, await readFile(join(selection.installationRoot, "node_modules/@aztec-labs/cli-wallet/dest", file), "utf8")])));
  const commands = files[COMMANDS_FILE]!;
  const deploy = commandBlock(commands, "deploy");
  expect(emittedFlags).toEqual([...DEPLOY_FLAGS, ...PROGRAM_FLAGS, ...Object.keys(HELPER_FLAGS)].sort());
  for (const flag of DEPLOY_FLAGS) expect(declares(deploy, flag), `${flag} in deploy`).toBe(true);
  for (const flag of PROGRAM_FLAGS) expect(declares(files[PROGRAM_FILE]!, flag), `${flag} in ${PROGRAM_FILE}`).toBe(true);
  for (const [flag, { helper, file }] of Object.entries(HELPER_FLAGS)) {
    expect(deploy, `${helper} in deploy`).toContain(helper);
    expect(declares(files[file]!, flag), `${flag} in ${file}`).toBe(true);
  }
  for (const method of ["fee_juice", "fpc-sponsored"]) expect(files[FEES_FILE], method).toContain(`case '${method}'`);
  expect(files[FEES_FILE]).toContain("fpc:");
  for (const command of ["create-account", "deploy-account", "register-contract", "get-tx"]) expect(commands, command).toContain(`.command('${command}')`);
  expect(declares(commandBlock(commands, "create-account"), "--register-only"), "--register-only").toBe(true);
}, 60000);
