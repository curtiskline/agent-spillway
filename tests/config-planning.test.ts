import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { planConfig, validateConfig } from "../src/config.js";
import { fixture } from "./helpers.js";
import { gitCommand } from "../src/git.js";
import { validateCredentialFile } from "../src/credentials.js";

describe("read-only configuration planning", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(); });
  afterEach(async () => { await f.cleanup(); });
  const input = () => ({ ...f.config, port: 7433 });
  it("validates prospective private paths with empty class grants before creating anything", async () => {
    const dataDir = join(f.root, "prospective", "data");
    const config = input();
    config.profiles[0]!.qualified_classes = [];
    const before = await readdir(f.root);
    const planned = await planConfig(config, { dataDir });
    expect(planned.data_dir).toBe(dataDir);
    expect(planned.profiles[0]!.qualified_classes).toEqual([]);
    expect(planned.repositories[0]!.data_policy).toBe("local-only");
    expect(planned.allow_checks_only).toBe(config.allow_checks_only);
    expect(planned.policy?.classes.risky.review).toBe("frontier");
    expect(await readdir(f.root)).toEqual(before);
    await expect(lstat(join(f.root, "prospective"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.calls).toBe(0);
  });
  it("does not chmod or rewrite an existing directory during planning; existing preparation remains explicit", async () => {
    const dataDir = join(f.root, "existing");
    await mkdir(dataDir, { mode: 0o755 });
    await chmod(dataDir, 0o755);
    const path = join(dataDir, "sentinel");
    await writeFile(path, "preserve");
    const before = await lstat(dataDir);
    const config = input();
    await planConfig(config, { dataDir });
    const after = await lstat(dataDir);
    expect(after.mode).toBe(before.mode);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(path, "utf8")).toBe("preserve");
    await validateConfig(config, { dataDir });
    expect((await lstat(dataDir)).mode & 0o777).toBe(0o700);
    expect(await readFile(path, "utf8")).toBe("preserve");
  });
  it("preserves strict field/class/binding and outside-repository validation without writes", async () => {
    const dataDir = join(f.root, "not-created");
    const before = await readdir(f.root);
    for (const config of [
      { ...input(), private_extra: "rejected" },
      { ...input(), profiles: [{ ...input().profiles[0]!, qualified_classes: ["unknown"] }] },
      { ...input(), profiles: [{ ...input().profiles[0]!, qualified_classes: ["mechanical", "mechanical"] }] },
      { ...input(), profiles: [{ ...input().profiles[0]!, endpoint: "missing" }] },
    ]) await expect(planConfig(config, { dataDir })).rejects.toThrow();
    await expect(planConfig(input(), { dataDir: join(f.repo, "private") })).rejects.toMatchObject({ code: "unsafe_data_path" });
    expect(await readdir(f.root)).toEqual(before);
  });
  it("refuses prospective state and credential references inside bare Git repositories", async () => {
    const bare = join(f.root, "bare.git");
    await mkdir(bare, { mode: 0o700 });
    await gitCommand(bare, ["init", "--bare"]);
    await expect(planConfig(input(), { dataDir: join(bare, "private") })).rejects.toMatchObject({ code: "unsafe_data_path" });
    const reference = join(bare, "private-reference");
    await writeFile(reference, "fixture-reference", { mode: 0o600 });
    await expect(validateCredentialFile(reference)).rejects.toMatchObject({ code: "invalid_credential" });
    await expect(lstat(join(bare, "private"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
