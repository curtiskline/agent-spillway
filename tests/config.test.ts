import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  rm,
  realpath,
  symlink,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig, validateConfig } from "../src/config.js";
import { stringify } from "yaml";
let root: string;
let repo: string;
const input = () => ({
  version: 1,
  data_dir: join(root, "private"),
  repositories: [{ path: repo }],
  endpoints: [
    { id: "fixture", kind: "local", url: "http://127.0.0.1:8080/v1" },
  ],
  profiles: [
    {
      id: "coder",
      endpoint: "fixture",
      model: "fixture-model",
      model_artifact: "fixture-hash",
      harness: "opencode",
      harness_version: "1.0.0",
      qualified_classes: ["tests"],
    },
  ],
  default_profile: "coder",
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "spillway-config-"));
  repo = join(root, "repo");
  await mkdir(repo);
  execFileSync("git", ["init", "-q", repo]);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
describe("private configuration", () => {
  it("canonicalizes repositories and creates restrictive private data", async () => {
    const config = await validateConfig(input());
    expect(config.repositories[0]?.path).toBe(await realpath(repo));
    expect(config.repositories[0]?.data_policy).toBe("local-only");
    expect(config.allow_checks_only).toBe(false);
    expect((await stat(config.data_dir)).mode & 0o777).toBe(0o700);
  });
  it("validates CLI data overrides before creating files", async () => {
    await expect(
      validateConfig(input(), { dataDir: join(repo, "private") }),
    ).rejects.toThrow(/outside/);
    const alternate = join(root, "alternate");
    const config = await validateConfig(input(), { dataDir: alternate });
    expect(config.data_dir).toBe(join(await realpath(root), "alternate"));
  });
  it("rejects symlink escapes and repository aliases", async () => {
    await symlink(repo, join(root, "alias"));
    await expect(
      validateConfig({ ...input(), data_dir: join(root, "alias", "data") }),
    ).rejects.toThrow(/outside/);
    await expect(
      validateConfig({
        ...input(),
        repositories: [{ path: repo }, { path: join(root, "alias") }],
      }),
    ).rejects.toThrow(/unique/);
  });
  it("rejects data under unregistered Git repositories too", async () => {
    const other = join(root, "other");
    await mkdir(other);
    execFileSync("git", ["init", "-q", other]);
    await expect(
      validateConfig({ ...input(), data_dir: join(other, "data") }),
    ).rejects.toThrow(/outside/);
  });
  it.each([
    "https://user:password@example.test/v1",
    "https://example.test/v1?key=secret",
    "https://example.test/v1#key",
    "file:///v1",
    "https://example.test/api",
  ])("rejects unsafe endpoint URL %s", async (url) => {
    await expect(
      validateConfig({
        ...input(),
        endpoints: [{ ...input().endpoints[0], url }],
      }),
    ).rejects.toThrow(/Endpoint URL/);
  });
  it("rejects unknown fields, missing bindings, duplicate identifiers and literal keys", async () => {
    await expect(
      validateConfig({ ...input(), api_key: "never-public" }),
    ).rejects.toThrow();
    await expect(
      validateConfig({ ...input(), default_profile: "missing" }),
    ).rejects.toThrow(/unknown/);
    await expect(
      validateConfig({
        ...input(),
        endpoints: [...input().endpoints, ...input().endpoints],
      }),
    ).rejects.toThrow(/unique/);
    await expect(
      validateConfig({
        ...input(),
        endpoints: [{ ...input().endpoints[0], api_key: "literal" }],
      }),
    ).rejects.toThrow();
    await expect(
      validateConfig({
        ...input(),
        profiles: [{ ...input().profiles[0], endpoint: "missing" }],
      }),
    ).rejects.toThrow(/unknown/);
  });
  it("requires root Git repositories", async () => {
    await mkdir(join(repo, "subdir"));
    await expect(
      validateConfig({
        ...input(),
        repositories: [{ path: join(repo, "subdir") }],
      }),
    ).rejects.toThrow(/root/);
    await expect(
      validateConfig({ ...input(), repositories: [{ path: root }] }),
    ).rejects.toThrow(/root/);
  });
  it("loads strict YAML and restricts configuration file permissions", async () => {
    const path = join(root, "config.yaml");
    await writeFile(path, stringify(input()), { mode: 0o644 });
    expect((await loadConfig(path)).default_profile).toBe("coder");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await writeFile(path, `${stringify(input())}\nversion: 1\n`);
    await expect(loadConfig(path)).rejects.toThrow(/YAML/);
  });
  it("refuses a configuration file stored inside a registered repository", async () => {
    const path = join(repo, "config.yaml");
    await writeFile(path, stringify(input()));
    await expect(loadConfig(path)).rejects.toThrow(/outside/);
  });
});
