import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  minimalEnvironment,
  runProcess,
  OUTPUT_LIMIT,
} from "../src/process.js";

describe("bounded private subprocesses", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "spillway-process-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  it("uses argument arrays and stdin without shell interpolation", async () => {
    const result = await runProcess({
      command: process.execPath,
      args: [
        "-e",
        'process.stdin.on("data", b => process.stdout.write(process.argv[1]+b))',
        "$(touch should-not-exist)",
      ],
      cwd: root,
      stdin: "hello",
      timeoutMs: 2000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("$(touch should-not-exist)hello");
  });
  it("redacts credentials across pipe boundaries and writes private bounded logs", async () => {
    const logPath = join(root, "logs", "run.log");
    const result = await runProcess({
      command: process.execPath,
      args: [
        "-e",
        'process.stdout.write("fixture-sec");setTimeout(()=>process.stdout.write("ret-token!"),25)',
      ],
      cwd: root,
      env: {
        ...minimalEnvironment(root),
        SPILLWAY_TEST_KEY: "fixture-secret-token",
      },
      timeoutMs: 2000,
      logPath,
    });
    expect(result.stdout).toBe("[REDACTED]!");
    expect(await readFile(logPath, "utf8")).toBe("[REDACTED]!");
    expect((await stat(logPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, "logs"))).mode & 0o777).toBe(0o700);
  });
  it("caps memory and reports launch failures", async () => {
    const result = await runProcess({
      command: process.execPath,
      args: ["-e", `process.stdout.write('x'.repeat(${OUTPUT_LIMIT * 3}))`],
      cwd: root,
      timeoutMs: 2000,
    });
    expect(result.stdout.length).toBeLessThan(OUTPUT_LIMIT + 100);
    expect(result.stdout).toContain("output truncated");
    const missing = await runProcess({
      command: join(root, "absent"),
      cwd: root,
      timeoutMs: 2000,
    });
    expect(missing.exitCode).toBeNull();
    expect(missing.stderr).toContain("ENOENT");
  });
  it("kills a TERM-resistant descendant on timeout", async () => {
    const pidFile = join(root, "pid");
    const code = `const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const c=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000)`;
    const result = await runProcess({
      command: process.execPath,
      args: ["-e", code],
      cwd: root,
      timeoutMs: 200,
    });
    expect(result.timedOut).toBe(true);
    const pid = Number(await readFile(pidFile, "utf8"));
    // POSIX may briefly retain a killed orphan as a zombie; it cannot execute.
    await new Promise((resolve) => setTimeout(resolve, 100));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (alive && process.platform === "linux") {
      expect(await readFile(`/proc/${pid}/stat`, "utf8")).toMatch(/\) Z /);
    } else expect(alive).toBe(false);
  });
  it("aborts a running process and does not inherit provider environment", async () => {
    const controller = new AbortController();
    const pending = runProcess({
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      cwd: root,
      timeoutMs: 5000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    expect((await pending).timedOut).toBe(true);
    process.env.SPILLWAY_TEST_PROVIDER_KEY = "fixture-only";
    try {
      const result = await runProcess({
        command: process.execPath,
        args: [
          "-e",
          "process.stdout.write(String(process.env.SPILLWAY_TEST_PROVIDER_KEY))",
        ],
        cwd: root,
        timeoutMs: 2000,
      });
      expect(result.stdout).toBe("undefined");
    } finally {
      delete process.env.SPILLWAY_TEST_PROVIDER_KEY;
    }
  });
  it("kills background descendants when a successful parent exits", async () => {
    const pidFile = join(root, "background-pid");
    const code = `const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});c.unref();fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));`;
    const result = await runProcess({
      command: process.execPath,
      args: ["-e", code],
      cwd: root,
      timeoutMs: 2000,
    });
    expect(result.exitCode).toBe(0);
    const pid = Number(await readFile(pidFile, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (alive && process.platform === "linux")
      expect(await readFile(`/proc/${pid}/stat`, "utf8")).toMatch(/\) Z /);
    else expect(alive).toBe(false);
  });
  it("writes evidence for exhausted deadlines without starting commands", async () => {
    const logPath = join(root, "expired.log");
    const result = await runProcess({
      command: process.execPath,
      args: ["-e", "process.exit(7)"],
      cwd: root,
      timeoutMs: 0,
      logPath,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(await readFile(logPath, "utf8")).toContain("deadline exhausted");
  });
});
