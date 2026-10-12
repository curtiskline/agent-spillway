import { constants } from "node:fs";
import { open, lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SpillwayError, type EndpointProfile } from "./contracts.js";

const execute = promisify(execFile);
const denied = () =>
  new SpillwayError(
    "invalid_credential",
    "Credential reference must be a private owner-only regular file outside repositories.",
  );
export async function validateCredentialFile(input: string): Promise<string> {
  const path = resolve(
    input.startsWith("~/") ? join(homedir(), input.slice(2)) : input,
  );
  try {
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.isSymbolicLink() ||
      info.size < 1 ||
      info.size > 16384 ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw denied();
    const canonical = await realpath(path);
    const parent = await lstat(dirname(path));
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      (parent.mode & 0o077) !== 0 ||
      (process.getuid && parent.uid !== process.getuid())
    )
      throw denied();
    const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const rel = relative(checkout, canonical);
    if (
      rel === "" ||
      (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel))
    )
      throw denied();
    let gitRepo = false;
    try {
      await execute(
        "git",
        ["-C", dirname(canonical), "rev-parse", "--show-toplevel"],
        { env: { PATH: process.env.PATH }, timeout: 5000 },
      );
      gitRepo = true;
    } catch {
      /*outsideGit*/
    }
    if (gitRepo) throw denied();
    return canonical;
  } catch {
    throw denied();
  }
}
export async function getEndpointCredential(
  endpoint: EndpointProfile,
): Promise<string | undefined> {
  if (endpoint.api_key_env && endpoint.api_key_file) throw denied();
  if (endpoint.api_key_env) {
    const value = process.env[endpoint.api_key_env];
    if (!value)
      throw new SpillwayError(
        "missing_credential",
        "Configured endpoint credential is unavailable.",
      );
    return value;
  }
  if (!endpoint.api_key_file) return undefined;
  const path = await validateCredentialFile(endpoint.api_key_file);
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size > 16384 ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw denied();
    const buffer = Buffer.alloc(16385);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > 16384) throw denied();
    const value = buffer.subarray(0, offset).toString("utf8").trim();
    if (!value || /[\r\n]/.test(value)) throw denied();
    return value;
  } finally {
    await handle.close();
  }
}
