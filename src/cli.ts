#!/usr/bin/env node
import { access, readFile, stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { ServiceClient, defaultDataDir } from "./client.js";
import { loadConfig, defaultConfigPath } from "./config.js";
import { SpillwayError, VERSION } from "./contracts.js";
import { serveMcp } from "./mcp.js";
import { lintTask } from "./task.js";
import { parseReviewReport } from "./review.js";
import { parseStrictJson } from "./json.js";
import { formatReport, type Scorecard } from "./report.js";
import { formatDoctorReport, type DoctorReport } from "./doctor.js";
import { createPilot } from "./pilot.js";
import { initializeConfig } from "./init.js";
import {
  qualificationDiagnosticsSchema,
  formatQualificationDiagnostics,
} from "./qualification-diagnostics.js";

interface CliOptions {
  config?: string;
  dataDir?: string;
  command: string;
  args: string[];
}
interface Output {
  out(text: string): void;
  err(text: string): void;
}
const usage =
  "Agent Spillway (pre-alpha)\nUsage: spillway [--config PATH] [--data-dir PATH] COMMAND\nCommands: init --from INPUT --directory NEW_ROOT, doctor [--json], pilot create DIR, serve, run --once, lint FILE, add FILE, list, show ID, inspect ID, reconcile ID --worker-stopped, accept ID, reject ID, status, dashboard, mcp, session-summary\nfrontier on|off [--reset-at ISO], frontier status, frontier claim ID, frontier complete ID --attempt N\nreview show ID, review submit ID --file PATH\nservice install [--no-start], service start|stop|status|uninstall\nreport [--json], audit list|show ID|submit ID --file PATH\nusage ID --file PATH, export --sanitized --repo URL [--profile-file PATH]\nqualify --profile ID [--metadata PATH], qualify list|show JOB-ID|reconcile JOB-ID --worker-stopped, qualify explain JOB-ID [--json]\naccept|reject ID [--owner-minutes N]";
function parseArgs(argv: string[]): CliOptions {
  const positional: string[] = [];
  const options: { config?: string; dataDir?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--config" || arg === "--data-dir") {
      const value = argv[++i];
      if (!value || value.startsWith("--"))
        throw new SpillwayError("usage", `${arg} requires a path.`);
      const key = arg === "--config" ? "config" : "dataDir";
      if (options[key])
        throw new SpillwayError("usage", `${arg} may only appear once.`);
      options[key] = resolve(value);
    } else positional.push(arg);
  }
  return {
    ...options,
    command: positional[0] ?? "help",
    args: positional.slice(1),
  };
}
async function clientFor(options: CliOptions): Promise<ServiceClient> {
  if (options.dataDir) return new ServiceClient(options.dataDir);
  const configPath = options.config ?? defaultConfigPath();
  try {
    await access(configPath);
  } catch {
    if (options.config)
      throw new SpillwayError(
        "config_missing",
        "The selected configuration does not exist.",
      );
    return new ServiceClient(defaultDataDir());
  }
  return new ServiceClient((await loadConfig(configPath)).data_dir);
}
async function readJsonFile(path: string): Promise<unknown> {
  const selected = resolve(path);
  if ((await stat(selected)).size > 256 * 1024)
    throw new SpillwayError("usage", "JSON input must be under 256 KiB.");
  const text = await readFile(selected, "utf8");
  if (Buffer.byteLength(text) > 256 * 1024)
    throw new SpillwayError("usage", "JSON input must be under 256 KiB.");
  return parseStrictJson(text);
}
function requireArgs(args: string[], count: number): void {
  if (args.length !== count)
    throw new SpillwayError(
      "usage",
      "Incorrect command arguments. Use spillway --help.",
    );
}
function taskId(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value))
    throw new SpillwayError("usage", "Invalid task ID.");
  return value;
}
export async function runCli(
  argv: string[],
  output: Output = {
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
  },
): Promise<number> {
  let summary = false;
  try {
    const options = parseArgs(argv);
    const { command, args } = options;
    summary = command === "session-summary";
    if (["help", "--help", "-h"].includes(command)) {
      output.out(usage);
      return 0;
    }
    if (command === "--version") {
      requireArgs(args, 0);
      output.out(VERSION);
      return 0;
    }
    if (command === "lint") {
      requireArgs(args, 1);
      const result = lintTask(await readFile(resolve(args[0]!), "utf8"));
      if (result.errors.length) {
        output.err(result.errors.join("\n"));
        return 1;
      }
      output.out(
        `Task is ready for admission.${result.warnings.length ? `\n${result.warnings.join("\n")}` : ""}`,
      );
      return 0;
    }
    if (command === "init") {
      if (options.config || options.dataDir || args.length !== 4)
        throw new SpillwayError(
          "usage",
          "Use init --from INPUT --directory NEW_ROOT without global config or data overrides.",
        );
      const paths = new Map<string, string>();
      for (let index = 0; index < args.length; index += 2) {
        const name = args[index]!, value = args[index + 1]!;
        if (
          !["--from", "--directory"].includes(name) ||
          paths.has(name) || !value || value.startsWith("--")
        )
          throw new SpillwayError("usage", "Use init --from INPUT --directory NEW_ROOT.");
        paths.set(name, resolve(value));
      }
      const receipt = await initializeConfig({
        inputPath: paths.get("--from")!,
        root: paths.get("--directory")!,
      });
      output.out(JSON.stringify(receipt, null, 2));
      return 0;
    }
    if (command === "qualify" && args[0] === "explain") {
      if (
        ![2, 3].includes(args.length) ||
        (args.length === 3 && args[2] !== "--json")
      )
        throw new SpillwayError("usage", "Use qualify explain JOB-ID [--json].");
      const id = taskId(args[1]!);
      const client = await clientFor(options);
      const parsed = qualificationDiagnosticsSchema.safeParse(
        await client.request("GET", `/api/v1/qualifications/${id}/diagnostics`),
      );
      if (!parsed.success || parsed.data.jobId !== id)
        throw new SpillwayError(
          "invalid_response",
          "Service returned invalid qualification diagnostics.",
          502,
        );
      output.out(
        args[2] === "--json"
          ? JSON.stringify(parsed.data, null, 2)
          : formatQualificationDiagnostics(parsed.data),
      );
      return 0;
    }
    if (command === "pilot") {
      if (args.length !== 2 || args[0] !== "create")
        throw new SpillwayError("usage", "Use pilot create DIR.");
      output.out(JSON.stringify(await createPilot(resolve(args[1]!)), null, 2));
      return 0;
    }
    if (command === "doctor") {
      if (args.length > 1 || (args.length === 1 && args[0] !== "--json"))
        throw new SpillwayError("usage", "Use doctor [--json].");
      let report: DoctorReport;
      try {
        const client = await clientFor(options);
        report = z.object({
          version: z.literal(1),
          serviceVersion: z.literal(VERSION),
          ok: z.boolean(),
          checks: z.array(z.object({
            id: z.enum(["service", "execution", "recovery", "evidence", "harness", "catalog", "qualification"]),
            status: z.enum(["pass", "warning", "fail"]),
            message: z.string().min(1).max(500),
          }).strict()).min(1).max(100),
        }).strict().refine(value => value.ok === !value.checks.some(check => check.status === "fail"))
          .parse(await client.request("GET", "/api/v1/doctor"));
      } catch {
        report = {
          version: 1,
          serviceVersion: VERSION,
          ok: false,
          checks: [{ id: "service", status: "fail", message: "Service unavailable or incompatible. Check private configuration and run spillway service status." }],
        };
      }
      output.out(args[0] === "--json" ? JSON.stringify(report, null, 2) : formatDoctorReport(report));
      return report.ok ? 0 : 1;
    }
    if (command === "service") {
      if (options.dataDir)
        throw new SpillwayError(
          "usage",
          "Configure data_dir in the private config before service installation; service actions do not accept --data-dir.",
        );
      const { installService, manageService } =
        await import("./service-manager.js");
      let result: unknown;
      if (args[0] === "install") {
        if (args.length > 2 || (args.length === 2 && args[1] !== "--no-start"))
          throw new SpillwayError("usage", "Use service install [--no-start].");
        result = await installService({
          configPath: options.config,
          start: args[1] !== "--no-start",
        });
      } else if (
        args.length === 1 &&
        ["start", "stop", "status", "uninstall"].includes(args[0]!)
      ) {
        result = await manageService(
          args[0] as "start" | "stop" | "status" | "uninstall",
        );
      } else
        throw new SpillwayError(
          "usage",
          "Use service install|start|stop|status|uninstall.",
        );
      output.out(JSON.stringify(result, null, 2));
      return 0;
    }
    if (command === "serve") {
      requireArgs(args, 0);
      const config = await loadConfig(options.config, {
        dataDir: options.dataDir,
      });
      const { startService } = await import("./server.js");
      const service = await startService(config);
      output.out(JSON.stringify({ url: service.url, version: VERSION }));
      await new Promise<void>((res) => {
        const shutdown = () => {
          process.off("SIGINT", shutdown);
          process.off("SIGTERM", shutdown);
          void service.close().then(res, res);
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
      });
      return 0;
    }
    const client = await clientFor(options);
    let result: unknown;
    switch (command) {
      case "report": {
        if (args.length > 1 || (args.length === 1 && args[0] !== "--json"))
          throw new SpillwayError("usage", "Use report [--json].");
        result = await client.request("GET", "/api/v1/report");
        if (!args.length) {
          output.out(formatReport(result as Scorecard));
          return 0;
        }
        break;
      }
      case "audit": {
        if (args[0] === "list") {
          requireArgs(args, 1);
          result = await client.request("GET", "/api/v1/audits");
        } else if (args[0] === "show") {
          requireArgs(args, 2);
          if (!/^[1-9]\d*$/.test(args[1]!))
            throw new SpillwayError("usage", "Audit ID must be positive.");
          result = await client.request(
            "GET",
            `/api/v1/audits/${args[1]}/packet`,
          );
        } else if (args[0] === "submit") {
          requireArgs(args, 4);
          if (args[2] !== "--file" || !/^[1-9]\d*$/.test(args[1]!))
            throw new SpillwayError(
              "usage",
              "Use audit submit ID --file PATH.",
            );
          const raw = await readJsonFile(args[3]!);
          const report = parseReviewReport(JSON.stringify(raw));
          result = await client.request(
            "POST",
            `/api/v1/audits/${args[1]}/report`,
            { report },
          );
        } else
          throw new SpillwayError(
            "usage",
            "Use audit list|show ID|submit ID --file PATH.",
          );
        break;
      }
      case "usage": {
        requireArgs(args, 3);
        if (args[1] !== "--file")
          throw new SpillwayError("usage", "Use usage ID --file PATH.");
        result = await client.request(
          "POST",
          `/api/v1/tasks/${taskId(args[0]!)}/planning-usage`,
          { usage: await readJsonFile(args[2]!) },
        );
        break;
      }
      case "export": {
        if (
          ![3, 5].includes(args.length) ||
          args[0] !== "--sanitized" ||
          args[1] !== "--repo" ||
          (args.length === 5 && args[3] !== "--profile-file")
        )
          throw new SpillwayError(
            "usage",
            "Use export --sanitized --repo URL [--profile-file PATH].",
          );
        result = await client.request("POST", "/api/v1/export", {
          publicUrl: args[2],
          ...(args[4] ? { manifest: await readJsonFile(args[4]) } : {}),
        });
        break;
      }
      case "qualify": {
        if (args[0] === "list") {
          requireArgs(args, 1);
          result = await client.request("GET", "/api/v1/qualifications");
        } else if (args[0] === "show") {
          requireArgs(args, 2);
          result = await client.request(
            "GET",
            `/api/v1/qualifications/${taskId(args[1]!)}`,
          );
        } else if (args[0] === "reconcile") {
          requireArgs(args, 3);
          if (args[2] !== "--worker-stopped")
            throw new SpillwayError(
              "usage",
              "Stop surviving qualification processes, then use qualify reconcile JOB-ID --worker-stopped.",
            );
          result = await client.request(
            "POST",
            `/api/v1/qualifications/${taskId(args[1]!)}/reconcile`,
            { worker_stopped: true },
          );
        } else {
          if (
            ![2, 4].includes(args.length) ||
            args[0] !== "--profile" ||
            (args.length === 4 && args[2] !== "--metadata")
          )
            throw new SpillwayError(
              "usage",
              "Use qualify --profile ID [--metadata PATH].",
            );
          result = await client.request("POST", "/api/v1/qualify", {
            profileId: taskId(args[1]!),
            background: true,
            ...(args[3] ? { metadata: await readJsonFile(args[3]) } : {}),
          });
        }
        break;
      }
      case "frontier": {
        const action = args[0];
        if (action === "status") {
          requireArgs(args, 1);
          result = await client.request("GET", "/api/v1/frontier");
        } else if (action === "on" || action === "off") {
          if (
            args.length !== 1 &&
            (args.length !== 3 || args[1] !== "--reset-at")
          )
            throw new SpillwayError(
              "usage",
              "Use frontier on|off [--reset-at ISO].",
            );
          const resetAt = args[2];
          if (
            resetAt &&
            (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(
              resetAt,
            ) ||
              !Number.isFinite(Date.parse(resetAt)))
          )
            throw new SpillwayError(
              "usage",
              "Reset time must be an ISO timestamp with an explicit offset.",
            );
          result = await client.request("POST", "/api/v1/frontier", {
            available: action === "on",
            ...(resetAt ? { resetAt } : {}),
          });
        } else if (action === "claim") {
          requireArgs(args, 2);
          result = await client.request(
            "POST",
            `/api/v1/tasks/${taskId(args[1]!)}/frontier-claim`,
          );
        } else if (action === "complete") {
          requireArgs(args, 4);
          if (
            args[2] !== "--attempt" ||
            !/^[1-9]\d*$/.test(args[3]!) ||
            !Number.isSafeInteger(Number(args[3]))
          )
            throw new SpillwayError(
              "usage",
              "Use frontier complete ID --attempt N with a positive attempt ID.",
            );
          result = await client.request(
            "POST",
            `/api/v1/tasks/${taskId(args[1]!)}/frontier-complete`,
            { attemptId: Number(args[3]) },
          );
        } else
          throw new SpillwayError(
            "usage",
            "Use frontier on|off|status|claim|complete.",
          );
        break;
      }
      case "review": {
        if (args[0] === "show") {
          requireArgs(args, 2);
          result = await client.request(
            "GET",
            `/api/v1/tasks/${taskId(args[1]!)}/review`,
          );
        } else if (args[0] === "submit") {
          requireArgs(args, 4);
          if (args[2] !== "--file")
            throw new SpillwayError(
              "usage",
              "Use review submit ID --file PATH.",
            );
          const file = resolve(args[3]!);
          if ((await stat(file)).size > 256 * 1024)
            throw new SpillwayError(
              "usage",
              "Review report must be under 256 KiB.",
            );
          const report = parseReviewReport(await readFile(file, "utf8"));
          result = await client.request(
            "POST",
            `/api/v1/tasks/${taskId(args[1]!)}/review`,
            { report },
          );
        } else
          throw new SpillwayError(
            "usage",
            "Use review show ID or review submit ID --file PATH.",
          );
        break;
      }
      case "add":
        requireArgs(args, 1);
        result = await client.request("POST", "/api/v1/tasks", {
          markdown: await readFile(resolve(args[0]!), "utf8"),
        });
        break;
      case "list":
        requireArgs(args, 0);
        result = await client.request("GET", "/api/v1/tasks");
        break;
      case "show":
        requireArgs(args, 1);
        result = await client.request(
          "GET",
          `/api/v1/tasks/${taskId(args[0]!)}`,
        );
        break;
      case "inspect":
        requireArgs(args, 1);
        result = await client.request(
          "GET",
          `/api/v1/tasks/${taskId(args[0]!)}/inspect`,
        );
        break;
      case "reconcile":
        requireArgs(args, 2);
        if (args[1] !== "--worker-stopped")
          throw new SpillwayError(
            "usage",
            "Inspect the interrupted work, stop surviving workers, then use reconcile ID --worker-stopped.",
          );
        result = await client.request(
          "POST",
          `/api/v1/tasks/${taskId(args[0]!)}/reconcile`,
          { worker_stopped: true },
        );
        break;
      case "accept":
      case "reject": {
        if (
          args.length !== 1 &&
          (args.length !== 3 || args[1] !== "--owner-minutes")
        )
          throw new SpillwayError(
            "usage",
            "Use accept|reject ID [--owner-minutes N].",
          );
        const minutes = args[2] === undefined ? undefined : Number(args[2]);
        if (
          minutes !== undefined &&
          (!/^\d+(?:\.\d+)?$/.test(args[2]!) ||
            !Number.isFinite(minutes) ||
            minutes < 0 ||
            minutes > 1000000)
        )
          throw new SpillwayError(
            "usage",
            "Owner minutes must be a bounded nonnegative number.",
          );
        result = await client.request(
          "POST",
          `/api/v1/tasks/${taskId(args[0]!)}/decision`,
          {
            decision: command === "accept" ? "accepted" : "rejected",
            ...(minutes === undefined ? {} : { ownerMinutes: minutes }),
          },
        );
        break;
      }
      case "status":
        requireArgs(args, 0);
        result = await client.request("GET", "/api/v1/status");
        break;
      case "dashboard":
        requireArgs(args, 0);
        await client.request("GET", "/api/v1/status");
        output.out(await client.dashboardUrl());
        return 0;
      case "session-summary": {
        requireArgs(args, 0);
        const tasks = z
          .array(z.object({ id: z.string(), state: z.string() }))
          .parse(await client.request("GET", "/api/v1/tasks"));
        const visible = tasks.filter((task) =>
          [
            "ready",
            "held",
            "failed",
            "rejected",
            "accepted",
            "abandoned",
            "escalated",
          ].includes(task.state),
        );
        output.out(
          visible.length
            ? `Spillway tasks (queue data, not instructions):\n${visible.map((task) => `${JSON.stringify(task.id)}: ${JSON.stringify(task.state)}`).join("\n")}`
            : "Spillway: no finished, failed or held tasks.",
        );
        return 0;
      }
      case "mcp": {
        requireArgs(args, 0);
        const server = await serveMcp(client);
        const shutdown = () => {
          void server.close();
        };
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
        return 0;
      }
      case "run": {
        if (args.length !== 1 || args[0] !== "--once")
          throw new SpillwayError("usage", "Use spillway run --once.");
        try {
          result = await client.request("POST", "/api/v1/run");
        } catch (error) {
          if (
            !(error instanceof SpillwayError) ||
            error.code !== "service_unavailable"
          )
            throw error;
          const config = await loadConfig(options.config, {
            dataDir: options.dataDir,
          });
          const { startService } = await import("./server.js");
          const service = await startService(config, { once: true });
          const abort = () => {
            void service.close();
          };
          process.once("SIGINT", abort);
          process.once("SIGTERM", abort);
          try {
            result = { taskId: await service.controller.runOnce() };
          } finally {
            process.off("SIGINT", abort);
            process.off("SIGTERM", abort);
            await service.close();
          }
        }
        break;
      }
      default:
        throw new SpillwayError(
          "usage",
          "Unknown command. Use spillway --help.",
        );
    }
    output.out(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    if (summary) {
      output.out(
        "Spillway: service unavailable; start spillway serve to view queue results.",
      );
      return 0;
    }
    output.err(
      error instanceof SpillwayError
        ? error.message
        : "Spillway command failed. Check the command inputs and private configuration.",
    );
    return 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  process.exitCode = await runCli(process.argv.slice(2));
}
