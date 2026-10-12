#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { ServiceClient, defaultDataDir } from "./client.js";
import { loadConfig, defaultConfigPath } from "./config.js";
import { SpillwayError, VERSION } from "./contracts.js";
import { serveMcp } from "./mcp.js";
import { lintTask } from "./task.js";

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
  "Agent Spillway (pre-alpha)\nUsage: spillway [--config PATH] [--data-dir PATH] COMMAND\nCommands: serve, run --once, lint FILE, add FILE, list, show ID, inspect ID, reconcile ID --worker-stopped, accept ID, reject ID, status, dashboard, mcp, session-summary";
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
      case "reject":
        requireArgs(args, 1);
        result = await client.request(
          "POST",
          `/api/v1/tasks/${taskId(args[0]!)}/decision`,
          { decision: command === "accept" ? "accepted" : "rejected" },
        );
        break;
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
