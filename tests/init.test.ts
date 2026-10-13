import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "yaml";
import { initializeConfig } from "../src/init.js";
import { planConfig } from "../src/config.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, mkdir: vi.fn(actual.mkdir), open: vi.fn(actual.open) };
});
const marker = "synthetic-private-input-marker";
describe("exclusive private config initialization (no providers or services)", () => {
  let home: string, repo: string, inputPath: string, destination: string;
  let original: typeof fs;
  beforeEach(async () => {
    original = await vi.importActual<typeof fs>("node:fs/promises");
    vi.mocked(fs.mkdir).mockImplementation(original.mkdir);
    vi.mocked(fs.open).mockImplementation(original.open);
    home = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "spillway-init-")));
    await fs.chmod(home, 0o700);
    repo = join(home, "repo");
    await fs.mkdir(repo);
    execFileSync("git", ["init", "-q", "--template=", repo], { env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
    inputPath = join(home, "input.json");
    destination = join(home, "new-private");
    await input();
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No network requested"); }));
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.mocked(fs.mkdir).mockImplementation(original.mkdir);
    vi.mocked(fs.open).mockImplementation(original.open);
    delete process.env.SPILLWAY_INIT_TEST_KEY;
    await fs.rm(home, { recursive: true, force: true });
  });
  const values = () => ({ version: 1, repo, endpoint: { url: "http://127.0.0.1:1234/v1" },
    model: marker, model_artifact: "fixture-artifact", harness_version: "1.2.3" });
  async function input(value: unknown = values()) {
    await fs.writeFile(inputPath, JSON.stringify(value), { mode: 0o600 });
  }
  const initialize = () => initializeConfig({ inputPath, root: destination });
  async function absent(path = destination) {
    await expect(fs.lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  }
  it("creates a loadable exact starter and fixed receipt with empty permissions and private modes", async () => {
    const beforeInput = await fs.readFile(inputPath);
    const repoBefore = await fs.readdir(repo);
    const receipt = await initialize();
    expect(receipt).toEqual({ version: 1, configPath: join(destination, "config.yaml"), dataDir: join(destination, "data"), profileId: "local", qualifiedClasses: [] });
    expect(JSON.stringify(receipt)).not.toContain(marker);
    expect(await fs.readdir(destination)).toEqual(["config.yaml", "data"]);
    expect(await fs.readdir(receipt.dataDir)).toEqual([]);
    expect((await fs.lstat(destination)).mode & 0o777).toBe(0o700);
    expect((await fs.lstat(receipt.dataDir)).mode & 0o777).toBe(0o700);
    expect((await fs.lstat(receipt.configPath)).mode & 0o777).toBe(0o600);
    const written = parse(await fs.readFile(receipt.configPath, "utf8"));
    expect(written).toEqual({ version: 1, data_dir: receipt.dataDir,
      repositories: [{ path: repo, data_policy: "local-only" }],
      endpoints: [{ id: "local", kind: "local", url: values().endpoint.url }],
      profiles: [{ id: "local", endpoint: "local", model: marker, model_artifact: "fixture-artifact", harness: "opencode", harness_version: "1.2.3", qualified_classes: [] }],
      default_profile: "local", allow_checks_only: false, port: 7433, poll_interval_ms: 5000, audit_rate: 0.3 });
    expect((await planConfig(written)).profiles[0]!.qualified_classes).toEqual([]);
    expect(await fs.readFile(inputPath)).toEqual(beforeInput);
    expect(await fs.readdir(repo)).toEqual(repoBefore);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("validates explicit env and private-file references without reading credentials or copying their values", async () => {
    process.env.SPILLWAY_INIT_TEST_KEY = "fixture-environment-value";
    const key = join(home, "key"); await fs.writeFile(key, "fixture-file-value", { mode: 0o600 });
    for (const reference of [{ api_key_env: "SPILLWAY_INIT_TEST_KEY" }, { api_key_file: key }]) {
      destination += "-next";
      await input({ ...values(), port: 8123, endpoint: { ...values().endpoint, ...reference } });
      const receipt = await initialize();
      const content = await fs.readFile(receipt.configPath, "utf8");
      expect(content).not.toMatch(/fixture-environment-value|fixture-file-value/);
      expect(parse(content).endpoints[0]).toMatchObject(reference);
      expect(parse(content).port).toBe(8123);
      expect(vi.mocked(fs.open).mock.calls.some(([path]) => path === key)).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    }
  });
  it.each(["directory", "file", "symlink"])("refuses existing %s roots without modifying them", async (kind) => {
    const foreign = join(home, "foreign"); await fs.mkdir(foreign, { mode: 0o755 });
    await fs.writeFile(join(foreign, "sentinel"), marker);
    if (kind === "directory") { await fs.mkdir(destination, { mode: 0o755 }); await fs.writeFile(join(destination, "sentinel"), marker); }
    else if (kind === "file") await fs.writeFile(destination, marker, { mode: 0o644 });
    else await fs.symlink(foreign, destination);
    const before = await fs.lstat(destination);
    await expect(initialize()).rejects.toMatchObject({ code: "INIT_EXISTS" });
    const after = await fs.lstat(destination);
    expect([after.ino, after.mode]).toEqual([before.ino, before.mode]);
    expect(await fs.readFile(join(foreign, "sentinel"), "utf8")).toBe(marker);
  });
  it.each(["normal", "bare"])("refuses input and destination parents in %s Git repositories", async (kind) => {
    const other = join(home, "git-root"); await fs.mkdir(other, { mode: 0o700 });
    execFileSync("git", ["init", "-q", ...(kind === "bare" ? ["--bare"] : []), other]);
    const goodInput = inputPath;
    inputPath = join(other, "input.json"); await input();
    await expect(initialize()).rejects.toThrow(); await absent();
    inputPath = goodInput; destination = join(other, "private");
    await expect(initialize()).rejects.toThrow(); await absent();
  });
  it("refuses missing, symlinked, noncanonical and writable destination parents", async () => {
    const safe = destination;
    for (const root of [join(home, "missing", "child"), join(repo, "child")]) {
      destination = root; await expect(initialize()).rejects.toThrow(); await absent();
    }
    const alias = join(home, "alias"); await fs.symlink(home, alias);
    destination = join(alias, "child"); await expect(initialize()).rejects.toThrow(); await absent();
    destination = safe; await fs.chmod(home, 0o777);
    await expect(initialize()).rejects.toThrow(); await absent();
    expect((await fs.lstat(home)).mode & 0o777).toBe(0o777);
  });
  it.each(["mode", "hardlink", "symlink", "parent", "oversize", "utf8"])("refuses unsafe private input: %s", async (kind) => {
    if (kind === "mode") await fs.chmod(inputPath, 0o644);
    if (kind === "hardlink") await fs.link(inputPath, join(home, "input-hardlink"));
    if (kind === "symlink") { await fs.rename(inputPath, join(home, "original")); await fs.symlink(join(home, "original"), inputPath); }
    if (kind === "parent") await fs.chmod(home, 0o755);
    if (kind === "oversize") await fs.writeFile(inputPath, "x".repeat(256 * 1024 + 1));
    if (kind === "utf8") await fs.writeFile(inputPath, Buffer.from([0xc3, 0x28]));
    await expect(initialize()).rejects.toThrow(); await absent();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["unknown", "duplicate", "escaped-duplicate", "literal-key", "dual-ref", "invalid-url", "empty", "port", "truncated", "version"])("rejects invalid input %s before any writes with safe errors", async (kind) => {
    const initial = values();
    if (kind === "unknown") await input({ ...initial, [marker]: marker });
    if (kind === "duplicate") await fs.writeFile(inputPath, JSON.stringify(initial).replace('"version":1', '"version":1,"version":1'));
    if (kind === "escaped-duplicate") await fs.writeFile(inputPath, JSON.stringify(initial).replace('"version":1', '"version":1,"vers\\u0069on":1'));
    if (kind === "literal-key") await input({ ...initial, endpoint: { ...initial.endpoint, api_key: marker } });
    if (kind === "dual-ref") await input({ ...initial, endpoint: { ...initial.endpoint, api_key_env: marker, api_key_file: marker } });
    if (kind === "invalid-url") await input({ ...initial, endpoint: { url: "https://user:" + marker + "@example.invalid/v1" } });
    if (kind === "empty") await input({ ...initial, model: " " });
    if (kind === "port") await input({ ...initial, port: 0 });
    if (kind === "truncated") await fs.writeFile(inputPath, '{"version":1');
    if (kind === "version") await input({ ...initial, version: 2 });
    const error = await initialize().catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "INIT_INPUT" });
    expect(String(error)).not.toContain(marker);
    await absent();
  });
  it("admits only one concurrent initializer without replacing the winning files", async () => {
    const outcomes = await Promise.allSettled([initialize(), initialize()]);
    expect(outcomes.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((row) => row.status === "rejected")).toHaveLength(1);
    expect(parse(await fs.readFile(join(destination, "config.yaml"), "utf8")).profiles[0].qualified_classes).toEqual([]);
  });
  it("rejects a parent identity substitution before creation and preserves foreign permissions", async () => {
    const privateDir = join(home, "private-parent"); await fs.mkdir(privateDir, { mode: 0o700 });
    destination = join(privateDir, "new");
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original.open(...args);
      if (args[0] === inputPath) {
        await fs.rename(privateDir, privateDir + "-retained");
        await original.mkdir(privateDir, { mode: 0o755 });
        await fs.writeFile(join(privateDir, "foreign"), marker);
      }
      return handle;
    });
    await expect(initialize()).rejects.toThrow(); await absent();
    expect((await fs.lstat(privateDir)).mode & 0o777).toBe(0o755);
    expect(await fs.readFile(join(privateDir, "foreign"), "utf8")).toBe(marker);
  });
  it("refuses an injected existing config file and preserves the newly created partial root", async () => {
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === join(destination, "config.yaml")) await fs.writeFile(String(args[0]), marker, { mode: 0o644 });
      return original.open(...args);
    });
    await expect(initialize()).rejects.toMatchObject({ code: "INIT_CREATE" });
    expect(await fs.readFile(join(destination, "config.yaml"), "utf8")).toBe(marker);
    expect((await fs.lstat(join(destination, "config.yaml"))).mode & 0o777).toBe(0o644);
    expect(await fs.readdir(destination)).toEqual(["config.yaml", "data"]);
  });
  it("detects root replacement before file content writes and never deletes or chmods substitutions", async () => {
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original.open(...args);
      if (args[0] === join(destination, "config.yaml")) {
        await fs.rename(destination, destination + "-retained");
        await original.mkdir(destination, { mode: 0o755 });
        await fs.writeFile(join(destination, "foreign"), marker, { mode: 0o644 });
      }
      return handle;
    });
    await expect(initialize()).rejects.toThrow();
    expect(await fs.readFile(join(destination, "foreign"), "utf8")).toBe(marker);
    expect((await fs.lstat(destination)).mode & 0o777).toBe(0o755);
    expect(await fs.readFile(join(destination + "-retained", "config.yaml"), "utf8")).toBe("");
  });
  it("rejects input truncation during its held read before creating the root", async () => {
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original.open(...args);
      if (args[0] === inputPath) {
        vi.spyOn(handle, "read").mockImplementationOnce(async () => {
          await original.truncate(inputPath, 0);
          return { bytesRead: 0, buffer: Buffer.alloc(0) };
        });
      }
      return handle;
    });
    await expect(initialize()).rejects.toMatchObject({ code: "INIT_INPUT" });
    await absent();
  });
  it("accepts complete output readback delivered through valid short reads", async () => {
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original.open(...args);
      if (args[0] === join(destination, "config.yaml")) {
        const read = handle.read.bind(handle);
        vi.spyOn(handle, "read").mockImplementation(async (bufferOrOptions: unknown, offset?: number, length?: number, position?: number | null) => {
          if (!Buffer.isBuffer(bufferOrOptions)) throw new Error("Unexpected read shape");
          return read(bufferOrOptions, offset, Math.min(length ?? 0, 7), position);
        });
      }
      return handle;
    });
    expect((await initialize()).qualifiedClasses).toEqual([]);
  });
  it("preserves a partial root and emits fixed safe errors after a durability failure", async () => {
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original.open(...args);
      if (args[0] === destination) vi.spyOn(handle, "sync").mockRejectedValueOnce(new Error(marker));
      return handle;
    });
    const error = await initialize().catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "INIT_CREATE" });
    expect(String(error)).not.toContain(marker);
    expect((await fs.lstat(destination)).mode & 0o777).toBe(0o700);
    expect(await fs.readdir(destination)).toEqual(["data"]);
  });
  it("closes all retained descriptors and sanitizes a final close failure", async () => {
    const closed: string[] = [];
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original.open(...args);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        await close();
        closed.push(String(args[0]));
        if (args[0] === inputPath) throw new Error(marker);
      });
      return handle;
    });
    const error = await initialize().catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "INIT_CREATE" });
    expect(String(error)).not.toContain(marker);
    expect(closed).toEqual(expect.arrayContaining([home, inputPath, destination, join(destination, "data"), join(destination, "config.yaml")]));
    expect(parse(await fs.readFile(join(destination, "config.yaml"), "utf8")).profiles[0].qualified_classes).toEqual([]);
  });
  it("opens the input and output with explicit nofollow/nonblocking flags and exclusive output", async () => {
    await initialize();
    const readFlags = vi.mocked(fs.open).mock.calls.find(([path]) => path === inputPath)![1] as number;
    const writeFlags = vi.mocked(fs.open).mock.calls.find(([path]) => path === join(destination, "config.yaml"))![1] as number;
    expect(readFlags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    expect(readFlags & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
    expect(writeFlags & constants.O_EXCL).toBe(constants.O_EXCL);
    expect(writeFlags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
  });
});
