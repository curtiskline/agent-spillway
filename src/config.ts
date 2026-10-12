import { homedir } from "node:os";
import { dirname, resolve, relative, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, realpath, stat, mkdir, chmod } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { identifier, taskClass, parseYaml } from "./task.js";
import { SpillwayError, type SpillwayConfig } from "./contracts.js";

const execute = promisify(execFile);
const nonempty = z.string().trim().min(1).max(4096);
const schema = z
  .object({
    version: z.literal(1),
    data_dir: nonempty.optional(),
    port: z.number().int().min(1).max(65535).default(7433),
    poll_interval_ms: z.number().int().min(100).max(3600000).default(5000),
    repositories: z
      .array(
        z
          .object({
            path: nonempty,
            data_policy: z
              .enum(["local-only", "open-weight-hosted-ok", "frontier-ok"])
              .default("local-only"),
          })
          .strict(),
      )
      .min(1),
    endpoints: z
      .array(
        z
          .object({
            id: identifier,
            kind: z.enum(["local", "open-weight-hosted", "frontier"]),
            url: nonempty,
            api_key_env: z
              .string()
              .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
              .optional(),
          })
          .strict(),
      )
      .min(1),
    profiles: z
      .array(
        z
          .object({
            id: identifier,
            endpoint: identifier,
            model: nonempty,
            model_artifact: nonempty,
            harness: z.literal("opencode"),
            harness_version: nonempty,
            qualified_classes: z.array(taskClass).min(1),
          })
          .strict(),
      )
      .min(1),
    default_profile: identifier,
    allow_checks_only: z.boolean().default(false),
  })
  .strict();

export function defaultConfigPath(): string {
  return join(homedir(), ".config", "spillway", "config.yaml");
}
function expand(path: string): string {
  return resolve(path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
}
export function within(path: string, parent: string): boolean {
  const rel = relative(parent, path);
  return (
    rel === "" ||
    (!rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      rel !== ".." &&
      !isAbsolute(rel))
  );
}
async function canonicalFuture(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalFuture(parent), relative(parent, path));
  }
}
async function gitRoot(path: string): Promise<string | undefined> {
  try {
    const { stdout } = await execute(
      "git",
      ["-C", path, "rev-parse", "--show-toplevel"],
      { env: { PATH: process.env.PATH }, timeout: 5000 },
    );
    return await realpath(stdout.trim());
  } catch {
    return undefined;
  }
}
async function ensureOutsideRepositories(
  path: string,
  repos: string[],
): Promise<void> {
  const checkout = await realpath(
    resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  );
  if ([checkout, ...repos].some((repo) => within(path, repo)))
    throw new SpillwayError(
      "unsafe_data_path",
      "Private config and data must be outside Spillway and registered repositories",
    );
  let ancestor = path;
  while (true) {
    try {
      if ((await stat(ancestor)).isDirectory()) break;
    } catch {
      /* Find existing parent. */
    }
    if (dirname(ancestor) === ancestor) break;
    ancestor = dirname(ancestor);
  }
  if (await gitRoot(ancestor))
    throw new SpillwayError(
      "unsafe_data_path",
      "Private config and data must be outside Git repositories",
    );
}

export async function validateConfig(
  input: unknown,
  overrides: { dataDir?: string } = {},
): Promise<SpillwayConfig> {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new SpillwayError(
      "invalid_config",
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
        .join("; "),
    );
  const config = parsed.data;
  for (const list of [config.endpoints, config.profiles]) {
    if (new Set(list.map((item) => item.id)).size !== list.length)
      throw new SpillwayError(
        "invalid_config",
        "Endpoint and profile IDs must be unique",
      );
  }
  for (const endpoint of config.endpoints) {
    let url: URL;
    try {
      url = new URL(endpoint.url);
    } catch {
      throw new SpillwayError("invalid_config", "Endpoint URL is invalid");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/\/v1\/?$/.test(url.pathname)
    )
      throw new SpillwayError(
        "invalid_config",
        "Endpoint URL must be HTTP(S), end at /v1, and contain no credentials, query, or fragment",
      );
    endpoint.url = url.href.replace(/\/$/, "");
  }
  for (const profile of config.profiles) {
    if (!config.endpoints.some((endpoint) => endpoint.id === profile.endpoint))
      throw new SpillwayError(
        "invalid_config",
        "Profile refers to an unknown endpoint",
      );
    if (
      new Set(profile.qualified_classes).size !==
      profile.qualified_classes.length
    )
      throw new SpillwayError(
        "invalid_config",
        "Qualified classes must be unique",
      );
  }
  if (!config.profiles.some((profile) => profile.id === config.default_profile))
    throw new SpillwayError("invalid_config", "Default profile is unknown");
  const repositories = [];
  for (const repo of config.repositories) {
    let path: string;
    try {
      path = await realpath(expand(repo.path));
    } catch {
      throw new SpillwayError(
        "invalid_config",
        "Registered repository does not exist",
      );
    }
    if ((await gitRoot(path)) !== path)
      throw new SpillwayError(
        "invalid_config",
        "Registered repository must be a Git worktree root",
      );
    repositories.push({ ...repo, path });
  }
  if (
    new Set(repositories.map((repo) => repo.path)).size !== repositories.length
  )
    throw new SpillwayError(
      "invalid_config",
      "Registered repositories must be unique",
    );
  const data_dir = await canonicalFuture(
    expand(
      overrides.dataDir ?? config.data_dir ?? join(homedir(), ".spillway"),
    ),
  );
  await ensureOutsideRepositories(
    data_dir,
    repositories.map((repo) => repo.path),
  );
  await mkdir(data_dir, { recursive: true, mode: 0o700 });
  await chmod(data_dir, 0o700);
  return { ...config, repositories, data_dir };
}

export async function loadConfig(
  path = defaultConfigPath(),
  overrides: { dataDir?: string } = {},
): Promise<SpillwayConfig> {
  const configPath = await realpath(expand(path));
  await ensureOutsideRepositories(configPath, []);
  if ((await stat(configPath)).size > 256 * 1024)
    throw new SpillwayError(
      "invalid_config",
      "Configuration must be under 256 KiB",
    );
  const config = await validateConfig(
    parseYaml(await readFile(configPath, "utf8")),
    overrides,
  );
  await ensureOutsideRepositories(
    configPath,
    config.repositories.map((repo) => repo.path),
  );
  await chmod(configPath, 0o600);
  return config;
}
