import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ServiceClient } from "./client.js";
import { SpillwayError, VERSION } from "./contracts.js";

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export function createMcpServer(client: ServiceClient): McpServer {
  const server = new McpServer({ name: "agent-spillway", version: VERSION });
  const call = async (method: "GET" | "POST", path: string, body?: unknown) => {
    try {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(await client.request(method, path, body)),
          },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text:
              error instanceof SpillwayError
                ? error.message
                : "Spillway request failed.",
          },
        ],
      };
    }
  };
  server.registerTool(
    "add_task",
    {
      description:
        "Bank a precise Markdown task in the running Spillway service.",
      inputSchema: z
        .object({ markdown: z.string().min(1).max(262144) })
        .strict(),
    },
    ({ markdown }) => call("POST", "/api/v1/tasks", { markdown }),
  );
  server.registerTool(
    "list_tasks",
    {
      description: "List queue tasks.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true },
    },
    () => call("GET", "/api/v1/tasks"),
  );
  server.registerTool(
    "get_task",
    {
      description: "Read task specification, attempts and events.",
      inputSchema: z.object({ id }).strict(),
      annotations: { readOnlyHint: true },
    },
    ({ id }) => call("GET", `/api/v1/tasks/${id}`),
  );
  server.registerTool(
    "get_result",
    {
      description: "Read the latest result and verification report.",
      inputSchema: z.object({ id }).strict(),
      annotations: { readOnlyHint: true },
    },
    ({ id }) => call("GET", `/api/v1/tasks/${id}/result`),
  );
  server.registerTool(
    "queue_status",
    {
      description: "Read service status and queue counts.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true },
    },
    () => call("GET", "/api/v1/status"),
  );
  return server;
}

export async function serveMcp(client: ServiceClient): Promise<McpServer> {
  const server = createMcpServer(client);
  await server.connect(new StdioServerTransport());
  return server;
}
