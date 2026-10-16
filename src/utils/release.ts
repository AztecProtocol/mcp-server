import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { simpleGit } from "simple-git";
import type { Logger } from "./git.js";

export interface ReleaseCommits {
  packagesCommit: string;
  nodeCommit: string;
  noirCommit: string;
}

/** Resolve gitlinks without checking out aztec-packages or downloading source blobs. */
export async function resolveReleaseCommits(version: string, log?: Logger): Promise<ReleaseCommits> {
  if (!/^v?\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) {
    throw new Error(`Invalid Aztec release tag: ${version}`);
  }
  const directory = mkdtempSync(join(tmpdir(), "aztec-mcp-release-"));
  try {
    const git = simpleGit(directory);
    await git.init(true);
    await git.addRemote("origin", "https://github.com/AztecProtocol/aztec-packages");
    const fetchTag = (tag: string) => git.fetch([
      "--depth=1", "--filter=blob:none", "--no-tags", "origin", `refs/tags/${tag}`,
    ]);
    log?.(`Resolving labs and Noir commits for ${version}`, "info");
    try {
      await fetchTag(version);
    } catch {
      await fetchTag(version.startsWith("v") ? version.slice(1) : `v${version}`);
    }
    const packagesCommit = (await git.revparse(["FETCH_HEAD^{commit}"])).trim();
    const gitlink = async (path: string): Promise<string> => {
      const entry = await git.raw(["ls-tree", packagesCommit, "--", path]);
      const match = entry.match(/^160000 commit ([a-f0-9]{40})\t([^\n]+)\n?$/);
      if (!match || match[2] !== path) {
        throw new Error(`${version} has no ${path} gitlink; cannot resolve a version-aligned checkout`);
      }
      return match[1];
    };
    return {
      packagesCommit,
      nodeCommit: await gitlink("labs"),
      noirCommit: await gitlink("noir/noir-repo"),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
