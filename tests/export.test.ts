import { afterEach, describe, it, expect, vi } from "vitest";
import { exportSanitized, verifyPublicGitHub } from "../src/export.js";
import type {
  ReportSnapshot,
  SpillwayConfig,
  TaskDetail,
} from "../src/contracts.js";

const publicUrl = "https://github.com/public-owner/public-repo";
const secret = "sk-proj-THIS-IS-A-SYNTHETIC-PRIVATE-MARKER";
const hash = "a".repeat(64);
function setup() {
  const detail: TaskDetail = {
    task: {
      id: secret,
      profileId: "PRIVATE-PROFILE",
      state: "accepted",
      reviewTier: "local",
      raw: secret,
      reason: secret,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:02Z",
      readyAt: "2026-01-01T00:00:01Z",
      origin: "ordinary",
      spec: {
        id: secret,
        repo: "/private/source",
        base: secret,
        class: "small-fix",
        after: [secret],
        scope: [secret],
        protected: [secret],
        context: [secret],
        checks: [secret],
        review: "default",
        limits: { max_minutes: 1, max_attempts: 2 },
        body: secret,
      },
    },
    attempts: [
      {
        id: 42,
        taskId: secret,
        profileId: "PRIVATE-PROFILE",
        endpoint: "http://192.168.1.2/private",
        model: "public-model",
        modelArtifact: hash,
        harness: "opencode",
        harnessVersion: "1.2.3",
        baseSha: "b".repeat(40),
        branch: secret,
        worktree: "/private/worktree",
        startedAt: "2026-01-01T00:00:00Z",
        endedAt: "2026-01-01T00:00:01Z",
        outcome: "completed",
        usage: { inputTokens: 20 },
        summary: secret,
        logPath: "/private/log",
        resultSha: "c".repeat(40),
        verification: {
          passed: true,
          resultSha: "c".repeat(40),
          reason: secret,
          changedPaths: [secret],
          flags: [secret],
          checks: [
            {
              command: secret,
              exitCode: 0,
              timedOut: false,
              durationMs: 100,
              logPath: secret,
            },
          ],
          diffPath: secret,
        },
        reportPath: secret,
      },
    ],
    events: [
      {
        id: 1,
        taskId: secret,
        type: secret,
        payload: secret,
        createdAt: secret,
      },
    ],
    reviews: [
      {
        id: 42,
        taskId: secret,
        attemptId: 42,
        tier: "local",
        source: "service-local",
        profileId: "PRIVATE-PROFILE",
        model: "public-model",
        modelArtifact: hash,
        harness: "opencode",
        harnessVersion: "1.2.3",
        resultSha: "c".repeat(40),
        outcome: "completed",
        report: {
          resultSha: "c".repeat(40),
          verdict: "accept",
          findings: [{ severity: "warning", message: secret, path: secret }],
        },
        usage: null,
        logPath: secret,
        startedAt: "2026-01-01T00:00:01Z",
        endedAt: "2026-01-01T00:00:02Z",
        reason: secret,
      },
    ],
  };
  const snapshot: ReportSnapshot = {
    tasks: [detail],
    decisions: [
      {
        taskId: secret,
        decision: "accepted",
        resultSha: "c".repeat(40),
        reviewTier: "local",
        ownerMinutes: 2,
        decidedAt: secret,
      },
    ],
    audits: [
      {
        id: 42,
        taskId: secret,
        attemptId: 42,
        resultSha: "c".repeat(40),
        reviewTier: "local",
        status: "completed",
        report: {
          resultSha: "c".repeat(40),
          verdict: "reject",
          findings: [{ severity: "blocking", message: secret }],
        },
        model: secret,
        usage: { outputTokens: 10 },
        createdAt: secret,
        completedAt: secret,
      },
    ],
    planning: [
      { id: 42, taskId: secret, usage: { inputTokens: 5 }, createdAt: secret },
    ],
    generatedAt: secret,
  };
  const config: SpillwayConfig = {
    version: 1,
    data_dir: "/private/data",
    port: 0,
    poll_interval_ms: 1000,
    repositories: [
      {
        path: "/private/source",
        data_policy: "local-only",
        publication: { public_url: publicUrl },
      },
    ],
    endpoints: [
      {
        id: secret,
        kind: "local",
        url: "http://192.168.1.2/v1",
        api_key_env: secret,
      },
    ],
    profiles: [
      {
        id: "PRIVATE-PROFILE",
        endpoint: secret,
        model: "public-model",
        model_artifact: hash,
        harness: "opencode",
        harness_version: "1.2.3",
        qualified_classes: ["small-fix"],
      },
    ],
    default_profile: "PRIVATE-PROFILE",
    allow_checks_only: false,
  };
  const metadata = {
    model: "public-model",
    modelArtifact: hash,
    harnessVersion: "1.2.3",
    serverVersion: "2.3.4",
    license: "Apache-2.0",
    contextTokens: 8192,
    hardware: { memoryGiB: 32, gpuCount: 1, gpuMemoryGiB: 24, cpuCores: 8 },
  };
  const manifest = {
    version: 1,
    profiles: [{ profileId: "PRIVATE-PROFILE", metadata }],
  };
  return {
    snapshot,
    config,
    publicUrl,
    manifest,
    metadata,
    verifyPublic: async () => true,
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("closed anonymous sanitized export", () => {
  it("projects only public outcomes and reviewed metadata without sensitive payloads or original IDs", async () => {
    const result = await exportSanitized(setup());
    const json = JSON.stringify(result);
    for (const privateText of [
      secret,
      "PRIVATE-PROFILE",
      "/private/",
      "192.168.1.2",
      "2026-01-01",
      "createdAt",
      "logPath",
      "findings",
      "resultSha",
      "command",
    ])
      expect(json).not.toContain(privateText);
    expect(result.reproducible).toBe(true);
    expect(result.tasks[0]).toMatchObject({
      label: "task-1",
      profile: "profile-1",
      state: "accepted",
      decision: { outcome: "accepted", ownerMinutes: 2 },
      attempts: [
        { profile: "profile-1", usage: { inputTokens: 20 }, verified: true },
      ],
    });
    expect(result.tasks[0]?.audits[0]?.verdict).toBe("reject");
  });
  it("keeps all ordinary outcomes and excludes other repositories and qualification fixtures", async () => {
    const input = setup();
    const original = input.snapshot.tasks[0]!;
    input.snapshot.tasks.push({
      ...original,
      task: {
        ...original.task,
        id: "other",
        spec: { ...original.task.spec, id: "other", repo: "/another/private" },
      },
    });
    input.snapshot.tasks.push({
      ...original,
      task: { ...original.task, id: "qualification", origin: "qualification" },
    });
    for (const state of ["held", "failed", "abandoned"] as const)
      input.snapshot.tasks.push({
        ...original,
        task: { ...original.task, id: state, state },
        attempts: [],
        reviews: [],
      });
    const result = await exportSanitized(input);
    expect(result.tasks).toHaveLength(4);
    expect(result.tasks.map((t) => t.state)).toEqual([
      "accepted",
      "held",
      "failed",
      "abandoned",
    ]);
    expect(result.qualificationExcluded).toBe(1);
  });
  it("leaves absent or historically unpinned metadata unknown and nonreproducible", async () => {
    const input = setup();
    const missing = await exportSanitized({ ...input, manifest: undefined });
    expect(missing.reproducible).toBe(false);
    expect(missing.profiles[0]?.metadata).toBeNull();
    input.config.profiles[0]!.model_artifact = "not-reported";
    expect((await exportSanitized(input)).profiles[0]?.metadata).toBeNull();
  });
  it("requires publication opt-in independently of frontier inference permission", async () => {
    const input = setup();
    input.config.repositories[0]!.data_policy = "frontier-ok";
    delete input.config.repositories[0]!.publication;
    let calls = 0;
    await expect(
      exportSanitized({
        ...input,
        verifyPublic: async () => {
          calls++;
          return true;
        },
      }),
    ).rejects.toThrow("publication permission");
    expect(calls).toBe(0);
  });
  it("does not mint current artifact/version metadata for legacy reviewers lacking an immutable snapshot", async () => {
    const input = setup();
    const review = input.snapshot.tasks[0]!.reviews![0]!;
    delete review.modelArtifact;
    delete review.harness;
    delete review.harnessVersion;
    const result = await exportSanitized(input);
    expect(result.reproducible).toBe(false);
    expect(result.profiles[0]?.metadata).toBeNull();
  });
  it.each(["modelArtifact", "harness", "harnessVersion"] as const)(
    "rejects historical reviewer %s drift rather than claiming current binding",
    async (field) => {
      const input = setup();
      input.snapshot.tasks[0]!.reviews![0]![field] =
        field === "modelArtifact"
          ? "d".repeat(64)
          : field === "harnessVersion"
            ? "9.9.9"
            : "another-harness";
      await expect(exportSanitized(input)).rejects.toThrow(
        "historical reviewer",
      );
    },
  );
  it("rechecks publication permission after awaited public verification", async () => {
    const input = setup();
    input.verifyPublic = async () => {
      delete input.config.repositories[0]!.publication;
      return true;
    };
    await expect(exportSanitized(input)).rejects.toThrow(
      "changed during verification",
    );
  });
  it.each([false, "offline"] as const)(
    "fails closed when anonymous verifier returns %s",
    async (mode) => {
      const input = setup();
      input.verifyPublic = async () => {
        if (mode === "offline") throw new Error(secret);
        return false;
      };
      await expect(exportSanitized(input)).rejects.toThrow(
        "verification failed",
      );
    },
  );
  it.each([
    "http://github.com/a/b",
    "https://private.example/a/b",
    "https://github.com/a/b?token=x",
    "https://user:pass@github.com/a/b",
    "https://github.com/a/b/../../c",
  ])(
    "rejects unsafe publication URL %s without network access",
    async (publicUrl) => {
      const verifier = vi.fn(async () => true);
      await expect(
        exportSanitized({ ...setup(), publicUrl, verifyPublic: verifier }),
      ).rejects.toThrow("canonical");
      expect(verifier).not.toHaveBeenCalled();
    },
  );
  it.each([
    "/Users/private/key",
    "https://private.example/key",
    "192.168.1.2",
    secret,
    "github_pat_fake-private",
    "../../private",
    "localhost",
    "inference.lan",
    "machine.internal",
    "private.ts.net",
  ])("rejects dangerous public metadata identifier %s", async (model) => {
    const input = setup();
    input.manifest.profiles[0]!.metadata.model = model;
    input.config.profiles[0]!.model = model;
    await expect(exportSanitized(input)).rejects.toThrow("unsafe metadata");
  });
  it("rejects unknown fields, unbound/mismatched models, historical drift and artifact/version mismatches", async () => {
    const input = setup();
    await expect(
      exportSanitized({
        ...input,
        manifest: { ...input.manifest, notes: secret },
      }),
    ).rejects.toThrow("unsafe metadata");
    await expect(
      exportSanitized({
        ...setup(),
        manifest: {
          version: 1,
          profiles: [{ profileId: "missing", metadata: input.metadata }],
        },
      }),
    ).rejects.toThrow("binding");
    input.snapshot.tasks[0]!.attempts[0]!.model = "old-public-model";
    await expect(exportSanitized(input)).rejects.toThrow("historical");
    const wrong = setup();
    wrong.manifest.profiles[0]!.metadata.modelArtifact = "d".repeat(64);
    await expect(exportSanitized(wrong)).rejects.toThrow("hash");
  });
  it.each([
    "AKIAIOSFODNN7EXAMPLE",
    "ASIAIOSFODNN7EXAMPLE",
    "AIza" + "a".repeat(35),
  ])(
    "rejects synthetic known credential %s in every public identifier",
    async (credential) => {
      for (const field of [
        "model",
        "harnessVersion",
        "serverVersion",
        "license",
      ] as const) {
        const input = setup();
        const value =
          field === "harnessVersion" || field === "serverVersion"
            ? `1.2.3-${credential}`
            : credential;
        input.manifest.profiles[0]!.metadata[field] = value;
        if (field === "model") input.config.profiles[0]!.model = value;
        if (field === "harnessVersion")
          input.config.profiles[0]!.harness_version = value;
        await expect(exportSanitized(input)).rejects.toThrow("unsafe metadata");
      }
    },
  );
  it.each(["1.2.3-01", "1.2.3-alpha..one", "1.2.3-", "v1.2.3", "1.2.3+secret"])(
    "rejects invalid or unsafe exact version %s",
    async (serverVersion) => {
      const input = setup();
      input.manifest.profiles[0]!.metadata.serverVersion = serverVersion;
      await expect(exportSanitized(input)).rejects.toThrow("unsafe metadata");
    },
  );
  it("uses only fixed GitHub anonymous HTTPS and refuses private/404/redirect/offline responses", async () => {
    const response = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status });
    const fetch = vi.fn(async (_url: string, _options?: RequestInit) =>
      response({
        private: false,
        visibility: "public",
        full_name: "public-owner/public-repo",
        html_url: publicUrl,
      }),
    );
    vi.stubGlobal("fetch", fetch);
    expect(await verifyPublicGitHub(publicUrl)).toBe(true);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/public-owner/public-repo",
    );
    const options = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(options.credentials).toBe("omit");
    expect(options.redirect).toBe("error");
    expect(JSON.stringify(options.headers)).not.toMatch(/authorization|token/i);
    fetch.mockImplementation(async () =>
      response({ private: true, visibility: "private" }, 200),
    );
    expect(await verifyPublicGitHub(publicUrl)).toBe(false);
    fetch.mockImplementation(async () => response({}, 404));
    expect(await verifyPublicGitHub(publicUrl)).toBe(false);
    fetch.mockImplementation(async () => response({}, 403));
    expect(await verifyPublicGitHub(publicUrl)).toBe(false);
    fetch.mockImplementation(async () => response({}, 302));
    expect(await verifyPublicGitHub(publicUrl)).toBe(false);
    fetch.mockImplementation(async () => {
      throw new Error(secret);
    });
    expect(await verifyPublicGitHub(publicUrl)).toBe(false);
  });
  it("bounds anonymous network waits and malformed/oversized responses", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      (_url: string, options: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          options.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          ),
        ),
    );
    const waiting = verifyPublicGitHub(publicUrl);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await waiting).toBe(false);
    vi.useRealTimers();
    vi.stubGlobal("fetch", async () => new Response("x".repeat(65537)));
    expect(await verifyPublicGitHub(publicUrl)).toBe(false);
    vi.stubGlobal("fetch", async () => new Response("{broken"));
    expect(await verifyPublicGitHub(publicUrl)).toBe(false);
  });
});
