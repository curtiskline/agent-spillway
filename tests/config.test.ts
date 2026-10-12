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

describe("phase two policy and review profile bindings", () => {
  it("returns effective default policy without inventing a review profile", async () => {
    const config = await validateConfig(input());
    expect(config.policy?.classes.risky.review).toBe("frontier");
    expect(config.policy?.max_repairs).toBe(1);
    expect(config.review_profile).toBeUndefined();
  });
  it("accepts explicit local and hosted open-weight review bindings while retaining repo policy", async () => {
    expect(
      (await validateConfig({ ...input(), review_profile: "coder" }))
        .review_profile,
    ).toBe("coder");
    const base = input();
    const config = await validateConfig({
      ...base,
      review_profile: "reviewer",
      endpoints: [
        ...base.endpoints,
        {
          id: "hosted",
          kind: "open-weight-hosted",
          url: "https://example.test/v1",
        },
      ],
      profiles: [
        ...base.profiles,
        { ...base.profiles[0], id: "reviewer", endpoint: "hosted" },
      ],
    });
    expect(config.review_profile).toBe("reviewer");
    expect(config.repositories[0]?.data_policy).toBe("local-only");
  });
  it("rejects missing and frontier review profiles", async () => {
    await expect(
      validateConfig({ ...input(), review_profile: "missing" }),
    ).rejects.toThrow(/unknown/);
    const base = input();
    await expect(
      validateConfig({
        ...base,
        review_profile: "coder",
        endpoints: [{ ...base.endpoints[0], kind: "frontier" }],
      }),
    ).rejects.toThrow(/local or open-weight/);
  });
  it("does not allow custom policy to bypass hard invariants", async () => {
    const { defaultPolicy } = await import("../src/policy.js");
    const policy = defaultPolicy();
    policy.classes.risky.review = "checks-only";
    await expect(validateConfig({ ...input(), policy })).rejects.toThrow(
      /frontier/,
    );
    const good = defaultPolicy();
    good.max_repairs = 0;
    good.classes.mechanical.review = "checks-only";
    const config = await validateConfig({ ...input(), policy: good });
    expect(config.policy?.max_repairs).toBe(0);
  });
});

describe("private credential file references", () => {
  it("validates file metadata without copying secret content into config", async () => {
    const path = join(root, "dummy-key");
    const dummy = "fixture-only-dummy-value";
    await writeFile(path, dummy, { mode: 0o600 });
    const base = input();
    const config = await validateConfig({
      ...base,
      endpoints: [{ ...base.endpoints[0], api_key_file: path }],
    });
    expect(config.endpoints[0]?.api_key_file).toBe(await realpath(path));
    expect(JSON.stringify(config)).not.toContain(dummy);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
  it("rejects simultaneous env/file refs before reading or creating private data", async () => {
    const base = input();
    await expect(
      validateConfig({
        ...base,
        endpoints: [
          {
            ...base.endpoints[0],
            api_key_env: "FIXTURE_KEY",
            api_key_file: join(root, "missing"),
          },
        ],
      }),
    ).rejects.toThrow(/one credential/);
  });
  it("rejects world-readable, symlinked and repository credential files", async () => {
    const base = input();
    const publicPath = join(root, "public-key");
    await writeFile(publicPath, "fixture-only", { mode: 0o644 });
    await expect(
      validateConfig({
        ...base,
        endpoints: [{ ...base.endpoints[0], api_key_file: publicPath }],
      }),
    ).rejects.toThrow(/private/);
    const key = join(root, "key");
    await writeFile(key, "fixture-only", { mode: 0o600 });
    const link = join(root, "key-link");
    await symlink(key, link);
    await expect(
      validateConfig({
        ...base,
        endpoints: [{ ...base.endpoints[0], api_key_file: link }],
      }),
    ).rejects.toThrow(/private/);
    const repoKey = join(repo, "key");
    await writeFile(repoKey, "fixture-only", { mode: 0o600 });
    await expect(
      validateConfig({
        ...base,
        endpoints: [{ ...base.endpoints[0], api_key_file: repoKey }],
      }),
    ).rejects.toThrow(/private/);
  });
});

describe("phase three publication and audit defaults", () => {
  it("keeps publication opt-in separate from inference policy and defaults audits to 30 percent", async () => {
    const base = input();
    const config = await validateConfig(base);
    expect(config.audit_rate).toBe(0.3);
    expect(config.repositories[0]?.publication).toBeUndefined();
    const granted = await validateConfig({
      ...base,
      audit_rate: 0,
      repositories: [
        {
          path: repo,
          data_policy: "local-only",
          publication: { public_url: "https://github.com/public/pilot" },
        },
      ],
    });
    expect(granted.audit_rate).toBe(0);
    expect(granted.repositories[0]?.data_policy).toBe("local-only");
    expect(granted.repositories[0]?.publication?.public_url).toBe(
      "https://github.com/public/pilot",
    );
  });
  it("rejects invalid audit rates and non-publication-shaped URLs before writing private state", async () => {
    for (const rate of [-0.1, 1.1, Infinity])
      await expect(
        validateConfig({ ...input(), audit_rate: rate }),
      ).rejects.toThrow();
    for (const url of [
      "https://private.example/repo",
      "https://github.com/a/b?token=x",
      "https://user:pass@github.com/a/b",
      "https://github.com/a/b/../../c",
    ])
      await expect(
        validateConfig({
          ...input(),
          repositories: [{ path: repo, publication: { public_url: url } }],
        }),
      ).rejects.toThrow();
  });
});
