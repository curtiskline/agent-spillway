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
if(prompt==='hang'){setInterval(()=>{},1000)}
else if(prompt==='malformed'){console.log('not json')}
else if(prompt==='transport'){console.log(JSON.stringify({type:'error',error:{name:'APIError',data:{statusCode:503,message:'unavailable'}}}))}
else if(prompt==='coding'){console.log(JSON.stringify({type:'error',error:{name:'APIError',data:{statusCode:400,message:'invalid request'}}}))}
else{console.log(JSON.stringify({type:'text',part:{text:'worker claim'}}));console.log(JSON.stringify({type:'step_finish',part:prompt==='missing'?{reason:'stop'}:{reason:prompt==='tool-round'?'tool-calls':'stop',tokens:{input:12,output:7},cost:0.01}}))}
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
  ] as const)("classifies %s events", async (prompt, exit) => {
    input.prompt = prompt;
    input.timeoutSec = prompt === "hang" ? 0.1 : 2;
    const result = await new OpenCodeAdapter(executable).run(input);
    expect(result.exit).toBe(exit);
    if (prompt === "missing") expect(result.usage).toBeUndefined();
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
