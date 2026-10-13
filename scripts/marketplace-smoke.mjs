#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const execute = promisify(execFile);
const vendorVersion = "2.1.296";
const publicSource = "https://github.com/curtiskline/agent-spillway.git";
const pluginId = "spillway@agent-spillway";
const marketplaceName = "agent-spillway";
const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const requiredFiles = [".claude-plugin/plugin.json", ".mcp.json", "agents/auditor.md", "agents/frontier-worker.md", "agents/reviewer.md",
  "hooks/hooks.json", "scripts/session-start.sh", "skills/bank/SKILL.md", "skills/setup/SKILL.md", "skills/status/SKILL.md"].sort();
const fail = () => { throw new Error("Administrative marketplace verification refused."); };
const inside = (path, root) => { const local = relative(root, path); return local === "" || (!local.startsWith("../") && local !== ".." && !isAbsolute(local)); };

export function parseArguments(args) {
  if (!Array.isArray(args) || (args.length !== 2 && args.length !== 3) || args[0] !== "--claude" ||
    typeof args[1] !== "string" || !isAbsolute(args[1]) || /[\x00-\x1f\x7f]/.test(args[1]) || args[1].length > 4096 ||
    (args.length === 3 && args[2] !== "--public-source")) fail();
  return { executable: args[1], remote: args.length === 3 };
}
export function parseVersion(output) {
  if (typeof output !== "string" || output.trim() !== `${vendorVersion} (Claude Code)`) fail();
  return vendorVersion;
}
export function administrativeArguments(args) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== "string" || /[\x00-\x1f\x7f]/.test(arg))) fail();
  const matches = [
    args.length === 1 && args[0] === "--version",
    args.length === 3 && args[0] === "plugin" && args[1] === "validate" && isAbsolute(args[2]),
    args.length === 7 && args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add" && (isAbsolute(args[3]) || args[3] === publicSource) &&
      args[4] === "--scope" && args[5] === "user" && args[6] === "--json",
    args.length === 7 && args[0] === "plugin" && args[1] === "marketplace" && args[2] === "remove" && args[3] === marketplaceName &&
      args[4] === "--scope" && args[5] === "user" && args[6] === "--json",
    args.length === 3 && args[0] === "plugin" && args[1] === "list" && args[2] === "--json",
    args.length === 6 && args[0] === "plugin" && ["install", "disable", "enable", "uninstall"].includes(args[1]) && args[2] === pluginId &&
      args[3] === "--scope" && args[4] === "user" && args[5] === "--json",
  ];
  if (!matches.some(Boolean)) fail();
  return args;
}
async function outsideGit(path, env) {
  try { await execute("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", path, "rev-parse", "--absolute-git-dir"],
    { env, timeout: 5000, maxBuffer: 4096 }); }
  catch (error) {
    if (error.code === 128 && !error.killed && /^fatal: not a git repository(?: \(or any of the parent directories\): \.git)?\s*$/.test(error.stderr)) return;
  }
  fail();
}
async function readBounded(path, max = 256 * 1024) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > max || await realpath(path) !== path) fail();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (info.ino !== before.ino || info.dev !== before.dev || info.size !== before.size || info.mtimeMs !== before.mtimeMs) fail();
    const data = Buffer.alloc(max + 1); let length = 0;
    while (length < data.length) { const read = await handle.read(data, length, data.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
    const after = await handle.stat();
    const current = await lstat(path);
    if (length !== info.size || length > max || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs ||
      current.ino !== info.ino || current.dev !== info.dev || current.nlink !== 1 || current.isSymbolicLink()) fail();
    return data.subarray(0, length);
  } finally { await handle.close(); }
}
async function directory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) fail();
}
export async function inventoryPlugin(path) {
  const entries = new Map();
  let total = 0;
  const walk = async (current, prefix = "", depth = 0) => {
    if (depth > 8) fail();
    await directory(current);
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) fail();
      const local = prefix + entry.name;
      if (entry.isDirectory()) await walk(join(current, entry.name), local + "/", depth + 1);
      else if (entry.isFile()) {
        if (entries.size >= 64) fail();
        const data = await readBounded(join(current, entry.name)); total += data.length;
        if (total > 1024 * 1024) fail();
        entries.set(local, data);
      } else fail();
    }
  };
  await walk(path);
  assert.deepEqual([...entries.keys()].sort(), requiredFiles);
  assert.ok((await lstat(join(path, "scripts", "session-start.sh"))).mode & 0o100);
  const manifest = JSON.parse(entries.get(".claude-plugin/plugin.json").toString("utf8"));
  assert.equal(manifest.name, "spillway"); assert.equal(manifest.version, "0.0.0");
  assert.deepEqual(JSON.parse(entries.get(".mcp.json").toString("utf8")), { spillway: { command: "spillway", args: ["mcp"] } });
  const hooks = JSON.parse(entries.get("hooks/hooks.json").toString("utf8"));
  assert.deepEqual(Object.keys(hooks.hooks), ["SessionStart"]);
  assert.equal(hooks.hooks.SessionStart.length, 1);
  assert.equal(hooks.hooks.SessionStart[0].hooks.length, 1);
  assert.equal(hooks.hooks.SessionStart[0].hooks[0].command, '"${CLAUDE_PLUGIN_ROOT}/scripts/session-start.sh"');
  for (const skill of ["bank", "setup", "status"]) assert.ok(entries.get(`skills/${skill}/SKILL.md`).toString().includes(`name: ${skill}`));
  for (const agent of ["auditor", "frontier-worker", "reviewer"]) assert.ok(entries.get(`agents/${agent}.md`).toString().includes(`name: ${agent}`));
  return entries;
}
export function matchingAssets(source, installed) {
  assert.deepEqual([...source.keys()].sort(), [...installed.keys()].sort());
  for (const [path, bytes] of source) if (!Buffer.isBuffer(installed.get(path)) || !bytes.equals(installed.get(path))) fail();
}
export function assetHash(marketplace, plugin) {
  const hash = createHash("sha256");
  for (const [path, bytes] of [[".claude-plugin/marketplace.json", marketplace], ...[...plugin].map(([path, bytes]) => [`plugins/spillway/${path}`, bytes])].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
    hash.update(path).update("\0").update(String(bytes.length)).update("\0").update(bytes);
  return hash.digest("hex");
}

export function parsePluginList(output, enabled, root) {
  const list = JSON.parse(output);
  if (!Array.isArray(list)) fail();
  if (enabled === null) { assert.equal(list.length, 0); return; }
  assert.equal(list.length, 1);
  const item = list[0];
  assert.equal(item.id, pluginId); assert.equal(item.version, "0.0.0"); assert.equal(item.scope, "user");
  assert.equal(item.enabled, enabled);
  if (typeof item.installPath !== "string" || !isAbsolute(item.installPath) || !inside(item.installPath, root)) fail();
  assert.deepEqual(item.mcpServers, { spillway: { command: "spillway", args: ["mcp"] } });
  return item;
}
export function parseReceipt(output, command) {
  const receipt = JSON.parse(output);
  assert.equal(receipt.command, command); assert.equal(receipt.outcome, "ok");
  if (command.startsWith("marketplace-")) assert.equal(receipt.marketplace, marketplaceName);
  else { assert.equal(receipt.pluginId, pluginId); assert.equal(receipt.scope, "user"); }
}

export function cleanEnvironment(root) {
  const home = join(root, "home"), config = join(home, ".claude");
  return { PATH: `${join(root, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home,
    CLAUDE_CONFIG_DIR: config, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"), XDG_STATE_HOME: join(home, ".local", "state"), TMPDIR: root,
    LANG: "C", LC_ALL: "C", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
    DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never",
    GIT_ASKPASS: "/usr/bin/false", SSH_ASKPASS: "/usr/bin/false", GIT_ALLOW_PROTOCOL: "https:file",
    GIT_CONFIG_COUNT: "3", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "core.hooksPath", GIT_CONFIG_VALUE_1: "/dev/null", GIT_CONFIG_KEY_2: "core.fsmonitor", GIT_CONFIG_VALUE_2: "false" };
}
export async function marketplaceAssets(path) {
  await directory(path);
  await directory(join(path, ".claude-plugin"));
  const marketplace = await readBounded(join(path, ".claude-plugin", "marketplace.json"));
  const manifest = JSON.parse(marketplace.toString());
  assert.equal(manifest.name, marketplaceName); assert.equal(manifest.plugins.length, 1);
  assert.equal(manifest.plugins[0].name, "spillway"); assert.equal(manifest.plugins[0].version, "0.0.0");
  assert.equal(manifest.plugins[0].source, "./plugins/spillway");
  return { marketplace, plugin: await inventoryPlugin(join(path, "plugins", "spillway")) };
}
async function copySnapshot(source, snapshot) {
  const assets = await marketplaceAssets(source);
  const files = [[".claude-plugin/marketplace.json", assets.marketplace], ...[...assets.plugin].map(([path, bytes]) => [`plugins/spillway/${path}`, bytes])];
  await mkdir(snapshot, { mode: 0o700 });
  for (const [path, bytes] of files) {
    await mkdir(dirname(join(snapshot, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(snapshot, path), bytes, { flag: "wx", mode: path.endsWith(".sh") ? 0o700 : 0o600 });
  }
  return assets;
}

export async function boundedCommand(program, args, cwd, env, timeout = 30000) {
  return new Promise((done, reject) => {
    const child = spawn(program, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const chunks = []; let bytes = 0, stopped = false;
    const kill = signal => { try { if (child.pid) process.kill(-child.pid, signal); } catch {} };
    const stop = () => { stopped = true; kill("SIGKILL"); };
    const timer = setTimeout(stop, timeout);
    for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > 256 * 1024) stop();
      else if (stream === child.stdout) chunks.push(chunk);
    });
    child.on("error", () => { clearTimeout(timer); stop(); reject(new Error("Administrative command failed.")); });
    child.on("close", code => {
      clearTimeout(timer);
      // Administrative completion owns its subprocess group even if the primary
      // exited successfully while leaving an unref'ed same-group helper alive.
      kill("SIGKILL");
      if (stopped || code !== 0) reject(new Error("Administrative command failed."));
      else done(Buffer.concat(chunks).toString("utf8"));
    });
  });
}
async function markerCount(path) {
  try { return (await readBounded(path, 4096)).length; }
  catch (error) { if (error.code === "ENOENT") return 0; throw error; }
}
async function privatePath(path, root) {
  if (!isAbsolute(path) || path !== resolve(path) || !inside(path, root) || await realpath(path) !== path) fail();
  await directory(path);
  return path;
}
async function registry(config, root, remote, snapshot) {
  const known = JSON.parse((await readBounded(join(config, "plugins", "known_marketplaces.json"))).toString());
  assert.deepEqual(Object.keys(known), [marketplaceName]);
  const registration = known[marketplaceName];
  if (remote) assert.deepEqual(registration.source, { source: "git", url: publicSource });
  else assert.deepEqual(registration.source, { source: "directory", path: snapshot });
  return privatePath(registration.installLocation, root);
}
async function installedRegistry(config, root, path, remote, commit) {
  const installed = JSON.parse((await readBounded(join(config, "plugins", "installed_plugins.json"))).toString());
  assert.equal(installed.version, 2); assert.deepEqual(Object.keys(installed.plugins), [pluginId]);
  assert.equal(installed.plugins[pluginId].length, 1);
  const entry = installed.plugins[pluginId][0];
  assert.equal(entry.scope, "user"); assert.equal(entry.version, "0.0.0"); assert.equal(entry.installPath, path);
  await privatePath(entry.installPath, root);
  if (remote) assert.equal(entry.gitCommitSha, commit);
}

export async function runMarketplaceSmoke(args = process.argv.slice(2)) {
  let stage = "arguments", root, rootInfo, problem, sourceCommit = null, resultHash;
  try {
    const { executable, remote } = parseArguments(args);
    stage = "isolation";
    if (process.platform !== "darwin" && process.platform !== "linux") fail();
    const claude = await realpath(executable);
    assert.equal((await lstat(claude)).isFile(), true);
    await access(claude, constants.X_OK);
    const parent = await realpath(tmpdir());
    await outsideGit(parent, cleanEnvironment(join(parent, "uncreated-spillway-smoke")));
    root = await mkdtemp(join(parent, "spillway-marketplace-"));
    const created = await lstat(root);
    if (!created.isDirectory() || created.isSymbolicLink() || created.uid !== process.getuid?.() || (created.mode & 0o777) !== 0o700 || await realpath(root) !== root) fail();
    rootInfo = created;
    const env = cleanEnvironment(root), cwd = join(root, "workspace"), marker = join(root, "unexpected-spillway");
    for (const path of [env.HOME, env.CLAUDE_CONFIG_DIR, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME, env.XDG_STATE_HOME, join(root, "bin"), cwd])
      await mkdir(path, { recursive: true, mode: 0o700 });
    await writeFile(join(root, "bin", "spillway"), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(marker)},'1',{mode:0o600});process.exit(1);\n`, { flag: "wx", mode: 0o700 });
    const cli = async argv => {
      administrativeArguments(argv);
      const output = await boundedCommand(claude, argv, cwd, env, remote && argv[2] === "add" ? 60000 : 30000);
      assert.equal(await markerCount(marker), 0);
      return output;
    };
    const list = enabled => cli(["plugin", "list", "--json"]).then(output => parsePluginList(output, enabled, root));
    stage = "version"; parseVersion(await cli(["--version"]));
    stage = "empty-inventory"; await list(null);
    stage = "source-snapshot";
    const snapshot = join(root, "snapshot");
    if (!remote) await copySnapshot(sourceRoot, snapshot);
    stage = "validation";
    if (!remote) {
      assert.ok((await cli(["plugin", "validate", snapshot])).includes("Validation passed"));
      assert.ok((await cli(["plugin", "validate", join(snapshot, "plugins", "spillway")])).includes("Validation passed"));
    }
    stage = "marketplace-add";
    parseReceipt(await cli(["plugin", "marketplace", "add", remote ? publicSource : snapshot, "--scope", "user", "--json"]), "marketplace-add");
    const fetched = await registry(env.CLAUDE_CONFIG_DIR, root, remote, snapshot);
    const source = await marketplaceAssets(fetched);
    let commit = null;
    if (remote) {
      const git = argv => execute("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", fetched, ...argv],
        { env, cwd, timeout: 10000, maxBuffer: 4096 });
      commit = (await git(["rev-parse", "HEAD"])).stdout.trim();
      assert.match(commit, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
      assert.equal((await git(["config", "--get", "remote.origin.url"])).stdout.trim(), publicSource);
      assert.equal((await git(["status", "--porcelain"])).stdout.trim(), "");
      stage = "remote-validation";
      assert.ok((await cli(["plugin", "validate", fetched])).includes("Validation passed"));
      assert.ok((await cli(["plugin", "validate", join(fetched, "plugins", "spillway")])).includes("Validation passed"));
    } else {
      const current = await marketplaceAssets(sourceRoot);
      assert.ok(current.marketplace.equals(source.marketplace)); matchingAssets(current.plugin, source.plugin);
    }
    const hash = assetHash(source.marketplace, source.plugin);
    sourceCommit = commit; resultHash = hash;
    await writeFile(join(root, "source-identity.json"), JSON.stringify({ version: 1, sourceKind: remote ? "public-main" : "current-snapshot", commit, assetHash: hash }), { flag: "wx", mode: 0o600 });
    stage = "install";
    parseReceipt(await cli(["plugin", "install", pluginId, "--scope", "user", "--json"]), "install");
    const initial = await list(true);
    await privatePath(initial.installPath, root);
    await installedRegistry(env.CLAUDE_CONFIG_DIR, root, initial.installPath, remote, commit);
    matchingAssets(source.plugin, await inventoryPlugin(initial.installPath));
    const verify = async enabled => {
      const item = await list(enabled); assert.equal(item.installPath, initial.installPath);
      matchingAssets(source.plugin, await inventoryPlugin(item.installPath));
      const unchanged = await marketplaceAssets(fetched);
      assert.equal(assetHash(unchanged.marketplace, unchanged.plugin), hash);
    };
    stage = "disable";
    parseReceipt(await cli(["plugin", "disable", pluginId, "--scope", "user", "--json"]), "disable"); await verify(false);
    stage = "enable";
    parseReceipt(await cli(["plugin", "enable", pluginId, "--scope", "user", "--json"]), "enable"); await verify(true);
    stage = "uninstall";
    parseReceipt(await cli(["plugin", "uninstall", pluginId, "--scope", "user", "--json"]), "uninstall"); await list(null);
    const uninstalled = JSON.parse((await readBounded(join(env.CLAUDE_CONFIG_DIR, "plugins", "installed_plugins.json"))).toString());
    assert.equal(uninstalled.version, 2); assert.deepEqual(Object.keys(uninstalled.plugins), []);
    stage = "marketplace-remove";
    parseReceipt(await cli(["plugin", "marketplace", "remove", marketplaceName, "--scope", "user", "--json"]), "marketplace-remove");
    const remaining = JSON.parse((await readBounded(join(env.CLAUDE_CONFIG_DIR, "plugins", "known_marketplaces.json"))).toString());
    assert.deepEqual(Object.keys(remaining), []);
    assert.equal(await markerCount(marker), 0);
  } catch { problem = stage; }
  finally {
    if (root && rootInfo) {
      try {
        const current = await lstat(root);
        if (current.ino !== rootInfo.ino || current.dev !== rootInfo.dev || current.isSymbolicLink() || await realpath(root) !== root) fail();
        await rm(root, { recursive: true, force: false });
      } catch { problem ??= "temporary-tree-cleanup"; }
    }
  }
  if (problem) { process.stderr.write(`Administrative marketplace verification failed during ${problem}. No session, model or service operation was requested.\n`); return 1; }
  const remote = args.length === 3;
  process.stdout.write(JSON.stringify({ version: 1, claudeVersion: vendorVersion, sourceKind: remote ? "public-main" : "current-snapshot", sourceCommit, assetHash: resultHash,
    matchingAssets: true, lifecycle: true, unexpectedInvocations: 0, liveSession: false }) + "\n");
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runMarketplaceSmoke();

// Vendor layout/list parsers and the bounded lifecycle are pinned to 2.1.296.
