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
  .object({ decision: z.enum(["accepted", "rejected"]) })
  .strict();
const reconcileInput = z.object({ worker_stopped: z.literal(true) }).strict();
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
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new SpillwayError("INVALID_JSON", "Invalid JSON.");
  }
}
function page(title: string, content: string, prefix = "/"): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Agent Spillway</title><style>body{font:16px system-ui;max-width:1100px;margin:3rem auto;padding:0 1rem;background:#f6f7f8;color:#18222d}a{color:#176198}table{width:100%;border-collapse:collapse;background:white}th,td{text-align:left;padding:.8rem;border-bottom:1px solid #ddd}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:white;padding:1rem;border:1px solid #ddd}small{color:#536171}h1{letter-spacing:-.04em}.state{font-family:monospace}</style></head><body><nav><a href="${prefix}">Agent Spillway</a> · local read-only dashboard</nav><h1>${escapeHtml(title)}</h1>${content}</body></html>`;
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
  const dispatch = (): Promise<string | null> => {
    if (closing) return Promise.resolve(null);
    if (running)
      throw new SpillwayError("BUSY", "A dispatch is already running.", 409);
    running = controller.runOnce().finally(() => {
      running = undefined;
    });
    return running;
  };
  const artifact = async (attemptId: number, name: string): Promise<string> => {
    const attempt = store.getAttempt(attemptId);
    if (!attempt)
      throw new SpillwayError("NOT_FOUND", "Artifact not found.", 404);
    const paths = [
      attempt.logPath,
      attempt.reportPath,
      attempt.verification?.diffPath,
      ...(attempt.verification?.checks.map((check) => check.logPath) ?? []),
    ].filter((entry): entry is string => !!entry);
    const selected = paths.find((path) => path.split(/[\\/]/).at(-1) === name);
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
        running: !!running,
        counts,
      });
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
    const taskPath = path.match(
      /^\/api\/v1\/tasks\/([^/]+)(?:\/(result|decision|inspect|reconcile))?$/,
    );
    if (taskPath) {
      const id = idSchema.parse(taskPath[1]);
      const detail = controller.getDetail(id);
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
        json(
          await controller.decide(
            id,
            decisionInput.parse(await body(req)).decision,
          ),
        );
        return;
      }
      if (req.method === "POST" && taskPath[2] === "reconcile") {
        reconcileInput.parse(await body(req));
        json(controller.reconcile(id));
        return;
      }
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
          `<p>Phase 1 · ${tasks.length} tasks · ${running ? "one slot active" : "slot idle"}. Refresh to see progress.</p><table><thead><tr><th>Task</th><th>Class</th><th>Profile</th><th>State</th><th>Reason</th><th>Banked</th></tr></thead><tbody>${rows}</tbody></table><p><small>Owner decisions stay in the CLI. Model reviews and scorecards arrive in later phases.</small></p>`,
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
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        page(
          detail.task.id,
          `<p>${escapeHtml(detail.task.state)} · review ${escapeHtml(detail.task.reviewTier)} · ${escapeHtml(detail.task.reason ?? "")}</p><h2>Task specification</h2><pre>${escapeHtml(detail.task.raw)}</pre>${attemptMarkup}<h2>Events</h2><pre>${escapeHtml(JSON.stringify(detail.events, null, 2))}</pre>`,
          prefix,
        ),
      );
      return;
    }
    throw new SpillwayError("NOT_FOUND", "Route not found.", 404);
  }
  try {
    await controller.recover();
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
        if (!running && !closing) void dispatch().catch(() => {});
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
      const descriptor = JSON.parse(
        await readFile(join(config.data_dir, "service.json"), "utf8").catch(
          () => "{}",
        ),
      ) as Partial<ServiceDescriptor>;
      if (descriptor.token === token)
        await rm(join(config.data_dir, "service.json"), { force: true });
      unlock();
      store.close();
    },
  };
}
