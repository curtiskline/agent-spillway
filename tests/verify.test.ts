import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  readFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitWorkspace } from "../src/git.js";
import { verifyAttempt } from "../src/verify.js";
import type { AttemptRecord, TaskSpec } from "../src/contracts.js";

const exec = promisify(execFile);
describe("independent committed-result verification", () => {
  let root: string;
  let repo: string;
  let worker: string;
  let workspace: GitWorkspace;
  let spec: TaskSpec;
  let attempt: AttemptRecord;
  const git = async (cwd: string, ...args: string[]) =>
    (await exec("git", args, { cwd })).stdout.trim();
  const verify = () =>
    verifyAttempt({
      spec,
      attempt,
      workspace,
      artifactDir: join(root, "artifacts"),
    });
  const commit = async () => {
    await git(worker, "add", "-A");
    await git(worker, "commit", "-m", "result");
  };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "spillway-verify-"));
    repo = join(root, "repo");
    await mkdir(repo);
    await git(repo, "init", "-b", "main");
    await git(repo, "config", "user.name", "Fixture");
    await git(repo, "config", "user.email", "fixture@example.invalid");
    await mkdir(join(repo, "src"));
    await mkdir(join(repo, "tests"));
    await writeFile(join(repo, "src", "hello.txt"), "before\n");
    await writeFile(
      join(repo, "tests", "unit.test.js"),
      'test("case",()=>{ expect(true).toBe(true); });\n',
    );
    await writeFile(join(repo, ".gitignore"), "ignored.txt\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "base");
    workspace = new GitWorkspace(repo, join(root, "data"));
    const base = await workspace.resolveBase("main");
    worker = await workspace.createWorker("fixture", base, 1);
    spec = {
      id: "fixture",
      repo,
      base: "main",
      class: "small-fix",
      after: [],
      scope: ["src/**"],
      protected: [],
      context: ["src/hello.txt"],
      checks: ['test "$(cat src/hello.txt)" = after'],
      review: "checks-only",
      limits: { max_minutes: 1, max_attempts: 2 },
      body: "fixture",
    };
    attempt = {
      id: 1,
      taskId: "fixture",
      endpoint: "fixture",
      profileId: "fixture",
      model: "fixture",
      modelArtifact: "fixture-only",
      harness: "fixture",
      harnessVersion: "0",
      baseSha: base,
      branch: "spillway/fixture",
      worktree: worker,
      startedAt: new Date().toISOString(),
      endedAt: null,
      outcome: "completed",
      usage: null,
      summary: null,
      logPath: join(root, "harness.log"),
      resultSha: null,
      verification: null,
      reportPath: null,
    };
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  it("verifies in a detached clean checkout and preserves result refs", async () => {
    await writeFile(join(worker, "src", "hello.txt"), "after\n");
    await commit();
    spec.checks.push('test "$(git rev-parse --abbrev-ref HEAD)" = HEAD');
    const result = await verify();
    expect(result.passed).toBe(true);
    expect(result.changedPaths).toEqual(["src/hello.txt"]);
    expect(result.checks).toHaveLength(2);
    expect(await git(repo, "rev-parse", attempt.branch)).toBe(result.resultSha);
    expect(await readFile(result.diffPath!, "utf8")).toContain("+after");
    expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain(
      "verification-1",
    );
  });
  it.each(["untracked", "ignored", "tracked"] as const)(
    "rejects %s residue and captures evidence before checks",
    async (kind) => {
      await writeFile(join(worker, "src", "hello.txt"), "after\n");
      await commit();
      await writeFile(
        join(
          worker,
          kind === "tracked"
            ? "src/hello.txt"
            : kind === "ignored"
              ? "ignored.txt"
              : "untracked.txt",
        ),
        "residual evidence",
      );
      const result = await verify();
      expect(result.passed).toBe(false);
      expect(result.checks).toHaveLength(0);
      expect(result.reason).toContain("uncommitted");
      expect(await readFile(result.diffPath!, "utf8")).toContain(
        "residual evidence",
      );
    },
  );
  it("rejects an unchanged base and a worker on the wrong branch", async () => {
    const unchanged = await verify();
    expect(unchanged.reason).toContain("new commit");
    // Distinct artifact directory preserves first inspection artifacts.
    await writeFile(join(worker, "src", "hello.txt"), "after\n");
    await commit();
    await git(worker, "switch", "-c", "wrong");
    const wrong = await verifyAttempt({
      spec,
      attempt,
      workspace,
      artifactDir: join(root, "other-artifacts"),
    });
    expect(wrong.reason).toContain("exact task branch");
  });
  it("rejects unrelated ancestry even when branch identity is correct", async () => {
    await git(worker, "checkout", "--orphan", "unrelated");
    await git(worker, "rm", "-rf", ".");
    await writeFile(join(worker, "unrelated.txt"), "new root");
    await commit();
    await git(worker, "branch", "-D", attempt.branch);
    await git(worker, "branch", "-m", attempt.branch);
    expect((await verify()).reason).toContain("recorded base");
  });
  it("enforces both rename paths and protects the original path", async () => {
    await git(worker, "mv", "src/hello.txt", "outside.txt");
    await commit();
    expect((await verify()).reason).toContain("outside task scope");
    spec.scope = ["**"];
    spec.protected = ["src/hello.txt"];
    const result = await verifyAttempt({
      spec,
      attempt,
      workspace,
      artifactDir: join(root, "protected-artifacts"),
    });
    expect(result.changedPaths).toEqual(
      expect.arrayContaining(["src/hello.txt", "outside.txt"]),
    );
    expect(result.reason).toContain("protected");
  });
  it("preserves newline/tab and Unicode paths without splitting scope evidence", async () => {
    const name = "src/naïve\tfile\nname.txt";
    await writeFile(join(worker, name), "content");
    await writeFile(join(worker, "src", "hello.txt"), "after\n");
    await commit();
    const result = await verify();
    expect(result.reason).toBeUndefined();
    expect(result.passed).toBe(true);
    expect(result.changedPaths).toContain(name);
  });
  it("rejects introduced symlinks", async () => {
    await symlink("/etc/passwd", join(worker, "src", "link"));
    await commit();
    expect((await verify()).reason).toContain("symbolic links");
  });
  it("flags reduced assertions, skipped/deleted tests and sensitive manifests", async () => {
    spec.scope = ["**"];
    spec.checks = ["true"];
    await writeFile(
      join(worker, "tests", "unit.test.js"),
      'test.skip("case",()=>{});\n',
    );
    await writeFile(join(worker, "package.json"), "{}");
    await commit();
    const result = await verify();
    expect(result.passed).toBe(true);
    expect(result.flags).toEqual(
      expect.arrayContaining([
        "skipped-tests",
        "removed-tests",
        "reduced-assertions",
        "security-sensitive-path",
      ]),
    );
  });
  it("flags deleted tests", async () => {
    spec.scope = ["**"];
    spec.checks = ["true"];
    await git(worker, "rm", "tests/unit.test.js");
    await commit();
    expect((await verify()).flags).toContain("deleted-tests");
  });
  it("does not use worker-installed or ignored artifacts for checks", async () => {
    await writeFile(join(worker, "src", "hello.txt"), "after\n");
    await commit();
    // Worker artefacts cannot validate checks, even when the owner expects them.
    spec.checks = ["test -f ignored.txt"];
    const result = await verify();
    expect(result.reason).toContain("check failed");
    expect(result.checks[0]?.exitCode).not.toBe(0);
  });
  it("rejects checks mutating tracked files or moving the result branch", async () => {
    await writeFile(join(worker, "src", "hello.txt"), "after\n");
    await commit();
    spec.checks = ["echo forged > src/hello.txt"];
    expect((await verify()).reason).toContain("mutated tracked");
    spec.checks = [
      `git update-ref refs/heads/${attempt.branch} ${attempt.baseSha}`,
    ];
    const result = await verifyAttempt({
      spec,
      attempt,
      workspace,
      artifactDir: join(root, "branch-artifacts"),
    });
    expect(result.reason).toContain("changed during verification");
  });
  it("shares one attempt deadline across checks and records timeout", async () => {
    await writeFile(join(worker, "src", "hello.txt"), "after\n");
    await commit();
    spec.limits.max_minutes = 0.012;
    spec.checks = ["sleep 0.35", "sleep 1"];
    const result = await verify();
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("time budget");
    expect(result.checks.at(-1)?.timedOut).toBe(true);
  });
});
