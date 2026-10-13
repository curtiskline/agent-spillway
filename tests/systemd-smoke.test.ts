import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFile, execFileSync, spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const script = resolve("scripts/systemd-smoke.mjs");
const execute = promisify(execFile);
interface SmokeHelpers {
  parsePackageArgument(args: string[]): string;
  validateInvocation(input: { platform: string; uid: number; username: string; optIn?: string; home: string }): void;
  assertAbsent(path: string): Promise<void>;
  fixtureHarnessSource(nodePath: string): string;
  servicePaths(home: string, uid: number): string[];
  unitNamespacePaths(path: string): string[];
  parseUnitPaths(output: string): string[];
}
let smoke: SmokeHelpers;
beforeAll(async () => { smoke = await import(pathToFileURL(script).href) as SmokeHelpers; });

describe("dedicated systemd smoke preflight and synthetic fixture (no manager mutation)", () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "spillway-systemd-preflight-")));
    await chmod(root, 0o700);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const invocation = () => ({ platform: "linux", uid: 12345, username: "spillway-ci", optIn: "1", home: "/home/spillway-ci" });
  it.each([
    [], ["--package"], ["--package", "relative"], ["--package", "/absolute", "extra"],
    ["--package=/absolute"], ["--package", "/absolute\nprivate"], ["--package", "/absolute\0private"],
  ].map(args => ({ args })))("rejects invalid installed-package arguments $args without reflecting them", ({ args }) => {
    expect(() => smoke.parsePackageArgument(args)).toThrow("Dedicated Linux service verification preflight refused.");
  });
  it("accepts exactly an explicit absolute package argument", () => {
    expect(smoke.parsePackageArgument(["--package", "/home/spillway-ci/package/node_modules/agent-spillway"])).toBe("/home/spillway-ci/package/node_modules/agent-spillway");
  });
  it.each([
    { platform: "darwin" }, { platform: "win32" }, { uid: 0 }, { uid: -1 }, { uid: 1.5 },
    { username: "ordinary-user" }, { optIn: undefined }, { optIn: "true" }, { optIn: "0" },
    { home: "relative" }, { home: "/home/private\nsecret" },
  ])("refuses non-dedicated or non-opted-in invocation %j", change => {
    expect(() => smoke.validateInvocation({ ...invocation(), ...change })).toThrow("Dedicated Linux service verification preflight refused.");
  });
  it("allows only the exact dedicated nonroot Linux opt-in shape", () => {
    expect(() => smoke.validateInvocation(invocation())).not.toThrow();
  });
  it.each(["file", "directory", "symlink", "dangling-symlink"])("refuses preexisting %s units and leaves bytes/identity untouched", async kind => {
    const path = join(root, "agent-spillway.service");
    if (kind === "file") await writeFile(path, "synthetic-foreign-unit", { mode: 0o644 });
    else if (kind === "directory") await mkdir(path, { mode: 0o755 });
    else {
      const target = join(root, "target");
      if (kind === "symlink") await writeFile(target, "synthetic-foreign-target");
      await symlink(target, path);
    }
    const before = await lstat(path);
    await expect(smoke.assertAbsent(path)).rejects.toThrow("Dedicated Linux service verification preflight refused.");
    const after = await lstat(path);
    expect([after.ino, after.mode]).toEqual([before.ino, before.mode]);
    if (kind === "file") expect(await readFile(path, "utf8")).toBe("synthetic-foreign-unit");
  });
  it("checks absent paths without creating their parents", async () => {
    const parent = join(root, "missing");
    await smoke.assertAbsent(join(parent, "agent-spillway.service"));
    await expect(lstat(parent)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("covers definition and enable links in both home and user-runtime paths", () => {
    expect(smoke.servicePaths("/home/spillway-ci", 12345)).toEqual([
      "/home/spillway-ci/.config/systemd/user/agent-spillway.service",
      "/home/spillway-ci/.config/systemd/user/default.target.wants/agent-spillway.service",
      "/home/spillway-ci/.config/systemd/user/agent-spillway.service.d",
      "/home/spillway-ci/.config/systemd/user/agent-.service.d",
      "/home/spillway-ci/.config/systemd/user/service.d",
      "/run/user/12345/systemd/user/agent-spillway.service",
      "/run/user/12345/systemd/user/default.target.wants/agent-spillway.service",
      "/run/user/12345/systemd/user/agent-spillway.service.d",
      "/run/user/12345/systemd/user/agent-.service.d",
      "/run/user/12345/systemd/user/service.d",
    ]);
  });
  it("uses bounded actual manager lookup roots without a guessed global list", () => {
    const paths = smoke.parseUnitPaths("/etc/systemd/user /usr/lib/systemd/user /etc/systemd/user\n");
    expect(paths).toEqual(["/etc/systemd/user", "/usr/lib/systemd/user"]);
    expect(paths.flatMap(smoke.unitNamespacePaths)).toContain("/etc/systemd/user/agent-.service.d");
    expect(paths.flatMap(smoke.unitNamespacePaths)).toContain("/usr/lib/systemd/user/service.d");
  });
  it.each(["", "relative", "/absolute  /second", "/absolute\n/second\n", '"/path with spaces"',
    "/escaped\\x20space", "/absolute/../ambiguous", "/absolute\0private", "/absolute\x01private", Array(65).fill("/absolute").join(" "), "/" + "x".repeat(16385)])(
    "rejects ambiguous or oversized manager lookup output without reflecting it", output => {
      expect(() => smoke.parseUnitPaths(output)).toThrow("Dedicated Linux service verification preflight refused.");
    },
  );
  it.each(["directory", "file", "symlink", "dangling-symlink"])("refuses orphan drop-in %s namespaces before writes", async kind => {
    for (const name of ["agent-spillway.service.d", "agent-.service.d", "service.d"]) {
      const path = join(root, name);
      if (kind === "directory") await mkdir(path);
      else if (kind === "file") await writeFile(path, "synthetic-foreign-dropin");
      else {
        const target = join(root, "target-" + name);
        if (kind === "symlink") await mkdir(target);
        await symlink(target, path);
      }
      const before = await lstat(path);
      await expect(smoke.assertAbsent(path)).rejects.toThrow("Dedicated Linux service verification preflight refused.");
      expect((await lstat(path)).ino).toBe(before.ino);
    }
  });
  it("refuses a dangling generated enable link before fixtures", async () => {
    const wants = join(root, ".config", "systemd", "user", "default.target.wants");
    await mkdir(wants, { recursive: true });
    const path = join(wants, "agent-spillway.service");
    await symlink(join(root, "missing-unit"), path);
    await expect(smoke.assertAbsent(path)).rejects.toThrow("Dedicated Linux service verification preflight refused.");
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
  });
  it("actual script refuses an ordinary host before executing commands or writing fixtures", async () => {
    // The test never invokes an opted-in smoke on its permitted dedicated host.
    const unsafeHost = process.platform !== "linux" || process.getuid?.() === 0 || userInfo().username !== "spillway-ci";
    const fakeBin = join(root, "bin"); await mkdir(fakeBin);
    const commandMarker = join(root, "command-called");
    await writeFile(join(fakeBin, "git"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(commandMarker)},'called');`, { mode: 0o700 });
    const before = await readdir(root);
    const outcome = await execute(process.execPath, [script, "--package", join(root, "synthetic-private-package")], {
      env: { PATH: fakeBin, HOME: root, SPILLWAY_SYSTEMD_SMOKE: unsafeHost ? "1" : "0", OPENAI_API_KEY: "synthetic-private-marker" },
      timeout: 5000,
    }).catch((error: unknown) => error) as { code: number; stdout: string; stderr: string };
    expect(outcome.code).toBe(1);
    expect(outcome.stdout).toBe("");
    expect(outcome.stderr).toBe("Dedicated Linux service verification failed during preflight. Private fixtures are preserved for disposable-account cleanup.\n");
    expect(outcome.stderr).not.toContain(root);
    expect(outcome.stderr).not.toContain("synthetic-private-marker");
    expect(await readdir(root)).toEqual(before);
    await expect(lstat(commandMarker)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("generated fixture subprocess edits only source, passes a previously failing protected check, then reviews without mutation", async () => {
    const repo = join(root, "repo");
    for (const path of [repo, join(repo, "src"), join(repo, "checks")]) await mkdir(path);
    const checkPath = join(repo, "checks", "acceptance.cjs");
    const check = "require('node:assert/strict').equal(require('../src/message.cjs')(), 'hello');\n";
    await writeFile(checkPath, check);
    await writeFile(join(repo, "src", "message.cjs"), "module.exports=()=> 'wrong';\n");
    const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const git = (args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: repo, env, encoding: "utf8" }).trim();
    git(["init", "-q", "--template=", "-b", "main"]);
    git(["add", "."]);
    git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Baseline"]);
    const base = git(["rev-parse", "HEAD"]);
    await expect(execute(process.execPath, [checkPath], { cwd: repo, env, timeout: 5000 })).rejects.toThrow();
    const harness = join(root, "opencode");
    await writeFile(harness, smoke.fixtureHarnessSource(process.execPath), { mode: 0o700 });
    expect((await execute(harness, ["--version"], { env, timeout: 5000 })).stdout.trim()).toBe("1.2.3");
    const run = (agent: string) => new Promise<string>((done, reject) => {
      const child = spawn(harness, ["run", "--pure", "--format", "json", "--agent", agent], { cwd: repo, env, stdio: "pipe", timeout: 10000 });
      let stdout = "";
      child.stdout.on("data", bytes => { stdout += String(bytes); });
      child.on("error", reject);
      child.on("close", code => { if (code === 0) done(stdout); else reject(new Error("Fixture failed")); });
      child.stdin.end("Synthetic fixture prompt");
    });
    const worker = (await run("build")).trim().split("\n").map(line => JSON.parse(line) as { type: string; part: { reason?: string } });
    expect(worker.at(-1)).toMatchObject({ type: "step_finish", part: { reason: "stop" } });
    const result = git(["rev-parse", "HEAD"]); expect(result).not.toBe(base);
    expect(git(["diff", "--name-only", base, result])).toBe("src/message.cjs");
    await execute(process.execPath, [checkPath], { cwd: repo, env, timeout: 5000 });
    expect(await readFile(checkPath, "utf8")).toBe(check);
    const review = (await run("spillway-review")).trim().split("\n").map(line => JSON.parse(line) as { type: string; part: { text?: string; reason?: string } });
    expect(JSON.parse(review[0]!.part.text!)).toEqual({ resultSha: result, verdict: "accept", findings: [] });
    expect(review.at(-1)).toMatchObject({ type: "step_finish", part: { reason: "stop" } });
    expect(git(["rev-parse", "HEAD"])).toBe(result);
    expect(git(["status", "--porcelain"])).toBe("");
    expect(await readFile(checkPath, "utf8")).toBe(check);
  });
});
