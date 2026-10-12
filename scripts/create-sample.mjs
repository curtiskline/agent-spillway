#!/usr/bin/env node
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

// A purpose-built public pilot. Task/config/runtime data belong beside the
// repository, never inside it. This script performs no inference calls.
const parent = process.argv[2]
  ? resolve(process.argv[2])
  : await mkdtemp(join(tmpdir(), "spillway-sample-"));
await mkdir(parent, { recursive: true, mode: 0o700 });
const repo = join(await realpath(parent), "repo");
await mkdir(repo); // Refuse an existing repository instead of replacing it.
await mkdir(join(repo, "src"));
await mkdir(join(repo, "tests"));
await writeFile(
  join(repo, "src/message.cjs"),
  "module.exports = () => 'goodbye';\n",
);
await writeFile(
  join(repo, "tests/acceptance.cjs"),
  "const assert = require('node:assert/strict'); assert.equal(require('../src/message.cjs')(), 'hello');\n",
);
for (const args of [
  ["init", "-b", "main"],
  ["config", "user.name", "Spillway Sample"],
  ["config", "user.email", "sample@example.invalid"],
  ["add", "."],
  ["-c", "core.hooksPath=/dev/null", "commit", "-m", "Public sample baseline"],
])
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
const task = join(parent, "hello.md");
await writeFile(
  task,
  `---\nid: hello\nrepo: ${JSON.stringify(repo)}\nbase: main\nclass: mechanical\nscope: [src/message.cjs]\nprotected: [tests/**]\ncontext: [src/message.cjs]\nchecks: [node tests/acceptance.cjs]\nreview: checks-only\n---\n\n## Objective\nChange the message helper to return hello.\n\n## Acceptance criteria\nThe protected acceptance check passes.\nOnly src/message.cjs changes and all work is committed on spillway/hello.\n`,
  { mode: 0o600 },
);
process.stdout.write(
  JSON.stringify(
    {
      repo,
      task,
      baseSha: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repo,
        encoding: "utf8",
      }).trim(),
    },
    null,
    2,
  ) + "\n",
);
