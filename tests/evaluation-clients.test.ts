import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { runCli } from "../src/cli.js";
import { startService, type ServiceHandle } from "../src/server.js";
import { fixture } from "./helpers.js";
import { CAPABILITIES, explainToolEvidence } from "../src/qualification.js";

describe("read-only saved qualification clients", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let service: ServiceHandle;
  beforeEach(async () => {
    f = await fixture();
    service = await startService(f.config, { once: true, adapter: f.adapter });
    service.store.createQualificationJob({ id: "saved-job", profileId: "fixture", root: join(f.data, "qualifications", "saved-job") });
  });
  afterEach(async () => { vi.restoreAllMocks(); await service.close(); await f.cleanup(); });
  async function invoke(args: string[]) {
    const out: string[] = [], err: string[] = [];
    const code = await runCli(["--data-dir", f.data, ...args], { out: text => out.push(text), err: text => err.push(text) });
    return { code, out: out.join("\n"), err: err.join("\n") };
  }
  it("inspects incomplete jobs without inference, queue mutations or credential reflection", async () => {
    const before = { jobs: service.store.listQualificationJobs(), evidence: service.store.listEvidence(0, 1000) };
    const report = await invoke(["qualify", "explain", "saved-job", "--json"]);
    expect(report.code, report.err).toBe(0);
    const parsed = JSON.parse(report.out);
    expect(parsed).toMatchObject({ version: 1, jobId: "saved-job", suiteVersion: null });
    expect(parsed.cases).toHaveLength(7);
    expect(parsed.cases.every((row: {status: string; checks: unknown[]}) => row.status === "not-recorded" && row.checks.length === 0)).toBe(true);
    expect((await invoke(["qualify", "explain", "saved-job"])).out).toContain("Stored results remain unchanged");
    for (const value of [service.token, f.data, f.repo, f.config.endpoints[0]!.url]) expect(report.out).not.toContain(value);
    expect(f.calls).toBe(0);
    expect({ jobs: service.store.listQualificationJobs(), evidence: service.store.listEvidence(0, 1000) }).toEqual(before);
    expect((await invoke(["qualify", "explain", "unknown-job"])).code).toBe(1);
  });
  it("requires explicit bearer authentication including dashboard aliases", async () => {
    const path = "api/v1/qualifications/saved-job/diagnostics";
    expect((await fetch(service.url + "/" + path)).status).toBe(401);
    const handshake = await fetch(service.url + "/?token=" + service.token, { redirect: "manual" });
    const prefix = handshake.headers.get("location")!;
    const cookie = handshake.headers.get("set-cookie")!.split(";")[0]!;
    expect((await fetch(service.url + prefix + path, { headers: { Cookie: cookie } })).status).toBe(401);
    expect((await fetch(service.url + prefix + path, { headers: { Authorization: `Bearer ${service.token}` } })).status).toBe(200);
    expect((await fetch(service.url + "/" + path, { headers: { Authorization: `Bearer ${service.token}`, Origin: "https://foreign.invalid" } })).status).toBe(403);
  });
  it("rejects malformed or misbound service diagnostics without reflecting response text", async () => {
    const emptyCases = CAPABILITIES.map(capability => ({ capability, status: "not-recorded", checks: [] }));
    for (const data of [
      { version: 1, jobId: "saved-job", suiteVersion: null, cases: [], secret: "PRIVATE-RESPONSE-TEXT" },
      { version: 1, jobId: "other-job", suiteVersion: null, cases: emptyCases },
      { version: 1, jobId: "saved-job", suiteVersion: null, cases: emptyCases.map((row, index) => index === 0 ? { ...row, status: "available", checks: explainToolEvidence("", row.capability).checks } : row) },
      { version: 1, jobId: "saved-job", suiteVersion: 3, cases: [{ capability: "command", status: "available", checks: [{ id: "command-success", met: false, message: "PRIVATE-RESPONSE-TEXT" }] }] },
    ]) {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ data }), { status: 200, headers: { "Content-Type": "application/json" } }));
      const result = await invoke(["qualify", "explain", "saved-job", "--json"]);
      expect(result.code).toBe(1);
      expect(result.out + result.err).not.toContain("PRIVATE-RESPONSE-TEXT");
      vi.restoreAllMocks();
    }
  });
  it("renders declared measurement limits and owner outcomes in the authenticated scorecard", async () => {
    await service.controller.addTask(f.markdown("ordinary-spec"));
    const response = await fetch(service.url + "/scorecard", { headers: { Authorization: `Bearer ${service.token}` } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Declared task measurements");
    expect(html).toContain("1,024 bytes");
    expect(html).toContain("Insufficient sample");
    expect(html).not.toContain(service.token);
    expect(f.calls).toBe(0);
  });
  it("validates explain arguments before requiring a running service", async () => {
    await service.close();
    for (const args of [["qualify", "explain"], ["qualify", "explain", "../escape"], ["qualify", "explain", "saved-job", "--other"], ["qualify", "explain", "saved-job", "--json", "--json"]]) {
      const result = await invoke(args);
      expect(result.code).toBe(1);
      expect(result.err).not.toContain("service_unavailable");
    }
  });
});
