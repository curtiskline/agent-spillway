import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { SpillwayError } from "./contracts.js";
import { parseStrictJson } from "./json.js";
import { minimalEnvironment, OUTPUT_TRUNCATED, runProcess } from "./process.js";

export interface PilotTask {
  id: string;
  path: string;
  class: "mechanical" | "small-fix" | "risky";
  expectedWorker: "local" | "frontier-session";
}
export interface PilotManifest {
  version: 1;
  suiteVersion: 1;
  license: "Apache-2.0";
  suiteHash: string;
  repo: string;
  baseSha: string;
  tasks: PilotTask[];
}
const cases = [
  {
    id: "pilot-greeting",
    class: "mechanical",
    expectedWorker: "local",
    source: "src/greeting.cjs",
    check: "checks/greeting.cjs",
    template: "templates/pilot-greeting.md",
  },
  {
    id: "pilot-slug",
    class: "small-fix",
    expectedWorker: "local",
    source: "src/slug.cjs",
    check: "checks/slug.cjs",
    template: "templates/pilot-slug.md",
  },
  {
    id: "pilot-permission",
    class: "risky",
    expectedWorker: "frontier-session",
    source: "src/permission.cjs",
    check: "checks/permission.cjs",
    template: "templates/pilot-permission.md",
  },
] as const;
const suite = {
  version: 1,
  suiteVersion: 1,
  license: "Apache-2.0",
  tasks: cases,
};
const error = (code: string, message: string) =>
  new SpillwayError(code, message);

async function assets(): Promise<{ files: Map<string, Buffer>; hash: string }> {
  try {
    const files = new Map<string, Buffer>();
    for (const path of [
      "manifest.json",
      "LICENSE",
      ...cases.flatMap((item) => [item.source, item.check, item.template]),
    ].sort()) {
      const url = new URL(`../eval/tasks/v1/${path}`, import.meta.url);
      const info = await lstat(url);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024)
        throw new Error("Unsafe asset");
      files.set(path, await readFile(url));
    }
    if (
      !isDeepStrictEqual(
        parseStrictJson(files.get("manifest.json")!.toString("utf8")),
        suite,
      )
    )
      throw new Error("Unexpected suite manifest");
    const hash = createHash("sha256");
    for (const [path, data] of files)
      hash.update(JSON.stringify({ path, bytes: data.length })).update(data);
    return { files, hash: hash.digest("hex") };
  } catch {
    throw error(
      "PILOT_ASSETS",
      "Bundled pilot assets are unavailable or invalid. Reinstall the tested package.",
    );
  }
}
async function git(cwd: string, args: string[]) {
  return runProcess({
    command: "git",
    args: [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "commit.gpgSign=false",
      ...args,
    ],
    cwd,
    env: {
      ...minimalEnvironment("/nonexistent-spillway-pilot-home"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_DISCOVERY_ACROSS_FILESYSTEM: "1",
    },
    timeoutMs: 10000,
  });
}
async function requiredGit(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  if (
    result.exitCode !== 0 ||
    result.timedOut ||
    result.stdout.includes(OUTPUT_TRUNCATED) ||
    result.stderr.includes(OUTPUT_TRUNCATED)
  )
    throw error(
      "PILOT_GIT",
      "Pilot Git setup failed. Preserve the new directory and inspect it locally before retrying with a fresh directory.",
    );
  return result.stdout;
}

/** Materialize one new pilot only; never enqueue, infer, accept or publish work. */
export async function createPilot(input: string): Promise<PilotManifest> {
  if (!input.trim() || /[\0\r\n]/.test(input))
    throw error(
      "PILOT_PATH",
      "Use a new pilot directory with an existing real parent outside Git.",
    );
  const root = resolve(input);
  try {
    await lstat(root);
    throw error(
      "PILOT_EXISTS",
      "Pilot directory already exists. Choose a new directory; existing content is never replaced.",
    );
  } catch (cause) {
    if (cause instanceof SpillwayError) throw cause;
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT")
      throw error(
        "PILOT_PATH",
        "Could not inspect the requested new pilot directory safely.",
      );
  }
  const parent = dirname(root);
  let parentIdentity;
  try {
    parentIdentity = await lstat(parent);
    if (
      !parentIdentity.isDirectory() ||
      parentIdentity.isSymbolicLink() ||
      (await realpath(parent)) !== parent
    )
      throw new Error("Invalid parent");
  } catch {
    throw error(
      "PILOT_PATH",
      "Pilot parent must already exist as a real directory outside Git.",
    );
  }
  const probe = await git(parent, ["rev-parse", "--absolute-git-dir"]);
  if (probe.exitCode === 0)
    throw error(
      "PILOT_PATH",
      "Pilot root must be outside every existing Git repository.",
    );
  if (
    probe.timedOut ||
    probe.exitCode !== 128 ||
    !/fatal: not a git repository/.test(probe.stderr) ||
    probe.stderr.includes(OUTPUT_TRUNCATED)
  )
    throw error(
      "PILOT_GIT",
      "Could not establish that the pilot parent is outside Git. Check the Git installation before retrying.",
    );
  const loaded = await assets();
  const currentParent = await lstat(parent);
  if (
    !currentParent.isDirectory() ||
    currentParent.isSymbolicLink() ||
    currentParent.dev !== parentIdentity.dev ||
    currentParent.ino !== parentIdentity.ino ||
    (await realpath(parent)) !== parent
  )
    throw error(
      "PILOT_PATH",
      "Pilot parent changed during preparation. Choose a stable real directory outside Git.",
    );
  try {
    await mkdir(root, { mode: 0o700 });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST")
      throw error(
        "PILOT_EXISTS",
        "Pilot directory already exists. Choose a new directory; existing content is never replaced.",
      );
    throw error("PILOT_CREATE", "Could not create the new pilot directory.");
  }
  try {
    const createdRoot = await lstat(root);
    if (
      !createdRoot.isDirectory() ||
      createdRoot.isSymbolicLink() ||
      (createdRoot.mode & 0o077) !== 0 ||
      (await realpath(root)) !== root
    )
      throw error(
        "PILOT_CREATE",
        "New pilot directory changed before setup. Preserve it and inspect it locally.",
      );
    const directories = new Map([
      [parent, parentIdentity],
      [root, createdRoot],
    ]);
    const stable = async () => {
      for (const [path, original] of directories) {
        const current = await lstat(path);
        if (
          !current.isDirectory() ||
          current.isSymbolicLink() ||
          current.dev !== original.dev ||
          current.ino !== original.ino ||
          (await realpath(path)) !== path
        )
          throw error(
            "PILOT_CREATE",
            "Pilot directories changed during setup. Preserve partial evidence and inspect it locally.",
          );
      }
    };
    const repo = join(root, "repo");
    const tasks = join(root, "tasks");
    for (const directory of [
      repo,
      tasks,
      join(repo, "src"),
      join(repo, "checks"),
    ]) {
      await stable();
      await mkdir(directory, { mode: 0o700 });
      directories.set(directory, await lstat(directory));
    }
    for (const path of [
      "LICENSE",
      ...cases.flatMap((item) => [item.source, item.check]),
    ]) {
      await stable();
      await writeFile(join(repo, path), loaded.files.get(path)!, {
        flag: "wx",
        mode: 0o644,
      });
    }
    const pilotGit = async (args: string[]) => {
      await stable();
      return requiredGit(repo, args);
    };
    await pilotGit(["init", "--template=", "-b", "main"]);
    await pilotGit(["config", "--local", "user.name", "Agent Spillway Pilot"]);
    await pilotGit([
      "config",
      "--local",
      "user.email",
      "pilot@example.invalid",
    ]);
    await pilotGit(["add", "--", "."]);
    await pilotGit(["commit", "-m", "Apache-2.0 pilot baseline"]);
    const baseSha = (
      await pilotGit(["rev-parse", "--verify", "HEAD^{commit}"])
    ).trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseSha))
      throw error(
        "PILOT_GIT",
        "Pilot baseline did not produce a valid immutable commit.",
      );
    const manifest: PilotManifest = {
      version: 1,
      suiteVersion: 1,
      license: "Apache-2.0",
      suiteHash: loaded.hash,
      repo,
      baseSha,
      tasks: [],
    };
    for (const item of cases) {
      await stable();
      const path = join(tasks, `${item.id}.md`);
      const markdown = loaded.files
        .get(item.template)!
        .toString("utf8")
        .replaceAll("{{REPO_JSON}}", JSON.stringify(repo))
        .replaceAll("{{BASE_SHA}}", baseSha);
      await writeFile(path, markdown, { flag: "wx", mode: 0o600 });
      manifest.tasks.push({
        id: item.id,
        path,
        class: item.class,
        expectedWorker: item.expectedWorker,
      });
    }
    await stable();
    await writeFile(
      join(root, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    return manifest;
  } catch (cause) {
    if (cause instanceof SpillwayError) throw cause;
    throw error(
      "PILOT_CREATE",
      "Pilot setup failed. Preserve the partial new directory and retry only with a different new directory.",
    );
  }
}
