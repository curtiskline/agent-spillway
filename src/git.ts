import { realpathSync, existsSync } from "node:fs";
import { mkdir, chmod, lstat, readFile } from "node:fs/promises";
import { resolve, relative, isAbsolute, dirname, join } from "node:path";
import {
  SpillwayError,
  type WorkspaceContract,
  type WorktreeInspection,
} from "./contracts.js";
import { runProcess, minimalEnvironment, OUTPUT_TRUNCATED } from "./process.js";

export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  if (parent === absolute) return absolute;
  return join(canonicalPath(parent), relative(parent, absolute));
}
export function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (!rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      rel !== ".." &&
      !isAbsolute(rel))
  );
}
export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}
export async function gitCommand(cwd: string, args: string[]): Promise<string> {
  const result = await runProcess({
    command: "git",
    args: [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.quotePath=false",
      ...args,
    ],
    cwd,
    env: {
      ...minimalEnvironment("/nonexistent-spillway-home"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
    },
    timeoutMs: 30_000,
  });
  if (
    result.exitCode !== 0 ||
    result.timedOut ||
    result.stdout.includes(OUTPUT_TRUNCATED)
  )
    throw new SpillwayError(
      "git_error",
      `Git operation failed: ${args[0] ?? "unknown"}`,
    );
  return result.stdout;
}
export function assertSha(sha: string): void {
  if (!/^[a-f0-9]{40,64}$/.test(sha))
    throw new SpillwayError(
      "invalid_commit",
      "Expected an immutable Git commit SHA",
    );
}

export class GitWorkspace implements WorkspaceContract {
  readonly repo: string;
  readonly dataDir: string;
  private readonly verificationPaths = new Set<string>();
  constructor(repo: string, dataDir: string) {
    this.repo = canonicalPath(repo);
    this.dataDir = canonicalPath(dataDir);
    if (
      within(this.dataDir, this.repo) ||
      within(this.dataDir, canonicalPath(process.cwd()))
    )
      throw new SpillwayError(
        "unsafe_data_dir",
        "Runtime data must be outside target and Spillway repositories",
      );
  }
  async resolveBase(ref: string): Promise<string> {
    if (!ref || ref.startsWith("-") || ref.includes("\0"))
      throw new SpillwayError("invalid_ref", "Invalid base reference");
    const sha = (
      await gitCommand(this.repo, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${ref}^{commit}`,
      ])
    ).trim();
    assertSha(sha);
    return sha;
  }
  async createWorker(
    taskId: string,
    baseSha: string,
    attemptId: number,
  ): Promise<string> {
    assertSha(baseSha);
    if (
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(taskId) ||
      !Number.isSafeInteger(attemptId) ||
      attemptId < 1
    )
      throw new SpillwayError("invalid_worktree", "Invalid worktree identity");
    const parent = join(this.dataDir, "worktrees");
    await privateDirectory(parent);
    const path = join(parent, `worker-${attemptId}-${taskId}`);
    await gitCommand(this.repo, [
      "worktree",
      "add",
      "-b",
      `spillway/${taskId}`,
      "--",
      path,
      baseSha,
    ]);
    await chmod(path, 0o700);
    return path;
  }
  async inspect(
    path: string,
    baseSha: string,
    expectedBranch: string,
  ): Promise<WorktreeInspection> {
    assertSha(baseSha);
    const head = (
      await gitCommand(path, ["rev-parse", "--verify", "HEAD"])
    ).trim();
    assertSha(head);
    const branch = (
      await gitCommand(path, ["rev-parse", "--abbrev-ref", "HEAD"])
    ).trim();
    const status = await gitCommand(path, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignored=matching",
    ]);
    const tokens = status.split("\0").filter(Boolean);
    const dirtyPaths: string[] = [];
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!;
      dirtyPaths.push(token.slice(3));
      if (/^[RC]|^.[RC]/.test(token)) {
        const old = tokens[++index];
        if (old) dirtyPaths.push(old);
      }
    }
    const descendant = await this.isAncestor(baseSha, head);
    const hasChanges =
      head !== baseSha && (await this.diff(baseSha, head)).length > 0;
    return {
      head,
      branch,
      clean: dirtyPaths.length === 0,
      descendant: descendant && branch === expectedBranch,
      hasChanges,
      dirtyPaths: [...new Set(dirtyPaths)],
    };
  }
  async createVerification(commit: string, attemptId: number): Promise<string> {
    assertSha(commit);
    if (!Number.isSafeInteger(attemptId) || attemptId < 1)
      throw new SpillwayError("invalid_worktree", "Invalid attempt identity");
    const parent = join(this.dataDir, "worktrees");
    await privateDirectory(parent);
    const path = join(parent, `verification-${attemptId}`);
    await gitCommand(this.repo, [
      "worktree",
      "add",
      "--detach",
      "--",
      path,
      commit,
    ]);
    await chmod(path, 0o700);
    this.verificationPaths.add(path);
    return path;
  }
  async createReviewVerification(
    commit: string,
    reviewId: number,
  ): Promise<string> {
    assertSha(commit);
    if (!Number.isSafeInteger(reviewId) || reviewId < 1)
      throw new SpillwayError("invalid_worktree", "Invalid review identity");
    const parent = join(this.dataDir, "worktrees");
    await privateDirectory(parent);
    const path = join(parent, `review-${reviewId}`);
    await gitCommand(this.repo, [
      "worktree",
      "add",
      "--detach",
      "--",
      path,
      commit,
    ]);
    await chmod(path, 0o700);
    this.verificationPaths.add(path);
    return path;
  }
  async archiveWorker(
    path: string,
    taskId: string,
    attemptId: number,
  ): Promise<string> {
    if (
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(taskId) ||
      !Number.isSafeInteger(attemptId) ||
      attemptId < 1 ||
      path !==
        join(this.dataDir, "worktrees", `worker-${attemptId}-${taskId}`) ||
      canonicalPath(path) !== path
    )
      throw new SpillwayError(
        "unsafe_archive",
        "Refusing to archive an unmanaged worker checkout",
      );
    await this.assertWorkerMetadata(path);
    const branch = (
      await gitCommand(path, ["rev-parse", "--abbrev-ref", "HEAD"])
    ).trim();
    if (branch !== `spillway/${taskId}`)
      throw new SpillwayError(
        "unsafe_archive",
        "Worker is no longer on its expected result branch",
      );
    const archived = `spillway/${taskId}-attempt-${attemptId}`;
    await gitCommand(path, ["branch", "-m", branch, archived]);
    return archived;
  }
  async preserveTransportWorker(
    path: string,
    taskId: string,
    attemptId: number,
  ): Promise<void> {
    if (
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(taskId) ||
      !Number.isSafeInteger(attemptId) ||
      attemptId < 1 ||
      path !==
        join(this.dataDir, "worktrees", `worker-${attemptId}-${taskId}`) ||
      canonicalPath(path) !== path
    ) {
      throw new SpillwayError(
        "unsafe_archive",
        "Refusing to archive an unmanaged worker checkout",
      );
    }
    await this.assertWorkerMetadata(path);
    const branch = (
      await gitCommand(path, ["rev-parse", "--abbrev-ref", "HEAD"])
    ).trim();
    if (branch !== `spillway/${taskId}`)
      throw new SpillwayError(
        "unsafe_archive",
        "Worker is no longer on its expected result branch",
      );
    await gitCommand(path, [
      "branch",
      "-m",
      `spillway/${taskId}`,
      `spillway/${taskId}-transport-${attemptId}`,
    ]);
  }
  private async assertWorkerMetadata(path: string): Promise<void> {
    try {
      const pointer = await lstat(join(path, ".git"));
      if (!pointer.isFile() || pointer.isSymbolicLink() || pointer.size > 16384)
        throw new Error("Invalid Git pointer");
      const originalCommon = canonicalPath(
        (
          await gitCommand(this.repo, [
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
          ])
        ).trim(),
      );
      const workerCommon = canonicalPath(
        (
          await gitCommand(path, [
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
          ])
        ).trim(),
      );
      const workerGitDir = canonicalPath(
        (await gitCommand(path, ["rev-parse", "--absolute-git-dir"])).trim(),
      );
      if (
        workerCommon !== originalCommon ||
        !within(workerGitDir, join(originalCommon, "worktrees"))
      )
        throw new Error("Foreign Git metadata");
      const backlink = join(workerGitDir, "gitdir");
      const info = await lstat(backlink);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size > 16384 ||
        canonicalPath((await readFile(backlink, "utf8")).trim()) !==
          join(path, ".git")
      )
        throw new Error("Worktree backlink mismatch");
    } catch {
      throw new SpillwayError(
        "unsafe_archive",
        "Worker Git metadata no longer identifies its exact registered checkout",
      );
    }
  }
  async removeVerification(path: string): Promise<void> {
    if (
      !this.verificationPaths.has(path) ||
      canonicalPath(path) !== path ||
      !within(path, join(this.dataDir, "worktrees")) ||
      (await lstat(path)).isSymbolicLink()
    )
      throw new SpillwayError(
        "unsafe_remove",
        "Refusing to remove an unmanaged checkout",
      );
    await gitCommand(this.repo, ["worktree", "remove", "--force", "--", path]);
    this.verificationPaths.delete(path);
  }
  async isAncestor(older: string, newer: string): Promise<boolean> {
    assertSha(older);
    assertSha(newer);
    const result = await runProcess({
      command: "git",
      args: ["merge-base", "--is-ancestor", older, newer],
      cwd: this.repo,
      env: {
        ...minimalEnvironment("/nonexistent-spillway-home"),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
      timeoutMs: 30_000,
    });
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw new SpillwayError("git_error", "Could not inspect commit ancestry");
  }
  async diff(base: string, result: string): Promise<string> {
    assertSha(base);
    assertSha(result);
    return gitCommand(this.repo, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--binary",
      "--find-renames",
      base,
      result,
      "--",
    ]);
  }
}
