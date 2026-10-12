import {
  access,
  lstat,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installService,
  manageService,
  renderLaunchAgent,
  renderUserUnit,
  SERVICE_LABEL,
  SERVICE_UNIT,
  type ManagerCommand,
  type InstallOptions,
  type ServiceDefinition,
} from "../src/service-manager.js";

const execute = promisify(execFile);
describe("per-user service management without real daemon actions", () => {
  let root: string;
  let options: InstallOptions;
  let commands: ManagerCommand[];
  let loaded: boolean;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "spillway-manager-")));
    const homeDir = join(root, "home");
    const repo = join(root, "repo");
    await mkdir(homeDir);
    await mkdir(repo);
    await execute("git", ["init", repo]);
    const configPath = join(root, "config.yaml");
    const dataDir = join(root, "private");
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        data_dir: dataDir,
        repositories: [{ path: repo }],
        endpoints: [
          { id: "fixture", kind: "local", url: "http://127.0.0.1:1/v1" },
        ],
        profiles: [
          {
            id: "fixture",
            endpoint: "fixture",
            model: "fixture",
            model_artifact: "fixture-only",
            harness: "opencode",
            harness_version: "fixture",
            qualified_classes: ["tests"],
          },
        ],
        default_profile: "fixture",
      }),
      { mode: 0o600 },
    );
    const nodePath = join(root, "node fixture");
    const cliPath = join(root, "cli fixture.js");
    await writeFile(nodePath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await writeFile(cliPath, "// fixture CLI");
    commands = [];
    loaded = false;
    options = {
      platform: "darwin",
      uid: 1234,
      homeDir,
      configPath,
      nodePath,
      cliPath,
      environmentPath: "/usr/bin:/bin",
      executor: async (command) => {
        commands.push(command);
        const action =
          command.args[0] === "--user" ? command.args[1] : command.args[0];
        if (action === "print" || action === "is-active")
          return {
            exitCode: loaded ? 0 : 1,
            stdout: loaded
              ? action === "print"
                ? "state = running\ninherited environment = PRIVATE_DO_NOT_RETURN"
                : "active\n"
              : "",
          };
        if (action === "bootstrap" || action === "restart") loaded = true;
        if (action === "bootout" || action === "stop") loaded = false;
        return { exitCode: 0, stdout: "" };
      },
    };
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  it("installs a private launch agent with pinned paths and clean environment", async () => {
    const result = await installService(options);
    const text = await readFile(result.path, "utf8");
    expect(result.path).toBe(
      join(
        options.homeDir!,
        "Library",
        "LaunchAgents",
        `${SERVICE_LABEL}.plist`,
      ),
    );
    expect(text).toContain(
      "<string>/usr/bin/env</string><string>-i</string><string>PATH=/usr/bin:/bin</string>",
    );
    expect(text).toContain(
      `<string>${options.nodePath}</string><string>${options.cliPath}</string>`,
    );
    expect(text).not.toContain("OPENAI_API_KEY");
    expect(text).not.toContain("NODE_OPTIONS");
    expect((await lstat(result.path)).mode & 0o777).toBe(0o600);
    const logs = join(root, "private", "service");
    expect((await lstat(logs)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(logs, "stdout.log"))).mode & 0o777).toBe(0o600);
    expect(commands).toContainEqual({
      command: "/bin/launchctl",
      args: ["bootstrap", "gui/1234", result.path],
      env: { HOME: options.homeDir, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    });
    if (process.platform === "darwin")
      await execute("/usr/bin/plutil", ["-lint", result.path]);
  });
  it("supports launch agent lifecycle and never deletes config/data/logs", async () => {
    const result = await installService({ ...options, start: false });
    expect(commands).toHaveLength(0);
    expect(await manageService("status", options)).toMatchObject({
      installed: true,
      running: false,
    });
    await manageService("start", options);
    expect(await manageService("status", options)).toMatchObject({
      running: true,
    });
    expect(
      JSON.stringify(await manageService("status", options)),
    ).not.toContain("PRIVATE_DO_NOT_RETURN");
    await manageService("stop", options);
    expect(await manageService("status", options)).toMatchObject({
      running: false,
    });
    await manageService("uninstall", options);
    await expect(access(result.path)).rejects.toThrow();
    await access(options.configPath!);
    await access(join(root, "private", "service", "stdout.log"));
    expect(await manageService("uninstall", options)).toMatchObject({
      installed: false,
    });
  });
  it("renders and manages systemd --user with no root or shell commands", async () => {
    options.platform = "linux";
    const result = await installService(options);
    const text = await readFile(result.path, "utf8");
    expect(result.path).toBe(
      join(options.homeDir!, ".config", "systemd", "user", SERVICE_UNIT),
    );
    expect(text).toContain('ExecStart=:/usr/bin/env "-i" "PATH=/usr/bin:/bin"');
    expect(text).toContain(
      `WorkingDirectory=${join(root, "private", "service")}`,
    );
    expect(text).toContain(
      `StandardOutput=append:${join(root, "private", "service", "stdout.log")}`,
    );
    expect(
      commands.every(
        (command) =>
          command.command === "/usr/bin/systemctl" &&
          command.args[0] === "--user",
      ),
    ).toBe(true);
    expect(commands.map((command) => command.args)).toEqual([
      ["--user", "daemon-reload"],
      ["--user", "enable", SERVICE_UNIT],
      ["--user", "restart", SERVICE_UNIT],
    ]);
    expect(await manageService("status", options)).toMatchObject({
      running: true,
    });
    await manageService("stop", options);
    await manageService("uninstall", options);
    expect(commands.map((command) => command.args)).toContainEqual([
      "--user",
      "disable",
      SERVICE_UNIT,
    ]);
    await access(options.configPath!);
  });
  it("restarts an active Linux service after reinstalling changed pins and preserves private data", async () => {
    options.platform = "linux";
    const installed = await installService(options);
    expect(await manageService("status", options)).toMatchObject({
      running: true,
    });
    const configBefore = await readFile(options.configPath!, "utf8");
    const log = join(root, "private", "service", "stdout.log");
    await writeFile(log, "preserved service evidence\n");
    const nextNode = join(root, "updated node");
    await writeFile(nextNode, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    commands.length = 0;
    await installService({ ...options, nodePath: nextNode });
    expect(commands.map((command) => command.args)).toEqual([
      ["--user", "daemon-reload"],
      ["--user", "enable", SERVICE_UNIT],
      ["--user", "restart", SERVICE_UNIT],
    ]);
    expect(await readFile(installed.path, "utf8")).toContain(`"${nextNode}"`);
    expect(await readFile(options.configPath!, "utf8")).toBe(configBefore);
    expect(await readFile(log, "utf8")).toBe("preserved service evidence\n");
    expect(await manageService("status", options)).toMatchObject({
      running: true,
    });
    commands.length = 0;
    await manageService("start", options);
    expect(commands.map((command) => command.args)).toEqual([
      ["--user", "daemon-reload"],
      ["--user", "enable", SERVICE_UNIT],
      ["--user", "restart", SERVICE_UNIT],
    ]);
  });
  it("updates only a known file and refuses unrelated files or symlinks", async () => {
    const result = await installService({ ...options, start: false });
    await installService({ ...options, start: false, environmentPath: "/bin" });
    expect(await readFile(result.path, "utf8")).toContain(
      "<string>PATH=/bin</string>",
    );
    await writeFile(result.path, "unrelated user job");
    await expect(
      installService({ ...options, start: false }),
    ).rejects.toMatchObject({ code: "unrelated_service_file" });
    await expect(manageService("uninstall", options)).rejects.toMatchObject({
      code: "unrelated_service_file",
    });
    expect(await readFile(result.path, "utf8")).toBe("unrelated user job");
    await rm(result.path);
    await symlink(options.configPath!, result.path);
    await expect(
      installService({ ...options, start: false }),
    ).rejects.toMatchObject({ code: "unsafe_service_file" });
  });
  it("rejects substituted manager directories and log paths", async () => {
    const result = await installService({ ...options, start: false });
    const logs = join(root, "private", "service");
    await rm(join(logs, "stdout.log"));
    await symlink(options.configPath!, join(logs, "stdout.log"));
    await expect(
      installService({ ...options, start: false }),
    ).rejects.toThrow();
    await rm(join(logs, "stdout.log"));
    await writeFile(join(logs, "stdout.log"), "");
    const launchAgents = join(options.homeDir!, "Library", "LaunchAgents");
    await rm(launchAgents, { recursive: true });
    await symlink(root, launchAgents);
    await expect(manageService("status", options)).rejects.toMatchObject({
      code: "unsafe_service_file",
    });
    expect(result.path).toContain("LaunchAgents");
  });
  it("refuses hard-linked logs and non-regular definitions without blocking", async () => {
    const result = await installService({ ...options, start: false });
    const log = join(root, "private", "service", "stdout.log");
    await rm(log);
    await link(options.configPath!, log);
    await expect(
      installService({ ...options, start: false }),
    ).rejects.toMatchObject({ code: "unsafe_service_file" });
    await rm(result.path);
    await execute("mkfifo", [result.path]);
    await expect(manageService("status", options)).rejects.toMatchObject({
      code: "unsafe_service_file",
    });
  });
  it("rejects invalid inputs and reports manager failures without raw output", async () => {
    await expect(installService({ ...options, uid: 0 })).rejects.toMatchObject({
      code: "service_user",
    });
    await expect(
      installService({ ...options, nodePath: "node" }),
    ).rejects.toMatchObject({ code: "service_path" });
    await expect(
      installService({ ...options, environmentPath: "/usr/bin:." }),
    ).rejects.toMatchObject({ code: "service_path" });
    await installService({ ...options, start: false });
    await expect(
      manageService("start", {
        ...options,
        executor: async () => ({
          exitCode: 1,
          stdout: "PRIVATE_DO_NOT_RETURN",
        }),
      }),
    ).rejects.toMatchObject({ code: "service_manager" });
  });
});

describe("manager rendering escapes syntax without a shell", () => {
  const definition: ServiceDefinition = {
    nodePath: "/opt/node",
    cliPath: "/opt/code/cli.js",
    configPath: "/private/config \"<&' $X %h.yaml",
    environmentPath: "/opt/tools:/usr/bin",
    workingDir: "/private/data \"<&' $X %h",
    stdoutPath: "/private/log out.log",
    stderrPath: "/private/log err.log",
  };
  it("XML-escapes every value and disables environment inheritance", () => {
    const text = renderLaunchAgent(definition);
    expect(text).toContain("&quot;&lt;&amp;&apos;");
    expect(text).toContain("<string>-i</string>");
    expect(text).not.toContain("EnvironmentVariables");
  });
  it("quotes ExecStart arguments, escapes percent expansion and keeps scalar paths literal", () => {
    const text = renderUserUnit(definition);
    expect(text).toContain("ExecStart=:/usr/bin/env");
    expect(text).toContain('\\"<&\' $X %%h.yaml"');
    expect(text).toContain("WorkingDirectory=/private/data \"<&' $X %%h");
    expect(text).not.toContain("EnvironmentFile=");
    expect(() =>
      renderUserUnit({ ...definition, configPath: "/x\nExecStart=evil" }),
    ).toThrow();
    expect(() =>
      renderUserUnit({ ...definition, workingDir: "/bad\\" }),
    ).toThrow();
  });
});
