import { it, expect } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  chmod,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { getEndpointCredential } from "../src/credentials.js";
const endpoint = {
  id: "fixture",
  kind: "local" as const,
  url: "http://127.0.0.1:1/v1",
};
it("resolves only explicitly selected env or private file references", async () => {
  const root = await mkdtemp(join(tmpdir(), "spillway-keys-"));
  await chmod(root, 0o700);
  const path = join(root, "key");
  await writeFile(path, "fixture-only-credential\n", { mode: 0o600 });
  try {
    expect(
      await getEndpointCredential({ ...endpoint, api_key_file: path }),
    ).toBe("fixture-only-credential");
    expect(await getEndpointCredential(endpoint)).toBeUndefined();
    process.env.SPILLWAY_CREDENTIAL_FIXTURE = "selected-fixture";
    expect(
      await getEndpointCredential({
        ...endpoint,
        api_key_env: "SPILLWAY_CREDENTIAL_FIXTURE",
      }),
    ).toBe("selected-fixture");
    await expect(
      getEndpointCredential({
        ...endpoint,
        api_key_file: path,
        api_key_env: "SPILLWAY_CREDENTIAL_FIXTURE",
      }),
    ).rejects.toThrow("Credential reference");
  } finally {
    delete process.env.SPILLWAY_CREDENTIAL_FIXTURE;
    await rm(root, { recursive: true, force: true });
  }
});
it("rejects exposed files, symlinks, repository keys and malformed key values", async () => {
  const root = await mkdtemp(join(tmpdir(), "spillway-keys-"));
  await chmod(root, 0o700);
  const path = join(root, "key");
  await writeFile(path, "fixture", { mode: 0o644 });
  try {
    await expect(
      getEndpointCredential({ ...endpoint, api_key_file: path }),
    ).rejects.toThrow("Credential reference");
    await chmod(path, 0o600);
    const link = join(root, "link");
    await symlink(path, link);
    await expect(
      getEndpointCredential({ ...endpoint, api_key_file: link }),
    ).rejects.toThrow("Credential reference");
    const parentLink = join(root, "parent-link");
    await symlink(root, parentLink);
    await expect(
      getEndpointCredential({
        ...endpoint,
        api_key_file: join(parentLink, "key"),
      }),
    ).rejects.toThrow("Credential reference");
    await writeFile(path, "line1\nline2");
    await expect(
      getEndpointCredential({ ...endpoint, api_key_file: path }),
    ).rejects.toThrow("Credential reference");
    const repo = join(root, "repo");
    await mkdir(repo, { mode: 0o700 });
    execFileSync("git", ["init", "-q", repo]);
    const key = join(repo, "key");
    await writeFile(key, "fixture", { mode: 0o600 });
    await expect(
      getEndpointCredential({ ...endpoint, api_key_file: key }),
    ).rejects.toThrow("Credential reference");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
