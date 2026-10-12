import { createServer, type Server } from "node:http";
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import ts from "typescript";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VERSION } from "../src/contracts.js";

describe("production MCP over real stdio and authenticated HTTP", () => {
  let dir: string;
  let server: Server;
  let client: Client;
  let transport: StdioClientTransport;
  const requests: { path: string; body: unknown }[] = [];
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "spillway-mcp-"));
    await chmod(dir, 0o700);
    for (const name of await readdir("src")) {
      if (!name.endsWith(".ts")) continue;
      await writeFile(
        join(dir, name.replace(/\.ts$/, ".js")),
        ts.transpileModule(await readFile(join("src", name), "utf8"), {
          compilerOptions: {
            target: ts.ScriptTarget.ES2023,
            module: ts.ModuleKind.ESNext,
          },
        }).outputText,
      );
    }
    await symlink(
      join(process.cwd(), "node_modules"),
      join(dir, "node_modules"),
    );
    await writeFile(join(dir, "package.json"), '{"type":"module"}');
    const token = randomBytes(32).toString("hex");
    server = createServer(async (request, response) => {
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401).end();
        return;
      }
      let text = "";
      for await (const chunk of request) text += String(chunk);
      requests.push({
        path: request.url ?? "",
        body: text ? (JSON.parse(text) as unknown) : null,
      });
      response.end(
        JSON.stringify({
          data: request.url?.endsWith("/result")
            ? null
            : { reached: request.url },
        }),
      );
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing HTTP port");
    await writeFile(
      join(dir, "service.json"),
      JSON.stringify({
        protocol: 1,
        version: VERSION,
        url: `http://127.0.0.1:${address.port}`,
        token,
        pid: process.pid,
      }),
      { mode: 0o600 },
    );
    client = new Client({ name: "fixture-mcp-client", version: "1.0.0" });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(dir, "cli.js"), "--data-dir", dir, "mcp"],
      stderr: "pipe",
    });
    await client.connect(transport);
  });
  afterAll(async () => {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(dir, { recursive: true, force: true });
  });
  it("exposes exactly the five frozen tools with schemas", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "add_task",
      "get_result",
      "get_task",
      "list_tasks",
      "queue_status",
    ]);
    expect(
      tools.find((tool) => tool.name === "add_task")?.inputSchema.required,
    ).toEqual(["markdown"]);
    expect(
      tools.find((tool) => tool.name === "get_task")?.inputSchema.required,
    ).toEqual(["id"]);
  });
  it("routes all tools through HTTP and keeps stdout valid MCP", async () => {
    for (const [name, args] of [
      ["queue_status", {}],
      ["list_tasks", {}],
      ["get_task", { id: "task-one" }],
      ["get_result", { id: "task-one" }],
      ["add_task", { markdown: "task text" }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      expect(result.content).toBeInstanceOf(Array);
    }
    expect(requests).toContainEqual({
      path: "/api/v1/tasks",
      body: { markdown: "task text" },
    });
    expect(requests).toContainEqual({
      path: "/api/v1/tasks/task-one/result",
      body: null,
    });
  });
  it("rejects invalid IDs and unexpected arguments before touching HTTP", async () => {
    const count = requests.length;
    expect(
      (
        await client.callTool({
          name: "get_task",
          arguments: { id: "../escape" },
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await client.callTool({
          name: "queue_status",
          arguments: { injected: true },
        })
      ).isError,
    ).toBe(true);
    expect(requests).toHaveLength(count);
  });
  it("returns isError when service is absent without terminating the MCP session", async () => {
    await rm(join(dir, "service.json"));
    const result = await client.callTool({
      name: "queue_status",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("not running");
    expect((await client.listTools()).tools).toHaveLength(5);
  });
});
