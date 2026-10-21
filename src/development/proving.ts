import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";

export interface ProvingConfiguration { backend: "NativeUnixSocket"; crsPath: string; threads?: number }
export interface ValidatedProvingConfiguration {
  backend: "NativeUnixSocket"; crsPath: string; threads: number;
  bbPath: string; binarySha256: string; version: "6.0.0-rc.6";
  crsFiles: Array<{ name: string; bytes: number }>;
  respawn: false;
}
export class ProvingConfigurationError extends Error {
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`); }
}
function fail(code: string, message: string): never { throw new ProvingConfigurationError(code, message); }
const NATIVE_BINARY_SHA256 = "fa4b12adaefd5684b53b802346b9fe839ab3d6a4a829a5ea4efd6bd200e0829f";
const CRS_FILES = [
  { name: "bn254_g1.dat", bytes: 2 ** 25 * 64 },
  { name: "bn254_g2.dat", bytes: 128 },
  { name: "grumpkin_g1_v2.flat.dat", bytes: 2 ** 18 * 64 },
];

export async function validateProvingConfiguration(installationRoot: string, value: unknown): Promise<ValidatedProvingConfiguration> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("proving-configuration-required", "Real mode requires proving: { backend: 'NativeUnixSocket', crsPath: '/existing/crs', threads: 2 }.");
  const input = value as Record<string, unknown>;
  if (input.backend !== "NativeUnixSocket") fail("unsupported-proving-backend", "Only the separately validated native Unix socket backend is supported; no fallback is attempted.");
  if (Object.keys(input).some(key => !["backend", "crsPath", "threads"].includes(key)) || typeof input.crsPath !== "string" || !isAbsolute(input.crsPath) ||
      (input.threads !== undefined && (!Number.isSafeInteger(input.threads) || Number(input.threads) < 1 || Number(input.threads) > 16))) {
    fail("invalid-proving-configuration", "Provide an absolute existing CRS directory and between 1 and 16 threads; binary overrides and automatic respawn are unsupported.");
  }
  let crsPath: string; const crsFiles: ValidatedProvingConfiguration["crsFiles"] = [];
  try {
    crsPath = await realpath(input.crsPath);
    if (!(await stat(crsPath)).isDirectory()) throw new Error();
    for (const file of CRS_FILES) {
      const metadata = await stat(join(crsPath, file.name));
      if (!metadata.isFile() || metadata.size < file.bytes || (file.name === "bn254_g2.dat" && metadata.size !== file.bytes)) throw new Error();
      await access(join(crsPath, file.name), constants.R_OK);
      crsFiles.push({ name: file.name, bytes: metadata.size });
    }
  } catch { return fail("missing-proving-dependencies", "Select an existing complete CRS cache: bn254_g1.dat (at least 2 GiB), bn254_g2.dat (128 bytes), grumpkin_g1_v2.flat.dat (at least 16 MiB). Missing data is never installed automatically."); }
  if (process.platform !== "linux" || process.arch !== "x64") fail("unsupported-proving-backend", "This real-proving profile has only been validated for Linux x64.");
  let bbPath: string; let binarySha256: string;
  try {
    const root = await realpath(installationRoot);
    bbPath = await realpath(join(root, "node_modules", "@aztec-foundation", "bb.js", "build", "amd64-linux", "bb"));
    const rel = relative(root, bbPath);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error();
    await access(bbPath, constants.X_OK);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(bbPath)) hash.update(chunk);
    binarySha256 = hash.digest("hex");
    if (binarySha256 !== NATIVE_BINARY_SHA256) throw new Error();
    const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_PATH;
    const { stdout } = await promisify(execFile)(bbPath, ["--version"], { timeout: 10000, maxBuffer: 8192, env });
    if (stdout.trim() !== "6.0.0-rc.6") throw new Error();
  } catch { return fail("unsupported-proving-binary", "The selected installation must contain the exact validated Foundation rc.6 native prover; restore that installation rather than selecting another binary."); }
  return { backend: "NativeUnixSocket", crsPath, threads: Number(input.threads ?? 2), bbPath, binarySha256, version: "6.0.0-rc.6", crsFiles, respawn: false };
}
