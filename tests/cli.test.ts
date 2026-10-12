import { createServer, type Server } from "node:http";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VERSION } from "../src/contracts.js";

describe("spawned CLI against authenticated mock service", () => {
  let dir: string;
  let entry: string;
  let token: string;
  let server: Server;
  const execute = promisify(execFile);
  const seen: { method: string; url: string; body: unknown }[] = [];
  const cli = (args: string[]) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
      execFile(
        process.execPath,
        [entry, "--data-dir", dir, ...args],
        { timeout: 10000 },
        (error, stdout, stderr) => {
          done({
            code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
            stdout,
            stderr,
          });
        },
      );
    });
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "spillway-cli-"));
    await chmod(dir, 0o700);
    const compiled = join(dir, "build", "dist");
    await mkdir(compiled, { recursive: true });
    // Transpile production modules outside the checkout; central typecheck verifies their types.
    for (const name of await readdir("src")) {
      if (!name.endsWith(".ts")) continue;
      const source = await readFile(join("src", name), "utf8");
      await writeFile(
        join(compiled, name.replace(/\.ts$/, ".js")),
        ts.transpileModule(source, {
          compilerOptions: {
            target: ts.ScriptTarget.ES2023,
            module: ts.ModuleKind.ESNext,
          },
        }).outputText,
      );
    }
    // Dependencies resolve from the project; only compiled code and test state live in temp.
    const { symlink } = await import("node:fs/promises");
    await symlink(
      join(process.cwd(), "node_modules"),
      join(dir, "build", "node_modules"),
    );
    await writeFile(join(dir, "build", "package.json"), '{"type":"module"}');
    entry = join(compiled, "cli.js");
    token = randomBytes(32).toString("hex");
    server = createServer(async (request, response) => {
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401).end();
        return;
      }
      let text = "";
      for await (const chunk of request) text += String(chunk);
      seen.push({
        method: request.method ?? "",
        url: request.url ?? "",
        body: text ? (JSON.parse(text) as unknown) : null,
      });
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          data:
            request.url === "/api/v1/tasks" && request.method === "GET"
              ? [{ id: "task-one", state: "held" }]
              : request.url === "/api/v1/run"
                ? { taskId: null }
                : { running: false },
        }),
      );
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing HTTP port");
    await writeFile(
      join(dir, "service.json"),
      JSON.stringify({
        protocol: 1,
        version: VERSION,
        url: `http://127.0.0.1:${address.port}`,
        token,
        pid: process.pid,
      }),
      { mode: 0o600 },
    );
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(dir, { recursive: true, force: true });
  });
  it("dispatches queue commands and JSON bodies without exposing tokens", async () => {
    const task = join(dir, "task.md");
    await writeFile(task, "private task markdown");
    for (const args of [
      ["status"],
      ["list"],
      ["show", "task-one"],
      ["inspect", "task-one"],
      ["add", task],
      ["accept", "task-one"],
      ["reject", "task-one"],
      ["run", "--once"],
    ]) {
      const result = await cli(args);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).not.toContain(token);
      expect(() => JSON.parse(result.stdout) as unknown).not.toThrow();
    }
    expect(seen).toContainEqual({
      method: "POST",
      url: "/api/v1/tasks",
      body: { markdown: "private task markdown" },
    });
    expect(seen).toContainEqual({
      method: "POST",
      url: "/api/v1/tasks/task-one/decision",
      body: { decision: "accepted" },
    });
    expect(seen).toContainEqual({
      method: "POST",
      url: "/api/v1/run",
      body: null,
    });
  });
  it("summarizes terminal states and prints owner dashboard URL only on request", async () => {
    expect((await cli(["session-summary"])).stdout).toContain(
      '"task-one": "held"',
    );
    const link = await cli(["dashboard"]);
    expect(new URL(link.stdout.trim()).searchParams.get("token")).toBe(token);
  });
  it("rejects malformed IDs, missing values and unsupported commands", async () => {
    for (const args of [
      ["show", "../escape"],
      ["run"],
      ["report"],
      ["--config"],
    ])
      expect((await cli(args)).code).toBe(1);
  });
  it("routes frontier availability, claim, completion and SHA-pinned review reports", async () => {
    const file = join(dir, "review.json");
    const report = {
      resultSha: "a".repeat(40),
      verdict: "accept",
      findings: [],
    };
    await writeFile(file, JSON.stringify(report));
    for (const args of [
      ["frontier", "status"],
      ["frontier", "off", "--reset-at", "2026-10-13T14:00:00-05:00"],
      ["frontier", "on"],
      ["frontier", "claim", "task-one"],
      ["frontier", "complete", "task-one", "--attempt", "42"],
      ["review", "show", "task-one"],
      ["review", "submit", "task-one", "--file", file],
    ]) {
      const result = await cli(args);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).not.toContain(token);
    }
    expect(seen).toContainEqual({
      method: "POST",
      url: "/api/v1/frontier",
      body: { available: false, resetAt: "2026-10-13T14:00:00-05:00" },
    });
    expect(seen).toContainEqual({
      method: "POST",
      url: "/api/v1/frontier",
      body: { available: true },
    });
    expect(seen).toContainEqual({
      method: "POST",
      url: "/api/v1/tasks/task-one/frontier-claim",
      body: null,
    });
    expect(seen).toContainEqual({
      method: "POST",
      url: "/api/v1/tasks/task-one/frontier-complete",
      body: { attemptId: 42 },
    });
    expect(seen).toContainEqual({
      method: "POST",
      url: "/api/v1/tasks/task-one/review",
      body: { report },
    });
    expect(seen).toContainEqual({
      method: "GET",
      url: "/api/v1/tasks/task-one/review",
      body: null,
    });
  });
  it("rejects malformed frontier/review/service commands without network or daemon mutations", async () => {
    const count = seen.length;
    for (const args of [
      ["frontier", "off", "--reset-at", "tomorrow"],
      ["frontier", "off", "--reset-at", "2026-10-13T12:00:00"],
      ["frontier", "claim", "../escape"],
      ["frontier", "complete", "task-one", "--attempt", "0"],
      ["frontier", "complete", "task-one", "--attempt", "9007199254740993"],
      ["review", "submit", "task-one"],
      ["service", "install", "--no-start"],
      ["service", "start"],
    ])
      expect((await cli(args)).code).toBe(1);
    const file = join(dir, "malformed-review.json");
    await writeFile(file, "not JSON");
    expect(
      (await cli(["review", "submit", "task-one", "--file", file])).code,
    ).toBe(1);
    expect(seen).toHaveLength(count);
  });
  it("rejects ambiguous duplicate review keys before posting advice", async () => {
    const count = seen.length;
    const file = join(dir, "duplicate-review.json");
    for (const verdictKey of ["verdict", "ver\\u0064ict"]) {
      await writeFile(
        file,
        `{"resultSha":"${"a".repeat(40)}","verdict":"reject","${verdictKey}":"accept","findings":[]}`,
      );
      const result = await cli([
        "review",
        "submit",
        "task-one",
        "--file",
        file,
      ]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("duplicate");
    }
    expect(seen).toHaveLength(count);
  });
  it("handles absent service gracefully for session hook and fails ordinary commands", async () => {
    await rm(join(dir, "service.json"));
    const summary = await cli(["session-summary"]);
    expect(summary.code).toBe(0);
    expect(summary.stdout).toContain("service unavailable");
    const status = await cli(["status"]);
    expect(status.code).toBe(1);
    expect(status.stderr).toContain("not running");
    expect(status.stderr).not.toContain(token);
  });
  it("runs an ephemeral controller and a foreground service with orderly signal cleanup", async () => {
    const repo = join(dir, "repo");
    await mkdir(repo);
    await execute("git", ["init", repo]);
    const reserve = createServer();
    await new Promise<void>((done) => reserve.listen(0, "127.0.0.1", done));
    const address = reserve.address();
    if (!address || typeof address === "string")
      throw new Error("Missing port");
    await new Promise<void>((done) => reserve.close(() => done()));
    const dataDir = join(dir, "runtime");
    const config = join(dir, "config.yaml");
    await writeFile(
      config,
      JSON.stringify({
        version: 1,
        port: address.port,
        data_dir: dataDir,
        repositories: [{ path: repo }],
        endpoints: [
          { id: "fixture", kind: "local", url: "http://127.0.0.1:1/v1" },
        ],
        profiles: [
          {
            id: "fixture",
            endpoint: "fixture",
            model: "fixture",
            model_artifact: "fixture-only",
            harness: "opencode",
            harness_version: "fixture",
            qualified_classes: ["tests"],
          },
        ],
        default_profile: "fixture",
      }),
      { mode: 0o600 },
    );
    // No queued work: this must not contact an endpoint or invoke a harness.
    const once = await execute(process.execPath, [
      entry,
      "--config",
      config,
      "--data-dir",
      dataDir,
      "run",
      "--once",
    ]);
    expect(JSON.parse(once.stdout) as unknown).toEqual({ taskId: null });
    await expect(access(join(dataDir, "service.json"))).rejects.toThrow();
    const child = spawn(
      process.execPath,
      [entry, "--config", config, "--data-dir", dataDir, "serve"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const exited = new Promise<number | null>((done) =>
      child.once("exit", done),
    );
    try {
      const line = await new Promise<string>((done, fail) => {
        const deadline = setTimeout(
          () => fail(new Error("Service startup timeout")),
          5000,
        );
        let output = "";
        child.stdout.on("data", (chunk) => {
          output += String(chunk);
          if (output.includes("\n")) {
            clearTimeout(deadline);
            done(output.split("\n")[0]!);
          }
        });
        child.once("error", fail);
      });
      expect((JSON.parse(line) as { version: string }).version).toBe(VERSION);
      const status = await execute(process.execPath, [
        entry,
        "--data-dir",
        dataDir,
        "status",
      ]);
      expect((JSON.parse(status.stdout) as { protocol: number }).protocol).toBe(
        1,
      );
      child.kill("SIGTERM");
      expect(await exited).toBe(0);
      await expect(access(join(dataDir, "service.json"))).rejects.toThrow();
      await expect(access(join(dataDir, "controller.lock"))).rejects.toThrow();
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  });
});
