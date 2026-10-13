import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { SpillwayError, type QualificationJobRecord } from "./contracts.js";
import {
  CAPABILITIES,
  QUALIFICATION_REQUIREMENT_IDS,
  QUALIFICATION_REQUIREMENT_MESSAGES,
  explainToolEvidence,
  type QualificationRequirementCheck,
  type QualificationResult,
} from "./qualification.js";

const jobIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const checkSchema = z
  .object({
    id: z.enum(QUALIFICATION_REQUIREMENT_IDS),
    met: z.boolean(),
    message: z.string().max(200),
  })
  .strict()
  .refine(
    (check) => check.message === QUALIFICATION_REQUIREMENT_MESSAGES[check.id],
  );
const rowSchema = z
  .object({
    capability: z.enum(CAPABILITIES),
    status: z.enum(["available", "not-recorded", "unavailable", "mismatch"]),
    checks: z.array(checkSchema).max(9),
  })
  .strict()
  .refine((row) =>
    row.status === "available"
      ? isDeepStrictEqual(
          row.checks.map((check) => check.id),
          explainToolEvidence("", row.capability).checks.map(
            (check) => check.id,
          ),
        )
      : row.checks.length === 0,
  );
export const qualificationDiagnosticsSchema = z
  .object({
    version: z.literal(1),
    jobId: jobIdSchema,
    suiteVersion: z
      .union([z.literal(1), z.literal(2), z.literal(3)])
      .nullable(),
    cases: z.array(rowSchema).length(CAPABILITIES.length),
  })
  .strict()
  .refine(
    (report) =>
      report.cases.every(
        (row, index) => row.capability === CAPABILITIES[index],
      ) &&
      (report.suiteVersion !== null ||
        report.cases.every((row) => row.status === "not-recorded")),
  );
export type QualificationDiagnostics = z.infer<
  typeof qualificationDiagnosticsSchema
>;

const LOG_LIMIT = 16 * 1024 * 1024 + 128;
function same(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}
function privateOwner(stat: Stats): boolean {
  return stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0;
}
async function directory(path: string): Promise<Stats> {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    !privateOwner(stat) ||
    (await realpath(path)) !== path
  )
    throw new Error("Unsafe directory");
  return stat;
}
async function readManagedLog(path: string, dataDir: string): Promise<string> {
  const directories: Array<{ path: string; stat: Stats }> = [];
  let parent = dirname(path);
  for (;;) {
    directories.push({ path: parent, stat: await directory(parent) });
    if (parent === dataDir) break;
    const next = dirname(parent);
    if (next === parent) throw new Error("Unmanaged log");
    parent = next;
  }
  const before = await lstat(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    !privateOwner(before) ||
    before.size > LOG_LIMIT
  )
    throw new Error("Unsafe log");
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!same(before, await handle.stat())) throw new Error("Changed log");
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const result = await handle.read(
        bytes,
        count,
        bytes.length - count,
        count,
      );
      if (result.bytesRead === 0) break;
      count += result.bytesRead;
    }
    if (
      count !== before.size ||
      !same(before, await handle.stat()) ||
      !same(before, await lstat(path))
    )
      throw new Error("Changed log");
    for (const item of directories) {
      if (!same(item.stat, await directory(item.path)))
        throw new Error("Changed directory");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, count),
    );
  } finally {
    await handle.close();
  }
}

export async function buildQualificationDiagnostics(input: {
  job: QualificationJobRecord;
  result: QualificationResult | null;
  dataDir: string;
}): Promise<QualificationDiagnostics> {
  if (!jobIdSchema.safeParse(input.job.id).success)
    throw new SpillwayError(
      "QUALIFICATION_DIAGNOSTICS",
      "Saved qualification diagnostics are unavailable.",
      409,
    );
  const { job, result, dataDir } = input;
  const root = join(dataDir, "qualifications", job.id);
  const managed =
    isAbsolute(dataDir) && resolve(dataDir) === dataDir && job.root === root;
  const suiteVersion = result?.suiteVersion ?? null;
  const cases: QualificationDiagnostics["cases"] = [];
  for (const [index, capability] of CAPABILITIES.entries()) {
    const rows =
      result?.cases.filter((row) => row.capability === capability) ?? [];
    const row = rows[0];
    const checks: QualificationRequirementCheck[] = [];
    if (!row || !row.logPath) {
      cases.push({ capability, status: "not-recorded", checks });
      continue;
    }
    const logPath = join(root, "artifacts", capability, "worker.log");
    const worktree = join(
      root,
      "runtime",
      capability,
      "worktrees",
      `worker-${index + 1}-qual-${capability}`,
    );
    if (
      !managed ||
      rows.length !== 1 ||
      row.logPath !== logPath ||
      row.worktree !== worktree ||
      ![1, 2, 3].includes(suiteVersion ?? 0)
    ) {
      cases.push({ capability, status: "unavailable", checks });
      continue;
    }
    try {
      const text = await readManagedLog(logPath, dataDir);
      const replay = explainToolEvidence(
        text,
        capability,
        worktree,
        suiteVersion as 1 | 2 | 3,
      );
      cases.push(
        isDeepStrictEqual(replay.evidence, row.observations)
          ? { capability, status: "available", checks: replay.checks }
          : { capability, status: "mismatch", checks },
      );
    } catch {
      cases.push({ capability, status: "unavailable", checks });
    }
  }
  return qualificationDiagnosticsSchema.parse({
    version: 1,
    jobId: job.id,
    suiteVersion,
    cases,
  });
}

const statusMessages: Record<
  QualificationDiagnostics["cases"][number]["status"],
  string
> = {
  available: "Saved evidence matches the stored observations.",
  "not-recorded": "No saved transcript was recorded.",
  unavailable: "The saved transcript cannot be safely inspected.",
  mismatch:
    "Replay differs from the stored observations; no checklist is shown.",
};
export function formatQualificationDiagnostics(
  report: QualificationDiagnostics,
): string {
  const safe = qualificationDiagnosticsSchema.parse(report);
  return [
    "Saved qualification evidence",
    "Stored results remain unchanged.",
    ...safe.cases.flatMap((row) => [
      `${row.capability}: ${statusMessages[row.status]}`,
      ...row.checks.map(
        (check) => `  ${check.met ? "PASS" : "UNMET"}: ${check.message}`,
      ),
    ]),
  ].join("\n");
}
