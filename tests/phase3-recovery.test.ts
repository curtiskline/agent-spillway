import { it, expect } from "vitest";
import {
  access,
  mkdir,
  readdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import ts from "typescript";
import { fixture } from "./helpers.js";
import type {
  QualificationJobRecord,
  ServiceDescriptor,
  TaskDetail,
} from "../src/contracts.js";

async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  timeout = 10000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await probe().catch(() => undefined);
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Qualification fixture condition timed out");
}

it("actual SIGKILL qualification recovery preserves uncertainty and fences ordinary work until owner reconciliation", async () => {
  const f = await fixture();
  const children = new Set<ReturnType<typeof spawn>>();
  let orphanPid: number | undefined;
  const runtime = join(f.root, "runtime");
  const dist = join(runtime, "dist");
  let service:
    | { child: ReturnType<typeof spawn>; exited: Promise<number | null> }
    | undefined;
  let pendingQualification: Promise<unknown> | undefined;
  const descriptor = async () =>
    JSON.parse(
      await readFile(join(f.data, "service.json"), "utf8"),
    ) as ServiceDescriptor;
  const request = async <T>(path: string, body?: unknown): Promise<T> => {
    const d = await descriptor();
    const response = await fetch(`${d.url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${d.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
    expect(response.ok).toBe(true);
    const parsed = (await response.json()) as { data: T };
    return parsed.data;
  };
  const start = async () => {
    const child = spawn(process.execPath, [join(runtime, "runner.mjs")], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    const exited = new Promise<number | null>((resolve) =>
      child.once("exit", resolve),
    );
    let stderr = "";
    child.stderr!.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-8192);
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Fixture service startup timed out: ${stderr}`)),
        10000,
      );
      child.stdout!.once("data", () => {
        clearTimeout(timer);
        resolve();
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error(`Fixture service exited during startup: ${stderr}`));
      });
    });
    return { child, exited };
  };
  const stop = async (current: NonNullable<typeof service>) => {
    if (current.child.exitCode !== null || current.child.signalCode !== null)
      return await current.exited;
    current.child.kill("SIGTERM");
    let timer: NodeJS.Timeout | undefined;
    const exited = await Promise.race([
      current.exited,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 5000);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (exited === undefined) {
      current.child.kill("SIGKILL");
      await current.exited;
    }
    return exited;
  };
  try {
    await mkdir(dist, { recursive: true });
    for (const name of await readdir("src"))
      if (name.endsWith(".ts"))
        await writeFile(
          join(dist, name.replace(/\.ts$/, ".js")),
          ts.transpileModule(await readFile(join("src", name), "utf8"), {
            compilerOptions: {
              target: ts.ScriptTarget.ES2023,
              module: ts.ModuleKind.ESNext,
            },
          }).outputText,
        );
    await writeFile(join(runtime, "package.json"), ' {"type":"module"}\n');
    await symlink(
      join(process.cwd(), "node_modules"),
      join(runtime, "node_modules"),
    );
    await symlink(join(process.cwd(), "eval"), join(runtime, "eval"));
    const marker = join(f.root, "qualification-worker.pid");
    const sleeper = join(f.root, "qualification-sleeper.cjs");
    await writeFile(
      sleeper,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`,
    );
    await writeFile(
      join(runtime, "runner.mjs"),
      `import {startService} from './dist/server.js';import {runProcess} from './dist/process.js';const config=${JSON.stringify(f.config)};const adapter={id:'opencode',async version(){return 'fixture-v1';},async run(input){const result=await runProcess({command:process.execPath,args:[${JSON.stringify(sleeper)}],cwd:input.worktree,timeoutMs:120000,logPath:input.logPath,signal:input.signal});return {exit:result.timedOut?'timeout':result.exitCode===0?'completed':'failed'};}};const service=await startService(config,{adapter});console.log(JSON.stringify({url:service.url}));const stop=()=>{void service.close().then(()=>process.exit(0));};process.on('SIGTERM',stop);process.on('SIGINT',stop);`,
    );
    service = await start();
    // The request stays open while a real fixture subprocess occupies the slot.
    pendingQualification = request("/api/v1/qualify", {
      profileId: "fixture",
    }).catch(() => undefined);
    orphanPid = await waitFor(async () => {
      const text = await readFile(marker, "utf8");
      const pid = Number(text);
      return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
    });
    const before = (
      await request<QualificationJobRecord[]>("/api/v1/qualifications")
    )[0]!;
    expect(before.status).toBe("running");
    expect(before.profileId).toBe("fixture");
    await request("/api/v1/tasks", {
      markdown: f.markdown("queued-after-qualification"),
    });
    expect(
      (await request<TaskDetail>("/api/v1/tasks/queued-after-qualification"))
        .attempts,
    ).toHaveLength(0);
    service.child.kill("SIGKILL");
    await service.exited;
    service = undefined;
    await pendingQualification;
    expect(() => process.kill(orphanPid!, 0)).not.toThrow();
    service = await start();
    const recovered = await waitFor(async () => {
      const jobs = await request<QualificationJobRecord[]>(
        "/api/v1/qualifications",
      );
      return jobs[0]?.status === "uncertain" ? jobs[0] : undefined;
    });
    expect(recovered).toMatchObject({
      id: before.id,
      profileId: "fixture",
      root: before.root,
      status: "uncertain",
      resultPath: null,
      reconciledAt: null,
    });
    const queued = await request<TaskDetail>(
      "/api/v1/tasks/queued-after-qualification",
    );
    expect(queued.task.state).toBe("queued");
    expect(queued.attempts).toHaveLength(0);
    expect(
      (await request<{ taskId: string | null }>("/api/v1/run", {})).taskId,
    ).toBeNull();
    expect(
      (await request<TaskDetail>("/api/v1/tasks/queued-after-qualification"))
        .attempts,
    ).toHaveLength(0);
    // Only an explicit owner stop attestation releases the persisted fence.
    f.setHealthy(false);
    process.kill(-orphanPid, "SIGKILL");
    orphanPid = undefined;
    const reconciled = await request<QualificationJobRecord>(
      `/api/v1/qualifications/${before.id}/reconcile`,
      { worker_stopped: true },
    );
    expect(reconciled).toEqual({
      ...recovered,
      reconciledAt: expect.any(String),
    });
    expect(Number.isFinite(Date.parse(reconciled.reconciledAt!))).toBe(true);
    await expect(access(before.root)).resolves.toBeUndefined();
    expect(
      (await request<{ taskId: string | null }>("/api/v1/run", {})).taskId,
    ).toBeNull();
    const waiting = await request<TaskDetail>(
      "/api/v1/tasks/queued-after-qualification",
    );
    expect(waiting.attempts).toHaveLength(0);
    expect(waiting.task.reason).toContain("503");
    const preserved = (
      await request<QualificationJobRecord[]>("/api/v1/qualifications")
    )[0]!;
    expect(preserved).toEqual(reconciled);
    expect(preserved.status).toBe("uncertain");
    expect(await stop(service)).toBe(0);
    service = undefined;
  } finally {
    f.setHealthy(false);
    if (orphanPid)
      try {
        process.kill(-orphanPid, "SIGKILL");
      } catch {
        /*already stopped*/
      }
    if (service) await stop(service);
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    await pendingQualification?.catch(() => undefined);
    await f.cleanup();
  }
}, 45000);
