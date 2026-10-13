import fs from "node:fs";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildQualificationDiagnostics,
  formatQualificationDiagnostics,
  qualificationDiagnosticsSchema,
} from "../src/qualification-diagnostics.js";
import {
  CAPABILITIES,
  explainToolEvidence,
  type Capability,
  type QualificationResult,
} from "../src/qualification.js";
import type { QualificationJobRecord } from "../src/contracts.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
function transcript(capability: Capability): string {
  const events: unknown[] = [{ type: "step_start", part: { id: "round-one" } }];
  const tool = (name: string, input: unknown, output = "", exit?: number) =>
    events.push({
      type: "tool_use",
      part: {
        id: `part-${events.length}`,
        callID: `call-${events.length}`,
        tool: name,
        state: {
          status: "completed",
          input,
          output,
          metadata: exit === undefined ? {} : { exit },
        },
      },
    });
  tool(
    "read",
    { filePath: "docs/inventory.json" },
    "synthetic-secret /private/owner/model-profile",
  );
  if (capability === "discovery") tool("glob", { pattern: "docs/**" });
  if (capability === "command")
    tool("bash", { command: "node tools/echo.cjs" }, "spillway-command-ok", 0);
  if (capability === "tool-error-recovery") {
    tool(
      "bash",
      { command: "node tools/failure.cjs" },
      "Intentional qualification tool error",
      17,
    );
    tool(
      "bash",
      { command: "node tools/recover.cjs" },
      "spillway-recovery-ok",
      0,
    );
  }
  events.push({ type: "step_finish", part: { reason: "stop" } });
  return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}
async function fixture(suiteVersion: 1 | 2 | 3 = 3) {
  const dataDir = await realpath(
    await mkdtemp(join(tmpdir(), "spillway-diagnostics-")),
  );
  roots.push(dataDir);
  await chmod(dataDir, 0o700);
  const root = join(dataDir, "qualifications", "qual-fixture");
  const job: QualificationJobRecord = {
    id: "qual-fixture",
    profileId: "private-profile",
    root,
    status: "completed",
    startedAt: "now",
    endedAt: "later",
    resultPath: join(root, "result.json"),
    reason: null,
    reconciledAt: null,
  };
  const result: QualificationResult = {
    version: 1,
    suiteVersion,
    scope: "tool-workload-only",
    provenance: "fixture",
    qualified: false,
    uncertain: false,
    startedAt: "now",
    finishedAt: "later",
    profileId: "private-profile",
    catalogModel: "private-model",
    harnessVersion: null,
    metadata: {
      model: null,
      modelArtifact: null,
      harnessVersion: null,
      serverVersion: null,
      license: null,
      contextTokens: null,
      hardware: null,
    },
    metadataComplete: false,
    requestedSettings: { temperature: 0, concurrency: 1 },
    workloadHash: "a".repeat(64),
    failures: [],
    cases: [],
  };
  await mkdir(join(dataDir, "qualifications"), { mode: 0o700 });
  await mkdir(root, { mode: 0o700 });
  await mkdir(join(root, "artifacts"), { mode: 0o700 });
  for (const [index, capability] of CAPABILITIES.entries()) {
    const directory = join(root, "artifacts", capability);
    await mkdir(directory, { mode: 0o700 });
    const logPath = join(directory, "worker.log");
    const worktree = join(
      root,
      "runtime",
      capability,
      "worktrees",
      `worker-${index + 1}-qual-${capability}`,
    );
    const text = transcript(capability);
    await writeFile(logPath, text, { mode: 0o600 });
    result.cases.push({
      capability,
      outcome: "failed",
      durationMs: 1,
      reason: "private error",
      usage: null,
      baseSha: null,
      resultSha: null,
      verification: null,
      observations: explainToolEvidence(
        text,
        capability,
        worktree,
        suiteVersion,
      ).evidence,
      logPath,
      worktree,
      contextBytes: 0,
    });
  }
  return { dataDir, job, result };
}
describe("private saved qualification diagnostics", () => {
  it.each([1, 2, 3] as const)(
    "replays suite %s with no remaining worktrees and exposes fixed requirements only",
    async (version) => {
      const input = await fixture(version);
      const before = await readFile(input.result.cases[0]!.logPath!);
      const report = await buildQualificationDiagnostics(input);
      expect(report.suiteVersion).toBe(version);
      expect(report.cases.map((row) => row.capability)).toEqual(CAPABILITIES);
      expect(report.cases.every((row) => row.status === "available")).toBe(
        true,
      );
      expect(report.cases[0]!.checks.every((check) => check.met)).toBe(true);
      expect(
        report.cases[6]!.checks.find((check) => check.id === "full-context")
          ?.met,
      ).toBe(false);
      expect(await readFile(input.result.cases[0]!.logPath!)).toEqual(before);
      const safe =
        JSON.stringify(report) + formatQualificationDiagnostics(report);
      for (const secret of [
        "synthetic-secret",
        "private-profile",
        "private-model",
        "private error",
        input.dataDir,
      ])
        expect(safe).not.toContain(secret);
      expect(safe).toContain("Stored results remain unchanged");
    },
  );
  it("distinguishes missing history, unsafe history and observation mismatches", async () => {
    const input = await fixture();
    input.result.cases[0]!.logPath = null;
    input.result.cases[1]!.observations.rounds = 42;
    await rm(input.result.cases[2]!.logPath!);
    input.result.cases = input.result.cases.filter(
      (row) => row.capability !== "command",
    );
    const report = await buildQualificationDiagnostics(input);
    expect(report.cases.slice(0, 4).map((row) => row.status)).toEqual([
      "not-recorded",
      "mismatch",
      "unavailable",
      "not-recorded",
    ]);
    expect(
      report.cases.slice(0, 4).every((row) => row.checks.length === 0),
    ).toBe(true);
    expect(
      (
        await buildQualificationDiagnostics({ ...input, result: null })
      ).cases.every((row) => row.status === "not-recorded"),
    ).toBe(true);
  });
  it("explains a matching invalid transcript without turning it into qualification", async () => {
    const input = await fixture();
    const row = input.result.cases[0]!;
    const text = "OUTPUT_TRUNCATED\n{malformed-secret}";
    await writeFile(row.logPath!, text);
    row.observations = explainToolEvidence(
      text,
      row.capability,
      row.worktree!,
    ).evidence;
    const report = await buildQualificationDiagnostics(input);
    expect(report.cases[0]!.status).toBe("available");
    expect(report.cases[0]!.checks[0]).toMatchObject({
      id: "complete-transcript",
      met: false,
    });
    expect(input.result.qualified).toBe(false);
  });
  it.each(["root", "log", "worktree", "duplicate"] as const)(
    "rejects a non-managed %s binding",
    async (field) => {
      const input = await fixture();
      if (field === "root") input.job.root += "-other";
      if (field === "log")
        input.result.cases[0]!.logPath = join(input.dataDir, "other.log");
      if (field === "worktree") input.result.cases[0]!.worktree += "-other";
      if (field === "duplicate")
        input.result.cases.push({ ...input.result.cases[0]! });
      expect(
        (await buildQualificationDiagnostics(input)).cases[0]!.status,
      ).toBe("unavailable");
    },
  );
  it.each([
    "symlink",
    "hardlink",
    "public-file",
    "public-parent",
    "directory",
    "oversize",
    "invalid-utf8",
  ] as const)("rejects %s transcripts", async (kind) => {
    const input = await fixture();
    const path = input.result.cases[0]!.logPath!;
    if (kind === "symlink") {
      await rename(path, path + "-target");
      await symlink(path + "-target", path);
    }
    if (kind === "hardlink") await link(path, path + "-link");
    if (kind === "public-file") await chmod(path, 0o644);
    if (kind === "public-parent")
      await chmod(join(input.job.root, "artifacts"), 0o755);
    if (kind === "directory") {
      await rm(path);
      await mkdir(path, { mode: 0o700 });
    }
    if (kind === "oversize")
      await writeFile(path, Buffer.alloc(16 * 1024 * 1024 + 129));
    if (kind === "invalid-utf8") await writeFile(path, Buffer.from([0xff]));
    expect((await buildQualificationDiagnostics(input)).cases[0]!.status).toBe(
      "unavailable",
    );
  });
  it("rejects a substituted private parent even when the log inode is unchanged", async () => {
    const input = await fixture();
    const path = input.result.cases[0]!.logPath!;
    const parent = join(input.job.root, "artifacts", "discovery");
    const original = fs.promises.open;
    let fired = false;
    fs.promises.open = async (...args: Parameters<typeof original>) => {
      const handle = await original(...args);
      if (args[0] === path && !fired) {
        fired = true;
        await rename(parent, parent + "-old");
        await mkdir(parent, { mode: 0o700 });
        await rename(join(parent + "-old", "worker.log"), path);
      }
      return handle;
    };
    syncBuiltinESMExports();
    try {
      expect(
        (await buildQualificationDiagnostics(input)).cases[0]!.status,
      ).toBe("unavailable");
      expect(fired).toBe(true);
    } finally {
      fs.promises.open = original;
      syncBuiltinESMExports();
    }
  });
  it("rejects a symlink substituted between inspection and opening", async () => {
    const input = await fixture();
    const path = input.result.cases[0]!.logPath!;
    const original = fs.promises.open;
    let fired = false;
    fs.promises.open = async (...args: Parameters<typeof original>) => {
      if (args[0] === path && !fired) {
        fired = true;
        await rename(path, path + "-original");
        await symlink(path + "-original", path);
      }
      return original(...args);
    };
    syncBuiltinESMExports();
    try {
      expect(
        (await buildQualificationDiagnostics(input)).cases[0]!.status,
      ).toBe("unavailable");
      expect(fired).toBe(true);
    } finally {
      fs.promises.open = original;
      syncBuiltinESMExports();
    }
  });
  it("rejects mutation during an open read", async () => {
    const input = await fixture();
    const path = input.result.cases[0]!.logPath!;
    const original = fs.promises.open;
    let fired = false;
    fs.promises.open = async (...args: Parameters<typeof original>) => {
      const handle = await original(...args);
      if (args[0] === path && !fired) {
        fired = true;
        const read = handle.read.bind(handle);
        handle.read = (async (...readArgs: Parameters<typeof read>) => {
          const result = await read(...readArgs);
          await writeFile(path, "changed");
          return result;
        }) as typeof handle.read;
      }
      return handle;
    };
    syncBuiltinESMExports();
    try {
      expect(
        (await buildQualificationDiagnostics(input)).cases[0]!.status,
      ).toBe("unavailable");
      expect(fired).toBe(true);
    } finally {
      fs.promises.open = original;
      syncBuiltinESMExports();
    }
  });
  it("rejects arbitrary messages, identifiers, row order and surplus fields at the response boundary", async () => {
    const report = await buildQualificationDiagnostics(await fixture());
    const mutate = (fn: (value: typeof report) => void) => {
      const copy = structuredClone(report);
      fn(copy);
      expect(qualificationDiagnosticsSchema.safeParse(copy).success).toBe(
        false,
      );
    };
    mutate((value) => {
      value.cases[0]!.checks[0]!.message = "raw owner secret";
    });
    mutate((value) => {
      value.suiteVersion = null;
    });
    mutate((value) => {
      value.cases.reverse();
    });
    mutate((value) => {
      value.cases[0]!.checks.reverse();
    });
    mutate((value) => {
      value.cases[0]!.status = "mismatch";
    });
    expect(
      qualificationDiagnosticsSchema.safeParse({ ...report, rawLog: "secret" })
        .success,
    ).toBe(false);
    expect(
      qualificationDiagnosticsSchema.safeParse({ ...report, suiteVersion: 4 })
        .success,
    ).toBe(false);
    const input = await fixture();
    input.job.id = "../escape";
    await expect(buildQualificationDiagnostics(input)).rejects.toMatchObject({
      code: "QUALIFICATION_DIAGNOSTICS",
    });
  });
});
