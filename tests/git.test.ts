import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitWorkspace } from "../src/git.js";

const exec = promisify(execFile);
describe("real Git workspace lifecycle", () => {
  let root: string;
  let repo: string;
  let workspace: GitWorkspace;
  let base: string;
  const git = async (cwd: string, ...args: string[]) =>
    (await exec("git", args, { cwd })).stdout.trim();
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "spillway-git-"));
    repo = join(root, "repo");
    await mkdir(repo);
    await git(repo, "init", "-b", "main");
    await git(repo, "config", "user.name", "Fixture");
    await git(repo, "config", "user.email", "fixture@example.invalid");
    await writeFile(join(repo, "hello.txt"), "before\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "base");
    workspace = new GitWorkspace(repo, join(root, "data"));
    base = await workspace.resolveBase("main");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  it("creates exact branches and detached verification checkouts", async () => {
    const worker = await workspace.createWorker("hello", base, 1);
    expect(
      await workspace.inspect(worker, base, "spillway/hello"),
    ).toMatchObject({
      clean: true,
      hasChanges: false,
      branch: "spillway/hello",
      descendant: true,
    });
    await writeFile(join(worker, "hello.txt"), "after\n");
    await git(worker, "add", ".");
    await git(worker, "commit", "-m", "result");
    const inspection = await workspace.inspect(worker, base, "spillway/hello");
    expect(inspection.hasChanges).toBe(true);
    expect(await workspace.isAncestor(base, inspection.head)).toBe(true);
    expect(await workspace.diff(base, inspection.head)).toContain("+after");
    const verification = await workspace.createVerification(inspection.head, 1);
    expect(await git(verification, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      "HEAD",
    );
    await workspace.removeVerification(verification);
    expect(await git(repo, "branch", "--list", "spillway/hello")).toContain(
      "spillway/hello",
    );
    await expect(workspace.removeVerification(worker)).rejects.toThrow(
      "unmanaged",
    );
  });
  it("reports tracked, untracked, ignored, and both renamed dirty paths", async () => {
    const worker = await workspace.createWorker("dirty", base, 1);
    await writeFile(join(worker, ".gitignore"), "ignored\n");
    await writeFile(join(worker, "ignored"), "artifact");
    await writeFile(join(worker, "untracked"), "artifact");
    await git(worker, "mv", "hello.txt", "renamed.txt");
    expect(
      (await workspace.inspect(worker, base, "spillway/dirty")).dirtyPaths,
    ).toEqual(
      expect.arrayContaining([
        "hello.txt",
        "renamed.txt",
        "untracked",
        "ignored",
      ]),
    );
  });
  it("preserves dirty transport evidence by archiving the branch", async () => {
    const worker = await workspace.createWorker("retry", base, 1);
    await writeFile(join(worker, "hello.txt"), "private worker progress");
    await workspace.preserveTransportWorker(worker, "retry", 1);
    expect(await git(worker, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      "spillway/retry-transport-1",
    );
    expect(await readFile(join(worker, "hello.txt"), "utf8")).toBe(
      "private worker progress",
    );
    const next = await workspace.createWorker("retry", base, 2);
    expect(await readFile(join(next, "hello.txt"), "utf8")).toBe("before\n");
    await expect(
      workspace.preserveTransportWorker(worker, "retry", 1),
    ).rejects.toThrow("expected");
    await expect(
      workspace.preserveTransportWorker(repo, "retry", 1),
    ).rejects.toThrow("unmanaged");
  });
  it("rejects option injection, identities and repository-contained state", async () => {
    await expect(workspace.resolveBase("--help")).rejects.toThrow("Invalid");
    await expect(workspace.createWorker("../escape", base, 1)).rejects.toThrow(
      "Invalid",
    );
    expect(() => new GitWorkspace(repo, join(repo, "state"))).toThrow(
      "outside",
    );
  });
});
