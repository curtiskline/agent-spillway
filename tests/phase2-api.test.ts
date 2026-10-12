import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { startService, type ServiceHandle } from "../src/server.js";
import { GitWorkspace, gitCommand } from "../src/git.js";
import { fixture } from "./helpers.js";

const packetSchema = z.object({
  taskId: z.string(),
  attemptId: z.number().int(),
  resultSha: z.string(),
});
const claimSchema = z.object({
  taskId: z.string(),
  attemptId: z.number().int(),
  baseSha: z.string(),
  branch: z.string(),
  worktree: z.string(),
  prompt: z.string(),
});
const responseSchema = z.object({ data: z.unknown() });
function api(
  service: ServiceHandle,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${service.url}/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${service.token}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function data(response: Response): Promise<unknown> {
  return responseSchema.parse((await response.json()) as unknown).data;
}
async function turnOn(service: ServiceHandle): Promise<void> {
  expect(
    (await api(service, "POST", "/frontier", { available: true })).status,
  ).toBe(200);
}
async function pendingReview(
  f: Awaited<ReturnType<typeof fixture>>,
  s: ServiceHandle,
  id: string,
): Promise<string> {
  expect(
    (await api(s, "POST", "/tasks", { markdown: f.markdown(id, "frontier") }))
      .status,
  ).toBe(201);
  expect((await api(s, "POST", "/run")).status).toBe(200);
  expect(s.store.getTask(id)).toMatchObject({
    state: "held",
    reviewTier: "frontier",
    nextAction: "review",
  });
  const resultSha = s.store.listAttempts(id).at(-1)?.resultSha;
  if (!resultSha) throw new Error("Fixture has no verified result");
  return resultSha;
}
async function ownerCommit(worktree: string, message = "hello"): Promise<void> {
  await writeFile(
    join(worktree, "src/message.cjs"),
    `module.exports = () => '${message}';\n// Owner-session fixture commit\n`,
  );
  await gitCommand(worktree, ["add", "src/message.cjs"]);
  await gitCommand(worktree, ["commit", "-m", "Owner-session fixture edit"]);
}
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function waitForGit(
  entered: ReturnType<typeof deferred>,
  request: Promise<Response>,
): Promise<void> {
  await Promise.race([
    entered.promise,
    request.then(() => {
      throw new Error(
        "Request completed before the awaited Git coordination point",
      );
    }),
  ]);
}

describe("Phase 2 authenticated owner-session API", () => {
  it("requires frontier dependencies accepted and merged before claiming without consuming denied attempts", async () => {
    const f = await fixture();
    f.config.repositories[0]!.data_policy = "frontier-ok";
    const s = await startService(f.config, { once: true, adapter: f.adapter });
    try {
      await turnOn(s);
      expect(
        (
          await api(s, "POST", "/tasks", {
            markdown: f.markdown("dependency-parent"),
          })
        ).status,
      ).toBe(201);
      const child = f
        .markdown(
          "dependency-child",
          "frontier",
          "after: [dependency-parent]\n",
        )
        .replace("class: mechanical", "class: risky");
      expect((await api(s, "POST", "/tasks", { markdown: child })).status).toBe(
        201,
      );
      expect(
        (await api(s, "POST", "/tasks/dependency-child/frontier-claim")).status,
      ).toBe(409);
      expect(s.store.listAttempts("dependency-child")).toHaveLength(0);
      expect((await api(s, "POST", "/run")).status).toBe(200);
      expect(s.store.getTask("dependency-parent")?.state).toBe("ready");
      expect(
        (
          await api(s, "POST", "/tasks/dependency-parent/decision", {
            decision: "accepted",
          })
        ).status,
      ).toBe(200);
      const parentSha = s.store
        .listAttempts("dependency-parent")
        .at(-1)?.resultSha;
      if (!parentSha) throw new Error("Parent fixture has no result");
      expect(
        (await api(s, "POST", "/tasks/dependency-child/frontier-claim")).status,
      ).toBe(409);
      expect(s.store.listAttempts("dependency-child")).toHaveLength(0);
      expect(s.store.getTask("dependency-child")).toMatchObject({
        nextAction: "frontier-worker",
        reviewTier: "frontier",
      });
      await gitCommand(f.repo, [
        "merge",
        "--ff-only",
        "spillway/dependency-parent",
      ]);
      const response = await api(
        s,
        "POST",
        "/tasks/dependency-child/frontier-claim",
      );
      expect(response.status).toBe(200);
      const claim = claimSchema.parse(await data(response));
      expect(
        await new GitWorkspace(f.repo, f.data).isAncestor(
          parentSha,
          claim.baseSha,
        ),
      ).toBe(true);
      expect(claim.baseSha).toBe(parentSha);
      expect(s.store.listAttempts("dependency-child")).toHaveLength(1);
      expect(s.store.listAttempts("dependency-child")[0]).toMatchObject({
        kind: "frontier",
        baseSha: parentSha,
      });
      expect(f.calls).toBe(1);
    } finally {
      await s.close();
      await f.cleanup();
    }
  }, 20000);
  it("rejects missing, malformed and duplicate raw review JSON without recording advice", async () => {
    const f = await fixture();
    f.config.repositories[0]!.data_policy = "frontier-ok";
    const s = await startService(f.config, { once: true, adapter: f.adapter });
    try {
      const sha = await pendingReview(f, s, "invalid-review");
      await turnOn(s);
      for (const raw of [
        "{}",
        '{"report":null}',
        '{"report":{}}',
        `{"report":{"resultSha":"${sha}","verdict":"reject","verdict":"accept","findings":[]}}`,
        `{"report":{"resultSha":"${sha}","verdict":"reject","ver\\u0064ict":"accept","findings":[]}}`,
        `{"report":{"resultSha":"${sha}","verdict":"accept","findings":[]},"report":null}`,
      ]) {
        const response = await fetch(
          `${s.url}/api/v1/tasks/invalid-review/review`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${s.token}`,
              "Content-Type": "application/json",
            },
            body: raw,
          },
        );
        expect(response.status, raw).toBe(400);
        expect(s.store.listReviews("invalid-review")).toHaveLength(0);
        expect(s.store.getTask("invalid-review")?.state).toBe("held");
      }
      expect(
        (
          await fetch(`${s.url}/api/v1/tasks/invalid-review/review`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          })
        ).status,
      ).toBe(401);
    } finally {
      await s.close();
      await f.cleanup();
    }
  }, 20000);

  it("pins review SHA and branch identity, records owner provenance and denies replay", async () => {
    const f = await fixture();
    f.config.repositories[0]!.data_policy = "frontier-ok";
    const s = await startService(f.config, { once: true, adapter: f.adapter });
    try {
      const sha = await pendingReview(f, s, "reviewed");
      await turnOn(s);
      const packetResponse = await api(s, "GET", "/tasks/reviewed/review");
      expect(packetResponse.status).toBe(200);
      expect(packetSchema.parse(await data(packetResponse))).toMatchObject({
        taskId: "reviewed",
        resultSha: sha,
      });
      const stale = await api(s, "POST", "/tasks/reviewed/review", {
        report: { resultSha: "b".repeat(40), verdict: "accept", findings: [] },
      });
      expect(stale.status).toBe(409);
      expect(s.store.listReviews("reviewed")).toHaveLength(0);
      const worktree = s.store.listAttempts("reviewed").at(-1)!.worktree;
      await ownerCommit(worktree);
      const report = { resultSha: sha, verdict: "accept", findings: [] };
      expect((await api(s, "GET", "/tasks/reviewed/review")).status).toBe(409);
      expect(
        (await api(s, "POST", "/tasks/reviewed/review", { report })).status,
      ).toBe(409);
      expect(s.store.listReviews("reviewed")).toHaveLength(0);
      await gitCommand(worktree, ["reset", "--hard", sha]);
      const accepted = await api(s, "POST", "/tasks/reviewed/review", {
        report,
        model: "owner-attested-fixture",
        usage: { inputTokens: 5 },
      });
      expect(accepted.status).toBe(200);
      expect(await data(accepted)).toMatchObject({
        task: { state: "ready", nextAction: null },
        reviews: [
          {
            tier: "frontier",
            source: "owner-session",
            resultSha: sha,
            outcome: "completed",
          },
        ],
      });
      expect(s.store.listReviews("reviewed")[0]?.usage).toEqual({
        inputTokens: 5,
      });
      expect(
        (await api(s, "POST", "/tasks/reviewed/review", { report })).status,
      ).toBe(409);
      expect(s.store.listReviews("reviewed")).toHaveLength(1);
      expect(
        (
          await api(s, "POST", "/tasks/reviewed/decision", {
            decision: "accepted",
          })
        ).status,
      ).toBe(200);
      expect(
        await gitCommand(f.repo, ["show", "main:src/message.cjs"]),
      ).toContain("wrong");
    } finally {
      await s.close();
      await f.cleanup();
    }
  }, 20000);

  it("gates frontier claims on availability and explicit repository approval with no worker calls", async () => {
    const f = await fixture();
    const s = await startService(f.config, { once: true, adapter: f.adapter });
    try {
      const markdown = f
        .markdown("frontier-claim", "frontier")
        .replace("class: mechanical", "class: risky");
      expect((await api(s, "POST", "/tasks", { markdown })).status).toBe(201);
      expect(s.store.getTask("frontier-claim")).toMatchObject({
        nextAction: "frontier-worker",
      });
      expect(
        (await api(s, "POST", "/tasks/frontier-claim/frontier-claim")).status,
      ).toBe(409);
      expect(s.store.listAttempts("frontier-claim")).toHaveLength(0);
      await turnOn(s);
      expect(
        (await api(s, "POST", "/tasks/frontier-claim/frontier-claim")).status,
      ).toBe(403);
      expect(s.store.listAttempts("frontier-claim")).toHaveLength(0);
      // Fixture seam models an explicit owner-approved configuration change.
      f.config.repositories[0]!.data_policy = "frontier-ok";
      const claimResponse = await api(
        s,
        "POST",
        "/tasks/frontier-claim/frontier-claim",
      );
      expect(claimResponse.status).toBe(200);
      const claim = claimSchema.parse(await data(claimResponse));
      expect(claim.branch).toBe("spillway/frontier-claim");
      expect(claim.prompt).toContain("Return hello");
      expect(s.store.listAttempts("frontier-claim")[0]).toMatchObject({
        kind: "frontier",
        endpoint: "owner-session",
        harnessVersion: "owner-attested",
        baseSha: claim.baseSha,
        outcome: "running",
      });
      expect(
        (await api(s, "POST", "/tasks/frontier-claim/frontier-claim")).status,
      ).toBe(409);
      expect(f.calls).toBe(0);
    } finally {
      await s.close();
      await f.cleanup();
    }
  }, 20000);

  it("verifies an already claimed owner commit after frontier turns off and holds further review", async () => {
    const f = await fixture();
    f.config.repositories[0]!.data_policy = "frontier-ok";
    const s = await startService(f.config, { once: true, adapter: f.adapter });
    try {
      const markdown = f
        .markdown("owner-complete", "frontier")
        .replace("class: mechanical", "class: risky");
      expect((await api(s, "POST", "/tasks", { markdown })).status).toBe(201);
      await turnOn(s);
      const claimResponse = await api(
        s,
        "POST",
        "/tasks/owner-complete/frontier-claim",
      );
      expect(claimResponse.status).toBe(200);
      const claim = claimSchema.parse(await data(claimResponse));
      await ownerCommit(claim.worktree);
      expect(
        (await api(s, "POST", "/frontier", { available: false })).status,
      ).toBe(200);
      expect(
        (
          await api(s, "POST", "/tasks/owner-complete/frontier-complete", {
            attemptId: claim.attemptId + 1,
          })
        ).status,
      ).toBe(409);
      const completed = await api(
        s,
        "POST",
        "/tasks/owner-complete/frontier-complete",
        { attemptId: claim.attemptId },
      );
      expect(completed.status).toBe(200);
      expect(await data(completed)).toMatchObject({
        task: { state: "held", nextAction: "review", reviewTier: "frontier" },
        attempts: [
          {
            outcome: "completed",
            verification: { passed: true, checks: [{ exitCode: 0 }] },
          },
        ],
      });
      expect((await api(s, "GET", "/tasks/owner-complete/review")).status).toBe(
        409,
      );
      expect(
        (
          await api(s, "POST", "/tasks/owner-complete/frontier-complete", {
            attemptId: claim.attemptId,
          })
        ).status,
      ).toBe(409);
      expect(s.store.listReviews("owner-complete")).toHaveLength(0);
      expect(f.calls).toBe(0);
      expect(
        await gitCommand(f.repo, ["show", "main:src/message.cjs"]),
      ).toContain("wrong");
    } finally {
      await s.close();
      await f.cleanup();
    }
  }, 20000);

  it("refuses readiness when a claimed owner commit fails the protected independent check", async () => {
    const f = await fixture();
    f.config.repositories[0]!.data_policy = "frontier-ok";
    const s = await startService(f.config, { once: true, adapter: f.adapter });
    try {
      expect(
        (
          await api(s, "POST", "/tasks", {
            markdown: f
              .markdown("bad-owner", "frontier")
              .replace("class: mechanical", "class: risky"),
          })
        ).status,
      ).toBe(201);
      await turnOn(s);
      const claimResponse = await api(
        s,
        "POST",
        "/tasks/bad-owner/frontier-claim",
      );
      expect(claimResponse.status).toBe(200);
      const claim = claimSchema.parse(await data(claimResponse));
      await ownerCommit(claim.worktree, "still-wrong");
      const completed = await api(
        s,
        "POST",
        "/tasks/bad-owner/frontier-complete",
        { attemptId: claim.attemptId },
      );
      expect(completed.status).toBe(200);
      expect(await data(completed)).toMatchObject({
        task: { state: "held", nextAction: null },
        attempts: [
          {
            outcome: "failed",
            verification: { passed: false, checks: [{ exitCode: 1 }] },
          },
        ],
      });
      expect(
        (
          await api(s, "POST", "/tasks/bad-owner/decision", {
            decision: "accepted",
          })
        ).status,
      ).toBe(409);
      expect((await api(s, "GET", "/tasks/bad-owner/review")).status).toBe(409);
      expect(f.calls).toBe(0);
    } finally {
      await s.close();
      await f.cleanup();
    }
  }, 20000);

  it("rechecks availability after awaited Git evidence before disclosing packets or recording review", async () => {
    const f = await fixture();
    f.config.repositories[0]!.data_policy = "frontier-ok";
    const s = await startService(f.config, { once: true, adapter: f.adapter });
    try {
      const sha = await pendingReview(f, s, "availability-race");
      for (const method of ["GET", "POST"] as const) {
        await turnOn(s);
        const entered = deferred();
        const release = deferred();
        const original = GitWorkspace.prototype.diff;
        const spy = vi
          .spyOn(GitWorkspace.prototype, "diff")
          .mockImplementation(async function (
            this: GitWorkspace,
            base: string,
            result: string,
          ) {
            const diff = await original.call(this, base, result);
            entered.resolve();
            await release.promise;
            return diff;
          });
        const pending = api(
          s,
          method,
          "/tasks/availability-race/review",
          method === "POST"
            ? { report: { resultSha: sha, verdict: "accept", findings: [] } }
            : undefined,
        );
        try {
          await waitForGit(entered, pending);
          expect(
            (await api(s, "POST", "/frontier", { available: false })).status,
          ).toBe(200);
          release.resolve();
          expect((await pending).status).toBe(409);
          expect(s.store.listReviews("availability-race")).toHaveLength(0);
          expect(s.store.getTask("availability-race")?.state).toBe("held");
        } finally {
          release.resolve();
          await pending;
          spy.mockRestore();
        }
      }
    } finally {
      await s.close();
      await f.cleanup();
    }
  }, 20000);
  it("rechecks availability after resolving a claim base without consuming a frontier attempt", async () => {
    const f = await fixture();
    f.config.repositories[0]!.data_policy = "frontier-ok";
    const s = await startService(f.config, { once: true, adapter: f.adapter });
    const release = deferred();
    let spy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      expect(
        (
          await api(s, "POST", "/tasks", {
            markdown: f
              .markdown("claim-race", "frontier")
              .replace("class: mechanical", "class: risky"),
          })
        ).status,
      ).toBe(201);
      await turnOn(s);
      const entered = deferred();
      const original = GitWorkspace.prototype.resolveBase;
      spy = vi
        .spyOn(GitWorkspace.prototype, "resolveBase")
        .mockImplementation(async function (this: GitWorkspace, ref: string) {
          const sha = await original.call(this, ref);
          entered.resolve();
          await release.promise;
          return sha;
        });
      const pending = api(s, "POST", "/tasks/claim-race/frontier-claim");
      try {
        await waitForGit(entered, pending);
        expect(
          (await api(s, "POST", "/frontier", { available: false })).status,
        ).toBe(200);
        release.resolve();
        expect((await pending).status).toBe(409);
        expect(s.store.listAttempts("claim-race")).toHaveLength(0);
        expect(s.store.getTask("claim-race")).toMatchObject({
          nextAction: "frontier-worker",
          reviewTier: "frontier",
        });
      } finally {
        release.resolve();
        await pending;
        spy.mockRestore();
        spy = undefined;
      }
      await turnOn(s);
      expect(
        (await api(s, "POST", "/tasks/claim-race/frontier-claim")).status,
      ).toBe(200);
      expect(s.store.listAttempts("claim-race")).toHaveLength(1);
      expect(f.calls).toBe(0);
    } finally {
      release.resolve();
      spy?.mockRestore();
      await s.close();
      await f.cleanup();
    }
  }, 20000);
  it("rechecks repository approval after awaited packet evidence and discloses no frontier data", async () => {
    const f = await fixture();
    f.config.repositories[0]!.data_policy = "frontier-ok";
    const s = await startService(f.config, { once: true, adapter: f.adapter });
    const release = deferred();
    let spy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await pendingReview(f, s, "policy-race");
      await turnOn(s);
      const entered = deferred();
      const original = GitWorkspace.prototype.diff;
      spy = vi
        .spyOn(GitWorkspace.prototype, "diff")
        .mockImplementation(async function (
          this: GitWorkspace,
          base: string,
          result: string,
        ) {
          const diff = await original.call(this, base, result);
          entered.resolve();
          await release.promise;
          return diff;
        });
      const pending = api(s, "GET", "/tasks/policy-race/review");
      try {
        await waitForGit(entered, pending);
        f.config.repositories[0]!.data_policy = "local-only";
        release.resolve();
        const response = await pending;
        expect(response.status).toBe(403);
        const error: unknown = await response.json();
        expect(error).toMatchObject({ error: { code: "DATA_POLICY" } });
        expect(error).not.toHaveProperty("data");
        expect(s.store.listReviews("policy-race")).toHaveLength(0);
      } finally {
        release.resolve();
        await pending;
      }
    } finally {
      release.resolve();
      spy?.mockRestore();
      await s.close();
      await f.cleanup();
    }
  }, 20000);
});
