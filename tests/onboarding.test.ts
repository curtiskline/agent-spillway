import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../src/cli.js";
import { startService, type ServiceHandle } from "../src/server.js";
import type { DoctorReport } from "../src/doctor.js";
import type { HarnessAdapter } from "../src/contracts.js";
import { gitCommand } from "../src/git.js";
import type { PilotManifest } from "../src/pilot.js";
import { fixture } from "./helpers.js";

describe("service-owned onboarding diagnostics", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let service: ServiceHandle;
  beforeEach(async () => {
    f = await fixture();
    service = await startService(f.config, { once: true, adapter: f.adapter });
  });
  afterEach(async () => { await service.close(); await f.cleanup(); });
  async function invoke(args: string[]) {
    const out: string[] = [], err: string[] = [];
    const code = await runCli(["--data-dir", f.data, ...args], {
      out: text => out.push(text), err: text => err.push(text),
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  }
  const snapshot = () => ({
    tasks: service.store.listTasks(),
    jobs: service.store.listQualificationJobs(),
    evidence: service.store.listEvidence(0, 1000),
  });
  it("authenticates diagnostics, skips inference and preserves queue/evidence", async () => {
    const before = snapshot();
    expect((await fetch(service.url + "/api/v1/doctor")).status).toBe(401);
    expect((await fetch(service.url + "/api/v1/doctor", {
      headers: { Authorization: `Bearer ${service.token}`, Origin: "https://foreign.invalid" },
    })).status).toBe(403);
    const handshake = await fetch(service.url + "/?token=" + service.token, { redirect: "manual" });
    const cookie = handshake.headers.get("set-cookie")!.split(";")[0]!;
    const prefix = handshake.headers.get("location")!;
    const browserDiagnostic = await fetch(service.url + prefix + "api/v1/doctor", { headers: { Cookie: cookie } });
    expect(browserDiagnostic.status).toBe(401);
    expect(await browserDiagnostic.text()).not.toContain("Task-class permissions");
    const diagnostic = await invoke(["doctor", "--json"]);
    expect(diagnostic.code).toBe(0);
    const report = JSON.parse(diagnostic.out) as DoctorReport;
    expect(report).toMatchObject({ version: 1, ok: true });
    expect(report.checks.find(check => check.id === "qualification")?.status).toBe("warning");
    expect((await invoke(["doctor"])).out).toContain("Warnings do not certify capability");
    expect(f.calls).toBe(0);
    expect(snapshot()).toEqual(before);
    for (const privateValue of [service.token, f.config.endpoints[0]!.url, f.repo, f.data, f.config.profiles[0]!.model])
      expect(diagnostic.out).not.toContain(privateValue);
  });
  it("reports unavailable catalogs and unresolved execution without starting or reconciling work", async () => {
    f.setHealthy(false);
    const unavailable = await invoke(["doctor", "--json"]);
    expect(unavailable.code).toBe(1);
    expect((JSON.parse(unavailable.out) as DoctorReport).checks).toContainEqual(expect.objectContaining({ id: "catalog", status: "fail" }));
    f.setHealthy(true);
    service.store.createQualificationJob({ id: "diagnostic-job", profileId: "fixture", root: join(f.data, "qualifications", "diagnostic-job") });
    const active = await invoke(["doctor", "--json"]);
    expect(active.code).toBe(0);
    expect((JSON.parse(active.out) as DoctorReport).checks).toContainEqual(expect.objectContaining({ id: "execution", status: "warning" }));
    service.store.finishQualificationJob("diagnostic-job", "uncertain", undefined, "Fixture interruption");
    const before = snapshot();
    const uncertain = await invoke(["doctor", "--json"]);
    expect(uncertain.code).toBe(1);
    expect((JSON.parse(uncertain.out) as DoctorReport).checks).toContainEqual(expect.objectContaining({ id: "recovery", status: "fail" }));
    expect(snapshot()).toEqual(before);
    expect(f.calls).toBe(0);
  });
  it("reports a missing service in plain and JSON forms and rejects malformed arguments", async () => {
    await service.close();
    const before = await readFile(join(f.data, "queue.sqlite"));
    for (const args of [["doctor"], ["doctor", "--json"]]) {
      const diagnostic = await invoke(args);
      expect(diagnostic.code).toBe(1);
      expect(diagnostic.err).toBe("");
      expect(diagnostic.out).toContain("spillway service status");
      expect(diagnostic.out).not.toContain(service.token);
      if (args.length === 2) expect(JSON.parse(diagnostic.out).ok).toBe(false);
    }
    for (const args of [["doctor", "unexpected"], ["doctor", "--json", "--json"], ["pilot"], ["pilot", "create"]])
      expect((await invoke(args)).code).toBe(1);
    expect(await readFile(join(f.data, "queue.sqlite"))).toEqual(before);
  });
});

it("creates pinned pilot tasks through CLI, verifies local results and holds risky work without owner decisions", async () => {
  const f = await fixture();
  let service: ServiceHandle | undefined;
  const invoke = async (args: string[]) => {
    const out: string[] = [], err: string[] = [];
    const code = await runCli(["--data-dir", f.data, ...args], {
      out: text => out.push(text), err: text => err.push(text),
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  try {
    const created = await invoke(["pilot", "create", join(f.root, "pilot")]);
    expect(created.code, created.err).toBe(0);
    const pilot = JSON.parse(created.out) as PilotManifest;
    expect(pilot.tasks).toHaveLength(3);
    expect(pilot.baseSha).toBe((await gitCommand(pilot.repo, ["rev-parse", "HEAD"])).trim());
    f.config.repositories = [{ path: pilot.repo, data_policy: "local-only" }];
    f.config.profiles[0]!.qualified_classes = ["mechanical", "small-fix"];
    f.config.allow_checks_only = false;
    const bindings = structuredClone(f.config.profiles);
    const workers: string[] = [], reviews: string[] = [];
    const adapter: HarnessAdapter = {
      id: "opencode",
      async version() { return "fixture-v1"; },
      async run(input) {
        if (input.purpose === "review") {
          const sha = (await gitCommand(input.worktree, ["rev-parse", "HEAD"])).trim();
          reviews.push(sha);
          return { exit: "completed", summary: JSON.stringify({ resultSha: sha, verdict: "accept", findings: [] }) };
        }
        const greeting = input.prompt.includes("src/greeting.cjs");
        const path = greeting ? "src/greeting.cjs" : "src/slug.cjs";
        expect(input.prompt).not.toContain("src/permission.cjs");
        workers.push(path);
        const source = greeting
          ? "module.exports=name=>{if(typeof name!=='string'||!name.trim())throw new TypeError();return 'Hello, '+name.trim()+'!';};\n"
          : "module.exports=value=>{if(typeof value!=='string')throw new TypeError();return value.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');};\n";
        await writeFile(join(input.worktree, path), source);
        await gitCommand(input.worktree, ["add", "--", path]);
        await gitCommand(input.worktree, ["commit", "-m", "Fixture pilot result"]);
        return { exit: "completed" };
      },
    };
    service = await startService(f.config, { once: true, adapter });
    for (const task of pilot.tasks) {
      const added = await invoke(["add", task.path]);
      expect(added.code, added.err).toBe(0);
      expect(service.store.getTask(task.id)?.spec.base).toBe(pilot.baseSha);
    }
    for (let step = 0; step < 6; step++) await service.controller.runOnce();
    for (const id of ["pilot-greeting", "pilot-slug"]) {
      const detail = service.controller.getDetail(id);
      expect(detail.task.state).toBe("ready");
      expect(detail.task.reviewTier).toBe("local");
      expect(detail.attempts).toHaveLength(1);
      expect(detail.attempts[0]?.verification?.passed).toBe(true);
      expect(detail.reviews?.[0]?.report?.resultSha).toBe(detail.attempts[0]?.resultSha);
    }
    expect(service.store.getTask("pilot-permission")).toMatchObject({ state: "held", nextAction: "frontier-worker", reviewTier: "frontier" });
    expect(service.store.listAttempts("pilot-permission")).toEqual([]);
    expect(workers.sort()).toEqual(["src/greeting.cjs", "src/slug.cjs"]);
    expect(reviews).toHaveLength(2);
    expect(service.store.listDecisions()).toEqual([]);
    expect(service.store.listAudits()).toEqual([]);
    expect(service.store.getFrontierState().available).toBe(false);
    expect(f.config.profiles).toEqual(bindings);
    expect((await gitCommand(pilot.repo, ["rev-parse", "main"])).trim()).toBe(pilot.baseSha);
    expect((await gitCommand(pilot.repo, ["status", "--porcelain"])).trim()).toBe("");
  } finally {
    await service?.close();
    await f.cleanup();
  }
}, 30000);
