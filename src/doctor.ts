import {
  VERSION,
  type EvidenceStatus,
  type HarnessAdapter,
  type SpillwayConfig,
} from "./contracts.js";
import { probeEndpoint } from "./harness.js";

export interface DoctorCheck {
  id:
    | "service"
    | "execution"
    | "recovery"
    | "evidence"
    | "harness"
    | "catalog"
    | "qualification";
  status: "pass" | "warning" | "fail";
  message: string;
  profileId?: string;
}
export interface DoctorReport {
  version: 1;
  serviceVersion: string;
  ok: boolean;
  checks: DoctorCheck[];
}
export interface DoctorInput {
  config: SpillwayConfig;
  adapter: HarnessAdapter;
  busy: boolean;
  uncertain: boolean;
  evidence: EvidenceStatus;
}

// Closed messages keep configuration, endpoint responses and subprocess errors
// out of both the service response and the CLI formatter.
const messages: Record<
  DoctorCheck["id"],
  Partial<Record<DoctorCheck["status"], string>>
> = {
  service: {
    pass: "The service is reachable. Use spillway status to inspect the queue.",
    fail: "The service is unavailable or incompatible. Check private configuration and matching CLI/service versions, then use spillway service status and start the configured service before retrying.",
  },
  execution: {
    pass: "The execution slot is idle.",
    warning: "Execution is active. Wait for it to finish before starting more work.",
  },
  recovery: {
    pass: "No unresolved execution requires recovery.",
    fail: "Unresolved execution blocks new work. Inspect held tasks and qualification jobs; reconcile only after confirming the worker has stopped.",
  },
  evidence: {
    pass: "Recorded evidence has been delivered.",
    warning: "Evidence delivery is pending. Allow synchronization to finish and check service status.",
    fail: "Evidence delivery failed. Inspect service status and restore private storage access before retrying synchronization.",
  },
  harness: {
    pass: "The installed harness matches every exact configured worker profile binding.",
    warning: "No local or hosted worker profile is configured. Harness inspection was skipped; frontier work uses authorized owner sessions.",
    fail: "The harness is unavailable or differs from an exact configured profile binding. Install the configured harness version and recheck private configuration.",
  },
  catalog: {
    pass: "Every configured local profile model is present in its catalog.",
    warning: "Nonlocal catalogs were skipped. Inspect those destinations separately; this diagnostic checks only configured local catalogs.",
    fail: "A configured local catalog is unavailable or missing its exact model. Check endpoint access and model bindings in private configuration.",
  },
  qualification: {
    warning: "Task-class permissions are operator assertions. Inspect real qualification and pilot evidence before relying on them.",
  },
};
function check(id: DoctorCheck["id"], status: DoctorCheck["status"]): DoctorCheck {
  return { id, status, message: messages[id][status]! };
}

async function installedVersion(adapter: HarnessAdapter): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      // Consume a late rejection even if the outer deadline has already won.
      Promise.resolve()
        .then(() => adapter.version())
        .catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Service-owned diagnostic only. Configuration is already validated at startup.
 * Catalogs reuse the existing bounded probe and explicit credential references;
 * hosted/frontier destinations are never probed. No state or permissions change.
 */
export async function buildDoctorReport(input: DoctorInput): Promise<DoctorReport> {
  const { config, adapter, busy, uncertain, evidence } = input;
  const workerProfiles = config.profiles.filter(
    (profile) => config.endpoints.find(
      (endpoint) => endpoint.id === profile.endpoint,
    )?.kind !== "frontier",
  );
  const catalog = async (): Promise<DoctorCheck> => {
    let skipped = false;
    const health = await Promise.all(
      config.profiles.map(async (profile) => {
        const endpoint = config.endpoints.find(
          (item) => item.id === profile.endpoint,
        );
        if (!endpoint) return false;
        if (endpoint.kind !== "local") {
          skipped = true;
          return true;
        }
        try {
          return (await probeEndpoint(endpoint, profile.model)).healthy;
        } catch {
          return false;
        }
      }),
    );
    const status = health.some((healthy) => !healthy)
      ? "fail"
      : skipped || health.length === 0 ? "warning" : "pass";
    return check("catalog", status);
  };
  const [version, catalogCheck] = await Promise.all([
    workerProfiles.length > 0 ? installedVersion(adapter) : Promise.resolve(null),
    catalog(),
  ]);
  const harnessMatches = version !== null && workerProfiles.every(
    (profile) => profile.harness === adapter.id && profile.harness_version === version,
  );
  const checks = [
    check("service", "pass"),
    check("execution", busy ? "warning" : "pass"),
    check("recovery", uncertain ? "fail" : "pass"),
    check("evidence", evidence.lastError !== null
      ? "fail" : evidence.pending > 0 ? "warning" : "pass"),
    check("harness", workerProfiles.length === 0
      ? "warning" : harnessMatches ? "pass" : "fail"),
    catalogCheck,
    check("qualification", "warning"),
  ];
  return {
    version: 1,
    serviceVersion: VERSION,
    ok: !checks.some((row) => row.status === "fail"),
    checks,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  // Use the closed message table rather than echoing arbitrary response text,
  // returned service versions or optional profile IDs.
  const rows = report.checks.map((row) => {
    const message = messages[row.id]?.[row.status];
    return message
      ? `${row.status.toUpperCase()} ${row.id}: ${message}`
      : "FAIL service: The diagnostic response is invalid. Restart the service and retry.";
  });
  const ok = report.ok && report.checks.every(
    (row) => row.status !== "fail" && messages[row.id]?.[row.status],
  );
  return [
    "Agent Spillway diagnostics",
    ...rows,
    ok
      ? "No diagnostic failures. Warnings do not certify capability."
      : "Diagnostic failures require attention.",
  ].join("\n");
}
