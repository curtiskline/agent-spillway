#!/usr/bin/env node
import { readdir, open } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseStrictJson } from "../dist/json.js";
import {
  validateCommunityProfile,
  qualificationWorkloadHash,
} from "../dist/qualification.js";

// Runtime Zod validation adds exact capability/privacy checks to the closed JSON schema.
const directory = process.argv[2]
  ? resolve(process.argv[2])
  : fileURLToPath(new URL("../profiles/community/", import.meta.url));
let count = 0;
try {
  const hash = await qualificationWorkloadHash();
  for (const name of await readdir(directory)) {
    if (!name.endsWith(".json")) continue;
    const path = resolve(directory, name);
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let profile;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 256 * 1024)
        throw new Error("Unsafe/oversized profile");
      profile = validateCommunityProfile(
        parseStrictJson(await handle.readFile("utf8")),
      );
    } finally {
      await handle.close();
    }
    if (profile.workloadHash !== hash)
      throw new Error("Workload version/hash mismatch");
    count++;
  }
  process.stdout.write(
    `Validated ${count} real community profiles. No fixture or unknown-metadata qualification claims accepted.\n`,
  );
} catch {
  process.stderr.write(
    "Community profile validation failed: check strict schema, real provenance, metadata, workload hash and observed capability evidence.\n",
  );
  process.exitCode = 1;
}
