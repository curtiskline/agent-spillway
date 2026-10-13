#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:http";

const execute = promisify(execFile);
const checkout = dirname(dirname(fileURLToPath(import.meta.url)));
const root = await realpath(
  await mkdtemp(join(tmpdir(), "spillway-onboarding-")),
);
await chmod(root, 0o700);
const home = join(root, "home");
const artifacts = join(root, "packages");
const install = join(root, "installation");
for (const path of [home, artifacts, install])
  await mkdir(path, { mode: 0o700 });
const npmrc = join(home, "npmrc");
await writeFile(npmrc, "", { mode: 0o600 });
const cleanEnv = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: home,
  LANG: "C.UTF-8",
  LC_ALL: "C",
  TMPDIR: root,
  NPM_CONFIG_USERCONFIG: npmrc,
  NPM_CONFIG_CACHE: join(home, "npm-cache"),
  NPM_CONFIG_IGNORE_SCRIPTS: "true",
};
let stage = "build";
let catalog;
const services = [];
async function command(program, args, cwd = checkout) {
  return execute(program, args, {
    cwd,
    env: cleanEnv,
    timeout: 120000,
    maxBuffer: 2 * 1024 * 1024,
  });
}
try {
  await command("npm", ["run", "build"]);
  stage = "pack";
  const packed = JSON.parse(
    (
      await command("npm", [
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        artifacts,
      ])
    ).stdout,
  );
  assert.equal(packed.length, 1);
  for (const version of [1, 2, 3]) {
    assert.ok(
      packed[0].files.some(
        (file) => file.path === `eval/workload-v${version}/workload.json`,
      ),
    );
  }
  assert.ok(
    !packed[0].files.some((file) =>
      /(?:service\.json|queue\.sqlite|config\.yaml|\.env)$/.test(file.path),
    ),
  );
  for (const path of ["eval/tasks/v1/manifest.json", "eval/tasks/v1/checks/greeting.cjs", "dist/doctor.js", "dist/pilot.js", "scripts/plugin-footprint.mjs"]) {
    assert.ok(packed[0].files.some(file => file.path === path));
  }
  stage = "install";
  await command(
    "npm",
    [
      "install",
      "--prefix",
      install,
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      join(artifacts, packed[0].filename),
    ],
    home,
  );
  const packageDir = join(install, "node_modules", "agent-spillway");
  const packageManifest = JSON.parse(
    await readFile(join(packageDir, "package.json"), "utf8"),
  );
  await access(join(packageDir, "dist", "qualification.js"));
  await access(join(packageDir, "scripts", "harness-wire-smoke.mjs"));
  for (const version of [1, 2, 3]) {
    await access(join(packageDir, "eval", `workload-v${version}`, "acceptance.cjs"));
  }
  stage = "workload-versions";
  const { qualificationWorkloadHash } = await import(
    pathToFileURL(join(packageDir, "dist", "qualification.js")).href
  );
  const workloadPath = join(packageDir, "eval", "workload-v3", "workload.json");
  const originalWorkload = await readFile(workloadPath, "utf8");
  const workloadManifest = JSON.parse(originalWorkload);
  assert.equal(workloadManifest.version, 3);
  for (const version of [1, 2]) {
    assert.equal(
      JSON.parse(await readFile(join(packageDir, "eval", `workload-v${version}`, "workload.json"), "utf8")).version,
      version,
    );
  }
  const workloadHash = await qualificationWorkloadHash();
  try {
    for (const version of [1, 2, 4]) {
      await writeFile(workloadPath, JSON.stringify({ ...workloadManifest, version }), { mode: 0o600 });
      await assert.rejects(
        qualificationWorkloadHash,
        (error) => error.issues?.some((issue) => issue.path[0] === "version" && issue.expected === 3),
      );
    }
  } finally {
    await writeFile(workloadPath, originalWorkload, { mode: 0o600 });
  }
  assert.equal(await qualificationWorkloadHash(), workloadHash);
  stage = "plugin-manifests";
  const plugin = JSON.parse(
    await readFile(
      join(packageDir, "plugins", "spillway", ".claude-plugin", "plugin.json"),
      "utf8",
    ),
  );
  assert.equal(plugin.name, "spillway");
  assert.equal(plugin.version, packageManifest.version);
  const marketplace = JSON.parse(
    await readFile(
      join(packageDir, ".claude-plugin", "marketplace.json"),
      "utf8",
    ),
  );
  assert.equal(marketplace.name, "agent-spillway");
  assert.equal(marketplace.plugins[0].source, "./plugins/spillway");
  assert.deepEqual(
    JSON.parse(
      await readFile(
        join(packageDir, "plugins", "spillway", ".mcp.json"),
        "utf8",
      ),
    ),
    { spillway: { command: "spillway", args: ["mcp"] } },
  );
  for (const name of ["bank", "status", "setup"])
    assert.match(
      await readFile(
        join(packageDir, "plugins", "spillway", "skills", name, "SKILL.md"),
        "utf8",
      ),
      new RegExp(`name: ${name}`),
    );
  for (const name of ["reviewer", "frontier-worker"])
    await access(
      join(packageDir, "plugins", "spillway", "agents", `${name}.md`),
    );
  assert.ok(
    JSON.parse(
      await readFile(
        join(packageDir, "plugins", "spillway", "hooks", "hooks.json"),
        "utf8",
      ),
    ).hooks.SessionStart,
  );

  catalog = createServer((_request, response) =>
    response.end(JSON.stringify({ data: [{ id: "fixture-model" }] })),
  );
  await new Promise((done) => catalog.listen(0, "127.0.0.1", done));
  const catalogAddress = catalog.address();
  assert.ok(catalogAddress && typeof catalogAddress === "object");
  const { Client } = await import(
    pathToFileURL(
      join(
        install,
        "node_modules",
        "@modelcontextprotocol",
        "sdk",
        "dist",
        "esm",
        "client",
        "index.js",
      ),
    ).href
  );
  const { StdioClientTransport } = await import(
    pathToFileURL(
      join(
        install,
        "node_modules",
        "@modelcontextprotocol",
        "sdk",
        "dist",
        "esm",
        "client",
        "stdio.js",
      ),
    ).href
  );

  for (const [label, directory, entry] of [
    ["source", checkout, join(checkout, "dist", "cli.js")],
    ["package", packageDir, join(install, "node_modules", ".bin", "spillway")],
  ]) {
    stage = `${label}-pilot`;
    const pilot = JSON.parse((await command(process.execPath, [entry, "pilot", "create", join(root, `${label}-pilot`)], home)).stdout);
    assert.equal(pilot.suiteVersion, 1);
    assert.equal(pilot.tasks.length, 3);
    assert.match(pilot.suiteHash, /^[a-f0-9]{64}$/);
    assert.equal((await command("git", ["rev-parse", "HEAD"], pilot.repo)).stdout.trim(), pilot.baseSha);
    assert.equal((await command("git", ["status", "--porcelain"], pilot.repo)).stdout.trim(), "");
    for (const task of pilot.tasks) assert.ok((await readFile(task.path, "utf8")).includes(pilot.baseSha));
    stage = `${label}-footprint`;
    const footprint = JSON.parse((await command(process.execPath, [join(directory, "scripts", "plugin-footprint.mjs")], home)).stdout);
    assert.equal(footprint.scope, "static-plugin-assets");
    assert.equal(footprint.tokenCount, null);
    assert.ok(footprint.totals.descriptorBytes > 0);
    assert.ok(footprint.entries.some(entry => entry.path === ".mcp.json"));
    stage = `${label}-fixture`;
    const { startService } = await import(
      pathToFileURL(join(directory, "dist", "server.js")).href
    );
    const { runProcess } = await import(
      pathToFileURL(join(directory, "dist", "process.js")).href
    );
    const repo = join(root, `${label}-repo`);
    const dataDir = join(root, `${label}-data`);
    for (const path of [repo, join(repo, "src"), join(repo, "checks"), dataDir])
      await mkdir(path, { mode: 0o700 });
    await writeFile(
      join(repo, "src", "message.cjs"),
      "module.exports=()=> 'wrong';\n",
    );
    await writeFile(
      join(repo, "checks", "acceptance.cjs"),
      "require('node:assert/strict').equal(require('../src/message.cjs')(), 'hello');\n",
    );
    for (const args of [
      ["init", "-b", "main"],
      ["config", "user.name", "Spillway Onboarding Fixture"],
      ["config", "user.email", "onboarding@example.invalid"],
      ["add", "."],
      ["-c", "core.hooksPath=/dev/null", "commit", "-m", "Fixture baseline"],
    ])
      await command("git", args, repo);
    const worker = join(root, `${label}-worker.cjs`);
    await writeFile(
      worker,
      `const fs=require('node:fs'),cp=require('node:child_process');fs.writeFileSync('src/message.cjs',"module.exports=()=> 'hello';\\n");for(const args of [['add','src/message.cjs'],['commit','-m','Fixture edit']])cp.execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{stdio:'pipe'});console.log('Fixture-only completion');`,
    );
    const adapter = {
      id: "opencode",
      async version() {
        return "fixture-v1";
      },
      async run(input) {
        const result = await runProcess({
          command: process.execPath,
          args: [worker],
          cwd: input.worktree,
          env: cleanEnv,
          timeoutMs: 10000,
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
    const config = {
      version: 1,
      data_dir: dataDir,
      port: 0,
      poll_interval_ms: 1000,
      repositories: [{ path: repo, data_policy: "local-only" }],
      endpoints: [
        {
          id: "fixture",
          kind: "local",
          url: `http://127.0.0.1:${catalogAddress.port}/v1`,
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
          qualified_classes: ["mechanical"],
        },
      ],
      default_profile: "fixture",
      allow_checks_only: true,
      audit_rate: 0,
    };
    const service = await startService(config, { once: true, adapter });
    services.push(service);
    const configPath = join(home, `${label}-config.yaml`);
    await writeFile(
      configPath,
      JSON.stringify({ ...config, port: Number(new URL(service.url).port) }),
      { mode: 0o600 },
    );
    const task = join(home, `${label}-task.md`);
    const id = `onboarding-${label}`;
    await writeFile(
      task,
      `---\nid: ${id}\nrepo: ${JSON.stringify(repo)}\nbase: main\nclass: mechanical\nscope: [src/message.cjs]\nprotected: [checks/**]\ncontext: [src/message.cjs]\nchecks: [node checks/acceptance.cjs]\nreview: checks-only\n---\n\n## Objective\nReturn hello.\n\n## Acceptance criteria\nProtected acceptance passes.\n`,
      { mode: 0o600 },
    );
    const cli = (args) =>
      command(
        process.execPath,
        [entry, "--config", configPath, "--data-dir", dataDir, ...args],
        home,
      );
    assert.equal(
      (await cli(["--version"])).stdout.trim(),
      packageManifest.version,
    );
    const diagnostic = JSON.parse((await cli(["doctor", "--json"])).stdout);
    assert.equal(diagnostic.ok, true);
    assert.ok(diagnostic.checks.some(check => check.id === "qualification" && check.status === "warning"));
    assert.ok(!(await cli(["doctor"])).stdout.includes(config.endpoints[0].url));
    await cli(["lint", task]);
    await cli(["add", task]);
    assert.equal(JSON.parse((await cli(["run", "--once"])).stdout).taskId, id);
    assert.equal(
      JSON.parse((await cli(["show", id])).stdout).task.state,
      "ready",
    );
    await cli(["accept", id]);
    assert.equal(
      JSON.parse((await cli(["show", id])).stdout).task.state,
      "accepted",
    );
    assert.match(
      (await command("git", ["show", "main:src/message.cjs"], repo)).stdout,
      /wrong/,
    );
    stage = `${label}-mcp`;
    const mcp = new Client({
      name: "isolated-onboarding-fixture",
      version: "1.0.0",
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry, "--config", configPath, "--data-dir", dataDir, "mcp"],
      env: cleanEnv,
      cwd: home,
      stderr: "pipe",
    });
    try {
      await mcp.connect(transport);
      assert.deepEqual(
        (await mcp.listTools()).tools.map((tool) => tool.name).sort(),
        ["add_task", "get_result", "get_task", "list_tasks", "queue_status"],
      );
      assert.notEqual(
        (await mcp.callTool({ name: "queue_status", arguments: {} })).isError,
        true,
      );
      assert.notEqual(
        (await mcp.callTool({ name: "get_result", arguments: { id } })).isError,
        true,
      );
    } finally {
      await mcp.close();
    }
    await service.close();
  }
  process.stdout.write(
    "Isolated-home source/package CLI, MCP, plugin-manifest and verified Git fixture onboarding passed. No daemon managers or paid inference were called. Live Claude sessions and clean OS onboarding remain separate gates.\n",
  );
} catch {
  process.stderr.write(
    `Fixture onboarding failed during ${stage}. No real provider or service-manager operation was requested.\n`,
  );
  process.exitCode = 1;
} finally {
  for (const service of services) await service.close();
  if (catalog) {
    catalog.closeAllConnections();
    await new Promise((done) => catalog.close(done));
  }
  await rm(root, { recursive: true, force: true });
}
