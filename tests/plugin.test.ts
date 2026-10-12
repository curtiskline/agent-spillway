import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/contracts.js";

const json = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
describe("plugin scaffold", () => {
  it("uses matching versions, local marketplace source and installed CLI", async () => {
    const manifest = await json("plugins/spillway/.claude-plugin/plugin.json");
    expect(manifest.name).toBe("spillway");
    expect(manifest.version).toBe(VERSION);
    const marketplace = await json(".claude-plugin/marketplace.json");
    expect(marketplace.name).toBe("agent-spillway");
    expect(marketplace.plugins).toEqual([
      {
        name: "spillway",
        source: "./plugins/spillway",
        description:
          "Pre-alpha task banking and queue visibility for Agent Spillway",
        version: VERSION,
      },
    ]);
    expect(await json("plugins/spillway/.mcp.json")).toEqual({
      spillway: { command: "spillway", args: ["mcp"] },
    });
    for (const skill of ["bank", "status", "setup"])
      expect(
        await readFile(`plugins/spillway/skills/${skill}/SKILL.md`, "utf8"),
      ).toContain(`name: ${skill}`);
    for (const agent of ["reviewer", "frontier-worker"]) {
      const text = await readFile(
        `plugins/spillway/agents/${agent}.md`,
        "utf8",
      );
      expect(text).toContain(`name: ${agent}`);
      expect(text).toContain("owner-session attestation");
      expect(text).toContain("untrusted");
      expect(text).toContain("frontier-ok");
    }
    const hooks = await readFile("plugins/spillway/hooks/hooks.json", "utf8");
    expect(hooks).toContain("SessionStart");
    expect(hooks).toContain("session-start.sh");
  });
  it("session hook invokes installed CLI and degrades safely without it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spillway-hook-"));
    try {
      const command = join(dir, "spillway");
      await writeFile(
        command,
        '#!/bin/sh\nif [ "$1" != session-summary ]; then exit 1; fi\nprintf "%s\\n" "fixture queue summary"\n',
      );
      await chmod(command, 0o700);
      const run = (path: string) =>
        new Promise<string>((done, fail) =>
          execFile(
            "/bin/sh",
            [resolve("plugins/spillway/scripts/session-start.sh")],
            { env: { PATH: path }, timeout: 2000 },
            (error, stdout) => (error ? fail(error) : done(stdout)),
          ),
        );
      expect(await run(dir)).toContain("fixture queue summary");
      await rm(command);
      expect(await run(dir)).toContain("CLI is not installed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
