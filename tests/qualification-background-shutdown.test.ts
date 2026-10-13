import { it, expect } from "vitest";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startService, type ServiceHandle } from "../src/server.js";
import { Store } from "../src/store.js";
import { runProcess } from "../src/process.js";
import type {
  HarnessAdapter,
  QualificationJobRecord,
  TaskDetail,
} from "../src/contracts.js";
import { fixture } from "./helpers.js";

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
  throw new Error("Fixture qualification shutdown condition timed out");
}
async function bounded<T>(promise: Promise<T>, timeout = 10000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Fixture orderly shutdown timed out")),
          timeout,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

it("orderly service shutdown aborts and awaits a real background qualification child, retaining a durable uncertainty fence on restart", async () => {
  const f = await fixture();
  const marker = join(f.root, "orderly-qualification.pid");
  const sleeper = join(f.root, "orderly-qualification.cjs");
  await writeFile(
    sleeper,
    `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`,
  );
  let service: ServiceHandle | undefined;
  let closing: Promise<void> | undefined;
  let childPid: number | undefined;
  let calls = 0;
  let confirmedStop = false;
  const unhandled: unknown[] = [];
  const observe = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", observe);
  const adapter: HarnessAdapter = {
    id: "opencode",
    version: () => f.adapter.version(),
    async run(input) {
      calls++;
      const result = await runProcess({
        command: process.execPath,
        args: [sleeper],
        cwd: input.worktree,
        timeoutMs: 120000,
        logPath: input.logPath,
        signal: input.signal,
      });
      confirmedStop = true;
      return {
        exit: result.timedOut
          ? "timeout"
          : result.exitCode === 0
            ? "completed"
            : "failed",
      };
    },
  };
  const api = async <T>(
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: T }> => {
    if (!service) throw new Error("Fixture service unavailable");
    const response = await fetch(service.url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${service.token}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(5000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      ...((await response.json()) as { data: T }),
    };
  };
  try {
    service = await startService(f.config, { once: true, adapter });
    const admission = await api<{ job: QualificationJobRecord }>(
      "/api/v1/qualify",
      { profileId: "fixture", background: true },
    );
    expect(admission.status).toBe(202);
    const id = admission.data.job.id;
    childPid = await waitFor(async () => {
      const pid = Number(await readFile(marker, "utf8"));
      return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
    });
    expect(() => process.kill(childPid!, 0)).not.toThrow();
    expect(calls).toBe(1);
    expect(confirmedStop).toBe(false);
    expect(
      (
        await api("/api/v1/tasks", {
          markdown: f.markdown("waiting-during-close"),
        })
      ).status,
    ).toBe(201);
    closing = service.close();
    await bounded(closing);
    closing = undefined;
    service = undefined;
    // The child ignores TERM; process-group escalation must finish before close.
    expect(confirmedStop).toBe(true);
    expect(() => process.kill(childPid!, 0)).toThrow();
    childPid = undefined;
    const reopened = new Store(f.data);
    let interrupted: QualificationJobRecord;
    try {
      interrupted = reopened.getQualificationJob(id)!;
      expect(interrupted).toMatchObject({
        id,
        status: "uncertain",
        reconciledAt: null,
        resultPath: null,
      });
      expect(interrupted.endedAt).not.toBeNull();
      expect(reopened.hasUnresolvedExecution()).toBe(true);
      expect(reopened.listAttempts("waiting-during-close")).toHaveLength(0);
    } finally {
      reopened.close();
    }
    await expect(access(interrupted.root)).resolves.toBeUndefined();
    service = await startService(f.config, { once: true, adapter });
    const detail = await api<{ job: QualificationJobRecord; result: null }>(
      `/api/v1/qualifications/${id}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.data).toEqual({ job: interrupted, result: null });
    expect((await api("/api/v1/run", {})).data).toEqual({ taskId: null });
    const waiting = await api<TaskDetail>("/api/v1/tasks/waiting-during-close");
    expect(waiting.data.task.state).toBe("queued");
    expect(waiting.data.attempts).toHaveLength(0);
    expect(calls).toBe(1);
    expect(
      (await api("/api/v1/qualify", { profileId: "fixture", background: true }))
        .status,
    ).toBe(409);
    expect(calls).toBe(1);
    await service.close();
    service = undefined;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  } finally {
    if (childPid)
      try {
        process.kill(-childPid, "SIGKILL");
      } catch {
        /*already stopped*/
      }
    if (closing) await bounded(closing).catch(() => undefined);
    if (service) await bounded(service.close());
    process.off("unhandledRejection", observe);
    await f.cleanup();
  }
}, 30000);
