import { describe, it, expect } from "vitest";
import { startService } from "../src/server.js";
import { fixture } from "./helpers.js";
import { readFile, writeFile, symlink, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { request } from "node:http";

describe("authenticated loopback API and dashboard", () => {
  it("authenticates APIs and browser session; rejects foreign Origin/Host and keeps dashboard read-only", async () => {
    const f = await fixture();
    const s = await startService(f.config, { once: true, adapter: f.adapter });
    const headers = {
      Authorization: `Bearer ${s.token}`,
      "Content-Type": "application/json",
    };
    try {
      expect((await fetch(`${s.url}/api/v1/tasks`)).status).toBe(401);
      expect(
        (
          await fetch(`${s.url}/api/v1/status`, {
            headers: { ...headers, Origin: "https://evil.invalid" },
          })
        ).status,
      ).toBe(403);
      const hostStatus = await new Promise<number | undefined>(
        (resolve, reject) => {
          const req = request(
            `${s.url}/api/v1/status`,
            { headers: { ...headers, Host: "evil.invalid" } },
            (res) => {
              res.resume();
              resolve(res.statusCode);
            },
          );
          req.on("error", reject);
          req.end();
        },
      );
      expect(hostStatus).toBe(403);
      const bank = await fetch(`${s.url}/api/v1/tasks`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          markdown: f
            .markdown()
            .replace("Return hello", "<script>alert(1)</script> Return hello"),
        }),
      });
      expect(bank.status).toBe(201);
      const login = await fetch(`${s.url}/?token=${s.token}`, {
        redirect: "manual",
      });
      expect(login.status).toBe(303);
      const prefix = login.headers.get("location")!;
      expect(prefix).toMatch(/^\/view\/[0-9a-f]{64}\/$/);
      expect(login.headers.get("set-cookie")).toContain(`Path=${prefix}`);
      expect(login.headers.get("set-cookie")).toContain("HttpOnly");
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const dashboard = await fetch(`${s.url}${prefix}tasks/hello`, {
        headers: { Cookie: cookie },
      });
      expect(dashboard.status).toBe(200);
      const html = await dashboard.text();
      expect(html).toContain("&lt;script&gt;");
      expect(html).not.toContain("<script>");
      expect(html).not.toContain(s.token);
      expect(
        (await fetch(`${s.url}/api/v1/tasks`, { headers: { Cookie: cookie } }))
          .status,
      ).toBe(401);
      expect(
        (
          await fetch(`${s.url}/view/wrong/tasks/hello`, {
            headers: { Cookie: cookie },
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await fetch(`${s.url}/api/v1/run`, {
            method: "POST",
            headers: { Cookie: cookie },
          })
        ).status,
      ).toBe(401);
      const run = await fetch(`${s.url}/api/v1/run`, {
        method: "POST",
        headers,
      });
      expect((await run.json()).data.taskId).toBe("hello");
      const result = await fetch(`${s.url}/api/v1/tasks/hello/result`, {
        headers,
      });
      expect((await result.json()).data.verification.passed).toBe(true);
      const descriptor = JSON.parse(
        await readFile(join(f.data, "service.json"), "utf8"),
      );
      expect(descriptor.url).toBe(s.url);
      await expect(startService(f.config, { once: true })).rejects.toThrow(
        "already running",
      );
    } finally {
      await s.close();
      await f.cleanup();
    }
  }, 20000);
  it("validates requests and limits artifact reads to stored managed files", async () => {
    const f = await fixture();
    const s = await startService(f.config, { once: true, adapter: f.adapter });
    const headers = {
      Authorization: `Bearer ${s.token}`,
      "Content-Type": "application/json",
    };
    try {
      expect(
        (
          await fetch(`${s.url}/api/v1/tasks`, {
            method: "POST",
            headers,
            body: "{",
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await fetch(`${s.url}/api/v1/tasks`, {
            method: "POST",
            headers,
            body: JSON.stringify({ markdown: f.markdown(), extra: true }),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await fetch(`${s.url}/api/v1/tasks`, {
            method: "POST",
            headers,
            body: JSON.stringify({ markdown: "x".repeat(310 * 1024) }),
          })
        ).status,
      ).toBe(413);
      expect(
        (await fetch(`${s.url}/api/v1/tasks/missing`, { headers })).status,
      ).toBe(404);
      await s.controller.addTask(f.markdown());
      await s.controller.runOnce();
      const attempt = s.store.listAttempts("hello")[0]!;
      expect(
        (
          await fetch(`${s.url}/api/v1/artifacts/${attempt.id}/report.json`, {
            headers,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await fetch(`${s.url}/api/v1/artifacts/${attempt.id}/prompt.md`, {
            headers,
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await fetch(`${s.url}/api/v1/artifacts/${attempt.id}/queue.sqlite`, {
            headers,
          })
        ).status,
      ).toBe(404);
      const outside = join(f.root, "private.txt");
      await writeFile(outside, "secret");
      // Stored allowlist does not grant access through a substituted symlink.
      const { unlink } = await import("node:fs/promises");
      await unlink(attempt.reportPath!);
      await symlink(outside, attempt.reportPath!);
      expect(
        (
          await fetch(`${s.url}/api/v1/artifacts/${attempt.id}/report.json`, {
            headers,
          })
        ).status,
      ).toBe(403);
      const directory = join(f.data, "artifacts", String(attempt.id));
      await rename(directory, `${directory}-preserved`);
      const outsideDir = join(f.root, "outside");
      await mkdir(outsideDir);
      await writeFile(join(outsideDir, "report.json"), "PRIVATE OUTSIDE");
      await symlink(outsideDir, directory);
      expect(
        (
          await fetch(`${s.url}/api/v1/artifacts/${attempt.id}/report.json`, {
            headers,
          })
        ).status,
      ).toBe(403);
    } finally {
      await s.close();
      await f.cleanup();
    }
  }, 20000);
});
