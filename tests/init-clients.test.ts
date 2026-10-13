import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import { startService, type ServiceHandle } from "../src/server.js";
import { fixture } from "./helpers.js";

describe("standalone private config CLI", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let service: ServiceHandle | undefined;
  beforeEach(async () => { f = await fixture(); });
  afterEach(async () => { vi.restoreAllMocks(); await service?.close(); service = undefined; await f.cleanup(); });
  async function invoke(args: string[]) {
    const out: string[] = [], err: string[] = [];
    const code = await runCli(args, { out: text => out.push(text), err: text => err.push(text) });
    return { code, out: out.join("\n"), err: err.join("\n") };
  }
  async function input() {
    const path = join(f.root, "initializer.json");
    await writeFile(path, JSON.stringify({ version: 1, repo: f.repo,
      endpoint: { url: f.config.endpoints[0]!.url }, model: "fixture-model",
      model_artifact: "fixture-only", harness_version: "fixture-v1" }), { mode: 0o600 });
    return path;
  }
  it("creates through CLI without a service or network, then boots diagnostics with no class grants", async () => {
    const path = await input(), root = join(f.root, "starter");
    const network = vi.spyOn(globalThis, "fetch");
    const created = await invoke(["init", "--from", path, "--directory", root]);
    expect(created.code, created.err).toBe(0);
    expect(network).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    const receipt = JSON.parse(created.out) as {configPath: string; dataDir: string};
    expect(JSON.parse(created.out)).toEqual({ version: 1, configPath: join(root, "config.yaml"), dataDir: join(root, "data"), profileId: "local", qualifiedClasses: [] });
    for (const value of [f.config.endpoints[0]!.url, "fixture-model", "fixture-only", "fixture-v1"]) expect(created.out).not.toContain(value);
    for (const [path, mode] of [[root, 0o700], [receipt.dataDir, 0o700], [receipt.configPath, 0o600]] as const)
      expect((await lstat(path)).mode & 0o777).toBe(mode);
    const config = await loadConfig(receipt.configPath);
    expect(config.profiles[0]!.qualified_classes).toEqual([]);
    expect(config.allow_checks_only).toBe(false);
    expect(config.repositories).toEqual([{ path: f.repo, data_policy: "local-only" }]);
    expect(f.calls).toBe(0);
    service = await startService({ ...config, port: 0 }, { once: true, adapter: f.adapter });
    const doctor = await invoke(["--config", receipt.configPath, "doctor", "--json"]);
    expect(doctor.code, doctor.err).toBe(0);
    expect(JSON.parse(doctor.out).ok).toBe(true);
    const task = join(f.root, "task.md");
    await writeFile(task, f.markdown("no-implicit-permission", "default"), { mode: 0o600 });
    const denied = await invoke(["--config", receipt.configPath, "add", task]);
    expect(denied.code).toBe(1);
    expect(denied.err).toContain("UNQUALIFIED_CLASS");
    expect(service.store.listTasks()).toEqual([]);
    expect(service.store.getFrontierState().available).toBe(false);
    expect(f.calls).toBe(0);
  });
  it("refuses existing output without changing its config or permissions", async () => {
    const path = await input(), root = join(f.root, "existing");
    const first = await invoke(["init", "--directory", root, "--from", path]);
    expect(first.code, first.err).toBe(0);
    const config = join(root, "config.yaml"), before = await readFile(config);
    const mode = (await lstat(root)).mode;
    const second = await invoke(["init", "--from", path, "--directory", root]);
    expect(second.code).toBe(1);
    expect(await readFile(config)).toEqual(before);
    expect((await lstat(root)).mode).toBe(mode);
  });
  it("rejects ambiguous/invalid arguments before reading input, networking or creating output", async () => {
    const before = await readdir(f.root), network = vi.spyOn(globalThis, "fetch");
    const path = join(f.root, "absent.json"), root = join(f.root, "never-created");
    for (const args of [
      ["init"], ["init", "--from", path],
      ["init", "--from", path, "--from", path],
      ["init", "--other", path, "--directory", root],
      ["init", "--from", "--directory", "--directory", root],
      ["--config", path, "init", "--from", path, "--directory", root],
      ["--data-dir", f.data, "init", "--from", path, "--directory", root],
    ]) {
      const result = await invoke(args);
      expect(result.code).toBe(1);
      expect(result.err).toContain("Use init");
    }
    expect(network).not.toHaveBeenCalled();
    expect(await readdir(f.root)).toEqual(before);
  });
  it("does not echo malformed input or private binding errors", async () => {
    const path = await input(), root = join(f.root, "invalid");
    const secret = "PRIVATE-INITIALIZER-INPUT-MARKER";
    await writeFile(path, JSON.stringify({ version: 1, repo: f.repo, secret }));
    const result = await invoke(["init", "--from", path, "--directory", root]);
    expect(result.code).toBe(1);
    expect(result.out + result.err).not.toContain(secret);
    expect(result.out + result.err).not.toContain(path);
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
