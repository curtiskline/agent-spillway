import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createPilot } from "../src/pilot.js";
import { parseTask } from "../src/task.js";
import { gitCommand } from "../src/git.js";
import * as processes from "../src/process.js";

const implementations = {
  "greeting.cjs":
    "module.exports = name => { if (typeof name !== 'string' || !name.trim()) throw new TypeError('Invalid name'); return 'Hello, ' + name.trim() + '!'; };\n",
  "slug.cjs":
    "module.exports = value => { if (typeof value !== 'string') throw new TypeError('Invalid value'); return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); };\n",
  "permission.cjs":
    "module.exports = (role, isOwner) => role === 'admin' || (role === 'editor' && isOwner === true);\n",
};
const broken = {
  "greeting.cjs": [
    "module.exports = name => 'Hello, ' + name.trim() + '!';",
    "module.exports = name => {if (typeof name !== 'string' || !name.trim()) throw new TypeError(); return 'Hello, ' + name.trim().replace(/[^a-zA-Z ]/g,'') + '!';};",
  ],
  "slug.cjs": [
    "module.exports = value => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');",
    "module.exports = value => {if(typeof value !== 'string') throw new TypeError(); return value.toLowerCase().replace(' ', '-');};",
  ],
  "permission.cjs": [
    "module.exports = (role, owner) => role === 'admin' || (role === 'editor' && Boolean(owner));",
    "module.exports = (role, owner) => role === 'admin' || owner === true;",
  ],
};

describe("exclusive private pilot creator and original protected checks", () => {
  let parent: string;
  beforeEach(async () => {
    parent = await realpath(await mkdtemp(join(tmpdir(), "spillway-pilot-")));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(parent, { recursive: true, force: true });
  });
  async function check(repo: string, name: string) {
    return processes.runProcess({
      command: process.execPath,
      args: [`checks/${name}`],
      cwd: repo,
      timeoutMs: 5000,
    });
  }
  it("creates a clean licensed Git baseline and private disjoint tasks pinned to its actual SHA", async () => {
    const root = join(parent, "pilot ' quoted space");
    const manifest = await createPilot(root);
    expect(Object.keys(manifest).sort()).toEqual([
      "baseSha",
      "license",
      "repo",
      "suiteHash",
      "suiteVersion",
      "tasks",
      "version",
    ]);
    expect(manifest).toMatchObject({
      version: 1,
      suiteVersion: 1,
      license: "Apache-2.0",
      repo: join(root, "repo"),
    });
    expect(manifest.suiteHash).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.baseSha).toBe(
      (await gitCommand(manifest.repo, ["rev-parse", "HEAD"])).trim(),
    );
    expect(
      (
        await gitCommand(manifest.repo, [
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
        ])
      ).trim(),
    ).toBe("");
    expect((await gitCommand(manifest.repo, ["remote"])).trim()).toBe("");
    expect(
      (
        await gitCommand(manifest.repo, ["config", "--local", "user.name"])
      ).trim(),
    ).toBe("Agent Spillway Pilot");
    expect(
      (
        await gitCommand(manifest.repo, [
          "ls-tree",
          "-r",
          "--name-only",
          "HEAD",
        ])
      )
        .trim()
        .split("\n"),
    ).toEqual([
      "LICENSE",
      "checks/greeting.cjs",
      "checks/permission.cjs",
      "checks/slug.cjs",
      "src/greeting.cjs",
      "src/permission.cjs",
      "src/slug.cjs",
    ]);
    expect(await readFile(join(manifest.repo, "LICENSE"), "utf8")).toContain(
      "Apache License",
    );
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(root, "tasks"))).mode & 0o777).toBe(0o700);
    expect((await lstat(join(root, "manifest.json"))).mode & 0o777).toBe(0o600);
    expect(
      JSON.parse(
        await readFile(join(root, "manifest.json"), "utf8"),
      ) as unknown,
    ).toEqual(manifest);
    const scopes: string[] = [];
    for (const task of manifest.tasks) {
      expect((await lstat(task.path)).mode & 0o777).toBe(0o600);
      const spec = parseTask(await readFile(task.path, "utf8"));
      expect(spec.repo).toBe(manifest.repo);
      expect(spec.base).toBe(manifest.baseSha);
      expect(spec.id).toBe(task.id);
      expect(spec.class).toBe(task.class);
      expect(spec.after).toEqual([]);
      expect(spec.scope).toHaveLength(1);
      expect(spec.context).toEqual(spec.scope);
      expect(spec.protected).toEqual(["checks/**"]);
      expect(spec.review).toBe(task.class === "risky" ? "frontier" : "default");
      expect(task.expectedWorker).toBe(
        task.class === "risky" ? "frontier-session" : "local",
      );
      scopes.push(spec.scope[0]!);
    }
    expect(new Set(scopes).size).toBe(3);
    expect((await readdir(root)).sort()).toEqual([
      "manifest.json",
      "repo",
      "tasks",
    ]);
  });
  it("binds every manifest/template/source/check/license byte independently of private root paths", async () => {
    const one = await createPilot(join(parent, "one"));
    const two = await createPilot(join(parent, "two"));
    expect(one.suiteHash).toBe(two.suiteHash);
    const assetRoot = new URL("../eval/tasks/v1/", import.meta.url);
    const bundled = JSON.parse(
      await readFile(new URL("manifest.json", assetRoot), "utf8"),
    ) as { tasks: Array<{ source: string; check: string; template: string }> };
    const hash = createHash("sha256");
    for (const path of [
      "manifest.json",
      "LICENSE",
      ...bundled.tasks.flatMap((task) => [
        task.source,
        task.check,
        task.template,
      ]),
    ].sort()) {
      const bytes = await readFile(new URL(path, assetRoot));
      hash.update(JSON.stringify({ path, bytes: bytes.length })).update(bytes);
    }
    expect(one.suiteHash).toBe(hash.digest("hex"));
  });
  it("fails each baseline, accepts known correct implementations, and rejects representative regressions", async () => {
    const manifest = await createPilot(join(parent, "behavior"));
    for (const [name, correct] of Object.entries(implementations)) {
      const protectedCheck = await readFile(
        join(manifest.repo, "checks", name),
      );
      expect((await check(manifest.repo, name)).exitCode).toBe(1);
      await writeFile(join(manifest.repo, "src", name), correct);
      const passed = await check(manifest.repo, name);
      expect(passed.exitCode).toBe(0);
      expect(passed.stdout).toContain("-ok");
      for (const regression of broken[name as keyof typeof broken]) {
        await writeFile(join(manifest.repo, "src", name), regression);
        expect((await check(manifest.repo, name)).exitCode).toBe(1);
      }
      expect(await readFile(join(manifest.repo, "checks", name))).toEqual(
        protectedCheck,
      );
    }
  });
  it("never replaces an existing directory, file or dangling symlink", async () => {
    const directory = join(parent, "exists");
    await mkdir(directory);
    await writeFile(join(directory, "keep"), "preserve");
    const file = join(parent, "file");
    await writeFile(file, "preserve");
    const link = join(parent, "link");
    await symlink(join(parent, "absent"), link);
    for (const path of [directory, file, link])
      await expect(createPilot(path)).rejects.toMatchObject({
        code: "PILOT_EXISTS",
      });
    expect(await readFile(join(directory, "keep"), "utf8")).toBe("preserve");
    expect(await readFile(file, "utf8")).toBe("preserve");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });
  it("rejects nonexistent, file and symlinked parents before creating anything", async () => {
    const file = join(parent, "file");
    await writeFile(file, "preserve");
    const alias = join(parent, "alias");
    await symlink(parent, alias);
    for (const root of [
      join(parent, "missing", "child"),
      join(file, "child"),
      join(alias, "child"),
      "",
      join(parent, "bad\nname"),
    ])
      await expect(createPilot(root)).rejects.toMatchObject({
        code: "PILOT_PATH",
      });
    expect((await readdir(parent)).sort()).toEqual(["alias", "file"]);
  });
  it("rejects roots under normal and bare Git repositories without modifying them", async () => {
    for (const bare of [false, true]) {
      const repository = join(parent, bare ? "bare" : "repo");
      await mkdir(repository);
      await gitCommand(
        repository,
        bare ? ["init", "--bare"] : ["init", "-b", "main"],
      );
      const before = (await readdir(repository)).sort();
      await expect(
        createPilot(join(repository, "new-pilot")),
      ).rejects.toMatchObject({ code: "PILOT_PATH" });
      expect((await readdir(repository)).sort()).toEqual(before);
    }
  });
  it("exclusively admits one concurrent creator and leaves its manifest intact", async () => {
    const root = join(parent, "race");
    const results = await Promise.allSettled([
      createPilot(root),
      createPilot(root),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const stored = JSON.parse(
      await readFile(join(root, "manifest.json"), "utf8"),
    ) as unknown;
    const successful = results.find((result) => result.status === "fulfilled");
    if (successful?.status !== "fulfilled")
      throw new Error("Missing creator result");
    expect(stored).toEqual(successful.value);
  });
  it("preserves the partial new root when Git setup fails", async () => {
    const actual = processes.runProcess;
    vi.spyOn(processes, "runProcess").mockImplementation(async (input) =>
      input.command === "git" && input.args?.includes("init")
        ? {
            exitCode: 1,
            timedOut: false,
            stdout: "",
            stderr: "synthetic failure",
            durationMs: 0,
          }
        : actual(input),
    );
    const root = join(parent, "partial");
    await expect(createPilot(root)).rejects.toMatchObject({
      code: "PILOT_GIT",
    });
    expect(
      await readFile(join(root, "repo", "src", "greeting.cjs"), "utf8"),
    ).toContain("Hello");
    expect((await lstat(root)).isDirectory()).toBe(true);
    await expect(createPilot(root)).rejects.toMatchObject({
      code: "PILOT_EXISTS",
    });
  });
  it("fails closed before writes when Git availability cannot establish parent safety", async () => {
    vi.spyOn(processes, "runProcess").mockResolvedValue({
      exitCode: null,
      timedOut: false,
      stdout: "",
      stderr: "synthetic unavailable Git",
      durationMs: 0,
    });
    const root = join(parent, "unavailable");
    await expect(createPilot(root)).rejects.toMatchObject({
      code: "PILOT_GIT",
    });
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("refuses a substituted repository directory and preserves foreign content", async () => {
    const outside = join(parent, "outside");
    await mkdir(outside);
    await gitCommand(outside, ["init", "-b", "main"]);
    await writeFile(join(outside, "keep"), "foreign content");
    const config = await readFile(join(outside, ".git", "config"));
    const actual = processes.runProcess;
    const root = join(parent, "substitution");
    vi.spyOn(processes, "runProcess").mockImplementation(async (input) => {
      const result = await actual(input);
      if (input.command === "git" && input.args?.includes("init")) {
        await rename(input.cwd, join(root, "retained-repository"));
        await symlink(outside, input.cwd);
      }
      return result;
    });
    await expect(createPilot(root)).rejects.toMatchObject({
      code: "PILOT_CREATE",
    });
    expect(await readFile(join(outside, ".git", "config"))).toEqual(config);
    expect(await readFile(join(outside, "keep"), "utf8")).toBe(
      "foreign content",
    );
    expect((await readdir(outside)).sort()).toEqual([".git", "keep"]);
    expect((await lstat(join(root, "retained-repository"))).isDirectory()).toBe(
      true,
    );
  });
  it("rejects a root replaced immediately after exclusive mkdir without changing foreign permissions or content", async () => {
    const foreign = join(parent, "foreign");
    await mkdir(foreign, { mode: 0o755 });
    await fs.promises.chmod(foreign, 0o755);
    await writeFile(join(foreign, "keep"), "foreign content", { mode: 0o644 });
    const root = join(parent, "root-race");
    const retained = root + "-retained";
    const original = fs.promises.mkdir;
    let substituted = false;
    fs.promises.mkdir = (async (
      path: Parameters<typeof original>[0],
      options?: Parameters<typeof original>[1],
    ) => {
      const result = await original(path, options);
      if (String(path) === root) {
        await rename(root, retained);
        await symlink(foreign, root);
        substituted = true;
      }
      return result;
    }) as typeof original;
    syncBuiltinESMExports();
    try {
      await expect(createPilot(root)).rejects.toMatchObject({
        code: "PILOT_CREATE",
      });
    } finally {
      fs.promises.mkdir = original;
      syncBuiltinESMExports();
    }
    expect(substituted).toBe(true);
    expect((await lstat(foreign)).mode & 0o777).toBe(0o755);
    expect(await readFile(join(foreign, "keep"), "utf8")).toBe(
      "foreign content",
    );
    expect(await readdir(foreign)).toEqual(["keep"]);
    expect((await lstat(root)).isSymbolicLink()).toBe(true);
    expect((await lstat(retained)).mode & 0o777).toBe(0o700);
    expect(await readdir(retained)).toEqual([]);
  });
  it("ignores inherited global Git settings and executable template hooks", async () => {
    const template = join(parent, "template");
    await mkdir(join(template, "hooks"), { recursive: true });
    const marker = join(parent, "hook-ran");
    await writeFile(
      join(template, "hooks", "pre-commit"),
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected');`,
      { mode: 0o700 },
    );
    const global = join(parent, "global.gitconfig");
    await writeFile(
      global,
      `[init]\n templateDir = ${template}\n[core]\n hooksPath = ${join(template, "hooks")}\n[user]\n name = Wrong Global Identity\n`,
    );
    const before = await readFile(global);
    const previous = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = global;
    try {
      const manifest = await createPilot(join(parent, "isolated"));
      expect(
        (
          await gitCommand(manifest.repo, ["config", "--local", "user.name"])
        ).trim(),
      ).toBe("Agent Spillway Pilot");
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previous;
    }
    await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(global)).toEqual(before);
  });
});
