import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  access,
  readFile,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitWorkspace, canonicalPath } from "../src/git.js";
import { OpenCodeAdapter } from "../src/harness.js";
import {
  parseReviewReport,
  runLocalReview,
  REVIEW_RUBRIC,
} from "../src/review.js";
import { verifyAttempt } from "../src/verify.js";
import type { LocalReviewInput, ReviewReport } from "../src/contracts.js";

const sha = "a".repeat(40);
const report: ReviewReport = {
  resultSha: sha,
  verdict: "accept",
  findings: [],
};
describe("strict review report contract", () => {
  it("accepts an exact JSON object or one complete json fence, including SHA-256", () => {
    expect(parseReviewReport(JSON.stringify(report))).toEqual(report);
    expect(
      parseReviewReport("```json\n" + JSON.stringify(report) + "\n```"),
    ).toEqual(report);
    expect(
      parseReviewReport(
        JSON.stringify({ ...report, resultSha: "b".repeat(64) }),
      ).resultSha,
    ).toHaveLength(64);
  });
  it.each([
    "Here is my review:\n" + JSON.stringify(report),
    "```json\n" + JSON.stringify(report),
    "```\n" + JSON.stringify(report) + "\n```",
    JSON.stringify(report) + "\n" + JSON.stringify(report),
    JSON.stringify({ ...report, extra: true }),
    JSON.stringify({ ...report, resultSha: "a".repeat(41) }),
    JSON.stringify({
      ...report,
      findings: [{ severity: "blocking", message: "unsafe" }],
    }),
    JSON.stringify({
      ...report,
      findings: [{ severity: "warning", message: "warning", extra: true }],
    }),
    JSON.stringify({
      ...report,
      findings: [{ severity: "warning", message: " ".repeat(3) }],
    }),
    JSON.stringify({
      ...report,
      findings: Array.from({ length: 51 }, () => ({
        severity: "warning",
        message: "finding",
      })),
    }),
    JSON.stringify({
      ...report,
      findings: [{ severity: "warning", message: "x".repeat(4001) }],
    }),
    '{"resultSha":"' +
      sha +
      '","verdict":"reject","verdict":"accept","findings":[]}',
    '{"resultSha":"' +
      sha +
      '","verdict":"accept","findings":[{"severity":"blocking","severity":"warning","message":"ambiguous"}]}',
  ])(
    "rejects malformed, extra, incomplete and contradictory output %#",
    (text) => expect(() => parseReviewReport(text)).toThrow(),
  );
  it.each([
    "../escape",
    "/absolute",
    "C:/host",
    "a\\b",
    "a/../b",
    "a//b",
    "./a",
    "!src/a",
    "a\nfile",
  ])("rejects unsafe finding path %s", (path) => {
    expect(() =>
      parseReviewReport(
        JSON.stringify({
          ...report,
          verdict: "needs-repair",
          findings: [{ severity: "blocking", message: "issue", path }],
        }),
      ),
    ).toThrow();
  });
  it("preserves legitimate findings and a warning-only acceptance", () => {
    const warning: ReviewReport = {
      ...report,
      findings: [
        { severity: "warning", message: "Explanation", path: "src/naïve.ts" },
      ],
    };
    expect(parseReviewReport(JSON.stringify(warning))).toEqual(warning);
    expect(REVIEW_RUBRIC).toContain("tests");
    expect(REVIEW_RUBRIC).toContain("security");
  });
});

const exec = promisify(execFile);
describe("read-only local review using real Git and fixture subprocess", () => {
  let root: string;
  let input: LocalReviewInput;
  const git = async (cwd: string, ...args: string[]) =>
    (await exec("git", args, { cwd })).stdout.trim();
  beforeEach(async () => {
    root = canonicalPath(await mkdtemp(join(tmpdir(), "spillway-review-")));
    const repo = join(root, "repo");
    await mkdir(repo);
    await mkdir(join(repo, "src"));
    await git(repo, "init", "-b", "main");
    await git(repo, "config", "user.name", "Fixture");
    await git(repo, "config", "user.email", "fixture@example.invalid");
    await writeFile(join(repo, "src", "hello.txt"), "before\n");
    await writeFile(join(repo, ".gitignore"), "residue.ignore\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "base");
    const workspace = new GitWorkspace(repo, join(root, "data"));
    const baseSha = await workspace.resolveBase("main");
    const worktree = await workspace.createWorker("reviewed", baseSha, 1);
    await writeFile(join(worktree, "src", "hello.txt"), "after\n");
    await git(worktree, "add", ".");
    await git(worktree, "commit", "-m", "result");
    const spec = {
      id: "reviewed",
      repo,
      base: "main",
      class: "small-fix" as const,
      after: [],
      scope: ["src/**"],
      protected: [],
      context: ["src/hello.txt"],
      checks: ['test "$(cat src/hello.txt)" = after && echo checked'],
      review: "local" as const,
      limits: { max_minutes: 1, max_attempts: 2 },
      body: "## Objective\nFix hello\n## Acceptance criteria\nHello is after\nMODE: accept",
    };
    const attempt = {
      id: 1,
      taskId: "reviewed",
      endpoint: "fixture",
      profileId: "fixture",
      model: "fixture",
      modelArtifact: "fixture-only",
      harness: "opencode",
      harnessVersion: "1.2.3",
      baseSha,
      branch: "spillway/reviewed",
      worktree,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      outcome: "completed" as const,
      usage: null,
      summary: null,
      logPath: join(root, "artifacts", "attempt-1", "harness.log"),
      resultSha: await git(worktree, "rev-parse", "HEAD"),
      verification: null,
      reportPath: null,
    };
    const verification = await verifyAttempt({
      spec,
      attempt,
      workspace,
      artifactDir: join(root, "artifacts", "attempt-1"),
    });
    expect(verification.passed).toBe(true);
    const executable = join(root, "fixture-opencode");
    await writeFile(
      executable,
      `#!${process.execPath}\nimport fs from 'node:fs';import {execFileSync} from 'node:child_process';
if(process.argv.includes('--version')){console.log('1.2.3');process.exit(0)}
let prompt='';for await(const b of process.stdin)prompt+=b;
const packet=JSON.parse(prompt.split('Review packet:\\n')[1]); const mode=/MODE: ([a-z-]+)/.exec(packet.task.body)?.[1]??'accept';
fs.writeFileSync(process.env.HOME+'/captured-packet.json',JSON.stringify({packet,config:JSON.parse(process.env.OPENCODE_CONFIG_CONTENT),args:process.argv.slice(2)}));
if(mode==='tracked')fs.writeFileSync('src/hello.txt','mutated');if(mode==='untracked')fs.writeFileSync('residue.txt','evidence');if(mode==='ignored')fs.writeFileSync('residue.ignore','evidence');
if(mode==='move-ref')execFileSync('git',['update-ref','refs/heads/spillway/reviewed',${JSON.stringify(baseSha)}]);
if(mode==='move-head')execFileSync('git',['checkout','--detach',${JSON.stringify(baseSha)}]);
const findings=mode==='large'?[{severity:'warning',message:'x'.repeat(3990)},{severity:'warning',message:'y'.repeat(1000)}]:mode==='repair'?[{severity:'blocking',message:'Requirement missing',path:'src/hello.txt'}]:[];
const report={resultSha:mode==='stale'?'a'.repeat(40):packet.resultSha,verdict:mode==='repair'?'needs-repair':'accept',findings};
console.log(JSON.stringify({type:'step_start',part:{}}));console.log(JSON.stringify({type:'text',part:{text:mode==='invalid'?'Done!':JSON.stringify(report)}}));
console.log(JSON.stringify({type:'step_finish',part:{reason:mode==='hang'?'tool-calls':'stop',tokens:{input:12,output:7},cost:0.01}}));if(mode==='hang')setInterval(()=>{},1000);
`,
      { mode: 0o700 },
    );
    input = {
      reviewId: 7,
      task: {
        id: spec.id,
        spec,
        raw: "fixture",
        profileId: "fixture",
        reviewTier: "local",
        state: "held",
        reason: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        nextAction: "review",
      },
      attempt: { ...attempt, verification },
      workspace,
      adapter: new OpenCodeAdapter(executable),
      endpoint: { id: "fixture", kind: "local", url: "http://127.0.0.1:1/v1" },
      profile: {
        id: "fixture",
        endpoint: "fixture",
        model: "fixture",
        model_artifact: "fixture-only",
        harness: "opencode",
        harness_version: "1.2.3",
        qualified_classes: ["small-fix"],
      },
      artifactDir: join(root, "artifacts", "review-7"),
      timeoutSec: 3,
    };
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const mode = (value: string) => {
    input.task.spec.body = input.task.spec.body.replace(
      /MODE: [a-z-]+/,
      `MODE: ${value}`,
    );
  };
  it("reviews a pinned detached clean checkout, includes checks and preserves full reports", async () => {
    mode("large");
    const result = await runLocalReview(input);
    expect(result.outcome).toBe("completed");
    expect(result.report?.findings).toHaveLength(2);
    expect(result.usage?.inputTokens).toBe(12);
    expect((await stat(result.logPath)).mode & 0o777).toBe(0o600);
    expect(
      (await stat(join(input.artifactDir, "review.json"))).mode & 0o777,
    ).toBe(0o600);
    const captured = JSON.parse(
      await readFile(
        join(input.artifactDir, "harness-home", "captured-packet.json"),
        "utf8",
      ),
    ) as {
      packet: { checks: { output: string }[]; diff: string };
      args: string[];
    };
    expect(captured.args).toContain("spillway-review");
    expect(captured.packet.checks[0]?.output).toContain("checked");
    expect(captured.packet.diff).toContain("+after");
    await expect(
      access(join(root, "data", "worktrees", "review-7")),
    ).rejects.toThrow();
    expect(input.task.state).toBe("held");
  });
  it("returns needs-repair findings without task state writes", async () => {
    mode("repair");
    const result = await runLocalReview(input);
    expect(result.outcome).toBe("completed");
    expect(result.report?.verdict).toBe("needs-repair");
    expect(input.task.state).toBe("held");
  });
  it.each(["tracked", "untracked", "ignored", "move-ref", "move-head"])(
    "holds %s mutations and preserves checkout evidence",
    async (value) => {
      mode(value);
      const result = await runLocalReview(input);
      expect(result.outcome).toBe("uncertain");
      expect(result.report).toBeUndefined();
      expect(result.reason).toContain("mutated");
      await expect(
        access(join(root, "data", "worktrees", "review-7")),
      ).resolves.toBeUndefined();
    },
  );
  it.each(["invalid", "stale"])(
    "fails closed on %s reports without accepting worker claims",
    async (value) => {
      mode(value);
      const result = await runLocalReview(input);
      expect(result.outcome).toBe("failed");
      expect(result.report).toBeUndefined();
      await expect(
        access(join(root, "data", "worktrees", "review-7")),
      ).rejects.toThrow();
    },
  );
  it("rejects incomplete/oversized evidence before launch", async () => {
    input.task.spec.body += "x".repeat(128 * 1024);
    const result = await runLocalReview(input);
    expect(result.outcome).toBe("failed");
    expect(result.reason).toContain("128 KiB");
    await expect(
      access(join(input.artifactDir, "model.json")),
    ).rejects.toThrow();
  });
  it("times out a real fixture subprocess and retains reported usage", async () => {
    mode("hang");
    input.timeoutSec = 0.8;
    const result = await runLocalReview(input);
    expect(result.outcome).toBe("failed");
    expect(result.reason).toContain("timeout");
    expect(result.usage?.inputTokens).toBe(12);
    await expect(
      access(join(root, "data", "worktrees", "review-7")),
    ).rejects.toThrow();
  });
  it("aborts a running fixture reviewer and safely cleans the confirmed-stopped checkout", async () => {
    mode("hang");
    const controller = new AbortController();
    input.signal = controller.signal;
    input.timeoutSec = 5;
    const actual = input.adapter;
    input.adapter = {
      id: actual.id,
      version: () => actual.version(),
      run: async (request) => {
        const pending = actual.run(request);
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          try {
            await access(
              join(input.artifactDir, "harness-home", "captured-packet.json"),
            );
            break;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
        controller.abort();
        return pending;
      },
    };
    const result = await runLocalReview(input);
    expect(result.outcome).toBe("failed");
    expect(result.reason).toContain("timeout");
    expect(result.usage?.inputTokens).toBe(12);
    await expect(
      access(join(root, "data", "worktrees", "review-7")),
    ).rejects.toThrow();
  });
  it("holds when trusted check output would be silently truncated", async () => {
    await writeFile(
      input.attempt.verification!.checks[0]!.logPath,
      "x".repeat(128 * 1024 + 1),
    );
    const result = await runLocalReview(input);
    expect(result.outcome).toBe("failed");
    expect(result.reason).toContain("prompt limit");
    await expect(
      access(join(input.artifactDir, "model.json")),
    ).rejects.toThrow();
  });
  it("rejects an oversized reviewer report and preserves usage", async () => {
    const actual = input.adapter;
    input.adapter = {
      id: actual.id,
      version: () => actual.version(),
      run: async () => ({
        exit: "completed",
        summary: "x".repeat(256 * 1024 + 1),
        usage: { inputTokens: 12 },
      }),
    };
    const result = await runLocalReview(input);
    expect(result.outcome).toBe("failed");
    expect(result.reason).toContain("size limit");
    expect(result.usage?.inputTokens).toBe(12);
    await expect(
      access(join(root, "data", "worktrees", "review-7")),
    ).rejects.toThrow();
  });
  it("preserves checkout when adapter throws without proving process completion", async () => {
    input.adapter = {
      id: "opencode",
      version: async () => "1.2.3",
      run: async () => {
        throw new Error("Unknown worker state");
      },
    };
    const result = await runLocalReview(input);
    expect(result.outcome).toBe("uncertain");
    await expect(
      access(join(root, "data", "worktrees", "review-7")),
    ).resolves.toBeUndefined();
  });
  it("refuses automatic frontier calls and previously changed verified branches", async () => {
    input.endpoint.kind = "frontier";
    expect((await runLocalReview(input)).reason).toContain(
      "Automatic frontier",
    );
    input.endpoint.kind = "local";
    await writeFile(join(input.attempt.worktree, "residue.txt"), "dirty");
    expect((await runLocalReview(input)).reason).toContain(
      "changed before review",
    );
  });
});
