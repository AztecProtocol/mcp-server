import { beforeEach, describe, expect, it, vi } from "vitest";
const git = vi.hoisted(() => ({ init: vi.fn(), addRemote: vi.fn(), fetch: vi.fn(), revparse: vi.fn(), raw: vi.fn() }));
vi.mock("simple-git", () => ({ simpleGit: vi.fn(() => git) }));
vi.mock("fs", () => ({ mkdtempSync: vi.fn(() => "/tmp/release-test"), rmSync: vi.fn() }));
import { rmSync } from "fs";
import { resolveReleaseCommits } from "../../src/utils/release.js";

const packages = "a".repeat(40);
const node = "b".repeat(40);
const noir = "c".repeat(40);
beforeEach(() => {
  vi.resetAllMocks();
  git.revparse.mockResolvedValue(packages + "\n");
  git.raw.mockImplementation(async (args: string[]) => {
    const path = args.at(-1);
    return `160000 commit ${path === "labs" ? node : noir}\t${path}\n`;
  });
});

describe("release resolution", () => {
  it("reads exact gitlinks from the fetched tag without checking out sources", async () => {
    expect(await resolveReleaseCommits("v6.0.0-rc.6")).toEqual({ packagesCommit: packages, nodeCommit: node, noirCommit: noir });
    expect(git.init).toHaveBeenCalledWith(true);
    expect(git.fetch).toHaveBeenCalledWith(["--depth=1", "--filter=blob:none", "--no-tags", "origin", "refs/tags/v6.0.0-rc.6"]);
    expect(git.raw).toHaveBeenCalledWith(["ls-tree", packages, "--", "labs"]);
    expect(rmSync).toHaveBeenCalledWith("/tmp/release-test", { recursive: true, force: true });
  });

  it("tries the alternate v prefix when the requested tag is absent", async () => {
    git.fetch.mockRejectedValueOnce(new Error("no tag"));
    await resolveReleaseCommits("6.0.0-rc.6");
    expect(git.fetch.mock.calls[1][0].at(-1)).toBe("refs/tags/v6.0.0-rc.6");
  });

  it("fails rather than using main when the labs gitlink is absent", async () => {
    git.raw.mockResolvedValue("");
    await expect(resolveReleaseCommits("v6.0.0-rc.6")).rejects.toThrow("no labs gitlink");
    expect(rmSync).toHaveBeenCalled();
  });

  it("rejects ordinary directories or blobs in place of the submodule", async () => {
    git.raw.mockResolvedValue(`040000 tree ${node}\tlabs\n`);
    await expect(resolveReleaseCommits("v6.0.0-rc.6")).rejects.toThrow("no labs gitlink");
  });

  it("cleans up temporary Git data when fetching fails", async () => {
    git.fetch.mockRejectedValue(new Error("network unavailable"));
    await expect(resolveReleaseCommits("v6.0.0-rc.6")).rejects.toThrow("network unavailable");
    expect(rmSync).toHaveBeenCalled();
  });

  it("rejects invalid release refs before invoking Git", async () => {
    await expect(resolveReleaseCommits("--upload-pack=other")).rejects.toThrow("Invalid Aztec release tag");
    expect(git.init).not.toHaveBeenCalled();
  });
});
