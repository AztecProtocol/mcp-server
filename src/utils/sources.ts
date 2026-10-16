import { existsSync } from "fs";
import { join } from "path";
import { getRepoPath } from "./git.js";
import { getAztecRepos } from "../repos/config.js";
import { readSyncMetadata } from "./sync-metadata.js";

export function getSourceMetadata() {
  const metadata = readSyncMetadata();
  if (metadata?.pendingVersion) {
    throw new Error(`Sync for ${metadata.pendingVersion} is incomplete. Run aztec_sync_repos again before searching.`);
  }
  return metadata;
}

/** Undefined retains legacy discovery; split releases search only recorded checkouts. */
export function getActiveRepoNames(): string[] | undefined {
  const metadata = getSourceMetadata();
  if (metadata?.repositories) return Object.keys(metadata.repositories);
  if (metadata?.aztecVersion) {
    return getAztecRepos(metadata.aztecVersion).flatMap((repo) =>
      repo.sparsePathOverrides ? [repo.name, `${repo.name}-docs`] : [repo.name]);
  }
  return undefined;
}

export function getCodeRepo(): string {
  return getSourceMetadata()?.repositories?.["aztec-node"] ? "aztec-node" : "aztec-packages";
}

export function getDocsSource(): { repo: string; paths?: string[]; notice: string } {
  const metadata = getSourceMetadata();
  const commit = metadata?.repositories?.["aztec-node"];
  if (!commit) return { repo: "aztec-packages-docs", notice: "" };

  return getNodeDocsSource(metadata.aztecVersion, commit);
}

export function getNodeDocsSource(version: string, commit: string): { repo: string; paths: string[]; notice: string } {
  const tag = version.startsWith("v") ? version : `v${version}`;
  const snapshot = `aztec-node/docs/developer_versioned_docs/version-${tag}`;
  if (existsSync(getRepoPath(snapshot))) {
    return { repo: "aztec-node", paths: [snapshot], notice: `Documentation snapshot ${tag} from aztec-node @ ${commit}.` };
  }
  return {
    repo: "aztec-node",
    paths: ["aztec-node/docs/docs-developers/docs", "aztec-node/docs/docs-operate", "aztec-node/docs/docs-participate"],
    notice: `No exact ${tag} documentation snapshot; using unversioned docs from aztec-node @ ${commit}.`,
  };
}

export function narrowDocsPaths(paths: string[], section?: string): string[] {
  if (!section) return paths;
  const matching = paths.map((path) => join(path, section)).filter((path) => existsSync(getRepoPath(path)));
  return matching.length ? matching : paths;
}
