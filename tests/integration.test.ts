import { it, expect } from "vitest";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import ts from "typescript";
import { fixture } from "./helpers.js";
import type { ServiceDescriptor } from "../src/contracts.js";

const execute = promisify(execFile);
async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  timeout = 10000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Fixture condition timed out");
}

it.each(["worker", "review"])(
  "actual SIGKILL %s recovery fences queued execution until owner stops orphan and reconciles",
  async (purpose) => {
    const f = await fixture();
    const runtime = join(f.root, "runtime");
    const dist = join(runtime, "dist");
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
    await writeFile(join(runtime, "package.json"), '{"type":"module"}');
    await symlink(
      join(process.cwd(), "node_modules"),
      join(runtime, "node_modules"),
    );
    const marker = join(f.root, "worker.pid");
    const sleep = join(f.root, "sleep.cjs");
    await writeFile(
      sleep,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`,
    );
    const runner = join(runtime, "runner.mjs");
    await writeFile(
      runner,
      `import {startService} from './dist/server.js';import {runProcess} from './dist/process.js';const config=${JSON.stringify(f.config)};const adapter={id:'opencode',async version(){return 'fixture-v1'},async run(input){const sleeping = ${JSON.stringify(purpose)}==='worker'||input.purpose==='review';const r=await runProcess({command:process.execPath,args:[sleeping?${JSON.stringify(sleep)}:${JSON.stringify(join(f.root, "worker.cjs"))}],cwd:input.worktree,timeoutMs:120000,logPath:input.logPath,signal:input.signal});return {exit:r.timedOut?'timeout':r.exitCode===0?'completed':'failed'};}};const service=await startService(config,{adapter});console.log(JSON.stringify({url:service.url}));const stop=()=>{void service.close().then(()=>process.exit(0));};process.on('SIGTERM',stop);process.on('SIGINT',stop);`,
    );
    let workerPid: number | undefined;
    const start = async () => {
      const child = spawn(process.execPath, [runner], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const exited = new Promise<number | null>((resolve) =>
        child.once("exit", resolve),
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`Startup timed out: ${stderr}`)),
          10000,
        );
        child.stdout.once("data", () => {
          clearTimeout(timeout);
          resolve();
        });
        child.once("exit", () => {
          clearTimeout(timeout);
          reject(new Error(`Startup exited: ${stderr}`));
        });
      });
      return { child, exited };
    };
    let service: Awaited<ReturnType<typeof start>> | undefined;
    const descriptor = async () =>
      JSON.parse(
        await readFile(join(f.data, "service.json"), "utf8"),
      ) as ServiceDescriptor;
    const get = async (path: string) => {
      const d = await descriptor();
      return (
        await (
          await fetch(`${d.url}${path}`, {
            headers: { Authorization: `Bearer ${d.token}` },
          })
        ).json()
      ).data;
    };
    try {
      service = await start();
      const first = join(f.root, "first.md");
      const second = join(f.root, "second.md");
      await writeFile(
        first,
        f.markdown("first", purpose === "review" ? "local" : "checks-only"),
      );
      await writeFile(second, f.markdown("second"));
      const cli = join(dist, "cli.js");
      await execute(process.execPath, [
        cli,
        "--data-dir",
        f.data,
        "add",
        first,
      ]);
      await execute(process.execPath, [
        cli,
        "--data-dir",
        f.data,
        "add",
        second,
      ]);
      workerPid = await waitFor(async () => {
        const text = await readFile(marker, "utf8");
        return text ? Number(text) : undefined;
      });
      service.child.kill("SIGKILL");
      await service.exited;
      service = undefined;
      // Demonstrate the orphan exists; recovery must not treat commit/checkout
      // inspection as proof of process termination or consume a second slot.
      expect(() => process.kill(workerPid!, 0)).not.toThrow();
      service = await start();
      const firstDetail = await get("/api/v1/tasks/first");
      const secondDetail = await get("/api/v1/tasks/second");
      expect(firstDetail.task.state).toBe("held");
      if (purpose === "review") {
        expect(firstDetail.attempts[0].outcome).toBe("completed");
        expect(firstDetail.reviews[0].outcome).toBe("uncertain");
      } else expect(firstDetail.attempts[0].outcome).toBe("uncertain");
      expect(secondDetail.task.state).toBe("queued");
      expect(secondDetail.attempts).toHaveLength(0);
      const d = await descriptor();
      const once = await fetch(`${d.url}/api/v1/run`, {
        method: "POST",
        headers: { Authorization: `Bearer ${d.token}` },
      });
      expect((await once.json()).data.taskId).toBeNull();
      expect((await get("/api/v1/tasks/second")).attempts).toHaveLength(0);
      f.setHealthy(false);
      process.kill(-workerPid!, "SIGKILL");
      workerPid = undefined;
      expect(
        (
          await execute(process.execPath, [
            cli,
            "--data-dir",
            f.data,
            "reconcile",
            "first",
            "--worker-stopped",
          ])
        ).stdout,
      ).toContain("abandoned");
      expect((await get("/api/v1/tasks/first")).task.state).toBe("abandoned");
      service.child.kill("SIGTERM");
      expect(await service.exited).toBe(0);
      service = undefined;
    } finally {
      if (workerPid)
        try {
          process.kill(-workerPid, "SIGKILL");
        } catch {
          /* already stopped */
        }
      if (service) {
        service.child.kill("SIGTERM");
        await service.exited;
      }
      await f.cleanup();
    }
  },
  45000,
);

it("creates a disposable public sample whose protected check fails on the baseline", async () => {
  const f = await fixture();
  try {
    const created = JSON.parse(
      (
        await execute(process.execPath, [
          "scripts/create-sample.mjs",
          join(f.root, "sample"),
        ])
      ).stdout,
    ) as { repo: string; task: string };
    await expect(
      execute(process.execPath, ["tests/acceptance.cjs"], {
        cwd: created.repo,
      }),
    ).rejects.toThrow();
    expect(await readFile(created.task, "utf8")).toContain(
      "protected: [tests/**]",
    );
    await chmod(created.task, 0o600);
  } finally {
    await f.cleanup();
  }
});
