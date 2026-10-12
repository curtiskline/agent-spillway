import { expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../src/cli.js";
import { startService } from "../src/server.js";
import { fixture } from "./helpers.js";

it("routes report, audit, planning, publication and qualification through the installed-style thin CLI", async () => {
  const f = await fixture();
  f.config.audit_rate = 1;
  const service = await startService(f.config, {
    once: true,
    adapter: f.adapter,
  });
  const invoke = async (args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(["--data-dir", f.data, ...args], {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  try {
    await service.controller.addTask(f.markdown("cli-pilot"));
    await service.controller.runOnce();
    const usage = join(f.root, "usage.json");
    await writeFile(usage, JSON.stringify({ inputTokens: 10, costUsd: 0 }));
    expect((await invoke(["usage", "cli-pilot", "--file", usage])).code).toBe(
      0,
    );
    expect(
      (await invoke(["accept", "cli-pilot", "--owner-minutes", "1.5"])).code,
    ).toBe(0);
    const report = await invoke(["report"]);
    expect(report.code).toBe(0);
    expect(report.out).toContain("accepted 1");
    expect(report.out).toContain("1.5 reported");
    expect(report.out).toContain("local review usage is excluded");
    const json = await invoke(["report", "--json"]);
    expect(JSON.parse(json.out).tasks.acceptedWhileFrontierOff.yes).toBe(1);
    const audits = await invoke(["audit", "list"]);
    const audit = JSON.parse(audits.out)[0];
    expect(audit.held).toBe(true);
    expect((await invoke(["audit", "show", String(audit.id)])).code).toBe(1);
    const denied = await invoke([
      "export",
      "--sanitized",
      "--repo",
      "https://github.com/public/pilot",
    ]);
    expect(denied.code).toBe(1);
    expect(denied.out).toBe("");
    const bad = join(f.root, "metadata.json");
    await writeFile(bad, "{}");
    expect(
      (await invoke(["qualify", "--profile", "fixture", "--metadata", bad]))
        .code,
    ).toBe(1);
    expect(service.store.listQualificationJobs()).toHaveLength(0);
    expect((await invoke(["qualify", "list"])).out).toBe("[]");
    const admission = await invoke(["qualify", "--profile", "fixture"]);
    expect(admission.code).toBe(0);
    const jobId: string = JSON.parse(admission.out).job.id;
    expect(service.store.getQualificationJob(jobId)).toBeDefined();
    await vi.waitFor(() => {
      expect(service.store.getQualificationJob(jobId)?.status).toBe("completed");
    }, { timeout: 15000, interval: 100 });
    const completed = await invoke(["qualify", "show", jobId]);
    expect(completed.code).toBe(0);
    expect(JSON.parse(completed.out)).toMatchObject({
      job: { id: jobId, status: "completed" },
      result: { provenance: "fixture", qualified: false },
    });
    const view = await fetch(`${service.url}/qualifications/${jobId}`, {
      headers: { Authorization: `Bearer ${service.token}` },
    });
    expect(view.status).toBe(200);
    const html = await view.text();
    expect(html).toContain("Observational result; model is not qualified.");
    expect(html).toContain("read-only");
    expect(html).not.toContain(f.config.endpoints[0]!.url);
    expect(html).not.toContain(f.data);
    expect(html).not.toContain("<form");
    expect(
      (await invoke(["accept", "cli-pilot", "--owner-minutes", "Infinity"]))
        .code,
    ).toBe(1);
    expect((await invoke(["audit", "submit", "1", "--file", bad])).code).toBe(
      1,
    );
  } finally {
    await service.close();
    await f.cleanup();
  }
}, 30000);

it("serves escaped read-only scorecard, audit and endpoint views without exposing endpoint addresses", async () => {
  const f = await fixture();
  f.config.audit_rate = 0;
  const service = await startService(f.config, {
    once: true,
    adapter: f.adapter,
  });
  try {
    await service.controller.addTask(f.markdown("view-pilot"));
    await service.controller.runOnce();
    await service.controller.decide("view-pilot", "accepted", 0);
    const handshake = await fetch(`${service.url}/?token=${service.token}`, {
      redirect: "manual",
    });
    const cookie = handshake.headers.get("set-cookie")!.split(";")[0]!;
    const prefix = handshake.headers.get("location")!;
    for (const path of ["scorecard", "audits", "endpoints", "qualifications"]) {
      const response = await fetch(service.url + prefix + path, {
        headers: { Cookie: cookie },
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).not.toContain(f.config.endpoints[0]!.url);
      expect(html).not.toContain("<form");
      expect(html).toContain("read-only");
    }
    const unauthorized = await fetch(service.url + "/api/v1/report");
    expect(unauthorized.status).toBe(401);
    const mutation = await fetch(
      service.url + prefix + "api/v1/evidence/sync",
      { method: "POST", headers: { Cookie: cookie } },
    );
    expect(mutation.status).toBe(401);
    const status = await fetch(service.url + "/api/v1/evidence", {
      headers: { Authorization: `Bearer ${service.token}` },
    });
    expect((await status.json()).data.pending).toBe(0);
  } finally {
    await service.close();
    await f.cleanup();
  }
}, 30000);
