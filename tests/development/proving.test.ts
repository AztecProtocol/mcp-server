import { afterEach, describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateProvingConfiguration } from "../../src/development/proving.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
describe("explicit real proving configuration", () => {
  it("requires an explicit backend and existing absolute CRS location", async () => {
    await expect(validateProvingConfiguration("/missing", undefined)).rejects.toThrow("proving-configuration-required");
    await expect(validateProvingConfiguration("/missing", { backend: "Wasm", crsPath: "/tmp" })).rejects.toThrow("unsupported-proving-backend");
    await expect(validateProvingConfiguration("/missing", { backend: "NativeUnixSocket", crsPath: "relative" })).rejects.toThrow("invalid-proving-configuration");
  });
  it("rejects missing CRS files before launching any backend or creating files", async () => {
    const root = await mkdtemp(join(tmpdir(), "aztec-proving-config-")); temporary.push(root);
    const crsPath = join(root, "crs"); await mkdir(crsPath);
    await expect(validateProvingConfiguration(root, { backend: "NativeUnixSocket", crsPath, threads: 2 })).rejects.toThrow("missing-proving-dependencies");
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(crsPath)).toEqual([]);
  });
  it("rejects unsafe or implicit backend options", async () => {
    for (const additional of [{ threads: 0 }, { threads: 17 }, { threads: 1.5 }, { bbPath: "/another/release/bb" }, { respawn: true }]) {
      await expect(validateProvingConfiguration("/missing", { backend: "NativeUnixSocket", crsPath: "/tmp", ...additional })).rejects.toThrow("invalid-proving-configuration");
    }
  });
  it.skipIf(process.platform !== "linux" || process.arch !== "x64")("refuses a different binary before executing its version command", async () => {
    const root = await mkdtemp(join(tmpdir(), "aztec-proving-binary-")); temporary.push(root);
    const crsPath = join(root, "crs"); await mkdir(crsPath);
    for (const [name, size] of [["bn254_g1.dat", 2 ** 25 * 64], ["bn254_g2.dat", 128], ["grumpkin_g1_v2.flat.dat", 2 ** 18 * 64]] as const) {
      const file = await open(join(crsPath, name), "w"); await file.truncate(size); await file.close();
    }
    const binaryDirectory = join(root, "node_modules", "@aztec-foundation", "bb.js", "build", "amd64-linux");
    await mkdir(binaryDirectory, { recursive: true });
    const marker = join(root, "executed");
    await writeFile(join(binaryDirectory, "bb"), `#!/bin/sh\ntouch '${marker}'\necho 6.0.0-rc.6\n`, { mode: 0o700 });
    await expect(validateProvingConfiguration(root, { backend: "NativeUnixSocket", crsPath })).rejects.toThrow("unsupported-proving-binary");
    await expect(access(marker)).rejects.toThrow();
  });
});
