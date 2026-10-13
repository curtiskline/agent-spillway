import { z } from "zod";
import {
  SpillwayError,
  TASK_STATES,
  type ReportSnapshot,
  type SpillwayConfig,
  type TaskClass,
  type ReviewTier,
  type Usage,
} from "./contracts.js";
import { deriveTaskSpecFeatures, type TaskSpecFeatures } from "./task-features.js";

const publicUrlSchema = z
  .string()
  .regex(
    /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/,
  )
  .refine((url) => ![".", ".."].includes(url.split("/").at(-1)!));
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const safeIdentifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9][A-Za-z0-9._+-]*)?$/)
  .refine(
    (value) =>
      !/(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35}|ya29\.[A-Za-z0-9_-]+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(
        value,
      ) &&
      !/(?:^|[^A-Za-z0-9])(?:sk-|gh[pousr]_|github_pat_|bearer|token|password|secret|api[_-]?key)|(?:https?|www)[.:/]|\b(?:\d{1,3}\.){3}\d{1,3}\b|(?:^|\/)(?:Users|home|Volumes|private|tmp|var|etc)(?:\/|$)|\.\.|[A-Za-z0-9]{40,}/i.test(
        value,
      ),
    "Metadata identifier may contain private or unsafe content",
  )
  .refine(
    (value) =>
      !/localhost|\.(?:local|lan|internal|home|ts\.net)(?:$|\/)/i.test(value),
    "Private network identifiers are not public metadata",
  );
const semver = z
  .string()
  .max(80)
  .regex(
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
  )
  .refine((value) => {
    const prerelease = value.split("+")[0]!.split("-").slice(1).join("-");
    return (
      !prerelease ||
      prerelease
        .split(".")
        .every((part) => part.length > 0 && !/^0\d+$/.test(part))
    );
  }, "Numeric prerelease versions must not contain leading zeroes")
  .pipe(safeIdentifier);
const metadataSchema = z
  .object({
    model: safeIdentifier,
    modelArtifact: z.string().regex(/^[a-f0-9]{64}$/),
    harnessVersion: semver,
    serverVersion: semver,
    license: z
      .string()
      .max(80)
      .regex(/^[A-Za-z][A-Za-z0-9.-]*$/)
      .pipe(safeIdentifier),
    contextTokens: z.number().int().positive().max(10_000_000),
    hardware: z
      .object({
        cpuCores: z.number().int().positive().max(4096).optional(),
        memoryGiB: z.number().positive().max(1_000_000),
        gpuCount: z.number().int().min(0).max(1024).optional(),
        gpuMemoryGiB: z.number().positive().max(1_000_000).optional(),
      })
      .strict(),
  })
  .strict();
const manifestSchema = z
  .object({
    version: z.literal(1),
    profiles: z
      .array(
        z
          .object({
            profileId: z.string().min(1).max(128),
            metadata: metadataSchema,
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();
export type PublicProfileMetadata = z.infer<typeof metadataSchema>;
export interface SanitizedExport {
  version: 1;
  repository: string;
  reproducible: boolean;
  qualificationExcluded: number;
  profiles: {
    label: string;
    metadata: PublicProfileMetadata | null;
    reproducible: boolean;
  }[];
  tasks: {
    label: string;
    profile: string;
    class: TaskClass;
    tier: ReviewTier;
    state: (typeof TASK_STATES)[number];
    taskSpec: TaskSpecFeatures | null;
    completedWhileFrontierOff: boolean | null;
    readyLatencyMs: number | null;
    attempts: {
      profile: string;
      kind: "worker" | "repair" | "frontier";
      outcome: string;
      durationMs: number | null;
      checks: {
        exitCode: number | null;
        timedOut: boolean;
        durationMs: number | null;
      }[];
      usage: Usage | null;
      verified: boolean | null;
    }[];
    reviews: {
      profile: string | null;
      tier: ReviewTier;
      outcome: string;
      verdict: "accept" | "needs-repair" | "reject" | null;
      durationMs: number | null;
      usage: Usage | null;
    }[];
    decision: {
      outcome: "accepted" | "rejected";
      ownerMinutes: number | null;
    } | null;
    audits: {
      tier: "checks-only" | "local";
      status: "pending" | "completed";
      verdict: "accept" | "needs-repair" | "reject" | null;
      usage: Usage | null;
    }[];
    planning: Usage[];
  }[];
}
export interface SanitizedExportInput {
  snapshot: ReportSnapshot;
  config: SpillwayConfig;
  publicUrl: string;
  manifest?: unknown;
  verifyPublic?: (url: string) => Promise<boolean>;
}
/** Anonymous, bounded, fixed-host verification. No inherited/account credentials. */
export async function verifyPublicGitHub(url: string): Promise<boolean> {
  const parsed = publicUrlSchema.safeParse(url);
  if (!parsed.success) return false;
  const [owner, repo] = url.split("/").slice(-2);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}`,
      {
        redirect: "error",
        credentials: "omit",
        signal: controller.signal,
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "agent-spillway-public-export",
        },
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      return false;
    }
    const reader = response.body?.getReader();
    if (!reader) return false;
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > 65536) {
        await reader.cancel();
        return false;
      }
      chunks.push(result.value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      return false;
    const data = value as Record<string, unknown>;
    return (
      data.private === false &&
      data.visibility === "public" &&
      typeof data.full_name === "string" &&
      data.full_name.toLowerCase() === `${owner}/${repo}`.toLowerCase() &&
      typeof data.html_url === "string" &&
      data.html_url.toLowerCase() === url.toLowerCase()
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
function cleanUsage(input: Usage | null): Usage | null {
  if (!input) return null;
  const output: Usage = {};
  for (const field of ["inputTokens", "outputTokens", "costUsd"] as const) {
    const value = input[field];
    if (finite(value)) output[field] = value;
  }
  return Object.keys(output).length ? output : null;
}
function duration(
  start: string | undefined | null,
  end: string | undefined | null,
): number | null {
  if (!start || !end) return null;
  const value = Date.parse(end) - Date.parse(start);
  return finite(value) ? value : null;
}
function verdict(value: unknown): "accept" | "needs-repair" | "reject" | null {
  return value === "accept" || value === "needs-repair" || value === "reject"
    ? value
    : null;
}
/** Closed public-only projection: all arbitrary/private strings are excluded. */
export async function exportSanitized(
  input: SanitizedExportInput,
): Promise<SanitizedExport> {
  if (!publicUrlSchema.safeParse(input.publicUrl).success)
    throw new SpillwayError(
      "PUBLICATION_DENIED",
      "Export requires an explicit canonical public GitHub repository URL.",
    );
  const repos = input.config.repositories.filter(
    (r) => r.publication?.public_url === input.publicUrl,
  );
  if (repos.length !== 1)
    throw new SpillwayError(
      "PUBLICATION_DENIED",
      "Explicit repository publication permission is required.",
    );
  let publicRepo = false;
  try {
    publicRepo = await (input.verifyPublic ?? verifyPublicGitHub)(
      input.publicUrl,
    );
  } catch {
    /*offline/private fails closed*/
  }
  if (!publicRepo)
    throw new SpillwayError(
      "PUBLICATION_DENIED",
      "Anonymous public repository verification failed.",
    );
  const currentGrant = input.config.repositories.filter(
    (r) => r.publication?.public_url === input.publicUrl,
  );
  if (currentGrant.length !== 1 || currentGrant[0]?.path !== repos[0]?.path)
    throw new SpillwayError(
      "PUBLICATION_DENIED",
      "Repository publication permission changed during verification.",
    );
  const eligible = input.snapshot.tasks.filter(
    (t) => t.task.spec.repo === repos[0]!.path,
  );
  const tasks = eligible.filter((t) => t.task.origin !== "qualification");
  const metadata = new Map<string, PublicProfileMetadata>();
  if (input.manifest !== undefined) {
    const parsed = manifestSchema.safeParse(input.manifest);
    if (!parsed.success)
      throw new SpillwayError(
        "INVALID_PUBLIC_MANIFEST",
        "Public profile manifest contains invalid or unsafe metadata.",
      );
    for (const entry of parsed.data.profiles) {
      if (metadata.has(entry.profileId))
        throw new SpillwayError(
          "INVALID_PUBLIC_MANIFEST",
          "Public manifest profile bindings must be unique.",
        );
      const profile = input.config.profiles.find(
        (p) => p.id === entry.profileId,
      );
      if (
        !profile ||
        profile.model !== entry.metadata.model ||
        profile.harness_version !== entry.metadata.harnessVersion
      )
        throw new SpillwayError(
          "INVALID_PUBLIC_MANIFEST",
          "Public metadata does not match the configured profile binding.",
        );
      if (/^[a-f0-9]{64}$/.test(profile.model_artifact)) {
        if (profile.model_artifact !== entry.metadata.modelArtifact)
          throw new SpillwayError(
            "INVALID_PUBLIC_MANIFEST",
            "Public artifact hash does not match the configured binding.",
          );
        metadata.set(entry.profileId, entry.metadata);
      }
      // A legacy unpinned binding remains unknown, not a reproducible certificate.
    }
  }
  const labels = new Map<string, string>();
  const label = (id: string) => {
    if (!labels.has(id)) labels.set(id, `profile-${labels.size + 1}`);
    return labels.get(id)!;
  };
  for (const task of tasks) {
    label(task.task.profileId);
    for (const attempt of task.attempts) {
      label(attempt.profileId);
      const meta = metadata.get(attempt.profileId);
      if (
        meta &&
        (attempt.model !== meta.model ||
          attempt.modelArtifact !== meta.modelArtifact ||
          attempt.harnessVersion !== meta.harnessVersion)
      )
        throw new SpillwayError(
          "INVALID_PUBLIC_MANIFEST",
          "Public metadata does not match historical attempt bindings.",
        );
    }
    for (const review of task.reviews ?? [])
      if (review.profileId) {
        label(review.profileId);
        const meta = metadata.get(review.profileId);
        if (
          meta &&
          (!review.model ||
            !review.modelArtifact ||
            !review.harness ||
            !review.harnessVersion)
        ) {
          metadata.delete(review.profileId);
        } else if (
          meta &&
          (review.model !== meta.model ||
            review.modelArtifact !== meta.modelArtifact ||
            review.harness !== "opencode" ||
            review.harnessVersion !== meta.harnessVersion)
        )
          throw new SpillwayError(
            "INVALID_PUBLIC_MANIFEST",
            "Public metadata does not match historical reviewer bindings.",
          );
      }
  }
  const profiles = [...labels].map(([id, label]) => ({
    label,
    metadata: metadata.get(id) ?? null,
    reproducible: metadata.has(id),
  }));
  const allowedStates = new Set<string>(TASK_STATES);
  const allowedClasses = new Set([
    "tests",
    "small-fix",
    "mechanical",
    "small-feature",
    "risky",
    "design",
  ]);
  const allowedTiers = new Set(["checks-only", "local", "frontier"]);
  const projected: SanitizedExport["tasks"] = tasks.map((detail, index) => {
    const task = detail.task;
    if (
      !allowedStates.has(task.state) ||
      !allowedClasses.has(task.spec.class) ||
      !allowedTiers.has(task.reviewTier)
    )
      throw new SpillwayError(
        "INVALID_EXPORT_DATA",
        "Stored outcome classifications are invalid.",
      );
    const decision = input.snapshot.decisions.find((d) => d.taskId === task.id);
    return {
      label: `task-${index + 1}`,
      profile: labels.get(task.profileId)!,
      class: task.spec.class,
      tier: task.reviewTier,
      state: task.state,
      taskSpec: deriveTaskSpecFeatures(task.spec),
      completedWhileFrontierOff:
        typeof task.completedWhileFrontierOff === "boolean"
          ? task.completedWhileFrontierOff
          : null,
      readyLatencyMs: duration(task.createdAt, task.readyAt),
      attempts: detail.attempts.map((a) => ({
        profile: labels.get(a.profileId)!,
        kind:
          a.kind === "repair"
            ? "repair"
            : a.kind === "frontier"
              ? "frontier"
              : "worker",
        outcome: [
          "running",
          "completed",
          "failed",
          "timeout",
          "transport_error",
          "uncertain",
        ].includes(a.outcome)
          ? a.outcome
          : "uncertain",
        durationMs: duration(a.startedAt, a.endedAt),
        checks: (a.verification?.checks ?? []).map((c) => ({
          exitCode:
            c.exitCode === null
              ? null
              : Number.isInteger(c.exitCode)
                ? c.exitCode
                : null,
          timedOut: c.timedOut === true,
          durationMs: finite(c.durationMs) ? c.durationMs : null,
        })),
        usage: cleanUsage(a.usage),
        verified:
          typeof a.verification?.passed === "boolean"
            ? a.verification.passed
            : null,
      })),
      reviews: (detail.reviews ?? []).map((r) => ({
        profile: r.profileId ? labels.get(r.profileId)! : null,
        tier: r.tier === "frontier" ? "frontier" : "local",
        outcome: ["running", "completed", "failed", "uncertain"].includes(
          r.outcome,
        )
          ? r.outcome
          : "uncertain",
        verdict: verdict(r.report?.verdict),
        durationMs: duration(r.startedAt, r.endedAt),
        usage: cleanUsage(r.usage),
      })),
      decision: decision
        ? {
            outcome: decision.decision === "accepted" ? "accepted" : "rejected",
            ownerMinutes: finite(decision.ownerMinutes)
              ? decision.ownerMinutes
              : null,
          }
        : null,
      audits: input.snapshot.audits
        .filter((a) => a.taskId === task.id)
        .map((a) => ({
          tier: a.reviewTier === "local" ? "local" : "checks-only",
          status: a.status === "completed" ? "completed" : "pending",
          verdict: verdict(a.report?.verdict),
          usage: cleanUsage(a.usage),
        })),
      planning: input.snapshot.planning
        .filter((p) => p.taskId === task.id)
        .map((p) => cleanUsage(p.usage))
        .filter((u): u is Usage => u !== null),
    };
  });
  return {
    version: 1,
    repository: input.publicUrl,
    reproducible: profiles.length > 0 && profiles.every((p) => p.reproducible),
    qualificationExcluded: eligible.length - tasks.length,
    profiles,
    tasks: projected,
  };
}
