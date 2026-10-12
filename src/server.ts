import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
  lstat,
} from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  VERSION,
  PROTOCOL,
  SpillwayError,
  type HarnessAdapter,
  type ServiceDescriptor,
  type SpillwayConfig,
} from "./contracts.js";
import { Store } from "./store.js";
import { Controller } from "./controller.js";
import { parseStrictJson } from "./json.js";
import { flushEvidence } from "./evidence.js";
import { buildScorecard, type Scorecard } from "./report.js";
import { exportSanitized } from "./export.js";
import type { EvidenceStatus } from "./contracts.js";

export interface ServiceHandle {
  url: string;
  token: string;
  controller: Controller;
  store: Store;
  close(): Promise<void>;
}
const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const taskInput = z
  .object({
    markdown: z
      .string()
      .min(1)
      .max(256 * 1024),
  })
  .strict();
const decisionInput = z
  .object({
    decision: z.enum(["accepted", "rejected"]),
    ownerMinutes: z.number().finite().min(0).max(1000000).optional(),
  })
  .strict();
const reconcileInput = z.object({ worker_stopped: z.literal(true) }).strict();
const frontierInput = z
  .object({
    available: z.boolean(),
    resetAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();
const usageInput = z
  .object({
    inputTokens: z.number().finite().int().nonnegative().optional(),
    outputTokens: z.number().finite().int().nonnegative().optional(),
    costUsd: z.number().finite().nonnegative().optional(),
  })
  .strict();
const reviewInput = z
  .object({
    report: z
      .unknown()
      .refine((value) => value !== undefined, "Review report is required"),
    model: z.string().trim().min(1).max(200).optional(),
    usage: usageInput.optional(),
  })
  .strict();
const planningInput = z
  .object({
    usage: usageInput.refine(
      (value) => Object.keys(value).length > 0,
      "Reported usage is required",
    ),
  })
  .strict();
const exportInput = z
  .object({
    publicUrl: z.string().min(1).max(300),
    manifest: z.unknown().optional(),
  })
  .strict();
const qualifyInput = z
  .object({
    profileId: idSchema,
    metadata: z.unknown().optional(),
    background: z.boolean().optional(),
  })
  .strict();
const completeInput = z
  .object({ attemptId: z.number().finite().int().positive() })
  .strict();
function escapeHtml(value: unknown): string {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
}
function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
async function body(req: IncomingMessage): Promise<unknown> {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    throw new SpillwayError("CONTENT_TYPE", "Use application/json.", 415);
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > 300 * 1024)
      throw new SpillwayError("BODY_TOO_LARGE", "Request too large.", 413);
    chunks.push(buffer);
  }
  try {
    return parseStrictJson(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new SpillwayError("INVALID_JSON", "Invalid JSON.");
  }
}
function page(title: string, content: string, prefix = "/"): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Agent Spillway</title><style>body{font:16px system-ui;max-width:1100px;margin:3rem auto;padding:0 1rem;background:#f6f7f8;color:#18222d}a{color:#176198}table{width:100%;border-collapse:collapse;background:white}th,td{text-align:left;padding:.8rem;border-bottom:1px solid #ddd}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:white;padding:1rem;border:1px solid #ddd}small{color:#536171}h1{letter-spacing:-.04em}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:1rem}.card{background:white;padding:1.3rem;border:1px solid #ddd;border-radius:8px}.card strong{display:block;font-size:2rem}.bar{height:8px;background:#e5e9ed;border-radius:4px;overflow:hidden;margin-top:6px}.fill{height:100%;background:#25855a}.note{padding:1rem;background:#fff3d8;border-radius:8px}nav{line-height:2}.state{font-family:monospace}</style></head><body><nav><a href="${prefix}">Agent Spillway</a> · <a href="${prefix}scorecard">Scorecard</a> · <a href="${prefix}audits">Audits</a> · <a href="${prefix}endpoints">Endpoints</a> · read-only</nav><h1>${escapeHtml(title)}</h1>${content}</body></html>`;
}
function scorecardMarkup(score: Scorecard): string {
  const counts = score.tasks;
  const cards = [
    ["Accepted", counts.accepted],
    ["Awaiting decision", counts.undecided],
    ["Rejected", counts.rejected],
    ["Pending audits", score.audits.pending],
  ]
    .map(
      ([label, count]) =>
        `<div class="card"><small>${escapeHtml(label)}</small><strong>${escapeHtml(count)}</strong></div>`,
    )
    .join("");
  const groups = (values: typeof score.tasks.byClass) =>
    Object.entries(values)
      .map(
        ([label, value]) =>
          `<tr><td>${escapeHtml(label)}</td><td>${value.accepted}<div class="bar"><div class="fill" style="width:${value.total ? Math.max(0, Math.min(100, (value.accepted / value.total) * 100)) : 0}%"></div></div></td><td>${value.rejected}</td><td>${value.undecided}</td><td>${value.total}</td></tr>`,
      )
      .join("");
  const header =
    "<thead><tr><th>Group</th><th>Accepted</th><th>Rejected</th><th>Undecided</th><th>Total</th></tr></thead>";
  const usage = Object.entries(score.usage)
    .map(
      ([role, value]) =>
        `<tr><td>${escapeHtml(role)}</td><td>${value.inputTokens.total} <small>(${value.inputTokens.known} known, ${value.inputTokens.missing} missing)</small></td><td>${value.outputTokens.total} <small>(${value.outputTokens.known} known, ${value.outputTokens.missing} missing)</small></td><td>${value.costUsd.known ? "$" + value.costUsd.total.toFixed(4) : "Unknown"} <small>(${value.costUsd.missing} missing)</small></td></tr>`,
    )
    .join("");
  return `<div class="cards">${cards}</div><p>${counts.acceptedWhileFrontierOff.yes} accepted tasks completed while frontier was off; ${counts.acceptedWhileFrontierOff.unknown} have unknown historical availability.</p><p>${score.attempts.tasksRepaired} tasks repaired; ${score.attempts.escalationExecutions} frontier executions. Audits: ${score.audits.misses} misses among ${score.audits.completed} completed (${score.audits.selected} selected).</p><h2>By class</h2><table>${header}<tbody>${groups(counts.byClass)}</tbody></table><h2>By profile</h2><table>${header}<tbody>${groups(counts.byProfile)}</tbody></table><h2>Reported usage across local and owner-session work</h2><table><thead><tr><th>Role</th><th>Input tokens</th><th>Output tokens</th><th>Reported cost</th></tr></thead><tbody>${usage}</tbody></table><p><small>Missing usage is unknown. Small samples remain counts; rates require 20 observations. Qualification tasks are excluded (${score.qualificationExcluded}). These results do not establish quota savings without a baseline.</small></p><p>Owner time: ${score.ownerMinutes.total} reported minutes; ${score.ownerMinutes.missing} missing.</p>`;
}
export async function startService(
  config: SpillwayConfig,
  options: { once?: boolean; adapter?: HarnessAdapter } = {},
): Promise<ServiceHandle> {
  await mkdir(config.data_dir, { recursive: true, mode: 0o700 });
  await chmod(config.data_dir, 0o700);
  const abort = new AbortController();
  const store = new Store(config.data_dir);
  const leaseNonce = randomBytes(16).toString("hex");
  try {
    store.acquireControllerLease(process.pid, leaseNonce);
  } catch (error) {
    store.close();
    throw error;
  }
  const unlock = () => store.releaseControllerLease(leaseNonce);
  const controller = new Controller(
    config,
    store,
    options.adapter,
    abort.signal,
  );
  const token = randomBytes(32).toString("hex");
  const cookie = randomBytes(32).toString("hex");
  const viewPrefix = `/view/${randomBytes(32).toString("hex")}/`;
  let url = "";
  let timer: ReturnType<typeof setInterval> | undefined;
  let closing = false;
  let running: Promise<string | null> | undefined;
  const qualificationRuns = new Set<Promise<void>>();
  let evidenceStatus: EvidenceStatus = {
    ...store.evidenceCounts(),
    lastError: null,
  };
  let flushing: Promise<EvidenceStatus> | undefined;
  const syncEvidence = (): Promise<EvidenceStatus> => {
    if (flushing) return flushing;
    flushing = flushEvidence(store, config.data_dir)
      .then((status) => {
        evidenceStatus = status;
        return status;
      })
      .catch(() => {
        evidenceStatus = {
          ...store.evidenceCounts(),
          lastError:
            "Evidence synchronization failed; SQLite records remain durable.",
        };
        return evidenceStatus;
      })
      .finally(() => {
        flushing = undefined;
      });
    return flushing;
  };
  const dispatch = (): Promise<string | null> => {
    if (closing) return Promise.resolve(null);
    if (running)
      throw new SpillwayError("BUSY", "A dispatch is already running.", 409);
    running = controller.runOnce().finally(() => {
      running = undefined;
      void syncEvidence();
    });
    return running;
  };
  const artifact = async (
    attemptId: number,
    name: string,
    reviewLog?: string,
  ): Promise<string> => {
    const attempt = store.getAttempt(attemptId);
    if (!attempt)
      throw new SpillwayError("NOT_FOUND", "Artifact not found.", 404);
    const paths = [
      attempt.logPath,
      attempt.reportPath,
      attempt.verification?.diffPath,
      ...(attempt.verification?.checks.map((check) => check.logPath) ?? []),
    ].filter((entry): entry is string => !!entry);
    const selected =
      reviewLog ?? paths.find((path) => path.split(/[\\/]/).at(-1) === name);
    if (!selected)
      throw new SpillwayError("NOT_FOUND", "Artifact not found.", 404);
    const rootPath = join(config.data_dir, "artifacts");
    const parentPath = join(rootPath, String(attempt.id));
    if (
      (await lstat(rootPath)).isSymbolicLink() ||
      (await lstat(parentPath)).isSymbolicLink() ||
      (await lstat(selected)).isSymbolicLink()
    )
      throw new SpillwayError(
        "ARTIFACT_PATH",
        "Artifact path is invalid.",
        403,
      );
    const root = await realpath(rootPath);
    const resolved = await realpath(selected);
    const parent = await realpath(parentPath);
    const parentRel = relative(root, parent);
    if (parentRel !== String(attempt.id))
      throw new SpillwayError(
        "ARTIFACT_PATH",
        "Artifact path is invalid.",
        403,
      );
    const rel = relative(parent, resolved);
    if (rel.startsWith("..") || isAbsolute(rel))
      throw new SpillwayError(
        "ARTIFACT_PATH",
        "Artifact path is invalid.",
        403,
      );
    if ((await stat(resolved)).size > 2 * 1024 * 1024)
      throw new SpillwayError(
        "ARTIFACT_SIZE",
        "Artifact exceeds dashboard limit; inspect it locally.",
        413,
      );
    return readFile(resolved, "utf8");
  };
  const server = createServer((req, res) => {
    void route(req, res).catch((error) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      const known = error instanceof SpillwayError;
      const invalid = error instanceof z.ZodError;
      res.writeHead(known ? error.status : invalid ? 400 : 500, {
        "Content-Type": "application/json",
      });
      res.end(
        JSON.stringify({
          error: {
            code: known ? error.code : invalid ? "VALIDATION" : "INTERNAL",
            message: known
              ? error.message
              : invalid
                ? "Invalid request."
                : "Operation could not be completed.",
          },
        }),
      );
    });
  });
  async function route(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    if (
      req.headers.host !== new URL(url).host ||
      (req.headers.origin && req.headers.origin !== url)
    )
      throw new SpillwayError("ORIGIN", "Invalid request origin.", 403);
    const location = new URL(req.url ?? "/", url);
    const browserSession = location.pathname.startsWith(viewPrefix);
    const path = browserSession
      ? `/${location.pathname.slice(viewPrefix.length)}`
      : location.pathname;
    const prefix = browserSession ? viewPrefix : "/";
    if (
      req.method === "GET" &&
      location.pathname === "/" &&
      location.searchParams.has("token")
    ) {
      if (!equal(location.searchParams.get("token") ?? "", token))
        throw new SpillwayError(
          "UNAUTHORIZED",
          "Authentication required.",
          401,
        );
      // Cookies share localhost across ports. An unguessable path confines this
      // cookie to the dashboard routes rather than every local web service.
      res.writeHead(303, {
        Location: viewPrefix,
        "Set-Cookie": `spillway=${cookie}; HttpOnly; SameSite=Strict; Path=${viewPrefix}`,
      });
      res.end();
      return;
    }
    const bearer = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : "";
    const session =
      req.headers.cookie
        ?.split(";")
        .map((value) => value.trim())
        .find((value) => value.startsWith("spillway="))
        ?.slice(9) ?? "";
    const authorized =
      equal(bearer, token) ||
      (req.method === "GET" && browserSession && equal(session, cookie));
    if (!authorized)
      throw new SpillwayError("UNAUTHORIZED", "Authentication required.", 401);
    const json = (data: unknown, status = 200) => {
      void syncEvidence();
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data }));
    };
    if (req.method === "GET" && path === "/api/v1/status") {
      const counts: Record<string, number> = {};
      for (const task of store.listTasks())
        counts[task.state] = (counts[task.state] ?? 0) + 1;
      json({
        version: VERSION,
        protocol: PROTOCOL,
        running:
          !!running ||
          controller.isBusy() ||
          Object.keys(counts).some((state) =>
            ["dispatched", "verifying", "reviewing"].includes(state),
          ),
        counts,
        frontier: store.getFrontierState(),
        evidence: {
          ...store.evidenceCounts(),
          lastError: evidenceStatus.lastError,
        },
        audits: {
          pending: store
            .listAudits()
            .filter((audit) => audit.status === "pending").length,
        },
      });
      return;
    }
    if (req.method === "GET" && path === "/api/v1/report") {
      json(buildScorecard(store.reportSnapshot()));
      return;
    }
    if (
      (req.method === "GET" && path === "/api/v1/evidence") ||
      (req.method === "POST" && path === "/api/v1/evidence/sync")
    ) {
      json(await syncEvidence());
      return;
    }
    if (req.method === "GET" && path === "/api/v1/endpoints") {
      json(await controller.endpointHealth());
      return;
    }
    if (req.method === "GET" && path === "/api/v1/audits") {
      json(
        store.listAudits().map((audit) => ({
          ...audit,
          held:
            audit.status === "pending" &&
            (!store.getFrontierState().available ||
              !config.repositories.some(
                (repo) =>
                  repo.path ===
                    controller.getDetail(audit.taskId).task.spec.repo &&
                  repo.data_policy === "frontier-ok",
              )),
        })),
      );
      return;
    }
    const auditPath = path.match(/^\/api\/v1\/audits\/(\d+)\/(packet|report)$/);
    if (auditPath && req.method === "GET" && auditPath[2] === "packet") {
      json(await controller.getAuditPacket(Number(auditPath[1])));
      return;
    }
    if (auditPath && req.method === "POST" && auditPath[2] === "report") {
      const input = reviewInput.parse(await body(req));
      json(
        await controller.submitAudit(Number(auditPath[1]), input.report, {
          model: input.model,
          usage: input.usage,
        }),
      );
      return;
    }
    if (req.method === "POST" && path === "/api/v1/export") {
      const input = exportInput.parse(await body(req));
      json(
        await exportSanitized({
          snapshot: store.reportSnapshot(),
          config,
          publicUrl: input.publicUrl,
          manifest: input.manifest,
        }),
      );
      return;
    }
    if (req.method === "GET" && path === "/api/v1/qualifications") {
      json(store.listQualificationJobs());
      return;
    }
    const qualificationPath = path.match(
      /^\/api\/v1\/qualifications\/([a-z0-9-]+)$/,
    );
    if (req.method === "GET" && qualificationPath) {
      json(
        await controller.qualificationDetail(idSchema.parse(qualificationPath[1])),
      );
      return;
    }
    const jobPath = path.match(
      /^\/api\/v1\/qualifications\/([a-z0-9-]+)\/reconcile$/,
    );
    if (req.method === "POST" && jobPath) {
      reconcileInput.parse(await body(req));
      store.reconcileQualificationJob(idSchema.parse(jobPath[1]));
      json(store.getQualificationJob(jobPath[1]!));
      return;
    }
    if (req.method === "POST" && path === "/api/v1/qualify") {
      const input = qualifyInput.parse(await body(req));
      if (!input.background) {
        json(await controller.qualify(input.profileId, input.metadata));
      } else {
        // Acknowledgement follows durable admission, never subprocess completion.
        let admit!: (job: ReturnType<Store["createQualificationJob"]>) => void;
        let deny!: (error: unknown) => void;
        const admitted = new Promise<ReturnType<Store["createQualificationJob"]>>(
          (resolve, reject) => {
            admit = resolve;
            deny = reject;
          },
        );
        const execution = controller
          .qualify(input.profileId, input.metadata, admit)
          .then(() => {}, (error: unknown) => {
            deny(error);
          })
          .finally(() => {
            qualificationRuns.delete(execution);
            void syncEvidence();
          });
        qualificationRuns.add(execution);
        json({ job: await admitted }, 202);
      }
      return;
    }
    if (path === "/api/v1/tasks") {
      if (req.method === "GET") {
        json(store.listTasks());
        return;
      }
      if (req.method === "POST") {
        json(
          await controller.addTask(taskInput.parse(await body(req)).markdown),
          201,
        );
        return;
      }
    }
    if (path === "/api/v1/run" && req.method === "POST") {
      json({ taskId: await dispatch() });
      return;
    }
    if (path === "/api/v1/frontier") {
      if (req.method === "GET") {
        json(store.getFrontierState());
        return;
      }
      if (req.method === "POST") {
        const input = frontierInput.parse(await body(req));
        json(store.setFrontierState(input.available, input.resetAt));
        return;
      }
    }
    const taskPath = path.match(
      /^\/api\/v1\/tasks\/([^/]+)(?:\/(result|decision|inspect|reconcile|review|frontier-claim|frontier-complete|planning-usage))?$/,
    );
    if (taskPath) {
      const id = idSchema.parse(taskPath[1]);
      const detail = controller.getDetail(id);
      if (req.method === "POST" && taskPath[2] === "planning-usage") {
        const input = planningInput.parse(await body(req));
        json(store.addPlanningUsage(id, input.usage));
        return;
      }
      if (req.method === "GET" && taskPath[2] === "review") {
        json(await controller.getReviewPacket(id));
        return;
      }
      if (req.method === "POST" && taskPath[2] === "review") {
        const input = reviewInput.parse(await body(req));
        json(
          await controller.submitFrontierReview(id, input.report, {
            model: input.model,
            usage: input.usage,
          }),
        );
        return;
      }
      if (req.method === "POST" && taskPath[2] === "frontier-claim") {
        json(await controller.claimFrontier(id));
        return;
      }
      if (req.method === "POST" && taskPath[2] === "frontier-complete") {
        json(
          await controller.completeFrontier(
            id,
            completeInput.parse(await body(req)).attemptId,
          ),
        );
        return;
      }
      if (req.method === "GET" && !taskPath[2]) {
        json(detail);
        return;
      }
      if (req.method === "GET" && taskPath[2] === "inspect") {
        json(await controller.inspect(id));
        return;
      }
      if (req.method === "GET" && taskPath[2] === "result") {
        const attempt = detail.attempts.at(-1);
        json(
          attempt
            ? {
                attempt,
                verification: attempt.verification,
                report: attempt.reportPath
                  ? await artifact(attempt.id, "report.json")
                  : null,
              }
            : null,
        );
        return;
      }
      if (req.method === "POST" && taskPath[2] === "decision") {
        const input = decisionInput.parse(await body(req));
        json(await controller.decide(id, input.decision, input.ownerMinutes));
        return;
      }
      if (req.method === "POST" && taskPath[2] === "reconcile") {
        reconcileInput.parse(await body(req));
        json(controller.reconcile(id));
        return;
      }
    }
    const reviewLogPath = path.match(/^\/api\/v1\/reviews\/(\d+)\/log$/);
    if (req.method === "GET" && reviewLogPath) {
      const review = store.getReview(Number(reviewLogPath[1]));
      if (!review?.logPath)
        throw new SpillwayError("NOT_FOUND", "Review log not found.", 404);
      const content = await artifact(
        review.attemptId,
        "reviewer.log",
        review.logPath,
      );
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(content);
      return;
    }
    const artifactPath = path.match(
      /^\/api\/v1\/artifacts\/(\d+)\/([a-zA-Z0-9._-]+)$/,
    );
    if (req.method === "GET" && artifactPath) {
      const content = await artifact(Number(artifactPath[1]), artifactPath[2]!);
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(content);
      return;
    }
    if (req.method === "GET" && path === "/scorecard") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        page(
          "Scorecard",
          scorecardMarkup(buildScorecard(store.reportSnapshot())),
          prefix,
        ),
      );
      return;
    }
    if (req.method === "GET" && path === "/audits") {
      const available = store.getFrontierState().available;
      const rows = store
        .listAudits()
        .map((audit) => {
          const task = controller.getDetail(audit.taskId).task;
          const permitted = config.repositories.some(
            (repo) =>
              repo.path === task.spec.repo &&
              repo.data_policy === "frontier-ok",
          );
          const status =
            audit.status === "completed"
              ? (audit.report?.verdict ?? "Unknown")
              : !available
                ? "Frontier off"
                : !permitted
                  ? "Repository policy holds audit"
                  : "Awaiting owner session";
          return `<tr><td>${audit.id}</td><td><a href="${prefix}tasks/${escapeHtml(task.id)}">${escapeHtml(task.id)}</a></td><td>${escapeHtml(audit.reviewTier)}</td><td>${escapeHtml(status)}</td><td>${escapeHtml(audit.resultSha)}</td></tr>`;
        })
        .join("");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        page(
          "Deferred audits",
          `<p>Audits preserve owner acceptance history. Submit them from an authorized Claude session; no automatic paid calls.</p><table><thead><tr><th>Audit</th><th>Task</th><th>Accepted tier</th><th>Status</th><th>Commit</th></tr></thead><tbody>${rows}</tbody></table>`,
          prefix,
        ),
      );
      return;
    }
    if (req.method === "GET" && path === "/endpoints") {
      const rows = (await controller.endpointHealth())
        .map(
          (health) =>
            `<tr><td>${escapeHtml(health.profileId)}</td><td>${health.healthy ? "Available" : "Waiting"}</td><td>${escapeHtml(health.reason ?? "Exact model is present in the catalog.")}</td></tr>`,
        )
        .join("");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        page(
          "Endpoint health",
          `<p>Catalog health does not certify model capability. Frontier services are never probed automatically.</p><table><thead><tr><th>Profile</th><th>Status</th><th>Reason</th></tr></thead><tbody>${rows}</tbody></table>`,
          prefix,
        ),
      );
      return;
    }
    if (req.method === "GET" && path === "/") {
      const tasks = store.listTasks();
      const rows = tasks
        .map(
          (task) =>
            `<tr><td><a href="${prefix}tasks/${task.id}">${escapeHtml(task.id)}</a></td><td>${escapeHtml(task.spec.class)}</td><td>${escapeHtml(task.profileId)}</td><td class="state">${escapeHtml(task.state)}</td><td>${escapeHtml(task.reason ?? "")}</td><td>${escapeHtml(task.createdAt)}</td></tr>`,
        )
        .join("");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        page(
          "Queue",
          `<p>Phase 3 · ${tasks.length} tasks · ${running || controller.isBusy() ? "one slot active" : "slot idle"}. Refresh to see progress.</p><p>Frontier sessions: ${store.getFrontierState().available ? "available" : "off"} · planned reset: ${escapeHtml(store.getFrontierState().resetAt ?? "none")}</p><table><thead><tr><th>Task</th><th>Class</th><th>Profile</th><th>State</th><th>Reason</th><th>Banked</th></tr></thead><tbody>${rows}</tbody></table><p class="note">Evidence delivery: ${store.evidenceCounts().pending} pending · ${store.evidenceCounts().delivered} delivered. ${escapeHtml(evidenceStatus.lastError ?? "")}</p><p><small>Owner decisions stay in the CLI. Frontier work uses authorized Claude Code sessions; the service makes no automatic paid calls.</small></p>`,
          prefix,
        ),
      );
      return;
    }
    const dashboardTask = path.match(/^\/tasks\/([a-z0-9-]+)$/);
    if (req.method === "GET" && dashboardTask) {
      const detail = controller.getDetail(idSchema.parse(dashboardTask[1]));
      const attemptMarkup = detail.attempts
        .map((attempt) => {
          const links = [
            attempt.logPath,
            attempt.reportPath,
            attempt.verification?.diffPath,
            ...(attempt.verification?.checks.map((check) => check.logPath) ??
              []),
          ]
            .filter((entry): entry is string => !!entry)
            .map((path) => {
              const name = path.split(/[\\/]/).at(-1)!;
              return `<a href="${prefix}api/v1/artifacts/${attempt.id}/${encodeURIComponent(name)}">${escapeHtml(name)}</a>`;
            })
            .join(" · ");
          return `<h2>Attempt ${attempt.id}: ${escapeHtml(attempt.outcome)}</h2><p>${escapeHtml(attempt.startedAt)} → ${escapeHtml(attempt.endedAt ?? "running")}</p><p>${links}</p><pre>${escapeHtml(JSON.stringify({ baseSha: attempt.baseSha, resultSha: attempt.resultSha, harness: attempt.harness, harnessVersion: attempt.harnessVersion, verification: attempt.verification, usage: attempt.usage }, null, 2))}</pre>`;
        })
        .join("");
      const reviewLinks = (detail.reviews ?? [])
        .filter((review) => review.logPath)
        .map(
          (review) =>
            `<a href="${prefix}api/v1/reviews/${review.id}/log">Review ${review.id} log</a>`,
        )
        .join(" · ");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        page(
          detail.task.id,
          `<p>${escapeHtml(detail.task.state)} · review ${escapeHtml(detail.task.reviewTier)} · ${escapeHtml(detail.task.reason ?? "")}</p><h2>Task specification</h2><pre>${escapeHtml(detail.task.raw)}</pre>${attemptMarkup}<h2>Reviews</h2><p>${reviewLinks}</p><pre>${escapeHtml(JSON.stringify(detail.reviews, null, 2))}</pre><h2>Events</h2><pre>${escapeHtml(JSON.stringify(detail.events, null, 2))}</pre>`,
          prefix,
        ),
      );
      return;
    }
    throw new SpillwayError("NOT_FOUND", "Route not found.", 404);
  }
  try {
    await controller.recover();
    await syncEvidence();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    url = `http://127.0.0.1:${address.port}`;
    const descriptor: ServiceDescriptor = {
      url,
      token,
      pid: process.pid,
      version: VERSION,
      protocol: PROTOCOL,
    };
    await writeFile(
      join(config.data_dir, "service.json"),
      JSON.stringify(descriptor),
      { mode: 0o600 },
    );
    await chmod(join(config.data_dir, "service.json"), 0o600);
    if (!options.once) {
      const tick = () => {
        if (!closing) void syncEvidence();
        if (!running && !closing && !controller.isBusy())
          void dispatch().catch(() => {});
      };
      timer = setInterval(tick, config.poll_interval_ms);
      timer.unref();
      tick();
    }
  } catch (error) {
    abort.abort();
    server.close();
    unlock();
    store.close();
    throw error;
  }
  return {
    url,
    token,
    controller,
    store,
    async close() {
      if (closing) return;
      closing = true;
      if (timer) clearInterval(timer);
      abort.abort();
      const closed = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
      server.closeIdleConnections();
      await running?.catch(() => {});
      await closed;
      await controller.waitForIdle();
      await Promise.all(qualificationRuns);
      const descriptor = JSON.parse(
        await readFile(join(config.data_dir, "service.json"), "utf8").catch(
          () => "{}",
        ),
      ) as Partial<ServiceDescriptor>;
      if (descriptor.token === token)
        await rm(join(config.data_dir, "service.json"), { force: true });
      await syncEvidence();
      unlock();
      store.close();
    },
  };
}
