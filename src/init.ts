import { constants, type Stats } from "node:fs";
import { lstat, realpath, open, mkdir, type FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { stringify } from "yaml";
import { SpillwayError } from "./contracts.js";
import { planConfig, within } from "./config.js";
import { parseStrictJson } from "./json.js";

export interface InitReceipt {
  version: 1;
  configPath: string;
  dataDir: string;
  profileId: "local";
  qualifiedClasses: [];
}
const LIMIT = 256 * 1024;
const execute = promisify(execFile);
const text = z.string().trim().min(1).max(4096);
const inputSchema = z.object({
  version: z.literal(1),
  repo: text,
  endpoint: z.object({ url: text, api_key_env: text.optional(), api_key_file: text.optional() }).strict(),
  model: text,
  model_artifact: text,
  harness_version: text,
  port: z.number().int().min(1).max(65535).optional(),
}).strict();
const failure = (code: "INIT_INPUT" | "INIT_PATH" | "INIT_EXISTS" | "INIT_CHANGED" | "INIT_CREATE") =>
  new SpillwayError(code, {
    INIT_INPUT: "Use a bounded private strict JSON input outside Git with explicit setup values.",
    INIT_PATH: "Choose a new private root with an existing canonical owner-controlled parent outside Git.",
    INIT_EXISTS: "Initialization root already exists. Choose a new root; existing content is never replaced.",
    INIT_CHANGED: "Private setup paths changed during initialization. Preserve any partial root and inspect it locally before retrying.",
    INIT_CREATE: "Initialization could not complete. Preserve any partial root and inspect it locally; existing content is never replaced.",
  }[code]);
interface DirectoryPin {
  path: string;
  handle: FileHandle;
  info: Stats;
  private: boolean;
}
interface FilePin { path: string; handle: FileHandle; info: Stats }
const owned = (info: Stats) => !process.getuid || info.uid === process.getuid();
const identity = (left: Stats, right: Stats) => left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.uid === right.uid;
const privateFile = (info: Stats) => info.isFile() && info.nlink === 1 && owned(info) && (info.mode & 0o077) === 0;
const unchangedFile = (left: Stats, right: Stats) => privateFile(right) && identity(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
function directorySafe(info: Stats, ownerOnly: boolean): boolean {
  return info.isDirectory() && !info.isSymbolicLink() && owned(info) &&
    (info.mode & (ownerOnly ? 0o077 : 0o022)) === 0;
}
async function directory(path: string, ownerOnly: boolean): Promise<DirectoryPin> {
  const before = await lstat(path);
  if (!directorySafe(before, ownerOnly) || await realpath(path) !== path) throw failure("INIT_PATH");
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!directorySafe(info, ownerOnly) || !identity(before, info)) throw failure("INIT_CHANGED");
    const pin = { path, handle, info, private: ownerOnly };
    await checkDirectory(pin);
    return pin;
  } catch (error) { await handle.close(); throw error; }
}
async function checkDirectory(pin: DirectoryPin): Promise<void> {
  const current = await lstat(pin.path);
  const held = await pin.handle.stat();
  if (!directorySafe(current, pin.private) || !identity(pin.info, current) ||
    !identity(pin.info, held) || await realpath(pin.path) !== pin.path) throw failure("INIT_CHANGED");
}
async function checkFile(pin: FilePin): Promise<void> {
  const current = await lstat(pin.path);
  if (!unchangedFile(pin.info, current) || !unchangedFile(pin.info, await pin.handle.stat()) ||
    await realpath(pin.path) !== pin.path) throw failure("INIT_CHANGED");
}
async function outsideGit(path: string): Promise<void> {
  try {
    // Only a definite non-repository response permits creation. Bare Git and
    // unavailable/ambiguous Git both fail closed, without inheriting Git config.
    await execute("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", path, "rev-parse", "--absolute-git-dir"], {
      timeout: 5000, maxBuffer: 4096,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/nonexistent-spillway-init-home", LANG: "C", LC_ALL: "C",
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_DISCOVERY_ACROSS_FILESYSTEM: "1" },
    });
  } catch (error) {
    const outcome = error as { code?: unknown; stderr?: unknown; killed?: unknown };
    if (outcome.code === 128 && outcome.killed !== true && typeof outcome.stderr === "string" &&
      /^fatal: not a git repository(?: \(or any of the parent directories\): \.git)?\s*$/.test(outcome.stderr)) return;
  }
  throw failure("INIT_PATH");
}
async function privateInput(path: string): Promise<{ value: unknown; pin: FilePin }> {
  const before = await lstat(path);
  if (!privateFile(before) || before.isSymbolicLink() || before.size > LIMIT ||
    await realpath(path) !== path) throw failure("INIT_INPUT");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!unchangedFile(before, info)) throw failure("INIT_CHANGED");
    const buffer = Buffer.alloc(LIMIT + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const pin = { path, handle, info };
    if (length > LIMIT || length !== info.size) throw failure("INIT_INPUT");
    await checkFile(pin);
    const value = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)));
    return { value, pin };
  } catch (error) { await handle.close(); throw error; }
}

/** Create only a new owner-private config/data root. This is not a sandbox
 * against a hostile process with the same UID; preserve ambiguous partials.
 */
export async function initializeConfig(options: { inputPath: string; root: string }): Promise<InitReceipt> {
  const pins = new Map<string, DirectoryPin>();
  let input: FilePin | undefined;
  let output: FilePin | undefined;
  let receipt: InitReceipt | undefined;
  let problem: SpillwayError | undefined;
  let created = false;
  let phase: "input" | "path" | "planning" | "create" = "path";
  try {
    for (const value of [options.inputPath, options.root])
      if (typeof value !== "string" || !value.trim() || value.length > 4096 || /[\0\r\n]/.test(value)) throw failure("INIT_PATH");
    const inputPath = resolve(options.inputPath), root = resolve(options.root);
    if (within(inputPath, root) || within(root, inputPath)) throw failure("INIT_PATH");
    try { await lstat(root); throw failure("INIT_EXISTS"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = dirname(root);
    pins.set(parent, await directory(parent, false));
    await outsideGit(parent);
    phase = "input";
    const inputParent = dirname(inputPath);
    if (pins.has(inputParent)) {
      if (!directorySafe(pins.get(inputParent)!.info, true)) throw failure("INIT_INPUT");
      pins.get(inputParent)!.private = true;
    } else pins.set(inputParent, await directory(inputParent, true));
    await outsideGit(inputParent);
    const loaded = await privateInput(inputPath);
    input = loaded.pin;
    const values = inputSchema.parse(loaded.value);
    phase = "planning";
    const dataDir = join(root, "data"), configPath = join(root, "config.yaml");
    const starter = {
      version: 1,
      data_dir: dataDir,
      repositories: [{ path: values.repo, data_policy: "local-only" }],
      endpoints: [{ id: "local", kind: "local", ...values.endpoint }],
      profiles: [{ id: "local", endpoint: "local", model: values.model, model_artifact: values.model_artifact,
        harness: "opencode", harness_version: values.harness_version, qualified_classes: [] }],
      default_profile: "local", allow_checks_only: false, port: values.port ?? 7433, poll_interval_ms: 5000, audit_rate: 0.3,
    };
    const planned = await planConfig(starter);
    if (planned.data_dir !== dataDir) throw failure("INIT_CHANGED");
    const content = Buffer.from(stringify({ ...starter, repositories: planned.repositories, endpoints: planned.endpoints, profiles: planned.profiles }), "utf8");
    const stable = async () => {
      for (const pin of pins.values()) await checkDirectory(pin);
      if (input) await checkFile(input);
      if (output) await checkFile(output);
    };
    await stable();
    phase = "create";
    try { await mkdir(root, { mode: 0o700 }); created = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw failure("INIT_EXISTS"); throw error; }
    pins.set(root, await directory(root, true));
    if ((pins.get(root)!.info.mode & 0o777) !== 0o700) throw failure("INIT_CHANGED");
    await stable();
    await pins.get(parent)!.handle.sync();
    await stable();
    await mkdir(dataDir, { mode: 0o700 });
    pins.set(dataDir, await directory(dataDir, true));
    if ((pins.get(dataDir)!.info.mode & 0o777) !== 0o700) throw failure("INIT_CHANGED");
    await stable();
    await pins.get(dataDir)!.handle.sync();
    await pins.get(root)!.handle.sync();
    await stable();
    const handle = await open(configPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const initial = await handle.stat();
      if (!privateFile(initial) || (initial.mode & 0o777) !== 0o600 || initial.size !== 0) throw failure("INIT_CHANGED");
      output = { path: configPath, handle, info: initial };
      await stable();
      await handle.writeFile(content);
      await handle.sync();
      output.info = await handle.stat();
      if (output.info.size !== content.length || !privateFile(output.info) || !identity(initial, output.info)) throw failure("INIT_CHANGED");
      const written = Buffer.alloc(content.length);
      let length = 0;
      while (length < written.length) {
        const { bytesRead } = await handle.read(written, length, written.length - length, length);
        if (!bytesRead) throw failure("INIT_CHANGED");
        length += bytesRead;
      }
      if (!written.equals(content)) throw failure("INIT_CHANGED");
      await stable();
      await pins.get(root)!.handle.sync();
      await stable();
      receipt = { version: 1, configPath, dataDir, profileId: "local", qualifiedClasses: [] };
    } finally { await handle.close(); output = undefined; }
  } catch (error) {
    problem = error instanceof SpillwayError && error.code.startsWith("INIT_") ? error :
      failure(created || phase === "create" ? "INIT_CREATE" : phase === "path" ? "INIT_PATH" : "INIT_INPUT");
  } finally {
    const handles = [...(input ? [input.handle] : []), ...[...pins.values()].map((pin) => pin.handle)];
    const closed = await Promise.allSettled(handles.map(async (handle) => { await handle.close(); }));
    if (closed.some((result) => result.status === "rejected")) problem ??= failure("INIT_CREATE");
  }
  if (problem) throw problem;
  if (!receipt) throw failure("INIT_CREATE");
  return receipt;
}
