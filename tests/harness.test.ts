import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server, type RequestListener } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeAdapter, probeEndpoint } from "../src/harness.js";
import type { HarnessInput } from "../src/contracts.js";

describe("provisional OpenCode plumbing (no model qualification)", () => {
  let root: string;
  let executable: string;
  let input: HarnessInput;
  const servers: Server[] = [];
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "spillway-harness-"));
    await mkdir(join(root, "worker"));
    await mkdir(join(root, "artifacts"));
    executable = join(root, "fixture-opencode");
    await writeFile(
      executable,
      `#!${process.execPath}\nimport fs from 'node:fs';
if(process.argv.includes('--version')){console.log('1.2.3');process.exit(0)}
let prompt='';for await(const b of process.stdin)prompt+=b;
fs.writeFileSync(process.env.HOME+'/capture.json',JSON.stringify({args:process.argv.slice(2),prompt,env:process.env,config:JSON.parse(process.env.OPENCODE_CONFIG_CONTENT)}));
if(prompt==='hang'||prompt==='usage-timeout'){if(prompt==='usage-timeout')console.log(JSON.stringify({type:'step_finish',part:{reason:'tool-calls',tokens:{input:12,output:7},cost:0.01}}));setInterval(()=>{},1000)}
else if(prompt==='malformed'){console.log('not json')}
else if(prompt==='transport'){console.log(JSON.stringify({type:'error',error:{name:'APIError',data:{statusCode:503,message:'unavailable'}}}))}
else if(prompt==='coding'){console.log(JSON.stringify({type:'error',error:{name:'APIError',data:{statusCode:400,message:'invalid request'}}}))}
else if(prompt.startsWith('round-reset-')){
console.log(JSON.stringify({type:'step_start',part:{}}));
console.log(JSON.stringify({type:'step_finish',part:{reason:'tool-calls',tokens:{input:3,output:2},cost:0.001}}));
console.log(JSON.stringify({type:'step_start',part:{}}));
console.log(JSON.stringify({type:'step_finish',part:{reason:prompt.slice('round-reset-'.length),tokens:{input:12,output:7},cost:0.01}}));
console.log(JSON.stringify({type:'step_start',part:{}}));
console.log(JSON.stringify({type:'text',part:{text:'unfinished final round'}}));
}
else{console.log(JSON.stringify({type:'text',part:{text:'worker claim'}}));console.log(JSON.stringify({type:'step_finish',part:prompt==='missing'?{reason:'stop'}:{reason:prompt==='content-filter'?'content-filter':prompt==='length'?'length':prompt==='tool-round'?'tool-calls':'stop',tokens:{input:12,output:7},cost:0.01}}))}
`,
      { mode: 0o700 },
    );
    await chmod(executable, 0o700);
    input = {
      worktree: join(root, "worker"),
      prompt: "make change",
      timeoutSec: 2,
      logPath: join(root, "artifacts", "harness.log"),
      endpoint: { id: "fixture", kind: "local", url: "http://127.0.0.1:1/v1" },
      profile: {
        id: "fixture",
        endpoint: "fixture",
        model: "fixture-model",
        model_artifact: "fixture-only-not-qualified",
        harness: "opencode",
        harness_version: "1.2.3",
        qualified_classes: ["small-fix"],
      },
    };
  });
  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map(
          (server) =>
            new Promise<void>((resolve) => server.close(() => resolve())),
        ),
    );
    await rm(root, { recursive: true, force: true });
    delete process.env.SPILLWAY_FIXTURE_API_KEY;
    delete process.env.SPILLWAY_OTHER_PROVIDER_KEY;
  });
  it("pins qualification sampling temperature without changing ordinary worker defaults", async () => {
    const result = await new OpenCodeAdapter(executable).run({
      ...input,
      temperature: 0,
    });
    expect(result.exit).toBe("completed");
    const captured = JSON.parse(
      await readFile(
        join(root, "artifacts", "harness-home", "capture.json"),
        "utf8",
      ),
    );
    expect(captured.config.agent.build.temperature).toBe(0);
    await expect(
      new OpenCodeAdapter(executable).run({ ...input, temperature: Infinity }),
    ).rejects.toThrow("Temperature");
  });
  it("uses the documented command/provider config, stdin and private isolated state", async () => {
    process.env.SPILLWAY_OTHER_PROVIDER_KEY = "unrelated-fixture-secret";
    process.env.SPILLWAY_FIXTURE_API_KEY = "configured-fixture-secret";
    input.endpoint.api_key_env = "SPILLWAY_FIXTURE_API_KEY";
    const adapter = new OpenCodeAdapter(executable);
    expect(await adapter.version()).toBe("1.2.3");
    expect(await adapter.run(input)).toEqual({
      exit: "completed",
      usage: { inputTokens: 12, outputTokens: 7, costUsd: 0.01 },
      summary: "worker claim",
    });
    const captured = JSON.parse(
      await readFile(
        join(root, "artifacts", "harness-home", "capture.json"),
        "utf8",
      ),
    ) as {
      args: string[];
      prompt: string;
      env: Record<string, string>;
      config: Record<string, unknown>;
    };
    expect(captured.args).toEqual([
      "run",
      "--pure",
      "--format",
      "json",
      "--model",
      "spillway/fixture-model",
    ]);
    expect(captured.prompt).toBe(input.prompt);
    expect(captured.env.HOME).toContain("/artifacts/harness-home");
    expect(captured.env.SPILLWAY_OTHER_PROVIDER_KEY).toBeUndefined();
    expect(captured.env.SPILLWAY_FIXTURE_API_KEY).toBeUndefined();
    expect(captured.config).toMatchObject({
      enabled_providers: ["spillway"],
      share: "disabled",
      autoupdate: false,
      plugin: [],
    });
    expect(
      await readFile(join(root, "artifacts", "model.json"), "utf8"),
    ).toContain("fixture-only-not-qualified");
    expect(await readFile(input.logPath, "utf8")).not.toContain(
      "configured-fixture-secret",
    );
  });
  it.each([
    ["missing", "completed"],
    ["malformed", "transport_error"],
    ["transport", "transport_error"],
    ["coding", "failed"],
    ["hang", "timeout"],
    ["tool-round", "transport_error"],
    ["length", "failed"],
    ["content-filter", "failed"],
    ["usage-timeout", "timeout"],
  ] as const)("classifies %s events", async (prompt, exit) => {
    input.prompt = prompt;
    input.timeoutSec =
      prompt === "usage-timeout" ? 1.5 : prompt === "hang" ? 0.2 : 2;
    const result = await new OpenCodeAdapter(executable).run(input);
    expect(result.exit).toBe(exit);
    if (prompt === "missing") expect(result.usage).toBeUndefined();
    if (
      prompt === "length" ||
      prompt === "content-filter" ||
      prompt === "tool-round" ||
      prompt === "usage-timeout"
    )
      expect(result.usage).toEqual({
        inputTokens: 12,
        outputTokens: 7,
        costUsd: 0.01,
      });
  });
  it("fails closed on project plugin/config or credential fallback", async () => {
    await writeFile(
      join(input.worktree, "opencode.json"),
      '{"plugin":["unexpected"]}',
    );
    await expect(new OpenCodeAdapter(executable).run(input)).rejects.toThrow(
      "project configuration",
    );
  });
  it.each([
    ["worker", "stop"],
    ["review", "stop"],
    ["worker", "length"],
    ["review", "length"],
    ["worker", "content-filter"],
    ["review", "content-filter"],
  ] as const)(
    "requires completion of the latest %s round after an earlier %s finish",
    async (purpose, reason) => {
      input.purpose = purpose;
      input.prompt = `round-reset-${reason}`;
      const result = await new OpenCodeAdapter(executable).run(input);
      expect(result.exit).toBe("transport_error");
      expect(result.summary).toContain("completion evidence");
      expect(result.usage?.inputTokens).toBe(15);
      expect(result.usage?.outputTokens).toBe(9);
      expect(result.usage?.costUsd).toBeCloseTo(0.011);
    },
  );
  it("selects an explicit read-only primary reviewer and preserves worker mode", async () => {
    input.purpose = "review";
    const result = await new OpenCodeAdapter(executable).run(input);
    expect(result.exit).toBe("completed");
    const captured = JSON.parse(
      await readFile(
        join(root, "artifacts", "harness-home", "capture.json"),
        "utf8",
      ),
    ) as {
      args: string[];
      config: {
        permission: Record<string, string>;
        agent: Record<
          string,
          { mode: string; permission: Record<string, string> }
        >;
      };
    };
    expect(captured.args.slice(-2)).toEqual(["--agent", "spillway-review"]);
    expect(captured.config.agent["spillway-review"]?.mode).toBe("primary");
    for (const permission of [
      captured.config.permission,
      captured.config.agent["spillway-review"]!.permission,
    ]) {
      expect(permission["*"]).toBe("deny");
      for (const tool of ["read", "glob", "grep"])
        expect(permission[tool]).toBe("allow");
      for (const tool of [
        "edit",
        "write",
        "bash",
        "task",
        "webfetch",
        "websearch",
        "external_directory",
        "lsp",
        "skill",
      ])
        expect(permission[tool]).toBe("deny");
    }
  });
  it("passes only a private credential-file value to the configured provider", async () => {
    const credential = join(root, "endpoint-key");
    await writeFile(credential, "file-fixture-token\n", { mode: 0o600 });
    input.endpoint.api_key_file = credential;
    expect((await new OpenCodeAdapter(executable).run(input)).exit).toBe(
      "completed",
    );
    const captured = JSON.parse(
      await readFile(
        join(root, "artifacts", "harness-home", "capture.json"),
        "utf8",
      ),
    ) as { env: Record<string, string> };
    expect(captured.env.SPILLWAY_ENDPOINT_KEY).toBe("file-fixture-token");
    expect(await readFile(input.logPath, "utf8")).not.toContain(
      "file-fixture-token",
    );
  });
  async function catalog(handler: RequestListener): Promise<string> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing fixture address");
    return `http://127.0.0.1:${address.port}/v1`;
  }
  it("requires the exact model and bounds malformed or oversized catalogs", async () => {
    const url = await catalog((request, response) => {
      expect(request.url).toBe("/v1/models");
      response.end(JSON.stringify({ data: [{ id: "exact-model" }] }));
    });
    expect(
      await probeEndpoint({ ...input.endpoint, url }, "exact-model"),
    ).toEqual({ healthy: true });
    expect(
      (await probeEndpoint({ ...input.endpoint, url }, "exact")).healthy,
    ).toBe(false);
    const malformed = await catalog((_request, response) =>
      response.end("{broken"),
    );
    expect(
      (await probeEndpoint({ ...input.endpoint, url: malformed }, "exact"))
        .reason,
    ).toContain("malformed");
    const oversized = await catalog((_request, response) =>
      response.end("x".repeat(1024 * 1024 + 1)),
    );
    expect(
      (await probeEndpoint({ ...input.endpoint, url: oversized }, "exact"))
        .reason,
    ).toContain("size limit");
  });
  it("never follows redirects or forwards credentials", async () => {
    let redirectedRequests = 0;
    const destination = await catalog((_request, response) => {
      redirectedRequests++;
      response.end("{}");
    });
    const url = await catalog((_request, response) => {
      response.writeHead(302, { location: destination });
      response.end();
    });
    process.env.SPILLWAY_FIXTURE_API_KEY = "fixture";
    expect(
      (
        await probeEndpoint(
          { ...input.endpoint, url, api_key_env: "SPILLWAY_FIXTURE_API_KEY" },
          "exact",
        )
      ).healthy,
    ).toBe(false);
    expect(redirectedRequests).toBe(0);
  });
  it("authenticates the exact catalog using a private file reference", async () => {
    const credential = join(root, "catalog-key");
    await writeFile(credential, "catalog-fixture-token\n", { mode: 0o600 });
    let authorization: string | undefined;
    const url = await catalog((request, response) => {
      authorization = request.headers.authorization;
      response.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
    });
    expect(
      (
        await probeEndpoint(
          { ...input.endpoint, url, api_key_file: credential },
          "fixture-model",
        )
      ).healthy,
    ).toBe(true);
    expect(authorization).toBe("Bearer catalog-fixture-token");
  });
  it("bounds an indefinitely streaming catalog and handles a busy endpoint", async () => {
    const hanging = await catalog((_request, response) => {
      response.writeHead(200);
      response.write("{");
    });
    const started = Date.now();
    expect(
      (await probeEndpoint({ ...input.endpoint, url: hanging }, "exact"))
        .healthy,
    ).toBe(false);
    expect(Date.now() - started).toBeLessThan(4500);
    const busy = await catalog((_request, response) => {
      response.writeHead(503);
      response.end();
    });
    expect(
      (await probeEndpoint({ ...input.endpoint, url: busy }, "exact")).reason,
    ).toContain("503");
  });
});
