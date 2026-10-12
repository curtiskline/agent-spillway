import { mkdtemp, mkdir, writeFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { gitCommand } from "../src/git.js";
import { runProcess } from "../src/process.js";
import type {
  HarnessAdapter,
  HarnessInput,
  SpillwayConfig,
} from "../src/contracts.js";

export async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "spillway-integration-")),
  );
  const repo = join(root, "repo");
  const data = join(root, "data");
  await mkdir(repo);
  await mkdir(data, { mode: 0o700 });
  await gitCommand(repo, ["init", "-b", "main"]);
  await gitCommand(repo, ["config", "user.email", "fixture@example.invalid"]);
  await gitCommand(repo, ["config", "user.name", "Spillway Fixture"]);
  await mkdir(join(repo, "src"));
  await mkdir(join(repo, "tests"));
  await writeFile(
    join(repo, "src/message.cjs"),
    "module.exports = () => 'wrong';\n",
  );
  await writeFile(
    join(repo, "tests/acceptance.cjs"),
    "const assert = require('node:assert/strict'); assert.equal(require('../src/message.cjs')(), 'hello');\n",
  );
  await gitCommand(repo, ["add", "."]);
  await gitCommand(repo, ["commit", "-m", "Fixture baseline"]);
  let healthy = true;
  let model = "fixture-model";
  const catalog = createServer((_req, res) => {
    res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: model }] }));
  });
  await new Promise<void>((resolve) => catalog.listen(0, "127.0.0.1", resolve));
  const address = catalog.address();
  if (!address || typeof address === "string")
    throw new Error("No catalog address");
  const config: SpillwayConfig = {
    version: 1,
    data_dir: data,
    port: 0,
    poll_interval_ms: 1000,
    repositories: [{ path: repo, data_policy: "local-only" }],
    endpoints: [
      {
        id: "fixture",
        kind: "local",
        url: `http://127.0.0.1:${address.port}/v1`,
      },
    ],
    profiles: [
      {
        id: "fixture",
        endpoint: "fixture",
        model: "fixture-model",
        model_artifact: "fixture-only",
        harness: "opencode",
        harness_version: "fixture-v1",
        qualified_classes: ["mechanical", "tests", "risky"],
      },
    ],
    default_profile: "fixture",
    allow_checks_only: true,
  };
  const markdown = (id = "hello", review = "checks-only", extra = "") =>
    `---\nid: ${id}\nrepo: ${repo}\nbase: main\nclass: mechanical\nscope: [src/message.cjs]\nprotected: [tests/**]\ncontext: [src/message.cjs]\nchecks: [node tests/acceptance.cjs]\nreview: ${review}\n${extra}---\n\n## Objective\nReturn hello from the message helper.\n\n## Acceptance criteria\nThe protected check passes.\n`;
  const script = join(root, "worker.cjs");
  await writeFile(
    script,
    `const fs=require('node:fs');const cp=require('node:child_process');fs.writeFileSync('src/message.cjs',"module.exports = () => 'hello';\\n");cp.execFileSync('git',['-c','core.hooksPath=/dev/null','add','src/message.cjs']);cp.execFileSync('git',['-c','core.hooksPath=/dev/null','commit','-m','Fixture edit']);console.log('fixture worker claim');`,
  );
  let calls = 0;
  const adapter: HarnessAdapter = {
    id: "opencode",
    async version() {
      return "fixture-v1";
    },
    async run(input: HarnessInput) {
      calls++;
      const result = await runProcess({
        command: process.execPath,
        args: [script],
        cwd: input.worktree,
        timeoutMs: input.timeoutSec * 1000,
        logPath: input.logPath,
        signal: input.signal,
      });
      return {
        exit: result.timedOut
          ? "timeout"
          : result.exitCode === 0
            ? "completed"
            : "failed",
      };
    },
  };
  return {
    root,
    repo,
    data,
    config,
    markdown,
    adapter,
    script,
    get calls() {
      return calls;
    },
    setHealthy(value: boolean) {
      healthy = value;
    },
    setModel(value: string) {
      model = value;
    },
    async cleanup() {
      await new Promise<void>((resolve) => catalog.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}
