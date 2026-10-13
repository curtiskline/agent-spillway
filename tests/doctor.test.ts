import { createServer, type Server, type RequestListener } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VERSION, type HarnessAdapter, type SpillwayConfig } from "../src/contracts.js";
import { OpenCodeAdapter } from "../src/harness.js";
import { buildDoctorReport, formatDoctorReport, type DoctorInput, type DoctorReport } from "../src/doctor.js";

const privateText = "synthetic-secret http://private.invalid/v1 /private/config 8.9.10 private-model";
describe("service-owned read-only diagnostics (fixture catalogs only)", () => {
  const servers: Server[] = [];
  const roots: string[] = [];
  let config: SpillwayConfig;
  let adapter: HarnessAdapter;
  beforeEach(() => {
    config = {
      version: 1,
      data_dir: "/private/fixture-state",
      port: 7433,
      poll_interval_ms: 5000,
      repositories: [{ path: "/private/fixture-repository", data_policy: "local-only" }],
      endpoints: [],
      profiles: [{ id: "private-profile", endpoint: "fixture", model: "private-model",
        model_artifact: "fixture-only", harness: "opencode", harness_version: "1.2.3",
        qualified_classes: ["small-fix"] }],
      default_profile: "private-profile",
      allow_checks_only: false,
    };
    adapter = { id: "opencode", version: vi.fn(async () => "1.2.3"),
      run: vi.fn(async () => { throw new Error("Inference must never run"); }) };
  });
  afterEach(async () => {
    vi.useRealTimers();
    delete process.env.SPILLWAY_DOCTOR_FIXTURE_KEY;
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });
  async function catalog(handler?: RequestListener): Promise<string> {
    const server = createServer(handler ?? ((_request, response) => {
      response.end(JSON.stringify({ data: [{ id: "private-model" }] }));
    }));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    return `http://127.0.0.1:${address.port}/v1`;
  }
  function input(overrides: Partial<DoctorInput> = {}): DoctorInput {
    return { config, adapter, busy: false, uncertain: false,
      evidence: { pending: 0, delivered: 2, lastError: null }, ...overrides };
  }
  function status(report: DoctorReport, id: string) {
    return report.checks.find((row) => row.id === id)?.status;
  }
  it("checks an actual local HTTP catalog once per profile and an exact harness version once without inference or mutation", async () => {
    const requests: { method: string | undefined; path: string | undefined }[] = [];
    config.endpoints = [{ id: "fixture", kind: "local", url: await catalog((request, response) => {
      requests.push({ method: request.method, path: request.url });
      response.end(JSON.stringify({ data: [{ id: "private-model" }, { id: "second-model" }] }));
    }) }];
    config.profiles.push({ ...config.profiles[0]!, id: "second-profile", model: "second-model" });
    const before = JSON.stringify(config);
    const report = await buildDoctorReport(input());
    expect(report).toMatchObject({ version: 1, serviceVersion: VERSION, ok: true });
    expect(report.checks.map((row) => row.id)).toEqual([
      "service", "execution", "recovery", "evidence", "harness", "catalog", "qualification",
    ]);
    expect(status(report, "harness")).toBe("pass");
    expect(status(report, "catalog")).toBe("pass");
    expect(status(report, "qualification")).toBe("warning");
    expect(adapter.version).toHaveBeenCalledTimes(1);
    expect(adapter.run).not.toHaveBeenCalled();
    expect(requests).toEqual([{ method: "GET", path: "/v1/models" }, { method: "GET", path: "/v1/models" }]);
    expect(JSON.stringify(config)).toBe(before);
    const output = JSON.stringify(report) + formatDoctorReport(report);
    for (const value of ["private-model", "second-model", "private-profile", "second-profile", config.data_dir, config.endpoints[0]!.url, "1.2.3"])
      expect(output).not.toContain(value);
    expect(report.checks.every((row) => !("profileId" in row))).toBe(true);
  });
  it("warns for active execution and pending evidence while failing unresolved execution and evidence errors", async () => {
    config.endpoints = [{ id: "fixture", kind: "local", url: await catalog() }];
    const warning = await buildDoctorReport(input({ busy: true, evidence: { pending: 2, delivered: 0, lastError: null } }));
    expect(warning.ok).toBe(true);
    expect(status(warning, "execution")).toBe("warning");
    expect(status(warning, "evidence")).toBe("warning");
    const failed = await buildDoctorReport(input({ uncertain: true,
      evidence: { pending: 1, delivered: 0, lastError: privateText } }));
    expect(failed.ok).toBe(false);
    expect(status(failed, "recovery")).toBe("fail");
    expect(status(failed, "evidence")).toBe("fail");
    expect(JSON.stringify(failed) + formatDoctorReport(failed)).not.toContain(privateText);
    expect(adapter.run).not.toHaveBeenCalled();
  });
  it("fails if any profile has a version mismatch or uses a different harness identity without exposing returned versions", async () => {
    config.endpoints = [{ id: "fixture", kind: "local", url: await catalog() }];
    config.profiles.push({ ...config.profiles[0]!, id: "different-profile", harness_version: "8.9.10" });
    const mismatch = await buildDoctorReport(input());
    expect(status(mismatch, "harness")).toBe("fail");
    expect(mismatch.ok).toBe(false);
    expect(JSON.stringify(mismatch) + formatDoctorReport(mismatch)).not.toContain("8.9.10");
    config.profiles.pop();
    adapter.id = "different-harness";
    expect(status(await buildDoctorReport(input()), "harness")).toBe("fail");
    adapter.id = "opencode";
    adapter.version = vi.fn(async () => privateText);
    const unsafe = await buildDoctorReport(input());
    expect(status(unsafe, "harness")).toBe("fail");
    expect(JSON.stringify(unsafe) + formatDoctorReport(unsafe)).not.toContain(privateText);
    expect(adapter.run).not.toHaveBeenCalled();
  });
  it("contains a malicious adapter failure without exposing errors", async () => {
    config.endpoints = [{ id: "fixture", kind: "local", url: await catalog() }];
    adapter.version = vi.fn(async () => { throw new Error(privateText); });
    const report = await buildDoctorReport(input());
    expect(report.ok).toBe(false);
    expect(status(report, "harness")).toBe("fail");
    expect(JSON.stringify(report) + formatDoctorReport(report)).not.toContain(privateText);
    expect(adapter.version).toHaveBeenCalledTimes(1);
    expect(adapter.run).not.toHaveBeenCalled();
  });
  it("reports a genuinely unavailable binary using the production version inspector without invoking inference", async () => {
    const root = await mkdtemp(join(tmpdir(), "spillway-doctor-"));
    roots.push(root);
    config.endpoints = [{ id: "fixture", kind: "local", url: await catalog() }];
    const unavailable = new OpenCodeAdapter(join(root, "missing-binary"));
    const run = vi.spyOn(unavailable, "run");
    const report = await buildDoctorReport(input({ adapter: unavailable }));
    expect(status(report, "harness")).toBe("fail");
    expect(report.ok).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(JSON.stringify(report) + formatDoctorReport(report)).not.toContain(root);
  });
  it.each(["missing", "malformed", "unavailable"])("fails the local catalog for %s responses", async (kind) => {
    config.endpoints = [{ id: "fixture", kind: "local", url: await catalog((_request, response) => {
      if (kind === "unavailable") response.statusCode = 503;
      response.end(kind === "missing" ? JSON.stringify({ data: [{ id: "wrong-model" }] }) : privateText);
    }) }];
    const report = await buildDoctorReport(input());
    expect(report.ok).toBe(false);
    expect(status(report, "catalog")).toBe("fail");
    expect(JSON.stringify(report) + formatDoctorReport(report)).not.toContain(privateText);
    expect(adapter.run).not.toHaveBeenCalled();
  });
  it("fails when one local model is absent even if another profile passes", async () => {
    config.endpoints = [{ id: "fixture", kind: "local", url: await catalog() }];
    config.profiles.push({ ...config.profiles[0]!, id: "missing-profile", model: "missing-model" });
    const report = await buildDoctorReport(input());
    expect(report.ok).toBe(false);
    expect(status(report, "catalog")).toBe("fail");
    expect(status(report, "harness")).toBe("pass");
    expect(adapter.version).toHaveBeenCalledTimes(1);
    expect(adapter.run).not.toHaveBeenCalled();
  });
  it("fails a hanging local catalog within the existing probe deadline", async () => {
    config.endpoints = [{ id: "fixture", kind: "local", url: await catalog(() => {}) }];
    const report = await buildDoctorReport(input());
    expect(report.ok).toBe(false);
    expect(status(report, "catalog")).toBe("fail");
    expect(adapter.run).not.toHaveBeenCalled();
  }, 5000);
  it("does not follow local catalog redirects", async () => {
    let redirected = 0;
    const destination = await catalog((_request, response) => { redirected++; response.end("{}"); });
    config.endpoints = [{ id: "fixture", kind: "local", url: await catalog((_request, response) => {
      response.writeHead(302, { Location: destination + "/models" }); response.end();
    }) }];
    expect(status(await buildDoctorReport(input()), "catalog")).toBe("fail");
    expect(redirected).toBe(0);
  });
  it("uses only an explicitly configured local credential reference and never returns its value", async () => {
    process.env.SPILLWAY_DOCTOR_FIXTURE_KEY = "synthetic-doctor-fixture-key";
    let authenticated = false;
    config.endpoints = [{ id: "fixture", kind: "local", api_key_env: "SPILLWAY_DOCTOR_FIXTURE_KEY",
      url: await catalog((request, response) => {
        authenticated = request.headers.authorization === "Bearer synthetic-doctor-fixture-key";
        response.end(JSON.stringify({ data: [{ id: "private-model" }] }));
      }) }];
    const report = await buildDoctorReport(input());
    expect(authenticated).toBe(true);
    expect(report.ok).toBe(true);
    expect(JSON.stringify(report) + formatDoctorReport(report)).not.toContain("synthetic-doctor-fixture-key");
    expect(adapter.run).not.toHaveBeenCalled();
  });
  it("skips hosted and frontier catalogs including their credential references", async () => {
    let requests = 0;
    const url = await catalog((_request, response) => { requests++; response.end("{}"); });
    config.endpoints = [{ id: "hosted", kind: "open-weight-hosted", url, api_key_env: "SPILLWAY_DOCTOR_UNAVAILABLE_KEY" },
      { id: "frontier", kind: "frontier", url, api_key_file: "/private/missing-secret-file" }];
    config.profiles = [ { ...config.profiles[0]!, endpoint: "hosted" },
      { ...config.profiles[0]!, id: "frontier-profile", endpoint: "frontier" } ];
    const report = await buildDoctorReport(input());
    expect(report.ok).toBe(true);
    expect(status(report, "catalog")).toBe("warning");
    expect(requests).toBe(0);
    expect(adapter.run).not.toHaveBeenCalled();
  });
  it("does not apply adapter version bindings to owner-session frontier profiles", async () => {
    config.endpoints = [{ id: "fixture", kind: "local", url: await catalog() },
      { id: "frontier", kind: "frontier", url: "https://private.invalid/v1" }];
    config.profiles.push({ ...config.profiles[0]!, id: "frontier-profile", endpoint: "frontier", harness_version: "owner-session-version" });
    const mixed = await buildDoctorReport(input());
    expect(mixed.ok).toBe(true);
    expect(status(mixed, "harness")).toBe("pass");
    config.profiles.shift();
    adapter.version = vi.fn(async () => { throw new Error(privateText); });
    const frontierOnly = await buildDoctorReport(input());
    expect(frontierOnly.ok).toBe(true);
    expect(status(frontierOnly, "harness")).toBe("warning");
    expect(status(frontierOnly, "catalog")).toBe("warning");
    expect(adapter.version).not.toHaveBeenCalled();
    expect(adapter.run).not.toHaveBeenCalled();
  });
  it("retains exact harness checks for hosted workers while skipping their catalogs", async () => {
    config.endpoints = [{ id: "fixture", kind: "open-weight-hosted", url: "https://private.invalid/v1" }];
    config.profiles[0]!.harness_version = "different-version";
    const report = await buildDoctorReport(input());
    expect(report.ok).toBe(false);
    expect(status(report, "harness")).toBe("fail");
    expect(status(report, "catalog")).toBe("warning");
    expect(adapter.run).not.toHaveBeenCalled();
  });
  it("warns for skipped destinations while still failing any configured local model that is absent", async () => {
    config.endpoints = [{ id: "fixture", kind: "local", url: await catalog((_request, response) => response.end('{"data":[]}')) },
      { id: "hosted", kind: "open-weight-hosted", url: "https://private.invalid/v1" }];
    config.profiles.push({ ...config.profiles[0]!, id: "hosted-profile", endpoint: "hosted" });
    expect(status(await buildDoctorReport(input()), "catalog")).toBe("fail");
    config.profiles.shift();
    expect(status(await buildDoctorReport(input()), "catalog")).toBe("warning");
  });
  it("bounds a stalled version lookup and consumes late rejection", async () => {
    vi.useFakeTimers();
    config.endpoints = [{ id: "fixture", kind: "open-weight-hosted", url: "https://private.invalid/v1" }];
    let reject: ((error: Error) => void) | undefined;
    adapter.version = vi.fn(() => new Promise<string>((_resolve, fail) => { reject = fail; }));
    const pending = buildDoctorReport(input());
    await vi.advanceTimersByTimeAsync(10_000);
    const report = await pending;
    expect(status(report, "harness")).toBe("fail");
    expect(adapter.version).toHaveBeenCalledTimes(1);
    expect(adapter.run).not.toHaveBeenCalled();
    reject?.(new Error(privateText));
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("formats only fixed messages even if response text or optional identifiers contain private data", async () => {
    config.endpoints = [{ id: "fixture", kind: "local", url: await catalog() }];
    const report = await buildDoctorReport(input());
    const altered: DoctorReport = { ...report, serviceVersion: privateText,
      checks: report.checks.map((row) => ({ ...row, message: privateText, profileId: privateText })) };
    const output = formatDoctorReport(altered);
    expect(output).not.toContain(privateText);
    expect(output).toContain("Warnings do not certify capability.");
    expect(output).toContain("Task-class permissions are operator assertions.");
  });
  it("formats closed service failure guidance for the unavailable-service CLI path", () => {
    const output = formatDoctorReport({ version: 1, serviceVersion: privateText, ok: false,
      checks: [{ id: "service", status: "fail", message: privateText }] });
    expect(output).not.toContain(privateText);
    expect(output).toContain("Check private configuration");
    expect(output).toContain("spillway service status");
    expect(output).toContain("Diagnostic failures require attention.");
  });
});
