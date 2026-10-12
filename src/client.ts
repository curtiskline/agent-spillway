import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  PROTOCOL,
  VERSION,
  SpillwayError,
  type ServiceDescriptor,
} from "./contracts.js";

export const defaultDataDir = (): string => join(homedir(), ".spillway");
const descriptorSchema = z
  .object({
    protocol: z.number().int(),
    version: z.string(),
    url: z.string(),
    token: z
      .string()
      .min(32)
      .max(512)
      .regex(/^[a-zA-Z0-9_-]+$/),
    pid: z.number().int().positive(),
  })
  .strict();
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const publicErrorCodes = new Set([
  "busy",
  "BUSY",
  "SHUTTING_DOWN",
  "NOT_FOUND",
  "NOT_READY",
  "NO_ATTEMPT",
  "NO_RESULT",
  "DATA_POLICY",
  "UNREGISTERED_REPO",
  "UNQUALIFIED_CLASS",
  "PLANNER_WORK",
  "PROFILE_MISSING",
  "REVIEW_POLICY",
  "RESULT_CHANGED",
  "CONTEXT_PATH",
  "CONTEXT_SIZE",
  "UNAUTHORIZED",
  "ORIGIN",
  "CONTENT_TYPE",
  "BODY_TOO_LARGE",
  "INVALID_JSON",
  "VALIDATION",
  "INTERNAL",
  "ARTIFACT_PATH",
  "ARTIFACT_SIZE",
  "invalid_task",
  "invalid_yaml",
  "invalid_dependency",
  "duplicate_task",
  "invalid_transition",
  "invalid_review",
  "not_found",
  "NOT_UNCERTAIN",
  "FRONTIER_OFF",
  "FRONTIER_UNAVAILABLE",
  "NOT_PENDING_REVIEW",
  "NOT_FRONTIER_WORK",
  "REVIEW_STALE",
  "INVALID_REVIEW",
  "invalid_frontier",
  "invalid_report",
  "REVIEW_REQUIRED",
  "ATTEMPT_MISMATCH",
  "FRONTIER_CLAIM",
  "FRONTIER_BUDGET",
  "DEPENDENCIES",
  "HANDOFF_FAILED",
  "INTERRUPTED",
  "NOT_CLAIMABLE",
  "NOT_REVIEWABLE",
  "NO_REPAIR_RESULT",
  "REPAIR_SIZE",
  "REVIEW_SIZE",
  "PROMPT_TOO_LARGE",
  "STALE_ATTEMPT",
  "STALE_REVIEW",
  "AUDIT_COMPLETE",
  "STALE_AUDIT",
  "QUALIFICATION_UNCERTAIN",
  "invalid_decision",
  "invalid_audit",
  "immutable_audit",
  "invalid_usage",
  "PUBLICATION_DENIED",
  "INVALID_PUBLIC_MANIFEST",
  "INVALID_EXPORT_SOURCE",
  "invalid_export",
  "QUALIFICATION_RESULT",
  "unsafe_export",
  "VERIFICATION_FAILED",
  "database_state",
  "duplicate_review",
  "immutable_review",
  "invalid_action",
  "stale_review",
]);

/** Stateless authenticated client. The service alone owns queue persistence. */
export class ServiceClient {
  constructor(readonly dataDir = defaultDataDir()) {}

  async descriptor(): Promise<ServiceDescriptor> {
    let handle;
    try {
      const dir = await stat(this.dataDir);
      if (
        !dir.isDirectory() ||
        (dir.mode & 0o077) !== 0 ||
        (process.getuid && dir.uid !== process.getuid())
      ) {
        throw new SpillwayError(
          "unsafe_descriptor",
          "Service data directory must be private and owned by the current user.",
        );
      }
      handle = await open(
        join(this.dataDir, "service.json"),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.size > 4096 ||
        (info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid())
      ) {
        throw new SpillwayError(
          "unsafe_descriptor",
          "Service descriptor must be a private file owned by the current user.",
        );
      }
      const parsed = descriptorSchema.safeParse(
        JSON.parse(await handle.readFile("utf8")) as unknown,
      );
      if (!parsed.success)
        throw new SpillwayError(
          "invalid_descriptor",
          "Service descriptor is invalid. Restart Spillway.",
        );
      const descriptor = parsed.data;
      let url: URL;
      try {
        url = new URL(descriptor.url);
      } catch {
        throw new SpillwayError(
          "invalid_descriptor",
          "Service address is invalid.",
        );
      }
      if (
        url.protocol !== "http:" ||
        url.hostname !== "127.0.0.1" ||
        !url.port ||
        url.pathname !== "/" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        throw new SpillwayError(
          "invalid_descriptor",
          "Service address must be a loopback HTTP origin.",
        );
      }
      if (descriptor.protocol !== PROTOCOL || descriptor.version !== VERSION) {
        throw new SpillwayError(
          "incompatible_service",
          "Service version is incompatible. Restart it using the installed Spillway version.",
        );
      }
      return descriptor;
    } catch (error) {
      if (error instanceof SpillwayError) throw error;
      if (object(error) && error.code === "ENOENT")
        throw new SpillwayError(
          "service_unavailable",
          "Spillway service is not running. Start spillway serve.",
          503,
        );
      throw new SpillwayError(
        "invalid_descriptor",
        "Cannot read a valid private service descriptor. Restart Spillway.",
      );
    } finally {
      await handle?.close();
    }
  }

  async request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    if (!/^\/api\/v1\/[a-zA-Z0-9_/-]+$/.test(path) || path.includes("//")) {
      throw new SpillwayError(
        "invalid_request",
        "Invalid service request path.",
      );
    }
    const descriptor = await this.descriptor();
    let response: Response;
    try {
      response = await fetch(new URL(path, descriptor.url), {
        method,
        redirect: "error",
        headers: {
          Authorization: `Bearer ${descriptor.token}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(
          path === "/api/v1/run" ||
            path === "/api/v1/qualify" ||
            path.endsWith("/frontier-complete")
            ? 24 * 60 * 60 * 1000
            : [
                  "/api/v1/export",
                  "/api/v1/endpoints",
                  "/api/v1/evidence/sync",
                ].includes(path)
              ? 30000
              : 5000,
        ),
      });
    } catch {
      throw new SpillwayError(
        "service_unavailable",
        "The service connection was interrupted. Check Spillway status before retrying or restarting; execution may still be running.",
        503,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new SpillwayError(
        "invalid_response",
        "Service returned an invalid response.",
        502,
      );
    }
    if (!response.ok) {
      // Never echo server-controlled text: errors can contain private code or tokens.
      const code =
        object(payload) &&
        object(payload.error) &&
        typeof payload.error.code === "string" &&
        publicErrorCodes.has(payload.error.code)
          ? payload.error.code
          : "service_error";
      throw new SpillwayError(
        code,
        `Service request failed (${response.status}, ${code}).`,
        response.status,
      );
    }
    if (!object(payload) || !("data" in payload))
      throw new SpillwayError(
        "invalid_response",
        "Service response is missing data.",
        502,
      );
    return payload.data;
  }

  async dashboardUrl(): Promise<string> {
    const descriptor = await this.descriptor();
    const url = new URL("/", descriptor.url);
    url.searchParams.set("token", descriptor.token);
    return url.href;
  }
}
