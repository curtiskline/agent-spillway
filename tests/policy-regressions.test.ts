import { describe, it, expect } from "vitest";
import { parseTask } from "../src/task.js";
import { Controller } from "../src/controller.js";
import { Store } from "../src/store.js";
import { OpenCodeAdapter } from "../src/harness.js";
import { fixture } from "./helpers.js";
import { writeFile, chmod, readFile } from "node:fs/promises";
import { join } from "node:path";

describe("independent review regressions", () => {
  it("honors checks-only revocation before dispatch", async () => {
    const f = await fixture();
    const store = new Store(f.data);
    const c = new Controller(f.config, store, f.adapter);
    try {
      await c.addTask(f.markdown());
      f.config.allow_checks_only = false;
      expect(await c.runOnce()).toBeNull();
      expect(c.getDetail("hello").task.state).toBe("held");
      expect(f.calls).toBe(0);
    } finally {
      store.close();
      await f.cleanup();
    }
  });
  it("rejects negated globs instead of allowing out-of-scope paths", async () => {
    const f = await fixture();
    try {
      expect(() =>
        parseTask(
          f
            .markdown()
            .replace(
              "scope: [src/message.cjs]",
              "scope: ['src/**', '!src/private/**']",
            ),
        ),
      ).toThrow(/negation/);
      expect(() =>
        parseTask(
          f
            .markdown()
            .replace("protected: [tests/**]", "protected: ['!tests/**']"),
        ),
      ).toThrow(/negation/);
    } finally {
      await f.cleanup();
    }
  });
  it("integrates Controller with the real OpenCode adapter against a subprocess fixture", async () => {
    const f = await fixture();
    const store = new Store(f.data);
    try {
      const executable = join(f.root, "fixture-opencode");
      await writeFile(
        executable,
        `#!/usr/bin/env node\nconst fs=require('node:fs'),cp=require('node:child_process');if(process.argv.includes('--version')){console.log('1.2.3');process.exit(0);}let prompt='';process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',()=>{if(!prompt.includes('Return hello'))process.exit(2);fs.writeFileSync('src/message.cjs',"module.exports=()=> 'hello';\\n");cp.execFileSync('git',['-c','core.hooksPath=/dev/null','add','.']);cp.execFileSync('git',['-c','core.hooksPath=/dev/null','commit','-m','Fixture commit'],{stdio:'ignore'});console.log(JSON.stringify({type:'step_finish',part:{reason:'stop'}}));});`,
        { mode: 0o700 },
      );
      await chmod(executable, 0o700);
      f.config.profiles[0]!.harness_version = "1.2.3";
      const c = new Controller(
        f.config,
        store,
        new OpenCodeAdapter(executable),
      );
      await c.addTask(f.markdown());
      expect(await c.runOnce()).toBe("hello");
      const detail = c.getDetail("hello");
      expect(detail.task.state).toBe("ready");
      expect(detail.attempts[0]?.verification?.passed).toBe(true);
      expect(
        await readFile(
          join(
            f.data,
            "artifacts",
            String(detail.attempts[0]!.id),
            "prompt.md",
          ),
          "utf8",
        ),
      ).toContain("Return hello");
    } finally {
      store.close();
      await f.cleanup();
    }
  }, 20000);
  it("allows exactly one transport retry preserving dirty checkout and keeping coding budget separate", async () => {
    const f = await fixture();
    const store = new Store(f.data);
    let calls = 0;
    const adapter = {
      ...f.adapter,
      async run(input: Parameters<typeof f.adapter.run>[0]) {
        calls++;
        await writeFile(
          join(input.worktree, "dirty.txt"),
          "transport evidence",
        );
        return { exit: "transport_error" as const };
      },
    };
    const c = new Controller(f.config, store, adapter);
    try {
      await c.addTask(
        f
          .markdown()
          .replace(
            "review: checks-only",
            "review: checks-only\nlimits: {max_attempts: 1}",
          ),
      );
      expect(await c.runOnce()).toBe("hello");
      expect(c.getDetail("hello").task.state).toBe("queued");
      const first = c.getDetail("hello").attempts[0]!;
      expect(await readFile(join(first.worktree, "dirty.txt"), "utf8")).toBe(
        "transport evidence",
      );
      expect(await c.runOnce()).toBe("hello");
      expect(c.getDetail("hello").task.state).toBe("held");
      expect(c.getDetail("hello").attempts).toHaveLength(2);
      expect(await c.runOnce()).toBeNull();
      expect(calls).toBe(2);
    } finally {
      store.close();
      await f.cleanup();
    }
  }, 20000);
});
