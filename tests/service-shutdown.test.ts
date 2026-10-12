import { it, expect, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { startService, type ServiceHandle } from "../src/server.js";
import { Store } from "../src/store.js";
import type { EvidenceRecord } from "../src/contracts.js";
import { fixture } from "./helpers.js";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Disconnected-route shutdown timed out")),
          10000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

it.each(["read-only", "task-admission"] as const)(
  "awaits a disconnected %s HTTP handler before flushing evidence and closing SQLite",
  async (operation) => {
    const f = await fixture();
    const entered = gate();
    const resume = gate();
    const clientAbort = new AbortController();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    let service: ServiceHandle | undefined;
    let closing: Promise<void> | undefined;
    let concurrentClosing: Promise<void> | undefined;
    let routeFinished = false;
    let closeFinished = false;
    let concurrentCloseFinished = false;
    let closedAfterRoute = false;
    let evidenceAtClose: EvidenceRecord[] = [];
    let pendingAtClose: number | undefined;
    try {
      service = await startService(f.config, {
        once: true,
        adapter: f.adapter,
      });
      const s = service;
      const originalClose = s.store.close.bind(s.store);
      const closeSpy = vi.spyOn(s.store, "close").mockImplementation(() => {
        closedAfterRoute = routeFinished;
        evidenceAtClose = s.store.listEvidence(0, 1000);
        pendingAtClose = s.store.evidenceCounts().pending;
        originalClose();
      });
      const initialTasks = s.store.listTasks();
      const initialEvidence = s.store.listEvidence(0, 1000);
      if (operation === "read-only") {
        const health = s.controller.endpointHealth.bind(s.controller);
        vi.spyOn(s.controller, "endpointHealth").mockImplementation(
          async () => {
            entered.release();
            await resume.promise;
            const result = await health();
            routeFinished = true;
            return result;
          },
        );
      } else {
        const addTask = s.controller.addTask.bind(s.controller);
        vi.spyOn(s.controller, "addTask").mockImplementation(
          async (markdown) => {
            entered.release();
            await resume.promise;
            // Commit through the actual controller/Store after the socket closes.
            const result = await addTask(markdown);
            routeFinished = true;
            return result;
          },
        );
      }
      const request = fetch(
        `${s.url}/api/v1/${operation === "read-only" ? "endpoints" : "tasks"}`,
        {
          method: operation === "read-only" ? "GET" : "POST",
          headers: {
            Authorization: `Bearer ${s.token}`,
            "Content-Type": "application/json",
          },
          ...(operation === "task-admission"
            ? {
                body: JSON.stringify({
                  markdown: f.markdown("late-admission"),
                }),
              }
            : {}),
          signal: clientAbort.signal,
        },
      ).then(
        () => ({ name: "UnexpectedResponse" }),
        (error: unknown) => error,
      );
      await bounded(entered.promise);
      clientAbort.abort();
      expect(await bounded(request)).toMatchObject({ name: "AbortError" });
      closing = s.close().then(() => {
        closeFinished = true;
      });
      concurrentClosing = s.close().then(() => {
        concurrentCloseFinished = true;
      });
      // A disconnected socket gives server.close no reason to await the route.
      // Hold its asynchronous work long enough to expose premature DB closure.
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      expect(closeFinished).toBe(false);
      expect(concurrentCloseFinished).toBe(false);
      expect(closeSpy).not.toHaveBeenCalled();
      expect(s.store.listTasks()).toEqual(initialTasks);
      expect(routeFinished).toBe(false);

      resume.release();
      await bounded(closing);
      await bounded(concurrentClosing);
      expect(concurrentCloseFinished).toBe(true);
      expect(closedAfterRoute).toBe(true);
      expect(closeSpy).toHaveBeenCalledOnce();
      expect(pendingAtClose).toBe(0);
      expect(await readFile(join(f.data, "evidence.jsonl"), "utf8")).toBe(
        evidenceAtClose.map((row) => JSON.stringify(row) + "\n").join(""),
      );
      expect(() => s.store.listTasks()).toThrow(/not open/i);

      const reopened = new Store(f.data);
      try {
        expect(reopened.evidenceCounts().pending).toBe(0);
        if (operation === "read-only") {
          expect(reopened.listTasks()).toEqual(initialTasks);
          expect(reopened.listEvidence(0, 1000)).toEqual(initialEvidence);
        } else {
          expect(reopened.getTask("late-admission")).toMatchObject({
            id: "late-admission",
            state: "queued",
          });
          expect(reopened.listAttempts("late-admission")).toEqual([]);
          expect(evidenceAtClose.length).toBeGreaterThan(
            initialEvidence.length,
          );
        }
      } finally {
        reopened.close();
      }
      expect(f.calls).toBe(0);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      clientAbort.abort();
      resume.release();
      if (closing) await bounded(closing).catch(() => {});
      else if (service) await bounded(service.close());
      if (concurrentClosing) await bounded(concurrentClosing).catch(() => {});
      vi.restoreAllMocks();
      process.off("unhandledRejection", onUnhandled);
      await f.cleanup();
    }
  },
  20000,
);
